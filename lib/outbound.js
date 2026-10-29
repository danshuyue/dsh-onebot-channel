/**
 * outbound.js —— 回复发回 QQ（自动转发）。
 *
 * 出站队列：会话 id → 待转发队列 [{ agent, cursor, target }]。
 *
 * 必须是队列而不是单条覆盖：同一个会话短时间内被连续投递两条消息时，
 * 后一次 set 会把前一次的 cursor 直接盖掉 —— 前一回合的 turn/end 从此落在游标之前，
 * 它的回复就永远不转发了（低概率但真实：群聊连 @ 两条、或上一回合刚好在
 * flushOutbound 两次扫描的间隙里结束）。另外两个 QQ 号绑同一个会话时，
 * target 也会被后投递的一方盖掉，回复发错人。队列逐条消化，两个问题一起没了。
 *
 * ⚠️ 队列条目**不能只靠 cursor 定位回合**（2026-10-28 修的大坑）：
 *   cursor 是「投递那一刻的 session.seq」，而 agent 跑回合期间 session.seq **不推进**。
 *   所以「没等她发完就发下一条」时，两条消息拿到的 cursor **完全相同**：
 *     条目A(cursor=10) 找到 turn/end(13) → 发出去，cursor 推到 13
 *     条目B(cursor=10) cursor 没动 → 下一轮又找到 turn/end(13) → **同一条回复再发一遍**
 *   连发 N 条 = 同一条回复发 N 遍（实测「连续发了好几遍」）。
 *
 *   修法：条目记住**自己那条 user/message 的 seq**（`userSeq`），
 *   靠「我这条用户消息之后、下一个 turn/end」来定位属于我的回合。
 *   两条消息合进同一回合时，两条 user/message 都在那个回合之前 →
 *   认到同一个 turn/end → 用 `sentTurnEnds` 集合保证那个回合只发一次。
 */
import { getConfig } from './config.js'
import { note } from './env.js'
import { consumeSuppress, targetKey, isStageOnly } from './rhythm.js'
import { callOneBot } from './onebot.js'
import { partDelayMs, splitMessage } from './split.js'
import { splitEmojiMarksAsync, attachFacesToParts } from './emoji-mark.js'
import { assertClean } from './sensitive.js'

export const outbound = new Map()

/**
 * 已经转发过的回合（按 sessionId + turn/end 的 seq 记）。
 *
 * 同一个回合被两个条目认到时，只发一次 —— 第二个条目直接跳过，
 * 但**不能出队丢掉**：它那条消息的回复已经在第一个条目发出去了，
 * 丢掉只是不重复发；留着则下一轮还会再撞一次同一个回合。
 *
 * ⚠️ 生命周期必须跟着队列走（2026-10-28 修）：
 *   早先这个 Map 只增不减，长跑几天后每个会话攒下几千个 seq，纯内存泄漏。
 *   而且它记的是**某个 seq 空间里的位置** —— 会话重连 / 冷启动后 seq 空间会变，
 *   旧记录留着只会误判（把新回合当成「已发过」直接跳过，回复就悄悄没了）。
 *   现在队列清空时一起清掉：没人排队时，这份记录没有任何用处。
 */
const sentTurnEnds = new Map()

/** 单会话最多记多少个已发回合（队列长期不空时的兜底上限）。 */
const SENT_TURNS_LIMIT = 500

/** 某会话已经发过的 turn/end 集合（懒建）。 */
function sentTurnsOf(sessionId) {
  let set = sentTurnEnds.get(sessionId)
  if (set === undefined) {
    set = new Set()
    sentTurnEnds.set(sessionId, set)
  }
  return set
}

/** 记一个已发回合，并维持集合上限（Set 保插入序，超了就丢最早的）。 */
function markSentTurn(sessionId, endSeq) {
  const set = sentTurnsOf(sessionId)
  set.add(endSeq)
  while (set.size > SENT_TURNS_LIMIT) {
    const oldest = set.values().next().value
    if (oldest === undefined) break
    set.delete(oldest)
  }
}

