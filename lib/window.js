/**
 * window.js —— 群聊 @ 唤醒后的连续对话窗口。
 *
 * 这个模块只负责窗口状态、预算和攒批，不依赖 poll/deliver，避免入站
 * 路由和窗口巡检互相 import 形成循环。调用方把原始 OneBot 消息放进
 * queueWindowMessage()，再通过 startWindowLoop(ctx, handler) 注册批处理器。
 */
import { getConfig } from './config.js'
import { note } from './env.js'
import { getState, saveState } from './state.js'
import { isAtMe, replyTargetOf } from './onebot.js'

export const WINDOW_BATCH_MS = 8000
export const WINDOW_BATCH_MAX = 3
export const WINDOW_MAX_PASSES = 2
export const WINDOW_AT_REPLIES = 2
export const WINDOW_SELF_MESSAGE_LIMIT = 20

/**
 * 开窗 @ 的门控最长存活时间。
 *
 * 门控的作用是「续聊批次必须排在开窗 @ 后面」，但它没有永久的合理性：
 * 那条 @ 有可能永远不来了（游标被跳过、配置改成不 @ 也回、消息滚出 10 条历史窗口）。
 * 而窗口内每来一条续聊都会 touchWindow 续期空闲计时 —— 只靠 windowIdleMs 关不掉，
 * 门控不设上限就等于让这个群永久攒批、永远不投。
 *
 * 90 秒 = 两次最慢轮询（wsFallbackPollMs 默认 30 秒）＋ 余量，
 * 够失败重试一次；超时就当这条 @ 不会再来了，直接放行批次（额度不退，见 releaseOpeningHold）。
 */
export const OPENING_HOLD_TTL_MS = 90000

/** 无 id 的触发消息用的是进程内临时门控号（跨重启不需要稳定）。 */
let openingSeq = 0

const DEFAULT_WATER_WINDOWS = ['12:00-14:00', '18:00-09:00']
const LOOP_MS = 1000

/** group id -> raw messages that have not reached the model yet. */
const pending = new Map()
/** group id -> the time the current pending batch started. */
const pendingSince = new Map()
/** groups whose batch handler is currently running. */
const flushing = new Set()
/** group id -> the triggering @ message that must reach the model before batches can flush. */
const batchHolds = new Map()
/** group id -> the in-flight opening charge, so a failed @ refunds exactly once. */
const openingReservations = new Map()
/** 没有 seq、也没有 message_id 的消息，只能靠对象身份拿一个进程内稳定的门控号。 */
const openingIds = new WeakMap()
const pendingRetry = new Map()
const WINDOW_RETRY_BASE_MS = 1000
const WINDOW_RETRY_MAX_MS = 60000
let batchHandler = null
let loopStop = null
let hydratedPending = false

function groupKey(groupId) {
  const key = String(groupId ?? '').trim()
  return key
}

function nowMs() {
  return Date.now()
}

