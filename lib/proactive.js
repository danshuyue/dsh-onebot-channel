/**
 * proactive.js —— 主动驱动：没人叫她，她自己想起来找你。
 *
 * 原来整条链只有入站驱动：QQ 来消息 → followup → 回一句。她永远是被动的，
 * 这也是「AI 味」最重的地方之一 —— 真人会在隔了半天之后想起一件事，主动发一句。
 *
 * 这一层补的就是那一格：一个常驻的钟，按条件把「主动搭话」这件事**变成一次正常回合**。
 * 关键设计：不新开一条发送链，也不自己生成文案 —— 只是往同一个会话里投一条内部来信：
 *
 *   （主动搭话：距上次说话 7 小时；上次停在「…」…想说什么就说；没什么想说的就 qq_pass）
 *
 * 于是「说」还是「不说」仍然由模型判断，转发、分条、抑制标记全部复用原有链路。
 * 这条设计红线很重要：如果这里硬拼一句「在吗」发出去，就退化成定时问候机器人了。
 *
 * 四道闸（缺一条就会变成骚扰）：
 *   1. 静默时段（默认 23:00–08:00）不打扰
 *   2. 距上次互动够久（默认 6 小时）
 *   3. 当日配额（默认 1 次）
 *   4. 退避：上次主动对方没回，下次要求的时间翻倍（上限 backoffMax 倍）
 *
 * 状态落在 ~/.dsh/qq-bridge-proactive.json，重启不丢 —— 否则每次重启都会重新「攒够 6 小时」，
 * 或者反过来把日配额清空。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR, note } from './env.js'
import { getConfig } from './config.js'
import { deliver, pickSessionId } from './deliver.js'
import { peekClosing } from './closure.js'

/** 主动搭话的状态文件。跟 state / memory / closure 分开，避免 loadState 重建时被吃掉。 */
export const PROACTIVE_FILE = join(DATA_DIR, 'qq-bridge-proactive.json')

/** 钟的间隔（毫秒）。不是「每 60 秒就说一次」，是「每 60 秒看一眼该不该说」。 */
export const TICK_MS = 60 * 1000

let proactiveFile = PROACTIVE_FILE
let table = null

/**
 * 写节流：persist() 被频繁调用时（群消息频繁触发 notePeerSpoke），
 * 不必每次都立刻写盘。30 秒内只写一次，脏数据攒在内存里。
 * 进程正常退出时 ctx.effect 会调 flushPersist() 兜底。
 */
const PERSIST_INTERVAL_MS = 30_000
let persistTimer = null
let persistDirty = false

/** 测试用：换读写路径并清内存缓存。传空 = 恢复默认。 */
export function useProactiveFile(path) {
  proactiveFile = typeof path === 'string' && path !== '' ? path : PROACTIVE_FILE
  table = null
}

/** 测试用：清空内存态（不删磁盘文件）。 */
export function clearProactiveState() {
  table = {}
}

function loadTable() {
  if (table !== null) return table
  table = {}
  try {
    if (existsSync(proactiveFile)) {
      const parsed = JSON.parse(readFileSync(proactiveFile, 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) table = parsed
    }
  } catch (error) {
    note('proactive', `状态读坏了（保留原文件）：${error instanceof Error ? error.message : error}`)
  }
  return table
}

function persist() {
  // 写节流：30 秒内只写一次，脏数据攒在内存里。
  // notePeerSpoke 在每条消息投递成功后都调用，群消息密集时可能几秒内触发十几次，
  // 每次都 writeFileSync 是不必要的磁盘 I/O。
  persistDirty = true
  if (persistTimer !== null) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    if (!persistDirty) return
    persistDirty = false
    try {
      writeFileSync(proactiveFile, JSON.stringify(table, null, 2), 'utf8')
    } catch (error) {
      note('proactive', `状态写失败：${error instanceof Error ? error.message : error}`)
    }
  }, PERSIST_INTERVAL_MS)
}

/** 立刻把内存态写盘（插件卸载 / 进程退出前调用，防丢数据）。 */
export function flushPersist() {
  if (persistTimer !== null) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  if (!persistDirty) return
  persistDirty = false
  try {
    writeFileSync(proactiveFile, JSON.stringify(table, null, 2), 'utf8')
  } catch (error) {
    note('proactive', `状态 flush 失败：${error instanceof Error ? error.message : error}`)
  }
}