/**
 * 某会话的「认领状态」：
 *   · matchCursor      —— 已经扫到哪了（用于增量收集 user/message）
 *   · pendingUserSeqs  —— 收集到但还没被队列条目认领的 user/message 的 seq
 *
 * 为什么要这个：队列条目要认领「属于自己的那条 user/message」，
 * 才能定位到真正回答它的那一回合（见 flushOutbound 的注释）。
 */
const sessionStates = new Map()

function sessionState(sessionId) {
  let state = sessionStates.get(sessionId)
  if (state === undefined) {
    // matchCursor 的初值在入队时按「第一个条目的 cursor」定（见 enqueueOutbound），
    // 这样收集范围刚好从本次投递开始，不会把更早的 user/message 也捞进来。
    state = { matchCursor: 0, pendingUserSeqs: [] }
    sessionStates.set(sessionId, state)
  }
  return state
}

/**
 * 往会话的待转发队列尾部追加一条。
 *
 * createdAt（2026-10-28）用于「回合超时」：见 flushOutbound 里的 stale 判断。
 * 没有它的话，turn/end 永远不来（DSH 崩了 / 会话被手动中断 / 回合被丢弃）时，
 * 这个条目会一辈子卡在队头，把后面所有转发全堵死 —— 表现是「她突然不回话了」，
 * 而且日志里一片安静，根本查不出来。
 */
export function enqueueOutbound(sessionId, agent, cursor, target, options) {
  const entry = {
    agent, cursor, target, userSeq: null, createdAt: Date.now(),
    // 主动搭话投进去的回合：这类回合里「只回动作」要按沉默处理（见下面 flushOutbound）
    proactive: options?.proactive === true
  }
  const queue = outbound.get(sessionId)
  if (queue !== undefined) queue.push(entry)
  else {
    outbound.set(sessionId, [entry])
    // 队列刚建：把收集起点定在第一个条目的 cursor，
    // 免得把「本次投递之前」的老 user/message 也收集进来（那些对应更早的、已处理的消息）。
    const state = sessionState(sessionId)
    if (state.matchCursor === 0) state.matchCursor = Number(cursor) || 0
  }
}

