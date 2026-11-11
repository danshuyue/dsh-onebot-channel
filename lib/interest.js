/**
 * interest.js —— 群聊兴趣点（0.23.0）。
 *
 * ## 它做什么
 *
 * 群里出现关键词 → 记下一条任务 → **等 N 分钟** → 把那段时间的聊天交给判定器
 * → 命中就私聊通知主人。
 *
 * ## 三条铁律（每一条都对应一次真实的失败形态）
 *
 * ### ① 旁路，旁路，旁路
 *
 * `observe()` 是从 `poll.js` 的群消息主链路里 `void` 调用的 —— 它**只做一件事**：
 * 把消息记进内存（和落盘）。判定、等待、下发全在自己的定时器里跑。
 *
 * 为什么：群消息的投递不能被一个可能 60 秒的模型调用拖住。这个模块里任何
 * `await` 都不该出现在 `observe` 的同步路径上，而且**所有异常必须自己吞掉** ——
 * 一个未捕获的 rejection 会冒到进程上，而它的调用方是轮询循环。
 *
 * ### ② 任务必须落盘
 *
 * `dueAt` 在 N 分钟后。这中间可能热重载、协议端断线、DSH 重启。
 * 任务丢了的后果是：主人那次「帮我盯着这个事」**静默失效**，
 * 而且他不会来问 —— 他不知道「本来该有一条通知」。
 * 所以 `~/.dsh/qq-bridge-interests.json` 是这份状态的唯一真相，启动时先扫一遍。
 *
 * ### ③ 取材不加戏
 *
 * 触发**之前**那段只能从内存缓冲里切快照（缓冲 30 条会被挤掉，必须当场存）；
 * 触发**之后**那段只能靠等待期逐条追加（协议端的历史接口没有可靠的
 * 「取某条之后」语义，拿它当主路径会得到一个安静的空窗口 ——
 * 听起来像「没人跟进」，实际是拉错了方向）。
 *
 * 两段都没有时就明确告诉判定器「开头可能不全」，**不谎称完整**。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { INTEREST_FILE } from './env.js'
import { note } from './env.js'
import { getConfig } from './config.js'
import { textSegmentsOf } from './commands.js'
import { buildImageBlocks, imageSegmentsOf } from './images.js'
import { judgeInterest, renderInterestNotice, reportJudgeFailure } from './judge.js'

/**
 * ⚠️ 循环依赖说明（照着 window.js ↔ poll.js 那次的教训写）：
 *
 * `poll.js` 在模块顶层 import 本模块（要在主链路里调 `observe`）。
 * 因此本模块**绝不能**在顶层 import 回 `poll.js` —— 那会形成真正的循环依赖，
 * 表现是 ESM 的 TDZ 错误（`Cannot access 'xxx' before initialization`，
 * 堆栈指向 import 行，看起来完全不像循环依赖）。
 *
 * `observe` 需要的两样 poll.js 的东西 —— 群缓冲快照、群名 —— 都**由调用方传进来**
 * （`options.buffer` / `options.groupName`）。这比"函数内动态 import"更好：
 *   · 动态 import 在 ESM 里是异步的，而快照必须在建任务时**同步**算完
 *     （它依赖「此刻的缓冲」；await 一下就被新消息挤掉了）；
 *   · 传参之后本模块对 poll.js **零依赖**，单测可以直接喂一个假 buffer，
 *     不需要把整个 poll.js 拉起来（那需要真配置、真路由表、隔离 HOME）。
 */

/** 等待期最多追多少条（防止一个刷屏群把一段几百条的历史全塞给判定器）。 */
export const DURING_MAX_MESSAGES = 120

/** 单条任务的生命周期总长上限：超过它还没判完就当失败丢弃（防止僵尸任务堆着）。 */
export const TASK_MAX_AGE_MS = 6 * 60 * 60 * 1000

/** 内容指纹保留多久（24 小时足够覆盖「同一个崩溃被复述几遍」的场面）。 */
export const RECENT_TTL_MS = 24 * 60 * 60 * 1000

/** 写盘节流：等待期追加消息时按这个间隔合并写一次。 */
export const PERSIST_THROTTLE_MS = 5000

// ---- 内存态 ----------------------------------------------------------------

/** 全部任务：`id -> task`。 */
const tasks = new Map()