function entryOf(key) {
  const t = loadTable()
  const entry = t[key]
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    const fresh = {}
    t[key] = fresh
    return fresh
  }
  return entry
}

/** 只读取一条：不建空条目（否则判定时会把从没聊过的人写进状态文件）。 */
function peekEntry(key) {
  const entry = loadTable()[key]
  return entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}
}

/** 本地日期（YYYY-MM-DD）—— 日配额按本地自然日算，不按 UTC。 */
export function dayKey(at) {
  const d = new Date(Number(at) || Date.now())
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * 对方说话了 —— 清退避、记最后互动时间。
 * 由 poll.js 在**投递成功**之后调用（跟 touchPeer 同一个位置）。
 */
export function notePeerSpoke(key, at) {
  if (typeof key !== 'string' || key === '') return false
  const now = Number(at) || Date.now()
  const entry = entryOf(key)
  entry.lastIncomingAt = now
  entry.unanswered = 0
  entry.lastAckAt = now
  persist()
  return true
}

/**
 * 记一次主动搭话。
 * 上一句还没人回（lastProactiveAt > lastIncomingAt）→ unanswered 加一，下次要等更久。
 */
export function noteNudge(key, at) {
  if (typeof key !== 'string' || key === '') return false
  const now = Number(at) || Date.now()
  const entry = entryOf(key)
  const lastIncoming = Number(entry.lastIncomingAt) || 0
  const lastProactive = Number(entry.lastProactiveAt) || 0
  // 上次主动之后有没有人说话？没有就累积「没被回应」次数
  if (lastProactive > 0 && lastIncoming <= lastProactive) {
    entry.unanswered = (Number(entry.unanswered) || 0) + 1
  }
  entry.lastProactiveAt = now
  // ⚠️ 跨天必须先把「今天几次」归零再累加。
  //   之前只写 day 不清 countToday，于是昨天的次数被算进今天：
  //   UI 上「今天 N 次」只会一直涨、永远不刷新，配额也会提前用完。
  const today = dayKey(now)
  if (entry.day !== today) {
    entry.day = today
    entry.countToday = 0
  }
  entry.countToday = (Number(entry.countToday) || 0) + 1
  persist()
  return true
}

/** 「HH:MM」→ 当日分钟数；格式不对回退到默认值。 */
export function minutesOf(hhmm, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim())
  if (m === null) return fallback
  const h = Number(m[1])
  const mi = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(mi) || h > 24 || mi > 59) return fallback
  return (h % 24) * 60 + mi
}

/** 当前时刻是否落在静默时段（支持跨午夜，from === to 视为不静默）。 */
export function inQuietHours(minutes, from, to) {
  if (from === to) return false
  return from < to ? (minutes >= from && minutes < to) : (minutes >= from || minutes < to)
}

function clampNumber(value, def, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, n))
}

/**
 * 该不该主动开口 —— 纯函数，不读盘不联网，方便单测。
 *
 * @param {object} input
 * @param {number} input.now
 * @param {boolean} input.enabled
 * @param {number} input.idleHours      距上次互动至少多久（小时，可小数）
 * @param {number} input.dailyMax       每日最多几次
 * @param {string} input.quietFrom      'HH:MM'
 * @param {string} input.quietTo        'HH:MM'
 * @param {number} input.backoffMax     没被回应时最多放大几倍
 * @param {object} input.entry          状态文件里这一条（可空）
 * @returns {{ok:boolean, reason:string, eligibleAt:number}}
 */
/**
 * 在 [min, max) 里挑一个数，同一个 seed 永远挑到同一个。
 *
 * 为什么要「同一个 seed 稳住」：钟每 60 秒看一次该不该开口，如果每次都重新摇号，
 * 门槛会在 1.5~2 小时之间来回跳 —— 摇到 1.5h 时就开口了，看起来像「随机根本没生效」；
 * 摇到 2h 时又突然闭嘴。用「这段安静期」的起点当 seed，一次安静期只摇一次号，
 * 直到有人说话（anchor 变了）才换新的门槛。
 */