function dayKey(at = nowMs()) {
  const date = new Date(Number(at))
  if (!Number.isFinite(date.getTime())) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function activeOf(win) {
  if (win === null || typeof win !== 'object' || String(win.triggerUin ?? '') === '') return false
  if (win.active === true) return Number.isFinite(Number(win.openedAt))
  return win.active !== false && Number(win.openedAt) > 0
}

function ensureWindows() {
  const state = getState()
  if (state.windows === null || typeof state.windows !== 'object' || Array.isArray(state.windows)) {
    state.windows = {}
  }
  return state.windows
}

function ensureWindowRecord(groupId) {
  const key = groupKey(groupId)
  if (key === '') return null
  const windows = ensureWindows()
  const existing = windows[key]
  if (existing !== null && typeof existing === 'object' && !Array.isArray(existing)) return existing
  const record = {
    active: false,
    openedAt: 0,
    lastActivityAt: 0,
    triggerUin: '',
    repliesInWindow: 0,
    passStreak: 0,
    lastWindowSeq: 0,
    selfMessageIds: [],
    dayKey: dayKey(),
    openedToday: 0,
    peersToday: {}
  }
  windows[key] = record
  return record
}

function normalizeRecord(win) {
  if (win === null || typeof win !== 'object' || Array.isArray(win)) return null
  if (!Array.isArray(win.selfMessageIds)) win.selfMessageIds = []
  win.selfMessageIds = win.selfMessageIds.map((id) => String(id ?? '').trim()).filter(Boolean).slice(-WINDOW_SELF_MESSAGE_LIMIT)
  if (win.peersToday === null || typeof win.peersToday !== 'object' || Array.isArray(win.peersToday)) win.peersToday = {}
  if (!Number.isFinite(Number(win.openedToday)) || Number(win.openedToday) < 0) win.openedToday = 0
  if (!Number.isFinite(Number(win.repliesInWindow)) || Number(win.repliesInWindow) < 0) win.repliesInWindow = 0
  if (!Number.isFinite(Number(win.passStreak)) || Number(win.passStreak) < 0) win.passStreak = 0
  if (!Number.isFinite(Number(win.openedAt))) win.openedAt = 0
  if (!Number.isFinite(Number(win.lastActivityAt))) win.lastActivityAt = 0
  if (win.dayKey === undefined || String(win.dayKey) === '') win.dayKey = dayKey()
  return win
}

function saveWindows() {
  const state = getState()
  saveState({ windows: state.windows })
}

function clearPending(groupId) {
  const key = groupKey(groupId)
  pending.delete(key)
  pendingSince.delete(key)
  pendingRetry.delete(key)
  pendingRetry.delete(`${key}:attempts`)
}

function persistPending(key) {
  const win = normalizeRecord(ensureWindows()[key])
  if (win === null || !activeOf(win)) return
  const messages = pending.get(key) ?? []
  if (messages.length === 0) {
    delete win.pending
    delete win.pendingSince
  } else {
    win.pending = messages.slice()
    win.pendingSince = Number(pendingSince.get(key)) || nowMs()
  }
  saveWindows()
}

function seqOf(message) {
  const value = Number(message?.message_seq)
  return Number.isFinite(value) ? value : null
}

function idOf(message) {
  const id = String(message?.message_id ?? '').trim()
  if (id !== '' && id !== '0') return `id:${id}`
  const seq = seqOf(message)
  if (seq !== null) return `seq:${seq}`
  return ''
}

/**
 * Return the currently active window. Closed records remain in state so the
 * daily counters survive close; callers never need to know about that detail.
 */
export function windowOf(groupId) {
  const key = groupKey(groupId)
  if (key === '') return null
  const win = normalizeRecord(ensureWindows()[key])
  return activeOf(win) ? win : null
}

/**
 * Whether a local clock instant falls inside one of the configured water
 * windows. A range crossing midnight (e.g. 18:00-09:00) is supported.
 */
export function isWithinWaterWindows(at = new Date(), windows = getConfig()?.waterWindows) {
  const date = at instanceof Date ? at : new Date(Number(at))
  if (!Number.isFinite(date.getTime())) return false
  const list = Array.isArray(windows) ? windows : DEFAULT_WATER_WINDOWS
  if (list.length === 0) return false
  const current = date.getHours() * 60 + date.getMinutes()
  for (const item of list) {
    const raw = typeof item === 'string' ? item : `${item?.start ?? ''}-${item?.end ?? ''}`
    const match = String(raw).match(/^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/)
    if (match === null) continue
    const startHour = Number(match[1])
    const startMinute = Number(match[2])
    const endHour = Number(match[3])
    const endMinute = Number(match[4])
    if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) continue
    const start = startHour * 60 + startMinute
    const end = endHour * 60 + endMinute
    if (start <= end ? current >= start && current < end : current >= start || current < end) return true
  }
  return false
}

/** Alias with a concise name useful to poll/tests. */
export const inWaterWindow = isWithinWaterWindows

/**
 * Apply the three eligibility rules from the design: trigger author, @ this
 * bot, or a reply to a message sent by this bot during this window.
 */
export function isWindowEligible(win, message, config = getConfig()) {
  if (!activeOf(win) || message === null || typeof message !== 'object') return false
  const senderUin = String(message?.sender?.user_id ?? '').trim()
  const ownerUin = String(config?.ownerUin ?? config?.peerUin ?? '').trim()
  if (senderUin !== '' && (senderUin === String(win.triggerUin ?? '').trim() || senderUin === ownerUin)) return true
  if (isAtMe(message.message, config?.selfUin)) return true
  const target = replyTargetOf(message.message)
  if (target === null || !Array.isArray(win.selfMessageIds)) return false
  const wanted = String(target.id ?? '').trim()
  return wanted !== '' && win.selfMessageIds.some((id) => String(id) === wanted)
}

/** Compute the automatic @ target for a reply in an active window. */
export function atUinForWindow(win, senderUin, selfUin) {
  if (!activeOf(win)) return ''
  const sender = String(senderUin ?? '').trim()
  if (Number(win.repliesInWindow) < WINDOW_AT_REPLIES && sender !== '' && sender !== String(selfUin ?? '')) return sender
  return ''
}

/**
 * Open a window after an @ message has been accepted by the normal poll path.
 * Returns false when disabled, outside water hours, or over either daily cap.
 * An already-open window is reused and does not consume another daily quota.
 */