/** 内容指纹账本：`{ fp, pointId, groupId, at }[]`（落盘，跨重启有效）。 */
let recent = []

/** 每日账本：`{ 'YYYY-MM-DD': { calls: n, perGroup: { gid: n } } }`（落盘）。 */
let daily = {}

/** 每个兴趣点上次通知的时间：`pointId -> at`（落盘，冷却跨重启有效）。 */
let lastNotified = {}

/** 上次写盘的时间（节流用）。 */
let lastPersistAt = 0

/** 任务循环的定时器句柄。 */
let loopTimer = null

/** 已经处理过、正在等 dueAt 的任务不需要重复扫；但扫本身很便宜，不用额外记。 */

// ---- 工具函数 --------------------------------------------------------------

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

function newTaskId() {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 内容指纹。
 *
 * 为什么指纹而不是「只比触发那条的原文」：
 *   同一件事会被不同的人复述（「服崩了」→「又炸了」→「进不去」），
 *   只看原文会各发一条。把 keyMessage + 前两条 related 拼起来算指纹，
 *   复述的内容高度重合，天然合并。
 */
function fingerprintOf(pointId, groupId, result) {
  const parts = [
    String(pointId ?? ''),
    String(groupId ?? ''),
    String(result?.keyMessage?.text ?? '').replace(/\s+/g, ' ').trim()
  ]
  for (const row of Array.isArray(result?.related) ? result.related.slice(0, 2) : []) {
    parts.push(String(row?.text ?? '').replace(/\s+/g, ' ').trim())
  }
  return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16)
}

/** 一条群消息 → 任务里的最小记录形状。 */
function recordOf(message, atOverride) {
  return {
    at: Number(atOverride ?? message?.time ?? 0) > 0
      ? Number(atOverride ?? message.time) * 1000
      : nowMs(),
    uin: String(message?.sender?.user_id ?? '').trim(),
    nick: String(message?.sender?.card ?? '').trim() || String(message?.sender?.nickname ?? '').trim(),
    text: textSegmentsOf(message?.message)
  }
}

// ---- 落盘 ------------------------------------------------------------------

export function loadInterests() {
  try {
    if (!existsSync(INTEREST_FILE)) return { tasks: [], recent: [], daily: {}, lastNotified: {} }
    const raw = JSON.parse(readFileSync(INTEREST_FILE, 'utf8'))
    tasks.clear()
    for (const row of Array.isArray(raw?.tasks) ? raw.tasks : []) {
      if (row === null || typeof row !== 'object' || typeof row.id !== 'string') continue
      tasks.set(row.id, row)
    }
    recent = Array.isArray(raw?.recent) ? raw.recent.filter((row) => row !== null && typeof row === 'object') : []
    daily = raw?.daily !== null && typeof raw?.daily === 'object' && !Array.isArray(raw.daily) ? raw.daily : {}
    lastNotified = raw?.lastNotified !== null && typeof raw.lastNotified === 'object' && !Array.isArray(raw.lastNotified)
      ? raw.lastNotified
      : {}
    return { tasks: [...tasks.values()], recent, daily, lastNotified }
  } catch (error) {
    // 坏文件按「没有」处理 —— 绝不让一份手改坏的 JSON 把整条链路拖垮（同 archive.js 的立场）。
    note('interest', `读 ${INTEREST_FILE} 失败，按空处理：${error instanceof Error ? error.message : error}`)
    tasks.clear()
    recent = []
    daily = {}
    lastNotified = {}
    return { tasks: [], recent: [], daily: {}, lastNotified: {} }
  }
}

/**
 * 立即落盘（不节流）。
 *
 * 什么时候必须立即写：任务创建、任务结束、下发记账。
 * 什么时候可以节流：等待期追加消息（每 5 秒合并一次）。
 */
export function persistInterests() {
  lastPersistAt = nowMs()
  try {
    const payload = {
      tasks: [...tasks.values()],
      recent,
      daily,
      lastNotified,
      updatedAt: new Date().toISOString()
    }
    writeFileSync(INTEREST_FILE, JSON.stringify(payload, null, 2), 'utf8')
  } catch (error) {
    note('interest', `写 ${INTEREST_FILE} 失败：${error instanceof Error ? error.message : error}`)
  }
}

function persistThrottled() {
  if (nowMs() - lastPersistAt < PERSIST_THROTTLE_MS) return
  persistInterests()
}