export function rollBetween(min, max, seed) {
  const lo = Number(min)
  const hi = Number(max)
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return lo
  let hash = 2166136261 >>> 0
  const text = String(seed)
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  hash ^= hash >>> 16
  hash = Math.imul(hash, 2246822507) >>> 0
  hash ^= hash >>> 13
  hash = Math.imul(hash, 3266489909) >>> 0
  hash ^= hash >>> 16
  // murmur3 的收尾混合：只做 FNV 的话，相邻时间戳（同一小时内的）算出来的
  // 小数部分会挤在一起，摇号等于没摇。
  return lo + (hi - lo) * ((hash >>> 0) / 4294967296)
}

export function shouldNudge(input) {
  const now = Number(input?.now) || Date.now()
  const idleHours = clampNumber(input?.idleHours, 6, 0.05, 720)
  const dailyMax = clampNumber(Math.round(Number(input?.dailyMax)), 1, 0, 48)
  const backoffMax = clampNumber(input?.backoffMax, 4, 1, 16)
  const quietFrom = minutesOf(input?.quietFrom, 23 * 60)
  const quietTo = minutesOf(input?.quietTo, 8 * 60)
  const entry = input?.entry !== null && typeof input?.entry === 'object' ? input.entry : {}

  // 设置页的「现在试一次」：跳过静默时段 / 空闲 / 配额 / 退避 / 总开关，仍然只打一个人。
  // 手动动作是人在按，不是钟在按 —— 用这些闸去挡他只会让人以为功能坏了。
  // 放在 enabled 之前：开关关着时也要能试，不然没人知道开了之后是什么手感。
  if (input?.force === true) return { ok: true, reason: 'force', eligibleAt: now }

  if (input?.enabled !== true) return { ok: false, reason: 'off', eligibleAt: 0 }

  const minutesNow = new Date(now).getHours() * 60 + new Date(now).getMinutes()
  if (inQuietHours(minutesNow, quietFrom, quietTo)) return { ok: false, reason: 'quiet-hours', eligibleAt: 0 }

  const lastIncoming = Number(entry.lastIncomingAt) || 0
  // 从没聊过的人不主动：没有上下文，开口就是陌生推销
  if (lastIncoming <= 0) return { ok: false, reason: 'never-talked', eligibleAt: 0 }

  const today = dayKey(now)
  const countToday = entry.day === today ? Number(entry.countToday) || 0 : 0
  if (countToday >= dailyMax) return { ok: false, reason: 'daily-quota', eligibleAt: 0 }

  const unanswered = Number(entry.unanswered) || 0
  const factor = Math.min(backoffMax, Math.pow(2, Math.max(0, unanswered)))
  /**
   * 空闲的起算点取「上次来信」和「上次主动」里**较晚**的那个。
   *
   * 只按 lastIncomingAt 算是错的：她主动说完一句之后，那个时间戳一动不动，
   * 于是下一次 tick（60 秒后）依然算「已经空闲 8 小时」，照样放行 ——
   * 表现就是静默一解除、一分钟一条，把当日额度几分钟烧光。
   * 「空闲」应该理解为「这段关系安静了多久」，她自己开口也算打破安静。
   *
   * 注意：之前「刚说完没人回」这条是靠 unanswered 退避兜的，但 backoffMax 配成 1
   * 就等于把退避关了，兜不住 —— 所以基准必须自己对。
   */
  const lastProactive = Number(entry.lastProactiveAt) || 0
  const idleFrom = Math.max(lastIncoming, lastProactive)
  // 空闲门槛可以是一个区间：idleMaxHours > idleHours 时，按这段安静期的起点摇一个值。
  // 摇号用 idleFrom 当 seed —— 同一次安静期内门槛固定，不会每 60 秒变一次。
  const idleMaxHours = Number(input?.idleMaxHours)
  const rolledHours = Number.isFinite(idleMaxHours) && idleMaxHours > idleHours
    ? rollBetween(idleHours, Math.min(720, idleMaxHours), idleFrom)
    : idleHours
  const idleMs = rolledHours * 60 * 60 * 1000 * factor
  const eligibleAt = idleFrom + idleMs
  if (now < eligibleAt) {
    return { ok: false, reason: unanswered > 0 ? 'backoff' : 'not-idle-enough', eligibleAt }
  }

  return { ok: true, reason: 'ok', eligibleAt }
}