export function openWindow(groupId, triggerUin) {
  const key = groupKey(groupId)
  const peer = String(triggerUin ?? '').trim()
  if (key === '' || peer === '') return false
  const config = getConfig()
  if (config?.windowEnabled === false) return false
  const windows = ensureWindows()
  const win = normalizeRecord(windows[key]) ?? ensureWindowRecord(key)
  const today = dayKey()
  let dayChanged = false
  if (String(win.dayKey) !== today) {
    win.dayKey = today
    win.openedToday = 0
    win.peersToday = {}
    dayChanged = true
  }
  if (activeOf(win)) {
    if (dayChanged) saveWindows()
    return true
  }
  if (!isWithinWaterWindows(new Date(nowMs()), config?.waterWindows)) {
    note('window', `group ${key} outside active hours; not opened`)
    return false
  }
  const groupLimit = Number(config?.windowPerGroupDaily)
  const peerLimit = Number(config?.windowPerPeerDaily)
  const openedToday = Math.max(0, Number(win.openedToday) || 0)
  const peerCount = Math.max(0, Number(win.peersToday?.[peer]) || 0)
  if (Number.isFinite(groupLimit) && groupLimit >= 0 && openedToday >= groupLimit) {
    note('window', `group ${key} daily budget exhausted (${openedToday}/${groupLimit})`)
    saveWindows()
    return false
  }
  if (Number.isFinite(peerLimit) && peerLimit >= 0 && peerCount >= peerLimit) {
    note('window', `group ${key} peer ${peer} daily budget exhausted (${peerCount}/${peerLimit})`)
    saveWindows()
    return false
  }
  const now = nowMs()
  windows[key] = {
    ...win,
    active: true,
    openedAt: now,
    lastActivityAt: now,
    triggerUin: peer,
    repliesInWindow: 0,
    passStreak: 0,
    lastWindowSeq: 0,
    selfMessageIds: [],
    dayKey: today,
    openedToday: openedToday + 1,
    peersToday: { ...(win.peersToday ?? {}), [peer]: peerCount + 1 }
  }
  // 新窗口绝不能继承上一个窗口没结算完的开窗预约（`...win` 会把它带过来，
  // 那条 @ 属于上一窗，留着会让新窗口的批次一开始就被挡）。
  clearPersistedOpening(windows[key])
  clearPending(key)
  saveWindows()
  note('window', `opened group=${key} trigger=${peer}`)
  return true
}

/** Mark activity and advance the monotonic in-window sequence cursor. */
export function touchWindow(groupId, seq) {
  const key = groupKey(groupId)
  const win = windowOf(key)
  if (win === null) return false
  win.lastActivityAt = nowMs()
  const value = Number(seq)
  if (Number.isFinite(value) && value > Number(win.lastWindowSeq ?? 0)) win.lastWindowSeq = value
  saveWindows()
  return true
}

/** Close a window while retaining daily counters for future budget checks. */
export function closeWindow(groupId, reason = 'unknown') {
  const key = groupKey(groupId)
  const win = normalizeRecord(ensureWindows()[key])
  if (win === null) return false
  const wasActive = activeOf(win)
  clearPending(key)
  batchHolds.delete(key)
  openingReservations.delete(key)
  clearPersistedOpening(win)
  win.active = false
  win.openedAt = 0
  win.lastActivityAt = 0
  win.triggerUin = ''
  win.repliesInWindow = 0
  win.passStreak = 0
  win.lastWindowSeq = 0
  win.selfMessageIds = []
  saveWindows()
  if (wasActive) note('window', `closed group=${key} reason=${String(reason ?? 'unknown')}`)
  return wasActive
}

/** Note one model turn that produced at least one outgoing message. */
export function noteReply(groupId, messageId) {
  const key = groupKey(groupId)
  const win = windowOf(key)
  if (win === null) return false
  win.repliesInWindow = Math.max(0, Number(win.repliesInWindow) || 0) + 1
  win.passStreak = 0
  const ids = Array.isArray(messageId) ? messageId : [messageId]
  const cleanIds = ids.map((id) => String(id ?? '').trim()).filter((id) => /^-?\d+$/.test(id) && id !== '0' && id !== '-0')
  const stored = Array.isArray(win.selfMessageIds) ? win.selfMessageIds.map((value) => String(value)) : []
  for (const id of cleanIds) if (!stored.includes(id)) stored.push(id)
  win.selfMessageIds = stored.slice(-WINDOW_SELF_MESSAGE_LIMIT)
  saveWindows()
  const maxReplies = Number(getConfig()?.windowMaxReplies)
  if (Number.isFinite(maxReplies) && maxReplies >= 0 && maxReplies > 0 && win.repliesInWindow >= maxReplies) {
    closeWindow(key, 'max-replies')
  }
  return true
}

/** Note one qq_pass and close after two consecutive passes. */
export function notePass(groupId) {
  const key = groupKey(groupId)
  const win = windowOf(key)
  if (win === null) return false
  win.passStreak = Math.max(0, Number(win.passStreak) || 0) + 1
  saveWindows()
  if (win.passStreak >= WINDOW_MAX_PASSES) closeWindow(key, 'pass-streak')
  return true
}

/** Return a copy of pending raw OneBot messages for a window. */
export function windowMessages(groupId) {
  const key = groupKey(groupId)
  return (pending.get(key) ?? []).slice()
}

/**
 * Put one eligible raw OneBot message into the batch queue. Duplicates are
 * ignored by message_id (or message_seq when no message_id exists).
 */