// ---- 命中与任务创建 ---------------------------------------------------------

/**
 * 一条群消息该不该成为兴趣点的触发源。
 *
 * 返回命中列表（可能多条：一个人可能同时关注「服务器崩溃」和「开服公告」）。
 *
 * ⚠️ 判据是**纯文字段**，与唤醒词同一口径（`textSegmentsOf`）：
 *    `textOf` 会把 at 段渲染成 `@3566906627`，那串数字不该参与关键词匹配。
 *
 * @param {object} message OneBot 群消息
 * @param {Array} points 归一化后的兴趣点
 * @param {string} groupId
 * @returns {Array<{point: object, word: string}>}
 */
export function matchPointsFor(message, points, groupId) {
  const text = textSegmentsOf(message?.message)
  if (text === '') return []
  const haystack = text.toLowerCase()
  const out = []
  for (const point of Array.isArray(points) ? points : []) {
    if (point === null || typeof point !== 'object' || point.enabled === false) continue
    // 生效群：空数组 = 所有监听群（与 proactiveTargets 同一套语义）
    const scope = Array.isArray(point.groupUins) ? point.groupUins : []
    if (scope.length > 0 && !scope.includes(String(groupId ?? ''))) continue
    const keywords = Array.isArray(point.keywords) ? point.keywords : []
    let hit = ''
    for (const word of keywords) {
      const needle = String(word ?? '').trim().toLowerCase()
      if (needle === '' || !haystack.includes(needle)) continue
      if (needle.length > hit.length) hit = String(word).trim()
    }
    if (hit !== '') out.push({ point, word: hit })
  }
  return out
}

/**
 * 主链路调用的唯一入口 —— **只记账，不判定**。
 *
 * ⚠️ 这是 fire-and-forget 的同步尾（返回 Promise 是给测试用的 await，
 *    但调用方 `void` 掉它，异常由本函数自己吞）。
 *
 * ## 为什么要调用方把 buffer / groupName 传进来
 *
 * 本模块对 `poll.js` **零依赖**（见文件头部的循环依赖说明）。
 * 群缓冲和群名都是 poll.js 的私有状态，所以由它在调用点顺手交过来：
 *
 * ```js
 * void interest.observe(ctx, groupId, message, {
 *   buffer: groupBuffer(groupId),          // 同步切一份快照，别传函数
 *   groupName: groupNames.get(groupId) ?? ''
 * })
 * ```
 *
 * ⚠️ `buffer` 必须是**数组快照**而不是 `groupBuffer` 函数本身：
 *    同一个 `groupBuffer(gid)` 在两处调用之间会被 `pushToBuffer` 追加，
 *    传函数就等于「10 分钟后再去取那时候的缓冲」—— 那时的缓冲早就不是
 *    触发那一刻的样子了（30 条上限会把前因全挤掉）。
 *
 * 三种情况直接返回：
 *   · 总开关关着 / 没有兴趣点 → 零开销；
 *   · 这条消息是她自己发的 → 那是「已经说出去的话」，不是「群里在讨论」；
 *   · 这条消息没有纯文字（纯图片/表情）→ 关键词无从命中。
 *
 * @param {object} ctx 插件 context
 * @param {string} groupId
 * @param {object} message OneBot 群消息
 * @param {object} [options] `{ buffer, groupName }` —— 由 poll.js 交过来
 */
export async function observe(ctx, groupId, message, options = {}) {
  try {
    const config = getConfig()
    if (config?.interestEnabled !== true) return
    const points = Array.isArray(config.interestPoints) ? config.interestPoints : []
    if (points.length === 0) return
    const senderUin = String(message?.sender?.user_id ?? '').trim()
    if (senderUin !== '' && senderUin === String(config.selfUin ?? '').trim()) return
    // 已经开着任务、且这条属于等待期 → 追加进 during，不再开新任务
    const appended = appendToRunningTasks(groupId, message)
    if (appended) return
    const hits = matchPointsFor(message, points, groupId)
    if (hits.length === 0) return
    let imageBlocks = null
    for (const hit of hits) {
      // 冷却与额度在**建任务时**判一次（省掉整个等待期 + 一次模型调用）。
      // 判完还会在**下发前**再判一次 —— 等待期可能有别的任务先命中同一件事。
      const allowed = admitTask(hit.point, groupId)
      if (!allowed.ok) {
        note('interest', `跳过触发 point=${hit.point.id} group=${groupId}：${allowed.why}`)
        continue
      }
      const task = createTask(ctx, hit.point, hit.word, groupId, message, {
        buffer: options.buffer,
        groupName: options.groupName
      })
      const imageSegments = imageSegmentsOf(message?.message).slice(0, 3)
      if (imageSegments.length > 0) {
        if (imageBlocks === null) {
          imageBlocks = await buildImageBlocks(ctx, [{
            sender: message?.sender,
            message: imageSegments.map((item) => item.segment)
          }], { remember: false })
        }
        task.imageBlocks = imageBlocks
        persistInterests()
      }
    }
  } catch (error) {
    // ⚠️ 绝不能抛回主链路。这里是旁路的边界。
    note('interest', `observe 抛错（已吞）：${error instanceof Error ? error.message : error}`)
  }
}

