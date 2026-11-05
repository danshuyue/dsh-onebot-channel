/**
 * progress.js —— 跨工作区 / 跨会话的「进度」只读聚合。
 *
 * 为什么要有这个（2026-11-05 用户需求）：
 *   QQ 桥接是严格会话绑定的：你从 QQ 发的话只会进那一个会话，
 *   而别的工作区在干什么、干到哪一步，你完全看不见。
 *   于是想要「在 QQ 里问一句『那边进度如何』」这件事，压根没有数据来源。
 *
 * 数据从哪来（**实测可用，且零成本**）：
 *   ① ~/.dsh/storages/session_projcache.json
 *      DSH 自己的投影缓存（由 dsh-session-projection-cache 写盘）。
 *      每个会话一份 rows，里面有：
 *        sessionStats  { turns, steps, lastTurn, openStep, pendingCalls, llmMs, toolMs }
 *        title         { val }
 *        todos         { val: [{content, status}] }
 *        goal          { val }
 *        tokenUsage    { totals, last }
 *        contextPressure { surfaceTokens, contextWindow, pressureTokens }
 *        permissions   { preset, sandbox, approval }
 *      本机实测 112 个会话，字段齐全，纯 JSON。
 *   ② ~/.dsh/storages/workspace.json
 *      tables.workspaces[wsId] = { path, title, sessionIds[], createdAt, updatedAt }
 *      global.archivedSessionIds = 归档集合 —— 有这一个就能跨工作区枚举。
 *      本机实测 48 个工作区。
 *
 * ⚠️ 三条铁律（违反任何一条都会出真事故）：
 *   1. **绝不 agents.resume()。** resume 会真的建出一个 agent，
 *      可能抢走 GUI 已打开会话的写句柄。读进度只用免副作用的路径：
 *      `agents.get(id)`（只查活着的，查不到就是查不到）+ 读盘。
 *   2. **绝不写盘。** 这个模块全程只读。投影缓存是 DSH 的，写坏了没人修。
 *   3. **读失败一律降级成「没有数据」，绝不抛。** 进度是锦上添花的功能，
 *      不能让一个坏掉的 JSON 把整条投递链路拖垮（跟 archive.js 同口径）。
 *
 * 时效说明：投影缓存是 write-behind（`writeEveryEvents: 200` / `writeIntervalMs: 5000`），
 * 所以最多滞后 5 秒 + 200 个事件。界面上必须注明，别让人以为卡住了。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DATA_DIR, note, serviceOf } from './env.js'
import { archivedSessionIds } from './archive.js'
import { encodeCwdDir, normCwd } from './title.js'

const PROJCACHE_LEGACY_FILE = `${DATA_DIR}/storages/session_projcache.json`
const PROJCACHE_DIR = `${DATA_DIR}/storages/session_projcache/sessions`
const WORKSPACE_FILE = `${DATA_DIR}/storages/workspace.json`
const SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions')

/**
 * 一次最多读多少个投影文件（按 mtime 取最新的）。
 *
 * 1113 个全读 = 776ms 同步 IO，会把宿主事件循环钉死。
 * 200 个足够覆盖「正在跑 + 最近一周活跃」；不够用时再调。
 */
const PROGRESS_SCAN_LIMIT = 200

/**
 * 缓存。`/进度` 是一次人工操作（不是消息热路径），但一次可能列十几个会话，
 * 每个都去读一遍几百 KB 的 JSON 就太可惜了 —— 按 (size, mtime) 缓存，变了才重读。
 */
const CACHE_MS = 3000
let projCache = { at: 0, key: '', data: null }
let wsCache = { at: 0, key: '', data: null }
/** 读失败只记一次日志，别每次 `/进度` 都刷一行。 */
const warned = new Set()
function warnOnce(tag, message) {
  if (warned.has(tag)) return
  warned.add(tag)
  note('progress', message)
}

/** 测试用：清掉缓存与「已警告」记录。 */
export function invalidateProgressCache() {
  projCache = { at: 0, key: '', data: null }
  wsCache = { at: 0, key: '', data: null }
  warned.clear()
}