export function queueWindowMessage(groupId, message) {
  const key = groupKey(groupId)
  const win = windowOf(key)
  if (key === '' || !activeOf(win) || message === null || typeof message !== 'object') return false
  const sequence = seqOf(message)
  if (sequence !== null && Number(win.lastWindowSeq ?? 0) > 0 && sequence <= Number(win.lastWindowSeq)) return false
  const list = pending.get(key) ?? []
  const identity = idOf(message)
  if (identity !== '' && list.some((item) => idOf(item) === identity)) return false
  list.push(message)
  pending.set(key, list)
  if (!pendingSince.has(key)) pendingSince.set(key, nowMs())
   persistPending(key)
  return true
}

/** Aliases make the enqueue operation discoverable to poll implementations. */
export const pushWindowMessage = queueWindowMessage
export const enqueueWindowMessage = queueWindowMessage

/**
 * Remove and return a snapshot. Call restoreWindowMessages on handler failure.
 *
 * ⚠️ **不要用它做批次投递**（审核发现）：它直接从 pending 取走，不经过 `shouldFlush`，
 *    于是会静默绕开开窗门控（`batchHolds`），顺序又反回去。
 *    `flushDue` 走的是 `windowMessages`（快照）+ 成功后按引用剔除那条路，那才是对的。
 *    目前全仓库无调用；留着是因为它是对外导出（换实现前先看这条注释）。
 */
export function takeWindowMessages(groupId, count = Infinity) {
  const key = groupKey(groupId)
  const list = pending.get(key) ?? []
  const n = Number.isFinite(Number(count)) ? Math.max(0, Math.floor(Number(count))) : list.length
  const taken = list.splice(0, n)
  if (list.length === 0) {
    pending.delete(key)
    pendingSince.delete(key)
  } else {
    pending.set(key, list)
  }
  return taken
}

/** Requeue messages at the front after a failed batch delivery. */
export function restoreWindowMessages(groupId, messages) {
  const key = groupKey(groupId)
  if (key === '' || !Array.isArray(messages) || messages.length === 0) return false
  const list = pending.get(key) ?? []
  const existing = new Set(list.map((item) => idOf(item)).filter(Boolean))
  const prefix = messages.filter((item) => {
    const identity = idOf(item)
    if (identity === '' || existing.has(identity)) return false
    if (identity !== '') existing.add(identity)
    return true
  })
  if (prefix.length === 0) return false
  pending.set(key, [...prefix, ...list])
   persistPending(key)
  if (!pendingSince.has(key)) pendingSince.set(key, nowMs())
  return true
}

/**
 * 一条 @ 消息的门控号。
 *
 * 必须是**同一条消息在两次调用里算出同一个值**：poll 侧开窗时算一次，
 * 投递成功/失败后结算时再算一次，两次对不上结算就静默失效（门控永不释放、
 * 额度永不退还）。所以三条路径都覆盖：
 *   1. 有 message_id → `id:<id>`（两条通路里都稳定，最可靠）；
 *   2. 没有 id 但有 seq → `seq:<n>`；
 *   3. 都没有 → WeakMap 按对象身份发号，同一对象两次调用拿到同一个号
 *      （跨重启接不回来，见 tmp: 分支的注释）。
 *
 * 注意 seq 判定不能写成 `seqOf(message) ?? messageIdOf(message)`（原实现就是错的）：
 * seqOf 只排除 undefined —— `message_seq: null` 会被 Number(null) 变成 0，
 * 于是算出 `seq:0` 这种看着合法、实则无意义的号（不同消息还会撞号）。
 * 所以这里自己判 `seq > 0`，不借道 seqOf。
 */
export function openingIdOf(message) {
  // 优先级：message_id 优先，seq 兜底。
  // 为什么不反过来（审核发现）：WS 的 normalizeEvent 只在事件带 message_seq 时才产出 seq，
  // 而 HTTP 历史必然带。若同一个 @ 第一次走 WS（得 id:…）、重试走 HTTP（得 seq:…），
  // 两次算出的号就对不上 —— 结算静默失效、门控白挡到 TTL。
  // message_id 在两条通路里都稳定存在，所以让它优先。
  const id = String(message?.message_id ?? '').trim()
  if (/^-?\d+$/.test(id) && id !== '0' && id !== '-0') return `id:${id}`
  const seq = Number(message?.message_seq)
  if (Number.isFinite(seq) && seq > 0) return `seq:${seq}`
  if (message !== null && typeof message === 'object') {
    const known = openingIds.get(message)
    if (known !== undefined) return known
    openingSeq += 1
    // ⚠️ 必须带进程身份：这个号会被落盘，重启后 adopt 会把它接回来。
    //   纯序号会在重启后从 1 重新数，于是和上一个进程留下的 `tmp:1` 撞车 ——
    //   轻则结算静默失败，重则误结算别人的预约（误释放门控 / 误退款）。
    const generated = `tmp:${process.pid}:${openingSeq}`
    openingIds.set(message, generated)
    return generated
  }
  return ''
}

