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
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')
const TEST = 'tests/diaglog-sim.mjs'
const TARGET = join(PLUGIN, 'lib', 'diaglog.js')

function pickTmp() {
  for (const base of [join(PLUGIN, '..', '.tmp-mutation'), tmpdir()]) {
    try { mkdirSync(base, { recursive: true }); return base } catch { /* 下一个 */ }
  }
  throw new Error('找不到可写的临时目录')
}
const TMP = pickTmp()

function mutate(file, from, to) {
  const source = readFileSync(file, 'utf8')
  if (!source.includes(from)) throw new Error(`变异没命中：${file}\n---\n${from}\n---`)
  writeFileSync(file, source.replace(from, to), 'utf8')
  return () => writeFileSync(file, source, 'utf8')
}

function run(logFile) {
  const fd = openSync(logFile, 'w')
  try {
    execFileSync(process.execPath, [TEST], {
      cwd: PLUGIN, stdio: ['ignore', fd, fd], timeout: 120000, env: { ...process.env }
    })
    return { ok: true, output: readFileSync(logFile, 'utf8') }
  } catch {
    let output = ''
    try { output = readFileSync(logFile, 'utf8') } catch { /* 空 */ }
    return { ok: false, output }
  } finally {
    closeSync(fd)
  }
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
  const sandbox = join(TMP, `mut-diag-${item.id}-${process.pid}`)
  mkdirSync(sandbox, { recursive: true })
  const logFile = join(sandbox, 'out.log')
  let restore
  try {
    restore = mutate(TARGET, item.from, item.to)
  } catch (error) {
    results.push({ ...item, caught: false, reason: `变异构造失败：${error.message}` })
    rmSync(sandbox, { recursive: true, force: true })
    continue
  }
  const outcome = run(logFile)
  restore()
  rmSync(sandbox, { recursive: true, force: true })
  const caught = outcome.ok === false && outcome.output.includes(item.expect)
  results.push({ ...item, caught, reason: caught ? '已变红' : (outcome.ok ? '仍然全绿（假测试！）' : `红了但不是预期那条（找「${item.expect}」）`) })
}

const baselineLog = join(TMP, `baseline-diag-${process.pid}.log`)
const baseline = run(baselineLog)
try { rmSync(baselineLog, { force: true }) } catch { /* 忽略 */ }

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