/** 把毫秒差写成人话（投进正文的那一行要短）。 */
export function formatGap(ms) {
  const minutes = Math.max(0, Math.round(Number(ms) / 60000))
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 24) return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`
  const days = Math.floor(hours / 24)
  return `${days} 天`
}

/**
 * 「现在几点」的人话：2026-11-02 22:01（周一）。
 *
 * 主动搭话是**没有前因**的一次开口：模型不知道现在是深夜还是上午，
 * 就容易写出「今天过得怎么样」这种不分场合的问候（凌晨三点问这个很怪）。
 * 星期几一起给，是因为「周末」和「工作日」该说的话不一样。
 */
export function formatClock(ms) {
  const d = new Date(Number(ms) || Date.now())
  const pad = (n) => String(n).padStart(2, '0')
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}（${week}）`
}

/**
 * 组装投给模型的那条「内部来信」。
 *
 * ⚠️ 必须把「可以不说」写进去：不写的话模型会认为收到了指令，于是硬找一句话发出去，
 *   这一层就退化成定时问候。qq_pass 就是它的出口。
 *
 * ⚠️⚠️ 但**不能无条件点名 qq_pass**（2026-11-05 审计发现）：
 *   「沉默权」那一档可以在设置页整档关掉，关掉后 qq_pass / qq_skip / qq_wait / qq_close
 *   全都不注册。这时还写「就 qq_pass」= 教模型去调一个不存在的工具，
 *   它会拿到 UNKNOWN_TOOL，然后换个写法再试 —— 反而更烧 token，
 *   而且「想安静」这个诉求彻底没有出口，只能硬说一句或者写动作描写。
 *
 *   所以按 features 分两种说法：
 *     · 有沉默权 → 直接点名（最有效，模型一看就懂）
 *     · 没沉默权 → 说「什么都不用发」，并且**明确**告诉它「不调用任何工具就是沉默」
 *       （自动转发那条路只转发正文，正文为空 = 什么都没发出去）
 */
export function composeNudge(key, entry, now) {
  const lastIncoming = Number(entry?.lastIncomingAt) || now
  const lines = [`（主动搭话：现在是 ${formatClock(now)}，距上次说话已经 ${formatGap(now - lastIncoming)}。`]
  const closing = peekClosing(key)
  if (closing !== null) {
    const parts = []
    if (closing.summary !== '') parts.push(`上次聊到「${closing.summary}」`)
    if (closing.next !== '') parts.push(`可以从「${closing.next}」接着聊`)
    if (parts.length > 0) lines.push(`${parts.join('，')}。`)
  }
  // silence=false 表示「沉默权」档被关掉了（qq_pass 等不存在）。
  // 默认 true：不传 options 的老调用方拿到的还是原来的文案。
  const hasSilence = options.silence !== false
  lines.push('想说什么就说，也可以只是问一句他在干嘛 —— 但这事你自己定：')
  if (hasSilence) {
    lines.push('这会儿没什么想说的、或者觉得开口很生硬，就 qq_pass，不用硬找话。')
    // 这条踩过：模型会回「（尾巴摆了摆）」表示「我在但没话说」，而正文会被原样发到 QQ，
    // 他收到一条莫名其妙的表情动作 —— 看起来像插件坏了。必须写清楚「动作不是回答」。
    lines.push('注意：正文里写的东西会原样发到他手机上。想安静就别写「（动作描写）」，直接 qq_pass。）')
  } else {
    lines.push('这会儿没什么想说的、或者觉得开口很生硬，就**什么都不发**，不用硬找话。')
    lines.push('注意：不调用任何工具、也不写任何正文，就是「这次不开口」—— 不会发给他。'
      + '正文里写的东西会原样发到他手机上，所以想安静就别写「（动作描写）」或「（算了）」这类话。）')
  }
  return lines.join('')
}

/**
 * 这个对象允不允许主动搭话。
 *
 * 设置页的白名单是**空的就全放开**（老行为，别让升级完突然谁都不理）；
 * 一旦填了人，就只对名单里的人生效。只认 `private:<数字>`：
 * 脏数据（手改错的、旧版本写进去的别的形态）会被忽略掉，
 * 否则一个笔误就能让整条功能静默失效，排查起来极其恶心。
 */