/** 按 (size, mtime) 判断文件是否变化；读不到 → 空 key。 */
function stampOf(file) {
  try {
    const stat = statSync(file)
    return `${stat.size}:${Math.round(stat.mtimeMs)}`
  } catch {
    return ''
  }
}

/**
 * 读投影缓存。
 *
 * ⚠️⚠️ 数据在**两个地方**，而且旧的那个早已不写（2026-11-05 实测踩到）：
 *   · `storages/session_projcache/sessions/<sessionId>.json`  ← **活的**
 *     单文件 per-record 布局，本机 1113 个，当前会话每隔几秒就写一次。
 *     形状：`{ version: 7, record: { identity, rows } }`
 *   · `storages/session_projcache.json`                        ← **陈旧的**
 *     单文件汇总布局 `{ unit, global, tables: { sessions: { id: {identity,rows} } } }`，
 *     本机 mtime 停在 9 月 10 日、两个月没动。
 *   一开始只读了后者，结果 `/进度` 里全是 9 月的僵尸数据，
 *   而且「48 小时内有写盘的会话 = 0」。所以**必须以目录为主、旧文件只做兜底**。
 *
 * 返回 `{ sessions: Map<id, { identity, rows, source }>, unit }`；读不到就空表。
 */
export function readProjCache() {
  const now = Date.now()
  // ⚠️ 缓存键**不能**带目录 mtime（2026-11-05 实测）：
  //   活跃会话每秒都在重写投影文件，Windows 上重写会让父目录 mtime 一直变，
  //   于是缓存每次都失效 → 每调一次都重读 200 个文件（226ms）。
  //   `/进度` 的用途本来就允许几秒延迟，所以这里就是**纯时间窗缓存**。
  if (projCache.data !== null && now - projCache.at < CACHE_MS) return projCache.data

  const sessions = new Map()
  // ---- 主来源：per-record 目录 ----
  readProjCacheDir(sessions)
  // ---- 兜底：老的汇总文件（新布局里没有的会话才补进来）----
  readProjCacheLegacy(sessions)

  if (sessions.size === 0) {
    warnOnce(
      'projcache-missing',
      `读不到投影缓存（当作无进度数据）：${PROJCACHE_DIR} 与 ${PROJCACHE_LEGACY_FILE} 都不可用`
    )
  }
  const data = { sessions, unit: null }
  projCache = { at: now, key: 'time', data }
  return data
}

function readProjCacheDir(sessions) {
  let names
  try {
    names = readdirSync(PROJCACHE_DIR)
  } catch {
    return
  }
  // ⚠️ 性能（2026-11-05 实测）：1113 个文件全读一遍要 776ms。
  //   `/进度` 虽然是人工操作，但 0.8 秒的同步 IO 会把整个宿主事件循环钉住
  //   （这期间 QQ 消息、WS 事件全部排队）。所以**先按 mtime 排序，只读最近的 N 个**：
  //   「在跑 / 最近活跃」这两个用途本来就不关心三个月前的会话。
  //   要全量看历史时把 PROGRESS_SCAN_LIMIT 调大或走 includeIdle 之外的路。
  const stamped = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const id = name.slice(0, -'.json'.length)
    if (id === '') continue
    let mtime = 0
    try {
      mtime = statSync(join(PROJCACHE_DIR, name)).mtimeMs
    } catch {
      continue
    }
    stamped.push({ id, name, mtime })
  }
  stamped.sort((a, b) => b.mtime - a.mtime)
  for (const item of stamped.slice(0, PROGRESS_SCAN_LIMIT)) {
    let raw
    try {
      raw = JSON.parse(readFileSync(join(PROJCACHE_DIR, item.name), 'utf8'))
    } catch {
      // 正在写 / 半截 —— 跳过这一个，别连累其他会话
      continue
    }
    // 新布局：{ version, record: { identity, rows } }
    // 也兼容直接 { identity, rows }
    const record = raw?.record ?? raw
    if (record === null || typeof record !== 'object') continue
    const rows = record.rows
    if (rows === null || typeof rows !== 'object') continue
    sessions.set(item.id, {
      identity: record.identity !== null && typeof record.identity === 'object' ? record.identity : {},
      rows,
      source: 'record',
      // 投影文件自己的 mtime 就是「这个会话最后一次被写盘」，
      // 比再去 sessions/<cwd>/<id>/ 里 stat 一次日志便宜得多，语义也等价。
      mtime: item.mtime
    })
  }
}