/**
 * 等待期内的消息追加到已存在的任务里。
 *
 * 判据是「同一个群、同一个兴趣点、任务还在等项目 dueAt」——
 * 不按 sender 判：别人接话才是这段功能最想要的东西。
 *
 * @returns {boolean} 有没有任何任务吃掉了这条消息
 */
function appendToRunningTasks(groupId, message) {
  const gid = String(groupId ?? '')
  let consumed = false
  const record = recordOf(message)
  if (record.text === '') return false
  for (const task of tasks.values()) {
    if (String(task.groupId ?? '') !== gid) continue
    if (Number(task.dueAt) <= nowMs()) continue
    const during = Array.isArray(task.during) ? task.during : []
    if (during.length >= DURING_MAX_MESSAGES) continue
    during.push(record)
    task.during = during
    consumed = true
  }
  if (consumed) persistThrottled()
  return consumed
}

/**
 * 建任务那一刻的准入：冷却 + 每群每日通知额度。
 *
 * 为什么在建任务时就判：等待期是 10 分钟，一个热点事件会在 10 分钟里
 * 反复命中关键词。不在这里拦，等 10 分钟后会同时冒出十几个任务，
 * 然后逐个调用模型 —— 钱花了，结论还是同一个。
 *
 * @returns {{ ok: boolean, why: string }}
 */
export function admitTask(point, groupId, at = nowMs()) {
  const config = getConfig()
  const cooldownMinutes = Number(config?.interestCooldownMinutes)
  if (Number.isFinite(cooldownMinutes) && cooldownMinutes > 0) {
    const last = Number(lastNotified[String(point?.id ?? '')] ?? 0)
    if (last > 0 && at - last < cooldownMinutes * 60_000) {
      return { ok: false, why: `冷却中（上次通知在 ${Math.round((at - last) / 60000)} 分钟前，冷却 ${cooldownMinutes} 分钟）` }
    }
  }
  const limit = Number(config?.interestDailyMaxPerGroup)
  if (Number.isFinite(limit) && limit > 0) {
    const used = Number(daily[dayKey(at)]?.perGroup?.[String(groupId ?? '')] ?? 0)
    if (used >= limit) return { ok: false, why: `这个群今天已经通知 ${used} 次（上限 ${limit}）` }
  }
  return { ok: true, why: '' }
}

/**
 * 建一条任务。
 *
 * 触发**之前**那段从群缓冲里切快照 —— 必须当场存：缓冲只有 30 条，
 * 等待期内会被新消息挤掉，10 分钟后想再取已经没有了。
 *
 * @param {object} ctx
 * @param {object} point
 * @param {string} word
 * @param {string} groupId
 * @param {object} message
 * @param {object} [options] 测试注入：`{ at, pre, groupName }`
 * @returns {object} 建出来的任务
 */
