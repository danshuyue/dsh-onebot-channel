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
import { consumeSuppress, targetKey, isStageOnly, closeRefusedThisTurn, skipTurnRequested } from './rhythm.js'
import { callOneBot } from './onebot.js'
import { partDelayMs, splitMessage } from './split.js'
import { splitEmojiMarksAsync, attachFacesToParts } from './emoji-mark.js'
import { assertClean } from './sensitive.js'
import { normUin } from './allowlist.js'
import { noteReply } from './window.js'
import { noteSent, tagForSession } from './focus.js'
import { noticeKindOf, notifyEntryOnce } from './notice.js'

/**
 * 等满 TTL 但 agent 仍在跑时，最多保留条目几次（每保留一次发一条「还在处理」）。
 *
 * 为 0 就等于退回到「到点就丢」的老行为。默认 2：5 分钟 TTL × 3 轮 ≈
 * 一个真正长任务的上限；再长就不是「慢」，而是卡死了。
 * 两个 TTL 都还等不到 turn/end 把队列堵着，才是更严重的故障。
 */
const TTL_STALL_KEEP_MAX = 2

/**
 * 宿主 agent 现在还在跑吗。
 *
 * 为什么用它而不是「等不到 turn/end 就当失败」：
 *   一个回合完全可以跑好几分钟（她一个回合里要 qq_wait、查历史、分条发好几条）。
 *   TTL 到点时「没等到 turn/end」既可能是**长任务还没完**，也可能是**回合丢了**，
 *   两者的补救方式完全相反（前者继续等，后者赶紧告诉对方重发）。
 *
 * ⚠️ 拿不到 status（老宿主 / 被测试替掉的对象）时**按「不在跑」处理**：
 *   宁可发一条「没能发出来」，也不要让条目卡在队头把整个会话的转发堵死。
 */
function agentIsRunning(agent) {
  try {
    return String(agent?.status ?? '') === 'running'
  } catch {
    return false
  }
}

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
    proactive: options?.proactive === true,
    // 自动转发时要引用哪一条（0.13.0）。空串 = 不带引用。
    replyTo: String(options?.replyTo ?? '').trim(),
    // 自动转发时要 @ 谁（0.14.0）。空串 = 不带 @。只有群聊会用上。
    atUin: String(options?.atUin ?? '').trim(),
    atRateKey: options?.atRateKey === undefined ? undefined : String(options.atRateKey)
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

// ---- 跨调用节流（0.19.4）----
//
// 为什么要它：分条间隔原来只在 sendToQQ 的分条循环里 sleep，而且条件写着 i > 0 ——
// 也就是说**只有「一次调用拆成 N 条」才有停顿**。而最常见的连发现场恰恰相反：
// 模型连着调 N 次 qq_send、每次只给一行（每次调用 markedParts.length === 1），
// 循环一次都不进 i > 0 分支，间隔等于完全没生效。
// 实测：一次调用拆 6 条 → 间隔 473/485/513/448/453 ms；三次独立调用 → gap 0ms。
//
// 所以把「停顿」从循环里挪到这里：按目标记下上一条真正发出去的时刻，
// 下一次发送前把不足的间隔补上。这样无论「一次拆 N 条」还是「N 次各一条」，
// 节奏都由同一个地方决定（单一事实来源，不会两处各算一遍）。
const lastSendAt = new Map()
// 同一个目标串行化：模型一次吐多个 qq_send（同一步里的并发工具调用）时，
// 两路会同时读到同一个 lastSendAt、同时补等同样的时间，然后**同时**发出去 ——
// 节流等于没做。所以按目标串成一条链，后一条等前一条真的发完再算间隔。
const sendChains = new Map()

/** 节流按目标分开算：私聊按对方的号、群聊按群号，两个人同时聊不会互相拖。 */
export function throttleKeyOf(target) {
  return `${target?.kind === 'group' ? 'group' : 'private'}:${String(target?.id ?? '')}`
}

