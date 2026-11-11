/**
 * diaglog-sim 的变异验证（2026-11-09）。
 *
 * 六个变异，对应 diaglog.js 里六条真正起作用的实现：
 *   M1 删掉正文截断        → 「正文被截断」变红
 *   M2 删掉环形裁剪        → 「最多留 200 条」变红
 *   M3 删掉时间窗过滤      → 「只保留窗口内的」变红
 *   M4 删掉 recordBody 的 try/catch → 「畸形输入不抛给调用方」变红
 *   M5 正文只留头不留尾    → 「截断时保留了尾部」变红
 *   M6 tools 不进环形      → 「最多留 200 条」同类（改写 recordTool）
 *
 * 每个变异独立沙箱；子进程输出走文件重定向。
 *
 * ⚠️ **变异必须在副本里做，不能原地改真实源码**（2026-11-11，0.23.0 接进测试链时现形）：
 *    DSH 沙箱把工作区源码设成只读 → 原地 `writeFileSync` 直接 EPERM，
 *    变异全部报「变异构造失败」，看起来像功能坏了，其实是**改不动文件**。
 *    更糟的是：原地改 + 跑完还原这套在崩溃/被 kill 时会留下被改坏的源码。
 *    所以先 `cpSync` 一份插件到临时目录，在副本里变异、跑副本里的测试。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')
const TEST = 'tests/diaglog-sim.mjs'

function pickTmp() {
  for (const base of [join(PLUGIN, '..', '.tmp-mutation'), tmpdir()]) {
    try { mkdirSync(base, { recursive: true }); return base } catch { /* 下一个 */ }
  }
  throw new Error('找不到可写的临时目录')
}
const TMP = pickTmp()

/** 复制一份插件（只复制跑测试需要的部分），变异在副本里做。 */
function makeCopy(tag) {
  const dir = join(TMP, `copy-${tag}-${process.pid}`)
  cpSync(PLUGIN, dir, {
    recursive: true,
    filter: (src) => !src.includes('node_modules') && !src.includes('.git') && !src.includes('.tmp-test')
      && !src.includes('.tmp-mutation') && !src.includes('_tmp-')
  })
  return dir
}

function mutate(copyDir, rel, from, to) {
  const file = join(copyDir, rel)
  const source = readFileSync(file, 'utf8')
  if (!source.includes(from)) throw new Error(`变异没命中：${rel}\n---\n${from}\n---`)
  writeFileSync(file, source.replace(from, to), 'utf8')
}

function run(copyDir, logFile) {
  let fd
  let ok = false
  try {
    fd = openSync(logFile, 'w')
    execFileSync(process.execPath, [join(copyDir, TEST)], {
      cwd: copyDir, stdio: ['ignore', fd, fd], timeout: 120000, env: { ...process.env }
    })
    ok = true
  } catch {
    ok = false
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* 已关 */ } }
  }
  let output = ''
  try { output = readFileSync(logFile, 'utf8') } catch { /* 空 */ }
  return { ok, output }
}

const MUTATIONS = [
  {
    id: 'M1',
    label: '删掉正文截断（body 不 clip）',
    expect: '正文被截断',
    from: '      body: clip(payload.body, MAX_BODY_CHARS)',
    to: '      body: String(payload.body ?? \'\')'
  },
  {
    id: 'M2',
    label: '删掉环形裁剪',
    expect: '最多留 200 条',
    from: '    while (bodies.length > MAX_BODIES) bodies.shift()',
    to: '    void MAX_BODIES'
  },
  {
    id: 'M3',
    label: '删掉时间窗过滤',
    expect: '只保留窗口内的',
    from: '    bodies: bodies.filter(within),',
    to: '    bodies: bodies.slice(),'
  },
  {
    id: 'M4',
    label: '删掉 recordBody 的 try/catch',
    expect: '畸形输入不会把异常抛给调用方',
    from: '    // 诊断记录失败绝不能影响投递\n    warnDiag(`recordBody 失败：${error instanceof Error ? error.message : error}`)',
    to: '    warnDiag(`recordBody 失败：${error instanceof Error ? error.message : error}`); throw error'
  },
  {
    id: 'M5',
    label: '截断只留头（丢掉尾部）',
    expect: '截断时保留了尾部',
    from: '  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`',
    to: '  return text.slice(0, limit)'
  },
  {
    id: 'M6',
    label: 'tools 不裁剪（容量失控）',
    expect: '工具记录被裁到上限内',
    from: '    while (tools.length > MAX_TOOLS) tools.shift()',
    to: '    void MAX_TOOLS'
  }
]

const results = []
for (const item of MUTATIONS) {
  // 每个变异用**独立副本**（避免遗留状态污染，坑 30；也避免改到真实源码）
  const copyDir = makeCopy(`diag-${item.id}`)
  const logFile = join(copyDir, 'out.log')
  try {
    // 变异在副本里做（真实源码只读不写 —— 见文件头注释）
    mutate(copyDir, 'lib/diaglog.js', item.from, item.to)
  } catch (error) {
    results.push({ ...item, caught: false, reason: `变异构造失败：${error instanceof Error ? error.message : error}` })
    rmSync(copyDir, { recursive: true, force: true })
    continue
  }
  const outcome = run(copyDir, logFile)
  rmSync(copyDir, { recursive: true, force: true })
  const caught = outcome.ok === false && outcome.output.includes(item.expect)
  results.push({ ...item, caught, reason: caught ? '已变红' : (outcome.ok ? '仍然全绿（假测试！）' : `红了但不是预期那条（找「${item.expect}」）`) })
}

// 基线：不改任何东西时必须绿（同样在副本里跑）
const baselineCopy = makeCopy('diag-baseline')
const baselineLog = join(baselineCopy, 'baseline.log')
const baseline = run(baselineCopy, baselineLog)
rmSync(baselineCopy, { recursive: true, force: true })

console.log('=== 基线 ===')
console.log(baseline.ok ? '  ✓ 原样运行全绿' : '  ✗ 原样运行就是红的')
console.log('')
console.log('=== 变异结果 ===')
let missed = 0
for (const item of results) {
  if (!item.caught) missed += 1
  console.log(`  ${item.caught ? '✓' : '✗'} ${item.id} ${item.label}`)
  console.log(`      期望抓住：${item.expect}`)
  console.log(`      结果：${item.reason}`)
}
console.log('')
if (!baseline.ok || missed > 0) {
  console.error(`✗ 基线 ${baseline.ok ? '绿' : '红'}，${missed} 个变异漏网`)
  process.exit(1)
}
console.log(`✓ ${results.length} 个变异全部被抓住，基线绿`)
process.exit(0)