function readProjCacheLegacy(sessions) {
  if (!existsSync(PROJCACHE_LEGACY_FILE)) return
  let raw
  try {
    raw = JSON.parse(readFileSync(PROJCACHE_LEGACY_FILE, 'utf8'))
  } catch (error) {
    warnOnce(
      `projcache-legacy-bad:${stampOf(PROJCACHE_LEGACY_FILE)}`,
      `旧投影缓存解析失败（已跳过，不影响新布局）：${error instanceof Error ? error.message : error}`
    )
    return
  }
  const table = raw?.tables?.sessions
  if (table === null || typeof table !== 'object' || Array.isArray(table)) return
  for (const [id, entry] of Object.entries(table)) {
    if (id === '' || entry === null || typeof entry !== 'object') continue
    if (sessions.has(id)) continue // 新布局优先
    sessions.set(id, {
      identity: entry.identity !== null && typeof entry.identity === 'object' ? entry.identity : {},
      rows: entry.rows !== null && typeof entry.rows === 'object' ? entry.rows : {},
      source: 'legacy'
    })
  }
}

/**
 * 读工作区注册表： `{ workspaces: [{ id, path, title, sessionIds[], updatedAt }], archived: Set }`。
 * 读不到就空表（`/进度` 会退化成「只按会话自己的 cwd 分组」）。
 */
export function readWorkspaces() {
  const key = stampOf(WORKSPACE_FILE)
  const now = Date.now()
  if (wsCache.data !== null && wsCache.key === key && now - wsCache.at < CACHE_MS) return wsCache.data

  const empty = { workspaces: [], archived: new Set() }
  if (key === '' || !existsSync(WORKSPACE_FILE)) {
    warnOnce('workspace-missing', `读不到工作区注册表（当作无工作区分组）：${WORKSPACE_FILE}`)
    wsCache = { at: now, key: '', data: empty }
    return empty
  }
  try {
    const raw = JSON.parse(readFileSync(WORKSPACE_FILE, 'utf8'))
    const table = raw?.tables?.workspaces
    const workspaces = []
    if (table !== null && typeof table === 'object' && !Array.isArray(table)) {
      for (const [id, entry] of Object.entries(table)) {
        if (entry === null || typeof entry !== 'object') continue
        const path = String(entry.path ?? '')
        const sessionIds = Array.isArray(entry.sessionIds) ? entry.sessionIds.map(String).filter((value) => value !== '') : []
        workspaces.push({
          id,
          path,
          title: String(entry.title ?? '') || path.split(/[\\/]/).filter(Boolean).pop() || id,
          sessionIds,
          updatedAt: String(entry.updatedAt ?? entry.createdAt ?? '')
        })
      }
    }
    const data = { workspaces, archived: archivedSessionIds() }
    wsCache = { at: now, key, data }
    return data
  } catch (error) {
    warnOnce(`workspace-bad:${key}`, `工作区注册表解析失败（当作无工作区分组）：${error instanceof Error ? error.message : error}`)
    wsCache = { at: now, key, data: empty }
    return empty
  }
}

/** 从 row 里取 `{ ver, seq, val }` 的 val（老格式没有包装就直接是值）。 */
function rowVal(row) {
  if (row === null || row === undefined) return undefined
  if (typeof row === 'object' && row !== null && 'val' in row) return row.val
  return row
}

/** 从 row 里取写盘时的 seq（排「谁更新」用）。 */
function rowSeq(row) {
  const seq = Number(row?.seq)
  return Number.isFinite(seq) ? seq : 0
}