/** 把同一个目标的发送排成队，前一个结束（成功或失败）才开始算下一个的间隔。 */
export async function withSendLock(key, fn) {
  const previous = sendChains.get(key) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  // 链尾只保存「已经落地」的 Promise，且吞掉错误 —— 否则前面一次失败会让后面全短路。
  const tail = run.then(() => {}, () => {})
  sendChains.set(key, tail)
  // 排空后自己摘掉（0.19.5 审核）：不摘的话每个 target 永久留一条链，
  // 闭包还攥着最后一次的 segments/payload —— 长跑进程里就是只增不减。
  // 判 `=== tail` 是为了不误删「这期间已经有新的一条接上去了」的情况。
  tail.then(() => {
    if (sendChains.get(key) === tail) sendChains.delete(key)
  })
  return run
}

/** 清空节流状态（测试用：每个用例都从「没发过」开始）。 */
export function resetSendThrottle() {
  lastSendAt.clear()
  sendChains.clear()
}

/** 这条消息的正文长度（「按字数」模式要拿它算间隔）。 */
function textLengthOf(message) {
  if (!Array.isArray(message)) return String(message ?? '').length
  return message.reduce(
    (sum, seg) => sum + (seg?.type === 'text' ? String(seg?.data?.text ?? '').length : 0),
    0
  )
}

/**
 * 保证同一个目标的相邻两条之间至少隔开配置里的间隔。
 *
 * 每次真的补等了 / 或者间隔明显不够，都记一行日志 —— 这是「间隔到底生效没有」
 * 唯一能在现场取到的证据（用户把日志导出来就能看到每条之间的真实毫秒数）。
 */
async function waitForGap(target, message) {
  return waitForGapFor(target, textLengthOf(message))
}

/**
 * 同上，但字数由调用方给 —— 收藏表情走的是独立 action（`send_custom_face`），
 * 手上没有段数组，按 0 字算（它本来就是「跟着文字后面的一条」，不该按字数再拉长）。
 *
 * 导出给 custom-faces.js 用：0.19.4 把停顿下沉到 `sendOneToQQ` 之后，收藏表情那条
 * 独立 action 成了漏网的口子（文字发完 0ms 就跟一条表情）。
 */
export async function waitForGapFor(target, charCount) {
  const key = throttleKeyOf(target)
  const previous = lastSendAt.get(key)
  if (previous === undefined) return
  const config = getConfig()
  const targetMs = partDelayMs('', {
    // 两种模式二选一：fixed = 每条等固定时间，perChar = 按字数算
    mode: String(config.splitDelayMode ?? 'fixed') === 'perChar' ? 'perChar' : 'fixed',
    // 注意这里不能写 Number(...) || 800：0 是合法的「立刻发」，被 || 吃掉就永远等 800ms。
    fixedMs: Number(config.splitDelayMs ?? 800),
    perCharMs: Number(config.splitDelayPerCharMs) || 120,
    // 上限由配置给；partDelayMs 自己不封顶，否则「按字数」在长回复上就失效了。
    maxMs: Number(config.splitDelayMaxCapMs) || 0,
    // 这边手上是段数组，没有拼好的正文 —— 直接把字数交给 partDelayMs。
    charCount: Number.isFinite(charCount) && charCount > 0 ? charCount : 0
  })
  const gap = Date.now() - previous
  const waitMs = targetMs - gap
  if (waitMs > 0) await sleep(waitMs)
  note('out', waitMs > 0
    ? `两条之间只隔 ${gap}ms，补等 ${waitMs}ms（目标 ${targetMs}ms）`
    : `两条之间隔了 ${gap}ms（目标 ${targetMs}ms，够了）`)
}