export function createTask(ctx, point, word, groupId, message, options = {}) {
  const config = getConfig()
  const at = Number(options.at ?? nowMs())
  const waitMinutes = Number.isFinite(Number(config?.interestWaitMinutes)) ? Number(config.interestWaitMinutes) : 10
  const preMinutes = Number.isFinite(Number(config?.interestPreMinutes)) ? Number(config.interestPreMinutes) : 10
  const task = {
    id: newTaskId(),
    pointId: String(point?.id ?? ''),
    groupId: String(groupId ?? ''),
    groupName: String(options.groupName ?? ''),
    triggerWord: String(word ?? ''),
    triggerSeq: Number(message?.message_seq ?? 0),
    triggerMessageId: String(message?.message_id ?? ''),
    triggerUin: String(message?.sender?.user_id ?? '').trim(),
    triggerNick: String(message?.sender?.card ?? '').trim() || String(message?.sender?.nickname ?? '').trim(),
    triggerText: textSegmentsOf(message?.message),
    triggerAt: Number(message?.time ?? 0) > 0 ? Number(message.time) * 1000 : at,
    createdAt: at,
    dueAt: at + waitMinutes * 60_000,
    pre: Array.isArray(options.pre) ? options.pre : snapshotBefore(options.buffer, message, preMinutes),
    during: [],
    imageBlocks: []
  }
  tasks.set(task.id, task)
  persistInterests()
  note('interest', `建任务 point=${task.pointId} group=${task.groupId} word=${task.triggerWord} `
    + `pre=${task.pre.length} 条，${waitMinutes} 分钟后再判`)
  return task
}

/**
 * 从调用方交来的群缓冲快照里，切「触发点之前 preMinutes 分钟」那段。
 *
 * ⚠️ `buffer` 必须是**数组快照**（调用方在同一刻 `groupBuffer(gid)` 切好），
 *    不能是函数：函数会在 10 分钟后再去取，那时的缓冲已经不是触发那一刻的样子。
 * ⚠️ 缓冲上限是 30 条（`poll.js` 的 GROUP_BUFFER_LIMIT），所以这里只能尽力而为：
 *    不够就是不够，返回实际能拿到的那些，由判定 prompt 那边交代「开头可能不全」，
 *    **不谎称完整**。传 `undefined`（老调用方 / 测试）时返回空数组，不抛错。
 */
function snapshotBefore(buffer, message, preMinutes) {
  if (!(preMinutes > 0)) return []
  if (!Array.isArray(buffer)) return []
  const triggerSeq = Number(message?.message_seq ?? 0)
  const triggerAt = Number(message?.time ?? 0) > 0 ? Number(message.time) * 1000 : nowMs()
  const from = triggerAt - preMinutes * 60_000
  const out = []
  for (const item of buffer) {
    if (item === message) continue
    const seq = Number(item?.message_seq ?? 0)
    // 只留「触发点之前」的：seq 单调时不比大小（message_id 可能是负数、seq 有 null），
    // 但缓冲里每条的 seq 是同一个协议端给的，比大小是安全的。
    if (triggerSeq > 0 && seq > 0 && seq >= triggerSeq) continue
    const at = Number(item?.time ?? 0) > 0 ? Number(item.time) * 1000 : 0
    if (at > 0 && at < from) continue
    const record = recordOf(item)
    if (record.text === '') continue
    out.push(record)
  }
  return out.slice(-DURING_MAX_MESSAGES)
}

// ---- 任务循环 --------------------------------------------------------------

/** 当前有哪些任务（测试与设置页用）。 */
export function listTasks() {
  return [...tasks.values()]
}

/** 清空全部任务（测试用；不删盘 —— 需要的话跟着 persistInterests）。 */
export function resetInterests() {
  tasks.clear()
  recent = []
  daily = {}
  lastNotified = {}
  lastPersistAt = 0
  if (loopTimer !== null) { clearTimeout(loopTimer); loopTimer = null }
}

/**
 * 扫一遍到期的任务并判定。
 *
 * ⚠️ 串行处理（一个一个 await）：判定器本身已经串行化了，
 *    这里再串行能保证「同一个群的两个任务先后判」时，
 *    后一个能看到前一个已经占用了当日额度。
 *
 * @param {object} ctx
 * @param {object} [options] `{ at, notify? }` 测试注入
 * @returns {Promise<{ judged: number, notified: number, skipped: number }>}
 */