/**
 * 这个会话现在是不是在跑。
 *
 * 两级判定，**顺序不能反**：
 *   ① `agents.get(id)?.status === 'running'` —— 权威。但只对「活着的」会话有效，
 *      没打开的会话查不到（返回 undefined），不能因此断定它「没在跑」。
 *   ② 投影启发式：`openStep != null`（有一步开着）或 `pendingCalls` 非空（有工具调用没结算）。
 *
 * ⚠️ 绝不为了判这个而 `agents.resume()`：那会建出真 agent、抢写句柄。
 *
 * ⚠️⚠️ 启发式**必须配新鲜度**（2026-11-05 实测踩到）：
 *   本机有个会话 10 月 4 日崩在半路，`pendingCalls` 就一直留在那儿没结算。
 *   只按 `pendingCalls` 判，它能「运行中」一个月 —— `/进度` 第一条永远是个僵尸，
 *   而且会让用户以为那个工作区还在干活。
 *   所以启发式只在该会话「最近还在动」（`freshMs` 内有写盘）时才采信，
 *   否则一律按 idle 处理（日志里点名，方便排障）。
 */
const HEURISTIC_FRESH_MS = 10 * 60 * 1000

function runningOf(ctx, sessionId, stats, lastActiveAt) {
  try {
    const agents = serviceOf(ctx, 'agents')
    if (agents !== null && agents !== undefined && typeof agents.get === 'function') {
      const agent = agents.get(sessionId)
      if (agent !== null && agent !== undefined) {
        const status = String(agent.status ?? '')
        if (status === 'running') return 'running'
        if (status !== '') return 'idle'
      }
    }
  } catch {
    /* 取不到就退回启发式 */
  }
  const fresh = Number(lastActiveAt) > 0 && Date.now() - Number(lastActiveAt) <= HEURISTIC_FRESH_MS
  const pending = stats?.pendingCalls
  const hasPending = pending !== null && pending !== undefined && typeof pending === 'object' && Object.keys(pending).length > 0
  const openStep = stats?.openStep
  const hasOpenStep = openStep !== null && openStep !== undefined && openStep !== ''
  if (!hasPending && !hasOpenStep) return 'idle'
  if (fresh) return 'running'
  // 有残留但很久没动 → 那是崩在路上的残骸，不是「还在跑」
  warnOnce(
    `stale:${sessionId}`,
    `会话 ${sessionId} 投影里有未结算的步骤/调用，但 ${Math.round((Date.now() - Number(lastActiveAt)) / 3600000)} 小时没写盘 —— 按 idle 处理（不是运行中）`
  )
  return 'idle'
}

/** todo 摘要：总数 / 完成数 / 当前那条。 */
function todosOf(row) {
  const list = rowVal(row)
  if (!Array.isArray(list)) return { total: 0, done: 0, current: '', items: [] }
  const items = list
    .filter((item) => item !== null && typeof item === 'object')
    .map((item) => ({ content: String(item.content ?? '').trim(), status: String(item.status ?? '') }))
    .filter((item) => item.content !== '')
  const done = items.filter((item) => item.status === 'completed').length
  const current = items.find((item) => item.status === 'in_progress') ?? items.find((item) => item.status !== 'completed')
  return { total: items.length, done, current: current?.content ?? '', items }
}

/**
 * 一个会话的进度摘要。
 *
 * @param ctx 宿主上下文（可为 null —— 纯读盘时不需要）
 * @param sessionId 会话 id
 * @param workspaceIndex 可选；不传就自己建一份（每次建索引要读一次 worktables，
 *        所以**批量调用时请显式传入**，别在循环里让它自己建）
 * @returns {{
 *   sessionId, title, cwd, workspaceTitle,
 *   running: boolean, state: 'running'|'idle'|'unknown',
 *   turns, steps, lastTurn, seq, todos, goal, tokens, context, permissions, hasData
 * }}
 */