/**
 * Hold queued batches until the matching opening @ message is delivered.
 *
 * 同时把「这次开窗已经计入日额度」记成一次预约。预约必须是**持久化 + 有截止时间**的：
 * 进程重启后 batchHolds 是空的（内存 Map 而已），而窗口和 pending 都会恢复 ——
 * 不把未结算的预约落盘，重启后 pending 会先于那条失败的 @ flush 出去，顺序又反了。
 *
 * @param {number} [at] 门控起始时刻，缺省取当前时间。只为测试能模拟「这条 @ 永远不来了」；
 *        生产路径永远不传。
 *
 * ⚠️ 预约是「一群一份」，后写者赢。实际能触发覆盖的只有一种罕见路径：
 *    窗口在第一条 @ 飞行途中被关掉、第二条 @ 又重新开窗（审核核实）。
 *    常态下第二条 @ 到达时窗口已经 active（openWindow 是同步执行的），
 *    走不到这里 —— 它 settle 时因 id 不匹配静默返回 false，这正是想要的：
 *    否则第二条 @ 成功会提前放掉第一条 @ 的门控，顺序又反了。
 *    后果有界（最多少退一次额度，门控由后一条负责释放），TTL 兜住最坏情况，
 *    所以不做多预约队列。
 */
export function holdWindowBatches(groupId, triggerId, at = nowMs()) {
  const key = groupKey(groupId)
  const id = String(triggerId ?? '').trim()
  const win = windowOf(key)
  if (key === '' || id === '' || win === null) return false
  const stamp = Number(at) > 0 ? Number(at) : nowMs()
  const reservation = {
    id,
    peer: String(win.triggerUin ?? ''),
    dayKey: String(win.dayKey ?? dayKey()),
    charged: true,
    at: stamp
  }
  batchHolds.set(key, { id, at: stamp })
  openingReservations.set(key, reservation)
  // 落盘（openWindow 已经写过一次 quota，这里补上「还欠一条 @」的事实）
  win.opening = reservation
  saveWindows()
  return true
}

/** 把预约从窗口记录里摘掉（结算完成 / 关窗 / 过期）。 */
function clearPersistedOpening(win) {
  if (win === null || typeof win !== 'object') return false
  if (win.opening === undefined) return false
  delete win.opening
  return true
}

/**
 * 退还一次开窗额度。
 *
 * 两条路径共用（失败重试 / 窗口在投递途中被关掉），所以抽出来一处，
 * 免得两边的跨日与钳位规则各写一遍、慢慢走样。
 *
 * 只退**同一自然日**内的账：跨日时 openWindow 已经把计数清零重来，
 * 再减一就减到昨天的头上（负数）。
 * `charged = false` 保证幂等 —— 重复调用不会退第二次。
 */
function refundOpening(win, reservation) {
  if (win === null || typeof win !== 'object' || reservation === null || typeof reservation !== 'object') return false
  if (reservation.charged !== true) return false
  if (String(win.dayKey) === String(reservation.dayKey)) {
    win.openedToday = Math.max(0, (Number(win.openedToday) || 0) - 1)
    const peer = String(reservation.peer ?? '')
    const peerLeft = Math.max(0, (Number(win.peersToday?.[peer]) || 0) - 1)
    if (peer === '') {
      // peer 为空的预约不该存在（openWindow 要求 peer !== ''），但盘上数据被改坏时要能兜住
    } else if (peerLeft === 0) {
      delete win.peersToday[peer]
    } else {
      win.peersToday[peer] = peerLeft
    }
  }
  reservation.charged = false
  return true
}

/**
 * Settle the opening quota transaction and release batches only after delivery.
 *
 * 结算有三种结局：
 *   · 成功 → 释放门控；若中途退过额度，这里重新计一次（跨日就按新的一天从 0 起算）；
 *   · 失败 → 退还额度但**保留门控**，等同一条 @ 重试成功再放行批次；
 *   · 窗口已不在 → 直接清门控（额度随之作废，见 closeWindow 保留计数的说明）。
 */