export function targetAllowed(config, key) {
  const raw = config?.proactiveTargets
  if (!Array.isArray(raw)) return true
  const clean = raw
    .map((v) => String(v ?? '').trim())
    .filter((v) => /^private:\d+$/.test(v))
  if (clean.length === 0) return true
  return clean.includes(String(key))
}

/** 有会话、可主动的对象（只做私聊：群里 @ 才投递，主动进群打扰不是这个功能的目的）。 */
export function candidates(config = getConfig()) {
  const table = config?.routes?.private
  if (table === null || typeof table !== 'object') return []
  const out = []
  for (const uin of Object.keys(table)) {
    const sessionId = pickSessionId(config, 'private', uin)
    if (sessionId === '') continue
    const key = `private:${uin}`
    // 白名单在这里就筛掉：名单外的人连「该不该开口」都不必算
    if (!targetAllowed(config, key)) continue
    const target = { kind: 'private', id: String(uin) }
    out.push({ key, uin: String(uin), target, sessionId })
  }
  return out
}

/**
 * 候选排序：最久没被主动过的排最前（从没主动过 = 0，直接顶到最前）。
 *
 * 为什么需要这个：手动「现在试一次」只打一个人，而 Object.keys 的顺序是固定的 ——
 * 连点三次会三次都发给同一个人，另一个人永远轮不到（0.9.1 之前就是这样）。
 * 按「谁最久没被找过」排，连点会自动轮转，也顺便让定时钟的先后更公平。
 */
export function orderByStalest(list) {
  return list.slice().sort((a, b) => {
    const ta = Number(peekEntry(a.key).lastProactiveAt) || 0
    const tb = Number(peekEntry(b.key).lastProactiveAt) || 0
    if (ta !== tb) return ta - tb
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  })
}

let running = false

/**
 * 跑一轮判定（tick 调它，设置页的「现在试一次」也调它）。
 *
 * @param {object} ctx
 * @param {{force?: boolean, only?: string}} [options]
 *   force = 忽略开关/配额/空闲/静默，立刻投一次；
 *   only  = 只对这一个 key（`private:123`）动手 —— 设置页每行的「试一次」用它，
 *           顺便也支持「只给某个人手动开一次口」，不用临时改白名单。
 * @returns {Promise<{sent:number, skipped:{key:string, reason:string}[]}>}
 */
export async function runProactiveOnce(ctx, options = {}) {
  const force = options?.force === true
  const only = typeof options?.only === 'string' && options.only.trim() !== '' ? options.only.trim() : ''
  const result = { sent: 0, skipped: [] }
  if (running) {
    note('proactive', '上一轮还没跑完，跳过这一轮')
    return result
  }
  running = true
  try {
    const config = getConfig()
    const now = Date.now()
    let list = orderByStalest(candidates(config))
    if (only !== '') {
      list = list.filter((item) => item.key === only)
      if (list.length === 0) {
        // 两种可能：没绑会话，或者不在白名单里。前端只显示一句话，就别细分了 —— 都是「这个对象现在不能主动」
        note('proactive', `${only} 不可主动（没绑会话或不在白名单）`)
        result.skipped.push({ key: only, reason: 'not-bound' })
        return result
      }
    }
    if (list.length === 0) {
      note('proactive', '没有可主动的对象（没有配好会话的私聊，或都不在主动名单里）')
      return result
    }
    for (const item of list) {
      const entry = peekEntry(item.key)
      const decision = shouldNudge({
        now,
        force,
        enabled: force ? true : config?.proactiveEnabled === true,
        idleHours: config?.proactiveIdleHours,
        idleMaxHours: config?.proactiveIdleMaxHours,
        dailyMax: config?.proactiveDailyMax,
        quietFrom: config?.proactiveQuietFrom,
        quietTo: config?.proactiveQuietTo,
        backoffMax: config?.proactiveBackoffMax,
        entry
      })
      if (!decision.ok) {
        result.skipped.push({ key: item.key, reason: force ? 'force' : decision.reason })
        continue
      }
      // 「沉默权」档被关掉时，qq_pass 不存在 —— 文案要跟着变（见 composeNudge 的注释）。
      const text = composeNudge(item.key, entry, now, { silence: getConfig()?.toolFeatures?.silence !== false })
      const used = await deliver(ctx, item.sessionId, text, item.target, undefined, { proactive: true })
      if (used === '') {
        note('proactive', `${item.key} 投递失败（没有可用会话）`)
        result.skipped.push({ key: item.key, reason: 'deliver-failed' })
        continue
      }
      noteNudge(item.key, now)
      result.sent += 1
      note('proactive', `主动搭话 ${item.key} -> ${used}（${decision.reason}${force ? '/手动' : ''}）`)
      // 手动触发只打一个人，别一次把所有人问候一遍
      if (force) break
    }
    return result
  } finally {
    running = false
  }
}