export function readSessionDigest(ctx, sessionId, workspaceIndex) {
  const id = String(sessionId ?? '')
  // 不传索引就现建一份：调用方漏传时不能让 workspaceTitle 静默变空
  // （实测就是这么踩的 —— 单测里只传两个参数，工作区标题永远为空，
  //   而生产路径传了三个所以看不出来。这种「两条调用路径行为不一致」最难查。）
  const index = workspaceIndex ?? buildWorkspaceIndex(readWorkspaces().workspaces)
  const { sessions } = readProjCache()
  const entry = sessions.get(id)
  const rows = entry?.rows ?? {}
  const identity = entry?.identity ?? {}
  const stats = rowVal(rows.sessionStats)
  const tokens = rowVal(rows.tokenUsage)
  const pressure = rowVal(rows.contextPressure)
  const permissions = rowVal(rows.permissions)
  const todos = todosOf(rows.todos)
  const goalVal = rowVal(rows.goal)
  const cwd = String(identity.cwd ?? '')
  // legacy 条目（两个月没更新的汇总文件）**不做任何 stat**：
  //   ① 它们本来就只该当「历史兜底」，出现在「最近活跃」里是错的；
  //   ② 一百多个 legacy 会话每个 stat 一次会话日志目录，白白吃掉几十毫秒。
  const lastActiveAt = entry?.source === 'legacy' ? 0 : lastActiveOf(id, cwd, entry?.mtime)

  const state = entry === undefined ? 'unknown' : runningOf(ctx, id, stats, lastActiveAt)
  const seq = Math.max(rowSeq(rows.sessionStats), rowSeq(rows.title), rowSeq(rows.todos), rowSeq(rows.goal))

  return {
    sessionId: id,
    title: String(rowVal(rows.title) ?? '') || (id.startsWith('session-') ? id.slice(8, 16) : id.slice(0, 8)),
    cwd,
    workspaceTitle: workspaceIndex?.titleOf?.(cwd) ?? '',
    running: state === 'running',
    state,
    lastActiveAt,
    turns: Number(stats?.turns) || 0,
    steps: Number(stats?.steps) || 0,
    lastTurn: Number(stats?.lastTurn) || 0,
    seq,
    todos,
    goal: goalVal === null || goalVal === undefined ? '' : String(goalVal).slice(0, 200),
    tokens: {
      in: Number(tokens?.totals?.uncachedInputTokens) || 0,
      out: Number(tokens?.totals?.outputTokens) || 0,
      cacheRead: Number(tokens?.totals?.cacheReadTokens) || 0
    },
    context: {
      surface: Number(pressure?.surfaceTokens) || 0,
      window: Number(pressure?.contextWindow) || 0,
      pressure: Number(pressure?.pressureTokens) || 0
    },
    permissions: {
      preset: String(permissions?.preset ?? ''),
      sandbox: String(permissions?.sandbox ?? ''),
      approval: String(permissions?.approval ?? '')
    },
    hasData: entry !== undefined
  }
}

/**
 * 会话的「最后活动时间」（毫秒）。0 = 不知道。
 *
 * ⚠️ 优先级：**日志文件 mtime > 投影文件 mtime > 目录 mtime**（2026-11-05 实测后定的）。
 *   · 投影文件的 mtime 只是「投影什么时候被写过」，语义上近似但更粗；
 *   · 会话日志 `session.v4.jsonl.zstd` 一有回合就追加，才是真实的「这个会话动过」；
 *   · 会话**目录**的 mtime 最不可信：往已有文件里追加内容不会更新父目录的 mtime
 *     （实测本工作区：目录 04:15、日志 16:01）。
 *
 * knownMtime（投影文件 mtime）只当兜底：日志读不到时才用。
 */
const LOG_NAME = 'session.v4.jsonl.zstd'
export function lastActiveOf(sessionId, cwd, knownMtime) {
  const id = String(sessionId ?? '')
  if (id === '' || String(cwd ?? '') === '') {
    const known = Number(knownMtime)
    return Number.isFinite(known) && known > 0 ? known : 0
  }
  const dir = join(SESSIONS_ROOT, encodeCwdDir(String(cwd)), id)
  try {
    return statSync(join(dir, LOG_NAME)).mtimeMs
  } catch {
    /* 没有标准命名的日志（老格式 / 空壳会话）→ 依次退回 */
  }
  const known = Number(knownMtime)
  if (Number.isFinite(known) && known > 0) return known
  try {
    return statSync(dir).mtimeMs
  } catch {
    return 0
  }
}