/** 清空所有待发队列（测试用）。 */
export function clearOutbound() {
  outbound.clear()
  sentTurnEnds.clear()
  sessionStates.clear()
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 发一条，不拆条。
 *
 * message 可以是字符串（内部包成单个 text 段），也可以是段数组 ——
 * 表情段就是靠后者跟文本拼在同一条消息里发出去的。
 */
export async function sendOneToQQ(target, message) {
  const config = getConfig()
  // 私聊目标：优先用投递时记下的 uin（谁来的回给谁），
  // 没有的话才退回 peerUin —— 以前这里直接写死 peerUin，结果在别的会话里回的话
  // 全被发回给用户本人，对方那边自然是"什么都收不到"。
  const privateUin = Number(target?.id ?? 0) > 0 ? Number(target.id) : Number(config.peerUin)
  const segments = Array.isArray(message)
    ? message
    : [{ type: 'text', data: { text: String(message ?? '') } }]
  const payload = target?.kind === 'group'
    ? { action: 'send_group_msg', params: { group_id: Number(target.id), message: segments } }
    : { action: 'send_private_msg', params: { user_id: privateUin, message: segments } }
  const result = await callOneBot(payload)
  if (result.retcode !== 0) throw new Error(`retcode=${result.retcode} ${result.message ?? ''}`)
  return result
}

/**
 * 发一段回复：按句末标点拆成多条，逐条发出并留出真人式的停顿。
 * 返回最后一条的结果（qq_send 的 message_id 取它）。
 *
 * @param {object} target 目标
 * @param {string} text 正文
 * @param {object} [options]
 * @param {object|null} [options.faceSegment] 经典表情段（face）——
 *   **附在最后一条消息末尾**，也就是「表情跟随前一句话」。
 *   face 段可以和文本拼在同一条消息里发出去。
 * @param {string|null} [options.customEmojiId] 收藏表情的 emoji_id ——
 *   协议端那边是独立 action，只能**单独发一条**，跟在文本之后。
 */
export async function sendToQQ(target, text, options = {}) {
  const config = getConfig()
  const toolFaceSegment = options?.faceSegment ?? null
  const customEmojiId = String(options?.customEmojiId ?? '').trim()

  // ---- 分段由谁定 ----
  // 默认按标点自动切；模型给了 segments（qq_send 的 segments 参数）就按它发 ——
  // 真人会自己决定「这句分三条还是一条说完」，而不是被标点机械切开。
  const explicitSegments = Array.isArray(options?.segments)
    ? options.segments.map((item) => String(item ?? '')).filter((item) => item.trim() !== '')
    : []
  const useExplicit = explicitSegments.length > 0

  // 出站内容审计（2026-10-28）：回复里出现本机路径 / 凭据特征就整条不发。
  // 挡在分条之前 —— 命中就整条拒绝，而不是只把其中一条打码发出去。
  // 这里抛错是故意的：上层会翻成工具错误给 agent 看，她会换个说法重讲；
  // 悄悄打码发送会让人误以为闸门没生效。
  // 显式分段时逐段拼起来审，保证每一段都过闸。
  assertClean(useExplicit ? explicitSegments.join('\n') : text, '回复')

  let markedParts
  if (useExplicit) {
    // 每段单独解析表情标记：表情跟着它所在的那一段走（段是模型定的边界）。
    // 用异步版：表情名反查先查 QQ 官方表情目录，查不到再落内置表。
    markedParts = []
    for (const segment of explicitSegments) {
      const marked = await splitEmojiMarksAsync(segment)
      if (marked.text === '' && marked.faces.length === 0) continue
      markedParts.push({ part: marked.text, faces: marked.faces.map((face) => face.id) })
    }
    if (markedParts.length > 1) {
      note('out', `按模型分段发 ${markedParts.length} 条，字数 ${markedParts.map((item) => item.part.length).join('/')}`)
    }
  } else {
    // 正文里的表情标记先摘出来 —— [表情:呲牙] 这种明文不该出现在 QQ 上
    const marked = await splitEmojiMarksAsync(text)
    const body = marked.text
    const parts = body === '' ? [] : config.splitReply === false
      ? [body]
      : splitMessage(body, {
          // 默认按换行分条（她自己决定说几条）；sentence = 老行为，按句末标点切
          mode: config.splitMode === 'sentence' ? 'sentence' : 'paragraph',
          maxChars: Number(config.splitMaxChars) || 120,
          minChars: Number(config.splitMinChars) || 4,
          maxParts: Number(config.splitMaxParts) || 8
        })
    if (parts.length > 1) {
      note('out', `分 ${parts.length} 条发送，字数 ${parts.map((item) => item.length).join('/')}`)
    }
    // 正文标记 → 按位置挂到各条消息末尾（「表情跟随前一句话」）
    markedParts = attachFacesToParts(parts, marked.faces)
  }

  if (markedParts.length === 0 && toolFaceSegment === null && customEmojiId === '') {
    throw new Error('要发送的内容是空的')
  }

  let result = null
  for (let i = 0; i < markedParts.length; i += 1) {
    const current = markedParts[i]
    if (i > 0) {
      await sleep(
        partDelayMs(current.part, {
          minDelayMs: Number(config.splitDelayMinMs) || 200,
          maxDelayMs: Number(config.splitDelayMaxMs) || 700
        })
      )
    }
    // 空文本段不塞进去（有些协议端对空 text 段不友好），只发它的表情
    const segments = []
    if (current.part !== '') segments.push({ type: 'text', data: { text: current.part } })
    // 正文标记来的表情
    for (const id of current.faces) segments.push({ type: 'face', data: { id: String(id) } })
    // 工具参数来的表情：附在最后一条消息末尾
    if (toolFaceSegment !== null && i === markedParts.length - 1) segments.push(toolFaceSegment)

    // ⚠️ 带表情发送失败 → 去掉表情、把文字重发一遍。
    //   协议端遇到它不认的 face id（比如内置表记错编号）会报 OIDB 错误，
    //   **整条消息直接发不出去** —— 文字也跟着没了。
    //   实测她的两条回复就是这么被吞的（「[表情:晕]」→ 编号 17 → 幽灵 id）。
    //   所以这里兜一层：表情发不出去就只发文字，绝不让整条回复消失。
    const hasFace = segments.some((item) => item.type === 'face')
    if (hasFace) {
      try {
        result = await sendOneToQQ(target, segments)
      } catch (error) {
        note('out', `带表情发送失败（${error instanceof Error ? error.message : error}），去掉表情重发文字`)
        if (current.part !== '') {
          result = await sendOneToQQ(target, [{ type: 'text', data: { text: current.part } }])
        } else {
          note('out', '这条只有表情且发不出去，已放弃')
        }
      }
    } else {
      result = await sendOneToQQ(target, segments)
    }
  }

  // 收藏表情：协议端只能单独发一条，跟在文本后面
  if (customEmojiId !== '') {
    const { sendCustomFace } = await import('./custom-faces.js')
    result = await sendCustomFace(target, customEmojiId)
  }

  // 只有表情没有文本的情况
  if (markedParts.length === 0 && toolFaceSegment !== null) {
    // 同样兜底：表情发不出去就整条放弃，但别抛错炸掉整个转发循环
    try {
      result = await sendOneToQQ(target, [toolFaceSegment])
    } catch (error) {
      note('out', `纯表情发送失败（${error instanceof Error ? error.message : error}），已放弃这条`)
      return {}
    }
  }

  return result ?? {}
}

// ---- 回合事件扫描 ----

/**
 * 取「上次看过的位置之后」的新事件。
 *
 * DSH 的 Session API 支持范围查询：snapshotEvents(fromSeq, toSeqExclusive)。
 * 早先调的是无参版本 —— 那是「从 0 取到当前」的全量快照，每秒扫一遍，
 * 长会话几千个事件时就是纯浪费。现在只取 [from, seq) 这一段。
 *
 * 边界做了两层保险：
 *   - from 可能落在「继承事件」区（seq < firstLiveSeq）之前 → 取 max(from, firstLiveSeq)；
 *   - 拿不准 from 是不是闭区间 → 下游一律用 seq > cursor 过滤，两种语义都对。
 */
function eventsSince(agent, fromSeq) {
  try {
    const session = agent?.session
    if (session === undefined || session === null) return []
    if (typeof session.snapshotEvents === 'function') {
      const first = typeof session.firstLiveSeq === 'number' ? session.firstLiveSeq : 0
      const from = Math.max(Number(fromSeq) || 0, first)
      // 上界用 seq + 1：DSH 的签名是 toSeqExclusive（开区间），
      // 而 session.seq 到底是「最后一个已分配 seq」还是「下一个待分配」，
      // 两种解释差一个事件 —— 漏掉的正好可能是 turn/end（回复就转发不出去了）。
      // 多取一个不存在的 seq 无害（下面按 seq > cursor 过滤）。
      const to = typeof session.seq === 'number' ? session.seq + 1 : undefined
      const list = to !== undefined ? session.snapshotEvents(from, to) : session.snapshotEvents(from)
      return Array.isArray(list) ? list : []
    }
    if (Array.isArray(session.events)) {
      return session.events.filter((event) => Number(event?.seq) > Number(fromSeq))
    }
  } catch {
    /* 拿不到就算了，下一轮再试 */
  }
  return []
}

/** 当前会话最大的事件 seq。DSH 有 seq getter，直接读；没有才退回报数。 */
export function maxEventSeq(agent) {
  try {
    const session = agent?.session
    if (session !== undefined && session !== null && typeof session.seq === 'number') return session.seq
  } catch {
    /* 忽略 */
  }
  let max = 0
  for (const event of eventsSince(agent, -1)) {
    const seq = Number(event?.seq)
    if (Number.isFinite(seq) && seq > max) max = seq
  }
  return max
}

function blocksToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block?.type === 'text' ? String(block.text ?? '') : ''))
    .join('')
    .trim()
}