export function settleWindowOpening(groupId, triggerId, succeeded) {
  const key = groupKey(groupId)
  const id = String(triggerId ?? '').trim()
  const reservation = openingReservations.get(key)
  if (key === '' || id === '' || reservation?.id !== id) return false
  const win = windowOf(key)
  if (win === null) {
    openingReservations.delete(key)
    batchHolds.delete(key)
    // 窗口已经关掉（可能就在这次投递期间），盘上那条预约也得摘掉，否则下个窗口
    // 重启恢复时会把它当成「还欠一条 @」接回来，白挡一轮批次。
    const raw = normalizeRecord(ensureWindows()[key])
    if (raw !== null) {
      // 这次开窗没用上（窗口在 @ 投递期间被关掉：qq_close / 回复数到顶 / 并发 pass / 超时），
      // 所以要把那笔额度退回去 —— 否则就是「窗口没开成、额度也白扣」（审核发现）。
      if (reservation.charged) refundOpening(raw, reservation)
      clearPersistedOpening(raw)
      saveWindows()
    }
    return false
  }
  if (succeeded === true) {
    if (!reservation.charged) {
      const today = dayKey()
      if (String(win.dayKey) !== today) {
        win.dayKey = today
        win.openedToday = 0
        win.peersToday = {}
      }
      win.openedToday = Math.max(0, Number(win.openedToday) || 0) + 1
      win.peersToday[reservation.peer] = Math.max(0, Number(win.peersToday[reservation.peer]) || 0) + 1
    }
    openingReservations.delete(key)
    batchHolds.delete(key)
    clearPersistedOpening(win)
    // ⚠️ 必须落盘：退额度那次写了盘，如果成功结算不写，重启后读到的还是「已退款」，
    //   同一条 @ 会被重复退款/重复计数，日额度就慢慢漂了。
    saveWindows()
  } else if (reservation.charged) {
    refundOpening(win, reservation)
    // 门控留着，连同截止时间一起落盘：重启后照样挡住批次，直到重试成功或过期。
    win.opening = reservation
    saveWindows()
  }
  return true
}

/**
 * 启动时把上次进程遗留的开窗预约接回来。
 *
 * 不接的后果（审核发现）：进程在开窗 @ 失败后重启，pending 恢复了、窗口也还 active，
 * 但 batchHolds 空了 —— 续聊批次立刻 flush，「先批次后 @」的顺序问题原样复现。
 */
function adoptPersistedOpening(key, win) {
  const saved = win?.opening
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) return false
  const id = String(saved.id ?? '').trim()
  const at = Number(saved.at)
  if (id === '' || !Number.isFinite(at)) return false
  if (nowMs() - at >= OPENING_HOLD_TTL_MS) return false
  batchHolds.set(key, { id, at })
  openingReservations.set(key, {
    id,
    peer: String(saved.peer ?? ''),
    dayKey: String(saved.dayKey ?? dayKey()),
    charged: saved.charged !== false,
    at
  })
  return true
}

/**
 * Release an opening hold and drop its persisted record.
 * 到期只放行批次、**不**退额度：那条 @ 可能其实投递成功了（进程在 settle
 * 之前崩掉），退了就等于白送一次额度。宁可少退，也不要越用越宽松。
 */
function releaseOpeningHold(key) {
  batchHolds.delete(key)
  openingReservations.delete(key)
  const win = normalizeRecord(ensureWindows()[key])
  if (win !== null && clearPersistedOpening(win)) saveWindows()
}

/**
 * 开窗门控是否仍然有效；过期就地释放并返回 false。
 *
 * 门控有寿命：那条 @ 永远不来时不能把整个群永久锁在攒批状态（见 OPENING_HOLD_TTL_MS）。
 * 抽成一处是因为「循环到期 flush」和「@ 到达时的强制 flush」都要问同一句话 ——
 * 各写一遍迟早走样。
 */
function holdActive(key, now) {
  const hold = batchHolds.get(key)
  if (hold === undefined) return false
  if (now - Number(hold.at) < OPENING_HOLD_TTL_MS) return true
  releaseOpeningHold(key)
  note('window', `opening hold expired group=${key}; releasing batches`)
  return false
}

function shouldFlush(key, now) {
  if (holdActive(key, now)) return false
  const list = pending.get(key) ?? []
  if (list.length === 0) return false
  if (now < Number(pendingRetry.get(key) ?? 0)) return false
  if (list.length >= WINDOW_BATCH_MAX) return true
  return now - Number(pendingSince.get(key) ?? now) >= WINDOW_BATCH_MS
}

/** 投递成功后按引用剔除已投的那批；await 期间新到的留在队列里等下一轮。 */
function removeDelivered(key, batch) {
  const list = pending.get(key) ?? []
  const remaining = list.slice()
  for (const item of batch) {
    const index = remaining.indexOf(item)
    if (index >= 0) remaining.splice(index, 1)
  }
  if (remaining.length === 0) {
    pending.delete(key)
    pendingSince.delete(key)
    pendingRetry.delete(key)
    pendingRetry.delete(`${key}:attempts`)
  } else {
    pending.set(key, remaining)
    // 这批走了，剩下的是新攒的一批：跨度从这一刻重新算（与 flushDue 原实现一致）
    pendingSince.set(key, nowMs())
  }
  persistPending(key)
}

function scheduleRetry(key) {
  const attempts = Number(pendingRetry.get(`${key}:attempts`) ?? 0) + 1
  const delay = Math.min(WINDOW_RETRY_MAX_MS, WINDOW_RETRY_BASE_MS * (2 ** Math.min(attempts - 1, 6)))
  pendingRetry.set(`${key}:attempts`, attempts)
  pendingRetry.set(key, nowMs() + delay)
  note('window', `batch group=${key} retry in ${delay}ms`)
}