/**
 * 全量进度视图（`/进度` 的数据源）。
 *
 * @param ctx 宿主上下文
 * @param options {
 *   cwd?: string          只看这个工作区（归一化后比较）
 *   limit?: number        最多返回几条（默认取 config.progressMaxRows）
 *   idleWindowMs?: number 「最近活跃」的时间窗，默认 24 小时
 *   includeIdle?: boolean 不限「最近」，全给
 *   includeArchived?: boolean 归档会话是否参与（默认 false）
 * }
 * @returns {{ running: Digest[], recent: Digest[], total: number, archivedSkipped: number }}
 *
 * 排序：
 *   在跑的一律按「最后活动时间」降序；
 *   其余同样降序，且只保留 idleWindowMs 内更新过的。
 *   **不按「谁最后说话」给任何路由暗示** —— 这个函数只负责展示。
 */
export function listProgress(ctx, options = {}) {
  const limitRaw = Number(options.limit)
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(200, Math.floor(limitRaw)) : 12
  const idleWindowMs = Number(options.idleWindowMs) > 0 ? Number(options.idleWindowMs) : 24 * 60 * 60 * 1000
  const wantCwd = String(options.cwd ?? '') === '' ? '' : normCwd(options.cwd)
  const includeArchived = options.includeArchived === true

  const { sessions } = readProjCache()
  const { workspaces, archived } = readWorkspaces()
  const index = buildWorkspaceIndex(workspaces)
  const now = Date.now()

  const running = []
  const recent = []
  let archivedSkipped = 0
  for (const [id, entry] of sessions) {
    if (!includeArchived && archived.has(id)) {
      archivedSkipped += 1
      continue
    }
    const cwd = String(entry?.identity?.cwd ?? '')
    if (wantCwd !== '' && normCwd(cwd) !== wantCwd) continue
    const digest = readSessionDigest(ctx, id, index)
    // legacy 条目（两个月没更新的汇总文件）不参与「最近活跃」：
    //   它们连日志都可能早被清掉了，出现在活跃列表里只会误导。
    if (entry?.source === 'legacy' && options.includeIdle !== true) continue
    if (digest.running) running.push(digest)
    else if (options.includeIdle === true) recent.push(digest)
    else if (digest.lastActiveAt > 0 && now - digest.lastActiveAt <= idleWindowMs) recent.push(digest)
  }
  // 主序：最后活动时间；次序：seq（同一秒内的多次写盘也能排出先后）
  const byActivity = (a, b) => (b.lastActiveAt - a.lastActiveAt) || (b.seq - a.seq)
  running.sort(byActivity)
  recent.sort(byActivity)

  return {
    running: running.slice(0, limit),
    recent: recent.slice(0, limit),
    total: running.length + recent.length,
    archivedSkipped
  }
}

/**
 * 按 cwd → 工作区标题建索引，同时给出「某个会话属于哪个工作区」。
 * 会话的 cwd 与工作区 path 都用 normCwd 归一化后比。
 */
export function buildWorkspaceIndex(workspaces) {
  const byPath = new Map()
  const bySession = new Map()
  for (const ws of workspaces) {
    const key = normCwd(ws.path)
    if (key !== '') {
      const old = byPath.get(key)
      // 同一目录可能有多个工作区记录（重新添加过）；留 sessionIds 多的那个，
      // 它更可能是用户真正在用的。
      if (old === undefined || ws.sessionIds.length > old.sessionIds.length) byPath.set(key, ws)
    }
    for (const id of ws.sessionIds) bySession.set(id, ws)
  }
  return {
    titleOf(cwd) {
      const key = normCwd(cwd)
      if (key === '') return ''
      return byPath.get(key)?.title ?? ''
    },
    workspaceOf(sessionId) {
      return bySession.get(String(sessionId ?? '')) ?? null
    },
    list: workspaces
  }
}

/** 一句话摘要 —— 给推送 / 标签用，控制在 ~60 字。 */
export function describeOneLine(digest) {
  if (digest === null || digest === undefined) return ''
  const parts = []
  if (digest.workspaceTitle !== '') parts.push(digest.workspaceTitle)
  if (digest.title !== '') parts.push(digest.title)
  let line = parts.join('·')
  if (digest.running) {
    line += ` · 运行中${digest.lastTurn > 0 ? ` 第 ${digest.lastTurn} 轮` : ''}`
  } else if (digest.lastTurn > 0) {
    line += ` · 第 ${digest.lastTurn} 轮`
  }
  if (digest.todos.total > 0) line += ` · 待办 ${digest.todos.done}/${digest.todos.total}`
  return line
}
