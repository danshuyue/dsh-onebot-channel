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

const DEFAULT_WATER_WINDOWS = ['12:00-14:00', '18:00-09:00']
const LOOP_MS = 1000

/** group id -> raw messages that have not reached the model yet. */
const pending = new Map()
/** group id -> the time the current pending batch started. */
const pendingSince = new Map()
/** groups whose batch handler is currently running. */
const flushing = new Set()
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

/** Remove and return a snapshot. Call restoreWindowMessages on handler failure. */
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

function shouldFlush(key, now) {
  const list = pending.get(key) ?? []
  if (list.length === 0) return false
  if (now < Number(pendingRetry.get(key) ?? 0)) return false
  if (list.length >= WINDOW_BATCH_MAX) return true
  return now - Number(pendingSince.get(key) ?? now) >= WINDOW_BATCH_MS
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
      persistPending(key)
    } else {
      pending.set(key, remaining)
      pendingSince.set(key, nowMs())
      persistPending(key)
    }
  } catch (error) {
    note('window', `batch handler threw group=${key}: ${error instanceof Error ? error.message : error}`)
    scheduleRetry(key)
  } finally {
    flushing.delete(key)
  }
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
 */
export function resetRecoveredWindows() {
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
      changed = true
      note('window', `startup restored pending window group=${key} count=${pending.get(key).length}`)
      continue
    }
    clearPending(key)
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
