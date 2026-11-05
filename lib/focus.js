/**
 * focus.js —— 跨会话路由：这条 QQ 消息该进哪个会话。
 *
 * 为什么需要（2026-11-05 用户需求）：
 *   插件原来是**严格会话绑定**：routes[target].sessionId 写死一个会话，
 *   你从 QQ 发的话永远只进那一个。别的会话能通过 sendapi 单向推给你，
 *   但你回不过去 —— 这就是「没法统一」。
 *
 * ⚠️ 这份文件的核心不是「怎么找会话」，而是**怎么拒绝猜**。
 *   两种看起来省事的方案都被否掉了（见 docs/开发提示词-跨工作区会话进度.md §0.1）：
 *
 *   · 总台会话（一个会话代理全部工作区）：它不是那个会话，只能转述，
 *     永远慢一层；每句话先烧总台 token；上下文几十条就漂移；
 *     真要干活还得转发，等于绕远。
 *   · 最近会话兜底：现有 sessionCandidates() 就是这条路，插件自己的注释写着
 *     「消息凭空进了别的对话」。48 个工作区并行时，「最近」是掷硬币。
 *     更糟的是**误判时没有任何提示** —— 消息静默进错会话，那头的模型还认真干活。
 *
 *   所以这里只认三个**显式**信号，按优先级：
 *     ① 引用（长按回复）了某条带标签的 bot 消息 → 回给发出它的会话
 *     ② /去 设过的焦点（带 TTL，过期回默认）
 *     ③ routes 里的默认绑定
 *   三个都没有 → 返回空，让调用方**明说**「发 /进度 挑一个」，绝不兜底到别的会话。
 *
 * 这个模块不碰 ctx、不发网络、不投递 —— 纯状态 + 纯函数，好单测。
 */
import { getConfig } from './config.js'
import { getState, saveState } from './state.js'
import { note } from './env.js'
import { routeOf } from './deliver.js'
import { isArchived } from './archive.js'

/**
 * 引用索引：`messageId → { sessionId, targetKey, at }`。
 *
 * 为什么用内存 Map 而不是落盘：它是「我最近发出去的消息」的临时索引，
 * 重启后旧的 message_id 也没法再被引用（QQ 那边还挂着，但我们已经不知道它属于谁了）。
 * 落盘反而会积一堆过期的垃圾。TTL 6 小时，跟「人隔一阵才回来引用」的现实匹配。
 */
const SENT_LIMIT = 500
const SENT_TTL_MS = 6 * 60 * 60 * 1000
const sentIndex = new Map()

/** 记一批「刚发出去的消息属于哪个会话」。messageIds 可以是数组或单个。 */
export function noteSent(sessionId, targetKey, messageIds, at = Date.now()) {
  const sid = String(sessionId ?? '')
  if (sid === '') return
  const ids = Array.isArray(messageIds) ? messageIds : [messageIds]
  for (const raw of ids) {
    const id = String(raw ?? '').trim()
    if (!/^-?\d+$/.test(id) || id === '0' || id === '-0') continue
    sentIndex.set(id, { sessionId: sid, targetKey: String(targetKey ?? ''), at })
  }
  // 容量 + 过期双清理（Map 保插入序，超了从最早开始删）
  const now = at
  for (const [id, entry] of sentIndex) {
    if (now - entry.at > SENT_TTL_MS) sentIndex.delete(id)
    else break // 插入序即时间序，遇到第一个没过期的就可以停
  }
  while (sentIndex.size > SENT_LIMIT) {
    const oldest = sentIndex.keys().next().value
    if (oldest === undefined) break
    sentIndex.delete(oldest)
  }
}

/** 这条 message_id 是本插件发的吗？属于哪个会话？没有就 null。 */
export function sessionOfSent(messageId, now = Date.now()) {
  const id = String(messageId ?? '').trim()
  if (id === '') return null
  const entry = sentIndex.get(id)
  if (entry === undefined) return null
  if (now - entry.at > SENT_TTL_MS) {
    sentIndex.delete(id)
    return null
  }
  return { sessionId: entry.sessionId, targetKey: entry.targetKey, at: entry.at }
}

/** 测试用：清空引用索引。 */
export function clearSent() {
  sentIndex.clear()
}

// ---------------------------------------------------------------------------
// 焦点（/去 设的那个指针）
// ---------------------------------------------------------------------------

/** 按 targetKey 取焦点会话；过期或不存在就返回空。 */
export function focusOf(targetKey, now = Date.now()) {
  const key = String(targetKey ?? '')
  if (key === '') return null
  const table = getState().focus
  const entry = table !== null && typeof table === 'object' ? table[key] : null
  if (entry === null || entry === undefined) return null
  const sessionId = String(entry.sessionId ?? '')
  if (sessionId === '') return null
  // 焦点必须有寿命：前天 /去 了 A，今天发消息还进 A，就是跨天串台。
  // 0 = 永不超时（配置里显式关掉这条保护）。
  const idleMs = Number(getConfig()?.focusIdleResetMs)
  if (Number.isFinite(idleMs) && idleMs > 0 && now - Number(entry.at ?? 0) > idleMs) {
    note('focus', `焦点 ${key} -> ${sessionId} 已闲置超时，自动回默认`)
    clearFocus(key)
    return null
  }
  // 焦点指向的会话被归档了 → 当没有。留着它就是把消息投进用户收起来的会话。
  if (isArchived(sessionId)) {
    note('focus', `焦点 ${key} 指向的 ${sessionId} 已归档，清掉焦点`)
    clearFocus(key)
    return null
  }
  return { sessionId, label: String(entry.label ?? ''), at: Number(entry.at ?? 0) }
}