async function flushDue(ctx, key, handler) {
  if (flushing.has(key) || !shouldFlush(key, nowMs())) return
  const win = windowOf(key)
  if (win === null) {
    clearPending(key)
    return
  }
  const batch = windowMessages(key)
  if (batch.length === 0) return
  flushing.add(key)
  try {
    const result = await handler(ctx, key, batch, win)
    const failed = result === false || result?.status === 'failed' || result?.ok === false
    if (failed) {
      note('window', `batch handler failed group=${key}; retaining ${batch.length} message(s)`)
      scheduleRetry(key)
      return
    }
    // Only remove the exact batch delivered; messages arriving during await
    // stay queued for the next decision.
    removeDelivered(key, batch)
  } catch (error) {
    note('window', `batch handler threw group=${key}: ${error instanceof Error ? error.message : error}`)
    scheduleRetry(key)
  } finally {
    flushing.delete(key)
  }
}

/**
 * 立刻投递**这一批**积压的续聊，返回 `{ status, delivered, maxSeq }`。
 *
 * `status` 的四种结局，每一种都对应「pending 留不留、调用方要不要推进上下文基准」：
 *   · `delivered` —— 投出去了，这批已从队列剔除，`deliveredIds` 是它们的身份（见下）；
 *   · `failed`    —— 投递失败或抛错，pending 原样留着等重试（`deliveredIds` 为空）；
 *   · `held`      —— 开窗 @ 还没投递完，不能抢在它前面（`deliveredIds` 为空）；
 *   · `skipped`   —— 队列空 / 正在 flush / 窗口已关，什么都没发生。
 *
 * `deliveredIds` 给调用方按**身份**剔除这条 @ 的「未读上下文」用（`idOf` 同一套口径：
 * 有 message_id 用 id，否则用 seq）。为什么不是「把基准抬到这批的 maxSeq」——
 * 那是按 seq 区间过滤，会把夹在队列消息之间、但**没进队列**的消息（没 @ 也没引用她的
 * 群友发言）一起删掉，那本来是有效上下文，删了就是丢消息。
 *
 * ⚠️ 为什么不让调用方直接调 `deliverWindowBatch`（审核发现）：
 *    那条路没有 `flushing` 保护、也不碰门控，`@` 一旦自己调一次，
 *    「循环 flush」和「@ 触发的 flush」就会各投一遍同一批消息。
 *    所以投递一律收口到本函数，`flushing` / 门控 / 剔除 三件事都在这一个地方做。
 */
export async function flushPendingNow(ctx, groupId) {
  const key = groupKey(groupId)
  const none = { status: 'skipped', delivered: 0, deliveredIds: [] }
  if (key === '' || flushing.has(key)) return none
  if (holdActive(key, nowMs())) return { ...none, status: 'held' }
  const win = windowOf(key)
  if (win === null) {
    clearPending(key)
    return none
  }
  const batch = windowMessages(key)
  if (batch.length === 0) return none
  if (typeof batchHandler !== 'function') return none
  const deliveredIds = batch.map(idOf).filter(Boolean)
  flushing.add(key)
  try {
    const result = await batchHandler(ctx, key, batch, win)
    const failed = result === false || result?.status === 'failed' || result?.ok === false
    if (failed) {
      note('window', `forced batch failed group=${key}; retaining ${batch.length} message(s)`)
      scheduleRetry(key)
      return { ...none, status: 'failed' }
    }
    removeDelivered(key, batch)
    note('window', `forced batch group=${key} count=${batch.length}`)
    return { status: 'delivered', delivered: batch.length, deliveredIds }
  } catch (error) {
    note('window', `forced batch threw group=${key}: ${error instanceof Error ? error.message : error}`)
    scheduleRetry(key)
    return { ...none, status: 'failed' }
  } finally {
    flushing.delete(key)
  }
}

/** 一条消息的投递身份，与 `idOf` 同一套口径（poll.js 剔除未读上下文时要对得上）。 */
export function messageIdentity(message) {
  return idOf(message)
}

/** 开窗门控是否仍然有效（只读，不改状态；过期不在这里释放，flush 路径会做）。 */
export function hasOpeningHold(groupId) {
  const key = groupKey(groupId)
  const hold = batchHolds.get(key)
  return hold !== undefined && nowMs() - Number(hold.at) < OPENING_HOLD_TTL_MS
}

/** 这批积压消息已经从第一条等了多少毫秒；没有积压返回 0。 */
export function pendingAgeMs(groupId) {
  const key = groupKey(groupId)
  if ((pending.get(key) ?? []).length === 0) return 0
  const since = Number(pendingSince.get(key))
  if (!Number.isFinite(since) || since <= 0) return 0
  return Math.max(0, nowMs() - since)
}

