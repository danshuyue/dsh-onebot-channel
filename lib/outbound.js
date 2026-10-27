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
 */
import { getConfig } from './config.js'
import { note } from './env.js'
import { callOneBot } from './onebot.js'
import { partDelayMs, splitMessage } from './split.js'
import { splitEmojiMarks, attachFacesToParts } from './emoji-mark.js'

export const outbound = new Map()

/** 往会话的待转发队列尾部追加一条。 */
export function enqueueOutbound(sessionId, agent, cursor, target) {
  const queue = outbound.get(sessionId)
  if (queue !== undefined) queue.push({ agent, cursor, target })
  else outbound.set(sessionId, [{ agent, cursor, target }])
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
  // 正文里的表情标记先摘出来 —— [表情:呲牙] 这种明文不该出现在 QQ 上
  const marked = splitEmojiMarks(text)
  const body = marked.text
  const toolFaceSegment = options?.faceSegment ?? null
  const customEmojiId = String(options?.customEmojiId ?? '').trim()
  if (body === '' && marked.faces.length === 0 && toolFaceSegment === null && customEmojiId === '') {
    throw new Error('要发送的内容是空的')
  }

  const parts = body === '' ? [] : config.splitReply === false
    ? [body]
    : splitMessage(body, {
        maxChars: Number(config.splitMaxChars) || 120,
        minChars: Number(config.splitMinChars) || 4,
        maxParts: Number(config.splitMaxParts) || 8
      })
  const list = parts.length > 0 ? parts : []
  if (list.length > 1) {
    note('out', `分 ${list.length} 条发送，字数 ${list.map((item) => item.length).join('/')}`)
  }

  // 正文标记 → 按位置挂到各条消息末尾（「表情跟随前一句话」）
  const markedParts = attachFacesToParts(list, marked.faces)

  let result = null
  for (let i = 0; i < markedParts.length; i += 1) {
    if (i > 0) {
      await sleep(
        partDelayMs(markedParts[i].part, {
          minDelayMs: Number(config.splitDelayMinMs) || 200,
          maxDelayMs: Number(config.splitDelayMaxMs) || 700
        })
      )
    }
    const segments = [{ type: 'text', data: { text: markedParts[i].part } }]
    // 正文标记来的表情
    for (const id of markedParts[i].faces) segments.push({ type: 'face', data: { id: String(id) } })
    // 工具参数来的表情：附在最后一条消息末尾
    if (toolFaceSegment !== null && i === markedParts.length - 1) segments.push(toolFaceSegment)
    result = await sendOneToQQ(target, segments)
  }

  // 收藏表情：协议端只能单独发一条，跟在文本后面
  if (customEmojiId !== '') {
    const { sendCustomFace } = await import('./custom-faces.js')
    result = await sendCustomFace(target, customEmojiId)
  }

  // 只有表情没有文本的情况
  if (markedParts.length === 0 && toolFaceSegment !== null) {
    result = await sendOneToQQ(target, [toolFaceSegment])
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

export async function flushOutbound() {
  if (flushBusy) return
  flushBusy = true
  try {
    for (const [sessionId, queue] of outbound) {
      while (queue.length > 0) {
        const entry = queue[0]
        try {
          // 只取 cursor 之后的新事件（不是全量快照）
          const events = eventsSince(entry.agent, entry.cursor)
          if (events.length === 0) break
          const ends = events
            .filter((event) => event?.type === 'turn/end' && Number(event.seq) > entry.cursor)
            .sort((a, b) => Number(a.seq) - Number(b.seq))
          if (ends.length === 0) break // 队头的回合还没跑完，等下一秒
          const end = ends[0]
          const from = Number(entry.cursor) // 先存旧游标，下面要用它划范围（别在改完游标后再读）
          const replies = events.filter(
            (event) => event?.type === 'assistant/message' && Number(event.seq) > from && Number(event.seq) < Number(end.seq)
          )
          entry.cursor = Number(end.seq)
          const last = replies[replies.length - 1]
          const text = blocksToText(last?.data?.message?.content)

          // 本回合如果已经用 qq_send 发过了，就别再自动转发 —— 否则工具发的是"给群里的正文"，
          // 自动转发又会把助手这一轮的完整正文再发一遍（实测：群里多收到 2 条本不该发的内容）。
          const sendCalls = events.filter(
            (event) =>
              event?.type === 'tool/call' &&
              Number(event.seq) > from &&
              Number(event.seq) < Number(end.seq) &&
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
              queue.shift()
              continue
            }
            note('out', 'qq_send 调用失败，改走自动转发兜底')
          }

          if (text === '') {
            const reason = end?.data?.reason
            if (reason?.kind === 'error') note('out', `回合失败，不转发：${reason?.error?.message ?? '未知错误'}`)
            queue.shift()
            continue
          }
          // 先出队再发送：发送中途出错时宁可丢这一条（日志里有），也不能让下一轮重发一遍
          queue.shift()
          await sendToQQ(entry.target, text)
          note('out', `已转发回复 ${text.length} 字 -> ${entry.target?.kind ?? '?'}`)
        } catch (error) {
          note('out', `转发失败：${error instanceof Error ? error.message : error}`)
          queue.shift() // 出错也出队：卡在队头会把后面所有待转发都堵死
        }
      }
      if (queue.length === 0) outbound.delete(sessionId)
    }
  } finally {
    flushBusy = false
  }
}

export { eventsSince }