export async function runDueTasks(ctx, options = {}) {
  const config = getConfig()
  const at = Number(options.at ?? nowMs())
  const stats = { judged: 0, notified: 0, skipped: 0 }
  if (config?.interestEnabled !== true) return stats

  // 先清僵尸：超过 TASK_MAX_AGE_MS 还没资格处理的一律丢（防止一个坏任务永远占着）。
  for (const task of [...tasks.values()]) {
    if (at - Number(task.createdAt ?? at) > TASK_MAX_AGE_MS) {
      tasks.delete(task.id)
      note('interest', `丢弃僵尸任务 ${task.id}（超过 ${TASK_MAX_AGE_MS / 3600000} 小时未判完）`)
    }
  }

  const due = [...tasks.values()]
    .filter((task) => Number(task.dueAt) <= at)
    .sort((a, b) => Number(a.dueAt) - Number(b.dueAt))
  if (due.length === 0) return stats

  for (const task of due) {
    const point = (Array.isArray(config.interestPoints) ? config.interestPoints : [])
      .find((row) => String(row?.id ?? '') === String(task.pointId ?? ''))
    // 关注点被删了 / 被关掉了 → 任务作废（不判、不通知）
    if (point === undefined || point.enabled === false) {
      tasks.delete(task.id)
      stats.skipped += 1
      note('interest', `任务作废 ${task.id}：关注点已删除或已关闭`)
      continue
    }
    // 成本硬顶：**送判之前**判。超了就不调用模型 —— 省的是钱，不是消息。
    const callLimit = Number(config.interestDailyMaxCalls)
    if (Number.isFinite(callLimit) && callLimit > 0) {
      const used = Number(daily[dayKey(at)]?.calls ?? 0)
      if (used >= callLimit) {
        tasks.delete(task.id)
        stats.skipped += 1
        note('interest', `任务丢弃 ${task.id}：今日判定调用已达上限（${used}/${callLimit}）`)
        continue
      }
    }

    // 记账调用次数（**在调用前**记）：调用失败也花了钱，得算进去。
    const key = dayKey(at)
    if (daily[key] === undefined || typeof daily[key] !== 'object') daily[key] = { calls: 0, perGroup: {} }
    if (daily[key].perGroup === null || typeof daily[key].perGroup !== 'object') daily[key].perGroup = {}
    daily[key].calls = Number(daily[key].calls ?? 0) + 1
    persistInterests()

    const trimmed = trimTask(task, Number(config.interestMaxMessages))
    const outcome = await judgeInterest(ctx, point, trimmed)
    stats.judged += 1
    // 不管判成什么，任务都结束了（同一个任务不重判：重判只会花钱拿到同一个结论）
    tasks.delete(task.id)
    persistInterests()

    if (outcome.ok !== true) {
      reportJudgeFailure(point, task, outcome.why)
      continue
    }
    if (outcome.result?.match !== true) {
      note('interest', `判定不命中 point=${point.id} group=${task.groupId}（${String(outcome.result?.reason ?? '').slice(0, 60)}）`)
      continue
    }

    // 下发前再判一次冷却 / 额度：等待期里可能有别的任务先命中了同一件事。
    const allowed = admitTask(point, task.groupId, at)
    if (!allowed.ok) {
      stats.skipped += 1
      note('interest', `命中但不下发 point=${point.id} group=${task.groupId}：${allowed.why}`)
      continue
    }
    // 内容指纹：同一件事被不同的人复述 → 只通知一次
    const fp = fingerprintOf(point.id, task.groupId, outcome.result)
    if (hasRecentFingerprint(fp, at)) {
      stats.skipped += 1
      note('interest', `命中但指纹重复，跳过 point=${point.id} group=${task.groupId} fp=${fp}`)
      continue
    }

    const delivered = await notify(ctx, point, task, outcome.result, options)
    stats.notified += delivered
    if (delivered > 0) {
      lastNotified[String(point.id)] = at
      recent.push({ fp, pointId: String(point.id), groupId: String(task.groupId), at })
      trimRecent(at)
      const bucket = daily[key]
      bucket.perGroup[String(task.groupId)] = Number(bucket.perGroup[String(task.groupId)] ?? 0) + 1
      persistInterests()
      note('interest', `已通知 point=${point.id} group=${task.groupId} fp=${fp}（${delivered} 条路）`)
    }
  }
  return stats
}

/** 把任务裁到 interestMaxMessages 条（按「离触发点最近」保留）。 */
export function trimTask(task, limit) {
  const cap = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.round(Number(limit)) : 80
  const pre = Array.isArray(task?.pre) ? task.pre.slice() : []
  const during = Array.isArray(task?.during) ? task.during.slice() : []
  const total = pre.length + 1 + during.length
  if (total <= cap) return task
  // 超了：优先丢**最老的 pre**（前因比跟进次要），再丢最老的 during
  let need = total - cap
  const cutPre = Math.min(need, pre.length)
  const keptPre = pre.slice(cutPre)
  need -= cutPre
  const keptDuring = need > 0 ? during.slice(need) : during
  return { ...task, pre: keptPre, during: keptDuring, trimmed: true }
}

