/**
 * progress-sim.mjs —— 进度聚合 + 命令层的单元/集成测试。
 *
 * 用隔离 HOME（run-isolated.mjs 已替你把 HOME 指到临时目录），
 * 在这个 HOME 下造一批假的投影缓存 / 工作区注册表 / 会话日志 mtime，
 * 然后断言 progress.js 与 commands.js 的行为。
 *
 * ⚠️ 这个文件**不碰真实 ~/.dsh**：DATA_DIR 是 env.js 在 import 时按 HOME 算出来的，
 *   所以只要 HOME 被 run-isolated 改过，读写就都在临时目录里。
 *   直接 `node tests/progress-sim.mjs` 跑的话会碰真实目录 —— 别那么干。
 */
import { mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = homedir()
const DATA = join(HOME, '.dsh')
const PROJDIR = join(DATA, 'storages', 'session_projcache', 'sessions')
const SESSROOT = join(DATA, 'sessions')

let pass = 0
let fail = 0
const failures = []
function ok(cond, label) {
  if (cond) {
    pass += 1
    return
  }
  fail += 1
  failures.push(label)
  console.log(`  ✗ ${label}`)
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  ok(a === e, `${label}（期望 ${e}，实际 ${a}）`)
}

/** 造一个投影记录文件。 */
function writeRecord(id, { cwd, title, turns = 1, lastTurn = 1, openStep = null, pendingCalls = {}, todos = null, goal = null, tokens = null }) {
  const record = {
    version: 7,
    record: {
      identity: { formatVersion: 4, createdAt: Date.now() - 100000, cwd, isSeeded: false, inheritedEventCount: 0 },
      rows: {
        title: { ver: 1, seq: 10, val: title },
        sessionStats: { ver: 1, seq: 10, val: { turns, steps: 5, lastTurn, openStep, pendingCalls } },
        todos: { ver: 2, seq: 10, val: todos },
        goal: { ver: 4, seq: 10, val: goal }
      }
    }
  }
  if (tokens !== null) {
    record.record.rows.tokenUsage = { ver: 1, seq: 10, val: { totals: tokens } }
    record.record.rows.contextPressure = { ver: 4, seq: 10, val: { surfaceTokens: 1000, contextWindow: 100000, pressureTokens: 5000 } }
  }
  writeFileSync(join(PROJDIR, `${id}.json`), JSON.stringify(record), 'utf8')
}

/** 造一份工作区注册表。 */
function writeWorkspaces(list, archived = []) {
  const table = {}
  for (const item of list) {
    table[item.id] = { path: item.path, title: item.title, sessionIds: item.sessionIds ?? [], createdAt: '', updatedAt: '' }
  }
  writeFileSync(
    join(DATA, 'storages', 'workspace.json'),
    JSON.stringify({ unit: { name: 'workspace', version: 1 }, global: { archivedSessionIds: archived }, tables: { workspaces: table } }),
    'utf8'
  )
}

/** 给某个会话造日志文件并设置 mtime（判「最近活跃」用它）。 */
function touchLog(sessionId, cwd, mtimeMs) {
  // 复用 title.js 的编码规则：这里直接 import 会更准，但为了不引入顺序依赖，手动实现一份
  const body = String(cwd)
    .replace(/[:\\/]+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, (ch) => '~' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'))
  const dir = join(SESSROOT, `--${body}--`, sessionId)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, 'fake', 'utf8')
  const secs = mtimeMs / 1000
  utimesSync(file, secs, secs)
}

function reset() {
  rmSync(join(DATA, 'storages', 'session_projcache'), { recursive: true, force: true })
  mkdirSync(PROJDIR, { recursive: true })
  rmSync(join(DATA, 'storages', 'workspace.json'), { force: true })
  rmSync(SESSROOT, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------

const WS_A = 'D:\\work\\CMPOR'
const WS_B = 'D:\\work\\VideoPlugin'

async function main() {
  reset()
  const now = Date.now()
  const { invalidateProgressCache, listProgress, readSessionDigest, readProjCache, buildWorkspaceIndex, readWorkspaces } = await import('../lib/progress.js')

  // ---- 造数据 ----
  writeRecord('session-run', {
    cwd: WS_A, title: '评估算法重写', turns: 88, lastTurn: 88,
    openStep: { turn: 88, step: 3 }, todos: [
      { content: '读交接文档', status: 'completed' },
      { content: '重写 RATE', status: 'completed' },
      { content: '跑 A/B 对比', status: 'in_progress' },
      { content: '写报告', status: 'pending' }
    ],
    goal: '把评估算法换成三扫描', tokens: { uncachedInputTokens: 1000, outputTokens: 200, cacheReadTokens: 3000 }
  })
  touchLog('session-run', WS_A, now - 30_000)

  writeRecord('session-idle', {
    cwd: WS_A, title: '主分支 (1)', turns: 204, lastTurn: 204, openStep: null
  })
  touchLog('session-idle', WS_A, now - 3 * 3600_000)

  writeRecord('session-old', {
    cwd: WS_B, title: '很久以前', turns: 3, lastTurn: 3, openStep: null
  })
  touchLog('session-old', WS_B, now - 10 * 86_400_000)

  // 僵尸：有残留 pendingCalls 但三个月没写盘 —— 必须判成 idle
  writeRecord('session-stale', {
    cwd: WS_B, title: '崩在半路', turns: 11, lastTurn: 11,
    openStep: { turn: 11, step: 2 }, pendingCalls: { call_x: now - 90 * 86_400_000 }
  })
  touchLog('session-stale', WS_B, now - 90 * 86_400_000)

  writeRecord('session-archived', { cwd: WS_B, title: '已归档', turns: 1, lastTurn: 1 })
  touchLog('session-archived', WS_B, now - 60_000)

  writeWorkspaces(
    [
      { id: 'ws-a', path: WS_A, title: 'CreateCMPOR', sessionIds: ['session-run', 'session-idle'] },
      { id: 'ws-b', path: WS_B, title: '视频插件', sessionIds: ['session-old', 'session-stale'] }
    ],
    ['session-archived']
  )

  const ctx = { get: () => undefined }
  invalidateProgressCache()

  // ---- 1. 读得到 ----
  const cache = readProjCache()
  ok(cache.sessions.size >= 5, '投影缓存能读到 5 个会话')

  // ---- 2. 在跑判定 ----
  // ⚠️ 必须显式传 index：readSessionDigest 不传索引时会**自己现建**一份，
  //   而那一步读的是同一个 workspace.json，本来应该没问题 ——
  //   但它和下面 listProgress 用的缓存实例必须一致，否则一旦某处缓存了空表，
  //   就会出现「列表里有工作区、单查没有」这种只在测试里才看得见的怪相。
  //   生产路径永远传索引，测试也照着生产走。
  const wsIndex = buildWorkspaceIndex(readWorkspaces().workspaces)
  const run = readSessionDigest(ctx, 'session-run', wsIndex)
  ok(run.running === true, '有 openStep 且刚写盘 → 判成运行中')
  eq(run.title, '评估算法重写', '标题读对')
  eq(run.todos.total, 4, 'todo 总数')
  eq(run.todos.done, 2, 'todo 完成数')
  eq(run.todos.current, '跑 A/B 对比', 'todo 当前那条取 in_progress')
  eq(run.workspaceTitle, 'CreateCMPOR', '工作区标题按 cwd 匹配上')

  const stale = readSessionDigest(ctx, 'session-stale', wsIndex)
  ok(stale.running === false, '★ 有残留 pendingCalls 但 90 天没写盘 → 必须是 idle（僵尸不算运行中）')

  const idle = readSessionDigest(ctx, 'session-idle', wsIndex)
  ok(idle.running === false, 'openStep=null → idle')
  eq(idle.todos.total, 0, '没有 todos 时 total=0，不炸')

  // ---- 3. 归档过滤 ----
  const all = listProgress(ctx, { limit: 50, idleWindowMs: 365 * 86_400_000 })
  const ids = [...all.running, ...all.recent].map((d) => d.sessionId)
  ok(!ids.includes('session-archived'), '★ 归档会话不出现在进度列表里')
  ok(all.archivedSkipped >= 1, '归档被计入 archivedSkipped')

  // ---- 4. 时间窗 ----
  const recentOnly = listProgress(ctx, { limit: 50, idleWindowMs: 24 * 3600_000 })
  const recentIds = [...recentOnly.running, ...recentOnly.recent].map((d) => d.sessionId)
  ok(recentIds.includes('session-run'), '24h 窗内有 session-run')
  ok(!recentIds.includes('session-old'), '★ 24h 窗外的不进「最近活跃」')

  // ---- 5. 工作区过滤 ----
  const onlyA = listProgress(ctx, { cwd: WS_A, limit: 50, idleWindowMs: 365 * 86_400_000 })
  const aIds = [...onlyA.running, ...onlyA.recent].map((d) => d.sessionId)
  ok(aIds.includes('session-run') && aIds.includes('session-idle'), '按 cwd 过滤能只拿到 A 的会话')
  ok(!aIds.includes('session-old'), '★ 过滤掉别的 cwd')

  // ---- 6. 排序：在跑的在前 ----
  const sorted = listProgress(ctx, { limit: 50, idleWindowMs: 365 * 86_400_000 })
  ok(sorted.running.every((d) => d.running === true), 'running 数组里全是 running')
  ok(sorted.recent.every((d) => d.running === false), 'recent 数组里没有 running')

  // ---- 7. 工作区索引 ----
  const index = buildWorkspaceIndex(readWorkspaces().workspaces)
  eq(index.titleOf(WS_A), 'CreateCMPOR', 'titleOf 归一化后能匹配（反斜杠）')
  eq(index.titleOf('d:/WORK/cmpor/'), 'CreateCMPOR', 'titleOf 大小写 + 正斜杠 + 尾斜杠都能匹配')
  ok(index.workspaceOf('session-run')?.id === 'ws-a', 'workspaceOf 按 sessionId 反查')

  // ---- 8. 坏数据不炸 ----
  writeFileSync(join(PROJDIR, 'session-broken.json'), '{ this is not json', 'utf8')
  invalidateProgressCache()
  let threw = false
  try {
    readProjCache()
  } catch {
    threw = true
  }
  ok(threw === false, '★ 一个坏掉的投影文件不会让整次读取抛错')

  // ---- 9. 命令层 ----
  const cmd = await import('../lib/commands.js')
  eq(cmd.parseCommand('/进度', '/'), { name: '进度', arg: '' }, '解析 /进度')
  eq(cmd.parseCommand('  /进度  ', '/'), { name: '进度', arg: '' }, '前后空白能容忍')
  eq(cmd.parseCommand('/看 3', '/'), { name: '看', arg: '3' }, '解析带空格的参数')
  eq(cmd.parseCommand('/去3', '/'), { name: '去', arg: '3' }, '★ 中文输入法常见的紧贴写法 /去3')
  eq(cmd.parseCommand('/看12', '/'), { name: '看', arg: '12' }, '★ /看12 也要拆开')
  eq(cmd.parseCommand('/xxx', '/'), { name: 'xxx', arg: '' }, '未知命令原样返回（由 canonicalName 判空）')
  eq(cmd.parseCommand('今天怎么样', '/'), null, '★ 普通消息不是命令')
  eq(cmd.parseCommand('/进度', ''), null, '★ 前缀为空 = 命令层关闭')

  eq(cmd.canonicalName('p'), '进度', '别名 p → 进度')
  eq(cmd.canonicalName('status'), '进度', '别名 status → 进度')
  eq(cmd.canonicalName('help'), '帮助', '别名 help → 帮助')
  eq(cmd.canonicalName('乱写'), '', '★ 未知命令名 → 空（原样投给会话）')

  // ---- 10. 编号表 ----
  const t = cmd.makeTable([{ n: 1, sessionId: 's1', label: 'a' }, { n: 2, sessionId: 's2', label: 'b' }], now)
  ok(cmd.lookupTable(t, '2').ok === true, '能按编号查到')
  eq(cmd.lookupTable(t, '2').entry.sessionId, 's2', '编号 2 对应 s2')
  const expired = cmd.lookupTable({ at: now - 20 * 60_000, entries: t.entries }, '1', now)
  eq(expired.ok, false, '★ 过期表查不到')
  eq(expired.reason, 'expired', '★ 过期原因是 expired')
  eq(cmd.lookupTable(t, '9').reason, 'range', '越界编号是 range')
  eq(cmd.lookupTable(null, '1').reason, 'empty', '空表是 empty')

  // ---- 11. 渲染 ----
  const rendered = cmd.renderProgress(ctx, { limit: 20 })
  ok(rendered.text.includes('▍CreateCMPOR'), '★ 进度正文按工作区分组')
  ok(rendered.text.includes('评估算法重写'), '进度正文含会话标题')
  ok(rendered.text.includes('运行中'), '进度正文标出运行中')
  ok(rendered.text.includes('待办 2/4'), '进度正文含待办进度')
  ok(rendered.text.includes('正在做：跑 A/B 对比'), '进度正文含当前待办')
  ok(rendered.entries.length > 0, '进度正文带编号表')

  const peekEntry = rendered.entries.find((e) => e.sessionId === 'session-run')
  const peek = cmd.renderPeek(ctx, peekEntry)
  ok(peek.includes('评估算法重写'), '详情含标题')
  ok(peek.includes('跑 A/B 对比'), '★ 详情列出未完成的待办')
  ok(peek.includes('▶'), '进行中的待办用 ▶ 标出')
  ok(peek.includes('输出 token'), '详情含 token')

  // ---- 12. 空数据降级 ----
  reset()
  mkdirSync(PROJDIR, { recursive: true })
  writeWorkspaces([], [])
  invalidateProgressCache()
  const emptyList = listProgress(ctx, { limit: 10 })
  eq(emptyList.total, 0, '没有数据时 total=0')
  const emptyRender = cmd.renderProgress(ctx, { limit: 10 })
  ok(emptyRender.text.includes('没有活跃会话'), '★ 没有数据时给一句人话，不是白屏')

  // ---- 汇总 ----
  console.log(`\nprogress-sim: ${pass} 过 / ${fail} 败`)
  if (fail > 0) {
    console.log('失败项：')
    for (const item of failures) console.log('  -', item)
    process.exit(1)
  }
}

await main()