/** 记下「这个目标刚刚真的发出去一条」（收藏表情那条独立 action 也要记）。 */
export function markSent(target) {
  lastSendAt.set(throttleKeyOf(target), Date.now())
}

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
  // 停顿在这里统一算：这是**唯一**的单条出口，所以「一次拆 N 条」和「N 次各一条」
  // 走的是同一条规则，不会两处各算一遍。
  //
  // 整段包进 withSendLock：同一步里并发来两个 qq_send 时，两路会同时读到同一个
  // lastSendAt、同时补等、然后同时发出 —— 那样节流就白做了（实测 gap 0ms）。
  return withSendLock(throttleKeyOf(target), async () => {
    await waitForGap(target, segments)
    const result = await callOneBot(payload)
    if (result.retcode !== 0) throw new Error(`retcode=${result.retcode} ${result.message ?? ''}`)
    // 只记「真的发成功」的时刻：发失败的那一次不该把下一条往后推。
    lastSendAt.set(throttleKeyOf(target), Date.now())
    return result
  })
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
const AT_RATE_WINDOW_MS = 30000
const AT_RATE_MAX = 2
const atRate = new Map()

function allowAtTarget(groupId, uin) {
  const key = `${String(groupId)}:${String(uin)}`
  const now = Date.now()
  const previous = atRate.get(key)
  if (previous === undefined || now - previous.startedAt >= AT_RATE_WINDOW_MS) {
    atRate.set(key, { startedAt: now, count: 1 })
    return true
  }
  if (previous.count >= AT_RATE_MAX) {
    note('out', `群 ${groupId} 对 ${uin} 的 @ 已限频（${AT_RATE_MAX}/${AT_RATE_WINDOW_MS}ms），本条去掉 @`)
    return false
  }
  previous.count += 1
  return true
}

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
  /** 收藏表情发送失败的原因（空 = 没失败）。见下面「发失败时的裁决」。 */
  let customFaceError = ''
  const sentMessageIds = []
  const rememberResult = (value) => {
    const id = String(value?.data?.message_id ?? '').trim()
    if (/^-?\d+$/.test(id) && id !== '0' && id !== '-0' && !sentMessageIds.includes(id)) sentMessageIds.push(id)
  }
  // 引用段（0.13.0）：只挂在**第一条**消息上。
  // QQ 的 reply 是「逐条消息」的属性，不是批次属性 —— 而这一批回复是同一个回合对
  // 同一句话的回答，所以只在第一条上引用一次，后几条是裸消息（跟 QQ 客户端原生行为一致）。
  // replyId 为 '' 时整批都不带引用。
  // reply_to 只接受 OneBot message_id 的纯整数形状，垃圾值不应触发协议端报错和无意义降级。
  const rawReply = String(options?.replyTo ?? '').trim()
  const replyId = /^-?\d+$/.test(rawReply) && rawReply !== '-0' ? rawReply : ''
  if (rawReply !== '' && replyId === '') note('out', `引用参数不是消息编号（${rawReply}），已忽略`)
  // @ 段（0.14.0）：同样只挂在第一条上。
  // 分条发送时后面几条不带 @ —— 否则同一个人被连点 N 次，群里看到就是刷屏。
  // atUin 为 '' 时整批都不带 @。
  //
  // ⚠️ @ 是个「点名」动作：被 @ 的人会收到提醒。所以：
  //   · 只在群聊里用（私聊没有 @ 的概念，硬塞一个 at 段会被协议端忽略或报错）；
  //   · 目标必须过白名单（见 allowlist.js），不能由模型随便填一个号去点人。
  // ⚠️ @ 是个「点名」动作：被 @ 的人会收到提醒。所以：
  //   · 只在群聊里用（私聊没有 @ 的概念，硬塞一个 at 段会被协议端忽略或报错）；
  //   · 号码必须合法（下面用 normUin 归一，垃圾值直接当没填）；
  //   · 不 @ 自己 —— 那是无意义动作，而且容易写错成「@ 机器人自己」。
  //
  // 为什么不再单独做一份「@ 白名单」：这条消息本来就只能发到已放行的群，
  // 群里所有人都看得见它；@ 只是多一次提醒，不构成新的越权面。
  // 真正的越权面在「发给谁」，那一道由 allowlist 管着。
  const rawAt = String(options?.atUin ?? '').trim()
  const atUin = target?.kind === 'group' ? normUin(rawAt) : ''
  if (rawAt.toLowerCase() === 'all') note('out', '@all 被拒绝，避免无差别打扰全群')
  if (target?.kind !== 'group' && rawAt !== '') {
    note('out', `私聊不收 @ 参数（${rawAt}），已忽略`)
  }
  if (atUin !== '' && atUin === normUin(config.selfUin)) {
    note('out', `不 @ 自己（${atUin}），已忽略`)
  }
  const atTarget = atUin !== '' && atUin !== normUin(config.selfUin) && rawAt.toLowerCase() !== 'all'
    && (target?.kind !== 'group' || options?.atRateKey === undefined || allowAtTarget(target.id, atUin))
    ? atUin
    : ''
  for (let i = 0; i < markedParts.length; i += 1) {
    const current = markedParts[i]
    // 每条分段独立结算结果，不能复用上一条已发送的 result。
    result = null
    // 停顿不在这里 sleep —— 已挪进 sendOneToQQ 的 waitForGap（0.19.4）。
    // 原来这里写的是 if (i > 0) await sleep(partDelayMs(...))，只覆盖「一次调用拆 N 条」；
    // 模型连调 N 次 qq_send（每次一条）时永远不满足 i > 0，所以间隔看起来没生效。
    // 现在按目标记「上一条发出去的时刻」，两种调用方式走同一条规则。
    // 空文本段不塞进去（有些协议端对空 text 段不友好），只发它的表情
    const segments = []
    // 段顺序（实测 SnowLuma 2.2.1 接受并原样保留）：reply → at → text
    //   引用段排第一，协议端才认得出「在回谁」；
    //   at 段紧跟其后、正文之前 —— 跟 QQ 客户端自己的排列一致。
    if (i === 0 && replyId !== '') segments.push({ type: 'reply', data: { id: replyId } })
    if (i === 0 && atTarget !== '') segments.push({ type: 'at', data: { qq: atTarget } })
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
    //
    // 引用段同理（0.13.0）：引用的那条可能已被撤回 / 跨会话 / 协议端不认，
    // 一旦它让整条消息失败，回复就凭空消失了 —— 比「没带上引用」严重得多。
    // 所以失败后按「去引用 → 去表情」逐级降级，每一级都记日志。
    //
    // @ 段（0.14.0）也纳入同一条降级链：@ 一个退群/不存在的号同样可能让整条失败。
    // 降级顺序按「装饰性从强到弱」：先丢 @（最容易被退群号搞挂），再丢引用，最后丢表情。
    const hasFace = segments.some((item) => item.type === 'face')
    const hasReply = segments.some((item) => item.type === 'reply')
    const hasAt = segments.some((item) => item.type === 'at')
    if (hasFace || hasReply || hasAt) {
      try {
        result = await sendOneToQQ(target, segments)
        rememberResult(result)
      } catch (error) {
        const reason = error instanceof Error ? error.message : error
        // 逐级剥离：每一级只去掉**一种**装饰段，再试一次。
        // ⚠️ 判断条件必须看**原始 segments**，不能看已剥过的 retrySegments ——
        //   踩过：写成串行的 if 改成「剥完 @ 再判断引用」，导致 @ 和引用在同一次
        //   重试里被一起去掉。那样就永远试不出「到底是哪一种段把消息搞挂的」，
        //   也白白丢了本来能用的引用。
        const drop = []
        if (hasAt) drop.push('at')
        if (hasReply) drop.push('reply')
        if (hasFace) drop.push('face')
        let dropped = []
        let sent = false
        for (const kind of drop) {
          dropped = [...dropped, kind]
          const retrySegments = segments.filter((item) => !dropped.includes(item.type))
          note('out', `${dropped.map((k) => (k === 'at' ? '@' : k === 'reply' ? '引用' : '表情')).join(' + ')} 发送失败（${reason}），去掉它们重发`)
          if (!retrySegments.some((item) => item.type === 'text')) {
            note('out', '这条去掉装饰段后没有正文了，已放弃')
            break
          }
          try {
            result = await sendOneToQQ(target, retrySegments)
            rememberResult(result)
            sent = true
            break
          } catch (nextError) {
            if (dropped.length === drop.length) {
              note('out', `去掉全部装饰段后仍然失败：${nextError instanceof Error ? nextError.message : nextError}`)
            }
          }
        }
        if (!sent) {
          const detail = `这条发不出去（已尝试逐级降级）：${reason}`
          note('out', detail)
          throw new Error(detail)
        }
      }
    } else {
      result = await sendOneToQQ(target, segments)
    }
  }

  // 收藏表情：协议端只能单独发一条，跟在文本后面
  if (customEmojiId !== '') {
    const { sendCustomFace } = await import('./custom-faces.js')
    // ⚠️ 这里**必须**兜住失败（0.16.16，审核发现）：
    //   文字在上面已经发出去了，如果表情这一步抛出去，
    //   整个 qq_send 会被判成失败 —— 模型以为没发出去，可能重发一遍，
    //   用户就收到两遍同样的话。这跟 0.16.14「表情失败不连累文字」是同一个道理，
    //   只是那条修在「找不到表情」，这条修在「找到了但发不出去」。
    //
    //   例外：如果这次**只有**表情、没有文字，那表情发不出去就是真的什么都没发，
    //   必须抛错（静默成功会让模型以为发出去了）。这个判断放在下面那段之后做。
    try {
      result = await sendCustomFace(target, customEmojiId)
      rememberResult(result)
    } catch (error) {
      customFaceError = error instanceof Error ? error.message : String(error)
    }
  }

  // 只有表情没有文本的情况
  if (markedParts.length === 0 && toolFaceSegment !== null) {
    // 同样兜底：表情发不出去就整条放弃，但别抛错炸掉整个转发循环
    try {
      result = await sendOneToQQ(target, [toolFaceSegment])
      rememberResult(result)
    } catch (error) {
      const detail = `纯表情发送失败：${error instanceof Error ? error.message : error}`
      note('out', detail)
      throw new Error(detail)
    }
  }

  // 收藏表情发失败时的裁决（见上面那段 try/catch）：
  //   · 还有别的消息发出去了（文字 / 经典表情）→ 只记日志，不算这次发送失败；
  //   · 什么都没有 → 真的没发出去，必须抛错（否则模型以为成功了）。
  if (customFaceError !== '') {
    const deliveredSomething = sentMessageIds.length > 0 || markedParts.length > 0 || toolFaceSegment !== null
    if (!deliveredSomething) {
      throw new Error(customFaceError)
    }
    note('out', `收藏表情没发出去（${customFaceError}），但文字已发出，按部分成功处理`)
  }

  const output = result ?? {}
  output.data = { ...(output.data ?? {}), message_ids: sentMessageIds }
  return output
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
        let dequeued = false
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
            // ---- 等满 TTL 仍没有 turn/end（2026-11-03 用户要求）----
            // 以前这里只记一条日志就 shift 丢弃 —— QQ 那头**一个字都没有**。
            // 线上日志里这一条出现 10 次、真丢弃 1 次，而 'error' 那条分支 0 次：
            // 「迟迟收不到相应」绝大多数是**这条**路径，不是模型报错。
            //
            // 但要分开两种完全不同的处境，不能一律播报成「出错了」：
            //   · agent 还在跑（status === 'running'）→ 长任务，回合本来就没结束，
            //     turn/end 只是还没来。说一句「还在处理」让对方别干等，然后**保留条目**
            //     继续等 —— 真结束了还能照常把回复转发出去。
            //   · agent 已经不跑了 → 这一回合真丢了（进程崩过 / 被中断且没补收尾）。
            //     丢条目 + 明说「没能发出来，可以再发一条」。
            //
            // ⚠️ 「保留条目」必须配一个硬上限，否则一个永久 running 的僵尸 agent
            //    会让这个条目永生、把后面所有转发全堵死（这正是 TTL 当初要解决的问题）。
            //    所以：保留次数最多 TTL_STALL_KEEP_MAX 次，之后照旧丢弃。
            const alive = agentIsRunning(entry.agent)
            if (alive && (Number(entry.ttlKeeps) || 0) < TTL_STALL_KEEP_MAX) {
              entry.ttlKeeps = (Number(entry.ttlKeeps) || 0) + 1
              await notifyEntryOnce(entry, 'stalled', `已等 ${Math.round(waited / 1000)}s，agent 仍在跑`)
              note(
                'out',
                `队列条目已等 ${Math.round(waited / 1000)}s 无 turn/end，但 agent 仍在跑（已保留 ${entry.ttlKeeps}/${TTL_STALL_KEEP_MAX} 次），继续等回复`
              )
              break
            }
            if (alive) {
              note('out', `队列条目已保留 ${entry.ttlKeeps} 次仍无 turn/end，按丢失处理并丢弃`)
            }
            await notifyEntryOnce(
              entry,
              'lost',
              alive ? 'agent 仍在跑但已超过保留上限' : `已等 ${Math.round(waited / 1000)}s，agent 不在运行`
            )
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

          // ---- 一次性标志：在这里**立刻**消费掉，存成本地布尔（0.16.16 审核发现）----
          // 为什么不能在各分支里按需查：
          //   下面有六七条提前 `continue` 的路径（qq_send 已发过、空文本、TTL 丢弃、
          //   sentTurns 去重、异常 break…）。只要有一条没消费，标志就留到**下一回合**，
          //   把下一回合正常该发的话吞掉 —— 用户看到的是「她突然不回话了」，
          //   日志里只有一行「本回合 qq_skip」，根本联想不到上一回合。
          //   一处一处补是补不完的，所以入口处统一消费一次。
          const turnKey = targetKey(entry.target)
          const skippedTurn = skipTurnRequested(turnKey)
          const closeRefused = closeRefusedThisTurn(turnKey)

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
            // ---- 回合以故障收尾 → 替她告诉对面一声（2026-11-03）----
            // 以前这里只有 note() 一行日志，QQ 那头一片安静：
            // 对面以为被无视，用户报的就是「迟迟收不到相应」。
            // noticeKindOf 只认 'error' / 'interrupted'，
            // 'aborted'（用户自己点停止）与 'disposed'（DSH 卸载）一律静默 —— 那不是故障。
            const noticeKind = noticeKindOf(reason)
            if (noticeKind !== '') {
              await notifyEntryOnce(entry, noticeKind, String(reason?.error?.message ?? reason?.kind ?? ''))
            }
            if (reason?.kind === 'error') note('out', `回合失败，不转发：${reason?.error?.message ?? '未知错误'}`)
            // 标志已在上面统一消费过了，这里只留日志（空文本本来就什么都不发，正是 qq_skip 要的效果）
            if (skippedTurn) note('out', '本回合 qq_skip（且正文为空），照常不转发')
            if (closeRefused) note('out', '本回合 qq_close 被拒（且正文为空），照常不转发')
            markSentTurn(sessionId, endSeq)
            queue.shift()
            continue
          }
          // ---- 「这条不该有回复」（qq_skip，0.16.16）----
          // ⚠️ 必须排在 qq_pass **之前**，而且**不看正文内容**：
          //   qq_pass 的规矩是「正文写了真话就照发」，而 qq_skip 的重点恰恰是
          //   「她写的那段是解释自己为什么不说」—— 那正是要拦的东西。
          //   用户实测：她判断出不用回，却因为没有无副作用的出口而写了一句判断，
          //   自动转发把它发出去，聊天被强行续命（对端是 AI 时会一直互相续）。
          //
          // 只压「自动转发正文」这一条路；她已经用 qq_send 发出去的话不受影响
          //（上面那条 sendCalls 分支已经把那种回合提前结账了）。
          const skipKey = turnKey
          if (skippedTurn) {
            note('out', `本回合 qq_skip：不转发正文（${text.length} 字）key=${skipKey}`)
            queue.shift()
            markSentTurn(sessionId, endSeq)
            continue
          }

          // ---- qq_close 被拒的回合：正文一律不转发（0.16.15）----
          // 为什么单独一条、而且要拦在 qq_pass 之前：
          //   qq_close 返回 ok:false 时，模型处在「判断模式」——
          //   它这一回合写出来的东西大概率是元话语（「对方还在问，我是不是该……」），
          //   也就是用户看到的「把该不该结束的纠结念出来了」。
          //   用户实测里对方是 AI 时会顺着这段元讨论继续回，两边都不肯先停。
          //
          // ⚠️ 这条只拦「本回合调用过 qq_close 且被拒」这一种组合 ——
          //   别扩大成「调过 qq_close 就拦」，那会吞掉用户真正需要的话。
          //   qq_pass 的既有语义（正文写了真话照发）一个字都没动。
          const closeRefusedKey = turnKey
          if (closeRefused) {
            note('out', `本回合 qq_close 被拒，正文按元话语处理不转发（${text.length} 字）key=${closeRefusedKey}`)
            queue.shift()
            markSentTurn(sessionId, endSeq)
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
            note('out', `主动搭话回合只回了动作描写（${text.length} 字），按沉默处理不转发`)
            queue.shift()
            markSentTurn(sessionId, endSeq)
            continue
          }

          // 先出队再发送：发送中途出错时宁可丢这一条（日志里有），也不能让下一轮重发一遍
          queue.shift()
          dequeued = true
          markSentTurn(sessionId, endSeq)
          // ---- 出站标签（2026-11-05 修正方向）----
          // 标签必须加在**出站**（她发给用户的话），不是入站。
          //   用户需要知道「这句是哪个会话说的」；给他自己发进来的话加前缀毫无用处，
          //   反而让他看到自己的话被改写。初版把 tagFor 挂在了 poll.js 的入站路径上，
          //   线上实测「发出去的消息没有标签」才发现方向错了。
          // 只在「当前会话 ≠ 该 QQ 号的默认绑定会话」时加 —— 日常单会话一个字都不会多。
          const markedTag = tagForSession(sessionId, entry.target)
          const outText = markedTag === '' ? text : `${markedTag}${text}`
          const sent = await sendToQQ(entry.target, outText, { replyTo: entry.replyTo, atUin: entry.atUin, atRateKey: entry.atRateKey })
          const sentId = String(sent?.data?.message_id ?? '').trim()
          if (entry.target?.kind === 'group' && /^-?\d+$/.test(sentId) && sentId !== '0' && sentId !== '-0') {
            // 同上的空数组问题：单条发送时 message_ids 是 []，必须退回 sentId
            const replyIds = Array.isArray(sent?.data?.message_ids) && sent.data.message_ids.length > 0
              ? sent.data.message_ids
              : sentId
            noteReply(String(entry.target.id), replyIds)
          }
          // ---- 记下「这条是我发的、属于哪个会话」（2026-11-05）----
          // 这是「引用即路由」的全部依据：用户长按回复某条消息时，
          // 插件靠这个索引知道那条消息是哪个会话说的，从而把话投回去。
          // 群聊也记（v1 群聊不接焦点路由，但索引本身无害，将来要用）。
          //
          // ⚠️ 取 ids 必须**排除空数组**（2026-11-05 实测踩到）：
          //   sendToQQ 末尾无条件写 `data.message_ids = sentMessageIds`，
          //   而它只在分条发送时才有内容 —— 单条发送时是**空数组**。
          //   `Array.isArray(ids) ? ids : sentId` 会拿到 []，一个 id 都没有，
          //   索引静默记不上，引用路由整条断掉（tool.js 里同一处也踩了，一起修）。
          const sentIds = Array.isArray(sent?.data?.message_ids) && sent.data.message_ids.length > 0
            ? sent.data.message_ids
            : sentId
          if (/^-?\d+$/.test(sentId) && sentId !== '0' && sentId !== '-0') {
            noteSent(sessionId, targetKey(entry.target), sentIds)
          }
          note('out', `已转发回复 ${text.length} 字 -> ${entry.target?.kind ?? '?'}`)
        } catch (error) {
          note('out', `转发失败：${error instanceof Error ? error.message : error}`)
          if (!dequeued) queue.shift() // 未提前出队的失败条目也要消化，避免堵住后续转发
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