/** 设焦点。label 是给人看的（`/在哪` 要显示「你现在在跟谁说话」）。 */
export function setFocus(targetKey, sessionId, label, at = Date.now()) {
  const key = String(targetKey ?? '')
  const sid = String(sessionId ?? '')
  if (key === '' || sid === '') return false
  const state = getState()
  const table = { ...(state.focus ?? {}) }
  table[key] = { sessionId: sid, label: String(label ?? ''), at }
  saveState({ focus: table })
  note('focus', `${key} -> ${sid}（${label}）`)
  return true
}

/** 清焦点（/回）。返回被清掉的会话 id，没有就空串。 */
export function clearFocus(targetKey) {
  const key = String(targetKey ?? '')
  if (key === '') return ''
  const state = getState()
  const table = state.focus ?? {}
  if (table[key] === undefined) return ''
  const removed = String(table[key].sessionId ?? '')
  const next = { ...table }
  delete next[key]
  saveState({ focus: next })
  return removed
}

/** 默认绑定（routes 里那个）。空 = 没配。 */
export function defaultSessionOf(cfg, kind, id) {
  const route = routeOf(cfg, kind, id)
  if (route !== null && typeof route.sessionId === 'string' && route.sessionId !== '') return route.sessionId
  return ''
}

/**
 * **核心**：这条消息该进哪个会话。
 *
 * @param {object} args
 *   cfg        配置
 *   kind       'private' | 'group'
 *   id         QQ 号 / 群号
 *   replyToId  这条消息引用的那条消息的 message_id（可空）
 * @returns {{ sessionId: string, via: 'reply'|'focus'|'default'|'none', label?: string }}
 *   via='none' 且 sessionId='' 表示**必须让用户挑**，绝不由调用方兜底。
 */
export function resolveSession({ cfg = null, kind, id, replyToId = '', now = Date.now() } = {}) {
  const config = cfg ?? getConfig()
  const targetKey = `${String(kind ?? '')}:${String(id ?? '')}`
  const defaultSession = defaultSessionOf(config, kind, id)

  // ① 引用优先。为什么排第一：它是**最明确**的意图表达 ——
  //    用户亲手点了「回复这条」，没有任何推断成分。
  //    引用到别的 target 的消息时**不横跨**：那说明用户在另一处引用，
  //    不该把这边的话搬到那边去（跨 target 搬消息是最容易出事故的路径）。
  const quoted = sessionOfSent(replyToId, now)
  if (quoted !== null && quoted.targetKey === targetKey) {
    if (isArchived(quoted.sessionId)) {
      note('focus', `引用的消息属于已归档会话 ${quoted.sessionId}，忽略引用`)
    } else {
      return { sessionId: quoted.sessionId, via: 'reply' }
    }
  }

  // ② 焦点。
  const focus = focusOf(targetKey, now)
  if (focus !== null) return { sessionId: focus.sessionId, via: 'focus', label: focus.label }

  // ③ 默认绑定。
  if (defaultSession !== '') {
    if (isArchived(defaultSession)) {
      note('focus', `默认绑定 ${defaultSession} 已归档，按「没有可用会话」处理`)
      return { sessionId: '', via: 'none' }
    }
    return { sessionId: defaultSession, via: 'default' }
  }

  // ④ 都没有 —— 不猜。
  return { sessionId: '', via: 'none' }
}

/**
 * 出站标签：`〔工作区·会话〕`。
 *
 * 只在「当前会话 ≠ 该 target 的默认绑定会话」时返回非空 —— 日常单会话聊天
 * 一个字都不会多出来。多会话并行时，这是让人在 QQ 那头分清「这句是哪边说的」
 * 的唯一办法（也是引用路由能成立的前提：必须让人看见标签才知道该引用谁）。
 */
export function tagFor(sessionId, kind, id, label) {
  if (getConfig()?.focusTagEnabled === false) return ''
  const sid = String(sessionId ?? '')
  if (sid === '') return ''
  const defaultSession = defaultSessionOf(getConfig(), kind, id)
  if (sid === defaultSession) return ''
  const text = String(label ?? '').trim()
  if (text === '') return ''
  // ⚠️ 只能是裸前缀，绝不写成整句说明。
  //    这个插件踩过一次：每条消息后面跟一段「想发表情就写 [表情:x]」的说明，
  //    几百条后纯烧 token，还让模型分不清哪句是用户说的、哪句是插件塞的。
  return `〔${clip(text, 24)}〕`
}

/** 截断，末尾加省略号。 */
function clip(text, max) {
  const str = String(text ?? '')
  return str.length <= max ? str : `${str.slice(0, max)}…`
}

/** 测试用：清干净所有路由状态。 */
export function clearAll() {
  sentIndex.clear()
  const state = getState()
  saveState({ focus: {} })
  void state
}