function sweep(ctx, handler) {
  const config = getConfig()
  const state = getState()
  const windows = state.windows
  if (windows === null || typeof windows !== 'object') return
  const now = nowMs()
  const idleMs = Number(config?.windowIdleMs)
  const maxMs = Number(config?.windowMaxMs)
  for (const key of Object.keys(windows)) {
    const win = windowOf(key)
    if (win === null) continue
    if (Number.isFinite(idleMs) && idleMs >= 0 && now - Number(win.lastActivityAt) >= idleMs) {
      closeWindow(key, 'idle-timeout')
      continue
    }
    if (Number.isFinite(maxMs) && maxMs >= 0 && now - Number(win.openedAt) >= maxMs) {
      closeWindow(key, 'max-timeout')
      continue
    }
    if (typeof handler !== 'function') return
    void flushDue(ctx, key, handler)
  }
}

/** Replace the default batch callback used by an already-started loop. */
export function setWindowBatchHandler(handler) {
  const previous = batchHandler
  batchHandler = typeof handler === 'function' ? handler : null
  return previous
}

/**
 * Start one lightweight expiry/batch loop. The callback receives
 * `(ctx, groupId, messages, window)` and should return false / `{status:'failed'}` on
 * delivery failure; failed batches remain queued for a later retry.
 */
export function startWindowLoop(ctx, handler) {
  if (loopStop !== null) loopStop()
  const explicitHandler = typeof handler === 'function' ? handler : null
  // 记进 module 级变量：`flushPendingNow`（@ 到达时强制投递积压）也要用它。
  // 不记的后果：生产里 index.js 是 `startWindowLoop(ctx, deliverWindowBatch)` 显式传参，
  // batchHandler 一直是 null —— @ 触发的那次 flush 静默不做事，
  // 攒批照样等到 8 秒后才投，「旧话题被翻出来」一点没修（探针发现的）。
  if (explicitHandler !== null) batchHandler = explicitHandler
  let stopped = false
  let timer = null
  const tick = () => {
    if (stopped) return
    try {
      sweep(ctx, explicitHandler ?? batchHandler)
    } catch (error) {
      note('window', `loop tick failed: ${error instanceof Error ? error.message : error}`)
    }
    if (stopped) return
    timer = setTimeout(tick, LOOP_MS)
    if (timer !== null && typeof timer.unref === 'function') timer.unref()
  }
  tick()
  const stop = () => {
    stopped = true
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (loopStop === stop) loopStop = null
  }
  loopStop = stop
  return stop
}

/**
 * 进程启动时清理落盘但无法恢复的活动窗口。
 * pending 只存在内存，重启后继续保留 active 会让新消息看似进窗、旧消息却已丢失。
 * 日计数保留，下一次 @ 会按新窗口重新开始。
 *
 * ⚠️ 恢复了 pending 的窗口必须**同时接回它的开窗预约**（adoptPersistedOpening）：
 *    否则重启后 pending 立刻被 flush，又排到了那条还没投出去的 @ 前面（审核发现）。
 *    预约要么接回来继续挡着（并在重试成功后结算），要么因为过期而放弃挡 ——
 *    过期的那笔额度不退，理由见 releaseOpeningHold。
 */
export function resetRecoveredWindows() {
  batchHolds.clear()
  openingReservations.clear()
  const windows = ensureWindows()
  let changed = false
  for (const key of Object.keys(windows)) {
    const win = normalizeRecord(windows[key])
    if (!activeOf(win)) continue
    if (Array.isArray(win.pending) && win.pending.length > 0) {
      pending.set(key, win.pending.slice())
      pendingSince.set(key, Number(win.pendingSince) > 0 ? Number(win.pendingSince) : nowMs())
      delete win.pending
      delete win.pendingSince
      // 重启后 pending 与窗口都在，唯一可能丢的就是内存里的门控 —— 从盘上接回来。
      const adopted = adoptPersistedOpening(key, win)
      if (!adopted) clearPersistedOpening(win)
      changed = true
      note('window', `startup restored pending window group=${key} count=${pending.get(key).length} `
        + `openingHold=${adopted ? 'restored' : 'none'}`)
      continue
    }
    clearPending(key)
    clearPersistedOpening(win)
    win.active = false
    win.openedAt = 0
    win.lastActivityAt = 0
    win.triggerUin = ''
    win.repliesInWindow = 0
    win.passStreak = 0
    win.lastWindowSeq = 0
    win.selfMessageIds = []
    changed = true
    note('window', `startup closed unrecoverable window group=${key}`)
  }
  if (changed) saveWindows()
  return changed
}

/** Reset daily quotas without disturbing an active window. */
export function resetWindowDay(groupId, requestedDayKey = dayKey()) {
  const key = groupKey(groupId)
  const win = normalizeRecord(ensureWindows()[key])
  if (win === null) return false
  const next = String(requestedDayKey ?? '').trim() || dayKey()
  if (String(win.dayKey) === next) return false
  win.dayKey = next
  win.openedToday = 0
  win.peersToday = {}
  saveWindows()
  return true
}

export { dayKey }