/**
 * 启动常驻的钟。返回停止函数（挂到 ctx.effect 的清理里）。
 * 第一次检查故意延后一个周期：开机就发消息最容易吓到人。
 */
export function startProactive(ctx) {
  let stopped = false
  let timer = null
  const tick = async () => {
    if (stopped) return
    try {
      const config = getConfig()
      if (config?.proactiveEnabled === true) await runProactiveOnce(ctx, { force: false })
    } catch (error) {
      note('proactive', `tick 抛错：${error instanceof Error ? error.message : error}`)
    } finally {
      if (!stopped) timer = setTimeout(() => { void tick() }, TICK_MS)
    }
  }
  timer = setTimeout(() => { void tick() }, TICK_MS)
  note('proactive', `主动搭话的钟已启动（每 ${Math.round(TICK_MS / 1000)} 秒看一次该不该开口）`)
  return () => {
    stopped = true
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
}

/** 设置页用：每个人上次主动是什么时候、今天说过几次、还要等多久。 */
export function proactiveSummary() {
  const config = getConfig()
  const now = Date.now()
  const t = loadTable()
  const rows = []
  const seen = new Set()

  function decide(entry) {
    return shouldNudge({
      now,
      enabled: config?.proactiveEnabled === true,
      idleHours: config?.proactiveIdleHours,
        idleMaxHours: config?.proactiveIdleMaxHours,
      dailyMax: config?.proactiveDailyMax,
      quietFrom: config?.proactiveQuietFrom,
      quietTo: config?.proactiveQuietTo,
      backoffMax: config?.proactiveBackoffMax,
      entry
    })
  }

  function row(key, entry, available) {
    const decision = decide(entry)
    return {
      key,
      uin: key.startsWith('private:') ? key.slice('private:'.length) : '',
      available,
      enabled: targetAllowed(config, key),
      lastProactiveAt: Number(entry.lastProactiveAt) || 0,
      lastIncomingAt: Number(entry.lastIncomingAt) || 0,
      countToday: entry.day === dayKey(now) ? Number(entry.countToday) || 0 : 0,
      unanswered: Number(entry.unanswered) || 0,
      reason: decision.reason,
      eligibleAt: decision.eligibleAt
    }
  }

  // 先列「绑了会话且在白名单里」的候选（含从没聊过的 —— 它们也该出现在勾选表里，否则没法勾回来）
  for (const item of candidates(config)) {
    seen.add(item.key)
    rows.push(row(item.key, peekEntry(item.key), true))
  }
  // 再补「有记录但当前不是候选」的（会话被删了 / 被白名单排掉了），给 UI 一个显示的地方，别让记录凭空消失
  for (const [key, entry] of Object.entries(t)) {
    if (seen.has(key)) continue
    if (entry === null || typeof entry !== 'object') continue
    rows.push(row(key, entry, false))
  }
  rows.sort((a, b) => b.lastProactiveAt - a.lastProactiveAt)
  // 「现在试一次」会打给谁 —— 前端要能提前显示，不然连点几次会以为坏了
  const queue = orderByStalest(candidates(config))
  const next = queue.length > 0 ? { key: queue[0].key, uin: queue[0].uin } : null
  return {
    file: proactiveFile,
    count: rows.length,
    // 白名单（清洗后）：空数组同时表示「全放开」，前端靠这个和勾选状态区分「全选」和「一个都没选」
    targets: Array.isArray(config?.proactiveTargets) ? config.proactiveTargets.slice() : [],
    next,
    peers: rows.slice(0, 40)
  }
}