function hasRecentFingerprint(fp, at) {
  return recent.some((row) => String(row?.fp ?? '') === fp && at - Number(row?.at ?? 0) < RECENT_TTL_MS)
}

function trimRecent(at) {
  recent = recent.filter((row) => at - Number(row?.at ?? 0) < RECENT_TTL_MS)
}

// ---- 下发 ------------------------------------------------------------------

function renderGroupReplyPrompt(point, task, result) {
  const question = String(result?.keyMessage?.text ?? '').trim() || String(task?.triggerText ?? '').trim()
  const instruction = String(point?.responseInstruction ?? '').trim()
  const lines = [
    '【兴趣点命中 · 请在本群直接处理】',
    `群号：${String(task?.groupId ?? '')}`,
    `关注点：${String(point?.label ?? '').trim() || '未命名'}`,
    '',
    '这是插件在判定命中后派发给你的工作，不是群友新发的一条消息。请按下面的执行指令处理所附图片和聊天上下文。',
    '',
    '【执行指令】',
    instruction,
    '',
    '不要复述兴趣点判定、监控过程或这条系统任务；不要私聊。最终答复会自动发回上面的群并引用触发消息，不要调用 qq_send。信息不足时说明缺少什么，不要猜测或编造。',
    '',
    `判定摘要：${String(result?.summary ?? '').trim()}`,
    `核心消息：${question}`
  ]
  const related = Array.isArray(result?.related) ? result.related : []
  for (const row of related.slice(0, 4)) {
    const text = String(row?.text ?? '').trim()
    if (text !== '') lines.push(`群聊补充：${text}`)
  }
  if (Array.isArray(task?.imageBlocks) && task.imageBlocks.length > 0) {
    lines.push(`原题图片：已附 ${task.imageBlocks.length} 张，请按执行指令处理图片内容。`)
  }
  return lines.join('\n')
}

/**
 * 把命中结果发出去。
 *
 * 私聊通知仍由两个全局开关控制；每个兴趣点还可以单独启用群内答题。
 * 群答题只对这条投递设置 forceForward，不会打开全局群自动转发。
 */
export async function notify(ctx, point, task, result, options = {}) {
  const config = getConfig()
  const text = renderInterestNotice(point, task, result)
  let delivered = 0

  if (options.notify === false) return 0

  if (point?.replyInGroup === true) {
    const condition = String(point?.description ?? '').trim()
    const instruction = String(point?.responseInstruction ?? '').trim()
    if (condition === '' || instruction === '') {
      note('interest', `群内回应跳过 point=${point?.id ?? ''}：判定条件或执行指令为空`)
    } else try {
      const { deliver, pickSessionId } = await import('./deliver.js')
      const groupId = String(task?.groupId ?? '').trim()
      const sessionId = groupId === '' ? '' : pickSessionId(config, 'group', groupId)
      if (sessionId === '') {
        note('interest', `群内回应跳过：群 ${groupId || '(empty)'} 没有绑定会话`)
      } else {
        const used = await deliver(
          ctx,
          sessionId,
          renderGroupReplyPrompt(point, task, result),
          { kind: 'group', id: groupId },
          Array.isArray(task?.imageBlocks) ? task.imageBlocks : [],
          { forceForward: true, replyTo: String(task?.triggerMessageId ?? '') }
        )
        if (used === '') {
          note('interest', `群内回应投递失败 group=${groupId} session=${sessionId}`)
        } else {
          delivered += 1
          note('interest', `群内答题已投进群会话 group=${groupId} session=${used}`)
        }
      }
    } catch (error) {
      note('interest', `群内回应失败（已吞）：${error instanceof Error ? error.message : error}`)
    }
  }

  if (config?.interestNotifySelf !== false) {
    try {
      // 动态 import：outbound.js 依赖链很长（rhythm/onebot/window/notice），
      // 顶层 import 会把这个模块卷进一条很长的初始化链，而它只在通知时才需要。
      const { sendToQQ } = await import('./outbound.js')
      const { privateRouteTarget } = await import('./notice.js')
      const target = privateRouteTarget()
      if (target === null) {
        note('interest', `要通知主人，但没配 ownerUin / peerUin，${text.length} 字丢弃`)
      } else {
        await sendToQQ(target, text)
        delivered += 1
        note('out', `兴趣点通知已发私聊 ${text.length} 字 -> ${target.id}`)
      }
    } catch (error) {
      note('interest', `兴趣点私聊通知失败（已吞）：${error instanceof Error ? error.message : error}`)
    }
  }

  if (config?.interestNotifySession === true) {
    try {
      const { deliver } = await import('./deliver.js')
      const { pickSessionId } = await import('./deliver.js')
      // ⚠️ 只投**主人私聊**对应的会话，**绝不兜底**到别的会话。
      //    收件人就是 privateRouteTarget 那个号；拿不到会话就放弃（同 deliver 的归档纪律）。
      const { privateRouteTarget } = await import('./notice.js')
      const target = privateRouteTarget()
      const sessionId = target === null ? '' : pickSessionId(config, 'private', target.id)
      if (sessionId === '') {
        note('interest', '路 B 跳过：没有绑定主人私聊会话')
      } else {
        // ⚠️ 首行必须写明「这是插件上报的事件，不是主人在说话」——
        //    否则主会话会以为主人在跟自己聊天，反过来问她。
        const material = [
          '【插件上报 · 兴趣点命中】',
          '下面这段不是主人说的话，是插件替主人盯着群时发现的情况。请据此给主人一条提醒（可以更自然一些，但不要编造细节）。',
          '',
          text
        ].join('\n')
        const used = await deliver(ctx, sessionId, material, { kind: 'private', id: target.id }, [])
        if (used === '') {
          note('interest', '路 B 投递失败（会话不可用 / 已归档）')
        } else {
          delivered += 1
          note('interest', `路 B 已投进主人会话 ${used}`)
        }
      }
    } catch (error) {
      note('interest', `兴趣点会话投递失败（已吞）：${error instanceof Error ? error.message : error}`)
    }
  }

  return delivered
}