/**
 * 每秒扫一遍：哪个会话的待转发队列头部的回合跑完了，就把这回合最后一条助手文本发回 QQ。
 *
 * 队列逐条消化：头部条目等到它的 turn/end 才转发（并按它自己的 target 发），
 * 转发完 shift，下一条成为新头部。回合失败 / 已用 qq_send 发过 / 空文本都算「消化完」。
 *
 * flushBusy 防重入：分条发送带真人停顿（最长几百 ms×N），一轮 flush 可能超过 1 秒，
 * 定时器又把第二轮拍进来 —— 两轮同时 shift 同一个队列会重发或跳发。
 */
let flushBusy = false

/**
 * flushOutbound 的新实现（临时脚本用，跑完即删）。
 *
 * 修复：连着发消息时同一条回复被发好几遍。
 *   cursor 是「投递那一刻的 session.seq」，agent 跑回合期间它不推进 →
 *   两条消息的 cursor 相同 → 两个队列条目认到同一个 turn/end → 同一条回复发两遍。
 *   改法：条目认领「属于自己的那条 user/message」，靠它定位回合；
 *        同一个 turn/end 用 sentTurns 去重，只发一次。
 */
export async function flushOutbound() {
  if (flushBusy) return
  flushBusy = true
  const config = getConfig()
  try {
    for (const [sessionId, queue] of outbound) {
      const state = sessionState(sessionId)
      const sentTurns = sentTurnsOf(sessionId)
      while (queue.length > 0) {
        const entry = queue[0]
        try {
          // ---- 回合超时（2026-10-28）----
          // turn/end 可能永远不来：DSH 崩了、会话被手动中断、回合被 DSH 丢弃。
          // 那种情况下这个条目会永久卡在队头 —— 后面所有转发全堵死，
          // 表现成「她突然不理人了」，日志里却一片安静（因为根本没走到出错分支）。
          // 所以给每个条目一个寿命：超了就丢，记一条日志，让队列继续走。
          //
          // 为什么是「丢」不是「重试」：turn/end 都没来，说明这一回合没有可靠结果；
          // 重试只会把同一条队列反复卡住。宁可少发一条，也不能让管道死掉。
          const ttlMs = Number(config.outboundEntryTtlMs) || 300000
          const waited = Date.now() - (Number(entry.createdAt) || 0)
          if (Number(entry.createdAt) > 0 && waited > ttlMs) {
            note(
              'out',
              `队列条目超时（等了 ${Math.round(waited / 1000)}s 没等到 turn/end，上限 ${Math.round(ttlMs / 1000)}s），已丢弃以免堵住后续转发`
            )
            queue.shift()
            continue
          }
          // 收集 user/message 时要从 state.matchCursor 开始扫（可能比 entry.cursor 更早），
          // 否则认不准「属于我这条消息」的那条 user/message。
          const scanFrom = Math.min(Number(entry.cursor) || 0, state.matchCursor)
          const events = eventsSince(entry.agent, scanFrom)
          if (events.length === 0) break

          // ---- 收集还没认领的 user/message ----
          // 队列是 FIFO，用户消息事件也是顺序出现的：
          //   第一个条目认领最早的那条，第二个认领下一条，以此类推。
          // 靠这个顺序对应，才能在「两条消息合进同一回合」时把两个条目都对到那个回合上。
          //
          // ⚠️ 收集范围 = [state.matchCursor, 本轮扫到的最大 seq]。
          //   matchCursor 只前进不后退，所以同一批事件不会被重复收集。
          const scanMax = events.reduce((max, event) => Math.max(max, Number(event?.seq) || 0), 0)
          for (const event of events) {
            const seq = Number(event?.seq)
            if (!Number.isFinite(seq)) continue
            if (seq < state.matchCursor || seq > scanMax) continue
            if (event?.type === 'user/message' && !state.pendingUserSeqs.includes(seq)) {
              state.pendingUserSeqs.push(seq)
            }
          }
          state.pendingUserSeqs.sort((a, b) => a - b)
          if (scanMax > state.matchCursor) state.matchCursor = scanMax

          // ---- 认领属于本条目的那条 user/message ----
          if (entry.userSeq === null) {
            // 用 >= 而不是 >：cursor 是「投递那一刻最后一个已分配的 seq」，
            // 而 followup 之后 user/message 会占用**新的** seq（cursor+1）；
            // 但边界情况下（事件正好落在 cursor 上）用 > 会认领不到 → 队列卡死。
            // 认领用「第一个还没被认走的、比 cursor 不早的 user/message」。
            const idx = state.pendingUserSeqs.findIndex((seq) => seq >= (Number(entry.cursor) || 0))
            if (idx >= 0) {
              entry.userSeq = state.pendingUserSeqs.splice(idx, 1)[0]
            } else {
              // 兜底：认不到 user/message（老会话格式、事件被裁剪等）。
              // 已经没有比 cursor 更晚的 turn/end → 回合还没跑完，等下一轮。
              const hasLaterEnd = events.some(
                (event) => event?.type === 'turn/end' && Number(event.seq) > (Number(entry.cursor) || 0)
              )
              if (!hasLaterEnd) break
              // 有 turn/end 但认不到用户消息 → 退回用 cursor 定位（老行为）。
              // 这种情况下无法区分「两条消息合进一个回合」，但至少不会卡死队列。
              entry.userSeq = Number(entry.cursor) || 0
            }
          }
          const myUserSeq = entry.userSeq

          // ---- 定位属于我的回合 ----
          // 用「我的 user/message 之后的第一个 turn/end」，而不是 cursor。
          // 原因：agent 跑回合期间 session.seq 不推进，连着发的两条消息 cursor 可能相同；
          // 用 cursor 会让两个条目认到同一个回合 → 同一条回复发两遍。
          const ends = events
            .filter((event) => event?.type === 'turn/end' && Number(event.seq) > myUserSeq)
            .sort((a, b) => Number(a.seq) - Number(b.seq))
          if (ends.length === 0) {
            // 队头的回合还没跑完，等下一秒。
            //
            // 这里是「她突然不回话」最关键的一个静默出口 —— 卡在这儿时不会有任何异常，
            // 日志一片安静。所以等太久就留一条诊断：通常意味着 turn/end 丢了
            // （DSH 崩过 / 会话被中断 / 事件被裁剪），而不是「模型还在想」。
            const stalled = Date.now() - (Number(entry.createdAt) || 0)
            if (stalled > 30000 && entry.stallWarned !== true) {
              entry.stallWarned = true
              note(
                'out',
                `队头条目已等 ${Math.round(stalled / 1000)}s 仍未等到 turn/end（cursor=${entry.cursor}，userSeq=${entry.userSeq ?? '未认领'}）—— 若持续如此，多半是这一回合丢了，等 TTL 到期会自动丢弃`
              )
            }
            break
          }
          const end = ends[0]
          const endSeq = Number(end.seq)

          // 同一个回合已经发过了 → 跳过（不重复发）。
          // ⚠️ 必须出队：它那条消息已经被这个回合一起回答过了，
          //   留在队头会一直卡住，把后面的条目全堵住。
          if (sentTurns.has(endSeq)) {
            note('out', `回合 seq=${endSeq} 已转发过，跳过重复发送`)
            entry.cursor = endSeq
            queue.shift()
            continue
          }

          // 回复正文 = 这个回合里的最后一条助手消息
          // ⚠️ 下界取 min(cursor, myUserSeq)：
          //   两条消息合进同一回合时，我的 user/message 可能在 cursor 之后，
          //   但本回合的 assistant/message 可能排在我的 user/message **之前**
          //   （DSH 把两条消息都塞进一个回合时，助手只回一次，回复在两条之后）。
          //   取宽一点的下界，保证「这个回合里的最后一条助手消息」一定在范围内 ——
          //   最后一条必然属于本回合（回合刚结束），不会误取到上一回合的。
          const from = Math.min(Number(entry.cursor) || 0, myUserSeq)
          const replies = events.filter(
            (event) => event?.type === 'assistant/message' && Number(event.seq) > from && Number(event.seq) < endSeq
          )
          entry.cursor = endSeq
          const last = replies[replies.length - 1]
          const text = blocksToText(last?.data?.message?.content)

          // 本回合如果已经用 qq_send 发过了，就别再自动转发 —— 否则工具发的是"给群里的正文"，
          // 自动转发又会把助手这一轮的完整正文再发一遍（实测：群里多收到 2 条本不该发的内容）。
          const sendCalls = events.filter(
            (event) =>
              event?.type === 'tool/call' &&
              Number(event.seq) > from &&
              Number(event.seq) < endSeq &&
              String(event?.data?.name ?? '') === 'qq_send'
          )
          if (sendCalls.length > 0) {
            const callIds = new Set(sendCalls.map((event) => String(event?.data?.callId ?? '')))
            const failed = events.some(
              (event) =>
                event?.type === 'tool/result' &&
                callIds.has(String(event?.data?.callId ?? event?.data?.message?.toolCallId ?? '')) &&
                event?.data?.message?.isError === true
            )
            if (!failed) {
              note('out', `本回合已用 qq_send 发过（${sendCalls.length} 次），跳过自动转发`)
              markSentTurn(sessionId, endSeq)
              queue.shift()
              continue
            }
            note('out', 'qq_send 调用失败，改走自动转发兜底')
          }

          if (text === '') {
            const reason = end?.data?.reason
            if (reason?.kind === 'error') note('out', `回合失败，不转发：${reason?.error?.message ?? '未知错误'}`)
            markSentTurn(sessionId, endSeq)
            queue.shift()
            continue
          }
          // ---- 她主动划走了（qq_pass）----
          // 这是「有意为之的沉默」：什么都别发出去，但这一回合要正常结账
          // （出队 + 标记已发），否则它会卡在队头把后面全堵住。
          const passKey = targetKey(entry.target)
          if (consumeSuppress(passKey)) {
            // ⚠️ 但它管的是「这次不开口」，不是「把我刚写的话删掉」。
            // 实测：模型会先写一句正文、再觉得「这时候再补一句太催了」而调 qq_pass，
            // 结果她在会话里明明说了一句话，QQ 上却什么都没有 ——
            // 用户看到的就是「她发消息了，但我没收到」，还以为是转发坏了。
            // 定成：正文里有真话 = 说出口了，照发；只有纯动作 / 纯标点时 qq_pass 才真按下不发。
            if (!isStageOnly(text)) {
              note('out', `qq_pass 但正文写了真话（${text.length} 字），按「说出口了」照发 key=${passKey}`)
            } else {
              note('out', `本回合已划走（qq_pass），不转发任何内容 key=${passKey}`)
              queue.shift()
              markSentTurn(sessionId, endSeq)
              continue
            }
          }

          // ---- 主动搭话回合里「只回了动作」= 她在沉默 ----
          // 主动搭话投进去之后，模型有时会回「（尾巴摆了摆）」表示「我在，但没话说」。
          // 转发链只认文字，于是 QQ 上真收到一条「（尾巴摆了摆）」——
          // 用户看到的是莫名其妙的消息，跟「她说了一句话」完全是两回事。
          // 只拦主动搭话回合，且只拦「整条都是动作」；普通聊天里的「（笑）好呀」照发。
          if (entry.proactive === true && isStageOnly(text)) {
            note('out', `主动搭话回合只回了动作描写（${text.length} 字），按沉默处理不转发：${text.slice(0, 40)}`)
            queue.shift()
            markSentTurn(sessionId, endSeq)
            continue
          }

          // 先出队再发送：发送中途出错时宁可丢这一条（日志里有），也不能让下一轮重发一遍
          queue.shift()
          markSentTurn(sessionId, endSeq)
          await sendToQQ(entry.target, text)
          note('out', `已转发回复 ${text.length} 字 -> ${entry.target?.kind ?? '?'}`)
        } catch (error) {
          note('out', `转发失败：${error instanceof Error ? error.message : error}`)
          queue.shift() // 出错也出队：卡在队头会把后面所有待转发都堵死
        }
      }
      if (queue.length === 0) {
        outbound.delete(sessionId)
        // 队列空了 → 重置会话状态：下次的新消息重新从它自己的 cursor 开始认领。
        // 不重置的话，之前没认领走的 user/message 会被下一个条目错认。
        sessionStates.delete(sessionId)
        // 「已发回合」记录同样清掉：它记的是 seq 空间里的位置，
        // 会话重连 / 冷启动后这个空间会变，留着只会把新回合误判成「发过了」。
        // 而且没人排队时它本来就没用（见 SENT_TURNS_LIMIT 的注释）。
        sentTurnEnds.delete(sessionId)
      }
    }
  } finally {
    flushBusy = false
  }
}

export { eventsSince }