// ---- 循环 ------------------------------------------------------------------

/** 扫描间隔：比「分钟级等待」细一点就够，不必每秒扫。 */
export const LOOP_INTERVAL_MS = 30_000

/**
 * 起兴趣点循环。返回停止函数。
 *
 * 启动时先 `loadInterests()` 把盘上的任务接回来，**已经过期的立刻进队列** ——
 * 这正是「重启后不丢通知」的全部实现。
 *
 * ⚠️ 循环里任何异常都必须吞掉：一个抛错会让 `setTimeout` 链断掉，
 *    于是这个功能**永久静默**，而日志里可能只有一行看不懂的栈。
 */
export function startInterestLoop(ctx) {
  stopInterestLoop()
  loadInterests()
  let stopped = false
  const tick = async () => {
    if (stopped) return
    try {
      await runDueTasks(ctx)
    } catch (error) {
      note('interest', `循环抛错（已吞，下一轮继续）：${error instanceof Error ? error.message : error}`)
    }
    if (stopped) return
    loopTimer = setTimeout(tick, LOOP_INTERVAL_MS)
    // ⚠️ unref：这个定时器不该把 Node 进程吊住（测试进程会因为一个活的
    //    setTimeout 永远退不出去，现象是「测试卡死」而不是「测试失败」）。
    if (typeof loopTimer.unref === 'function') loopTimer.unref()
  }
  loopTimer = setTimeout(tick, 0)
  if (typeof loopTimer.unref === 'function') loopTimer.unref()
  note('interest', `兴趣点循环已启动 interval=${LOOP_INTERVAL_MS}ms 待判任务=${tasks.size}`)
  return stopInterestLoop
}

export function stopInterestLoop() {
  if (loopTimer !== null) {
    clearTimeout(loopTimer)
    loopTimer = null
  }
}

/** 汇总（设置页显示「待判几个 / 今天判了几次」用）。 */
export function interestSummary() {
  const at = nowMs()
  return {
    tasks: tasks.size,
    dueSoon: [...tasks.values()].filter((task) => Number(task.dueAt) - at < 60_000).length,
    callsToday: Number(daily[dayKey(at)]?.calls ?? 0),
    notifiedToday: Object.values(daily[dayKey(at)]?.perGroup ?? {}).reduce((sum, n) => sum + Number(n ?? 0), 0),
    recent: recent.length
  }
}