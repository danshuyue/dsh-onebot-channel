/**
 * window-batch-render-sim 的变异验证（2026-11-09 复查）。
 *
 * 要证明的是：那几条源码断言**真的在测东西**。
 * 把 `deliverWindowBatch` 的渲染退回 0.21.0 交付时的样子（没有 gapOf / 你自己），
 * 测试必须变红 —— 那正是这次复查揪出来的缺口。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')
const TEST = 'tests/window-batch-render-sim.mjs'
const TARGET = join(PLUGIN, 'lib', 'poll.js')

function pickTmp() {
  for (const base of [join(PLUGIN, '..', '.tmp-mutation'), tmpdir()]) {
    try { mkdirSync(base, { recursive: true }); return base } catch { /* 下一个 */ }
  }
  throw new Error('找不到可写的临时目录')
}
const TMP = pickTmp()

function mutate(file, from, to) {
  const source = readFileSync(file, 'utf8')
  if (!source.includes(from)) throw new Error(`变异没命中：${file}\n---\n${from.slice(0, 120)}\n---`)
  writeFileSync(file, source.replace(from, to), 'utf8')
  return () => writeFileSync(file, source, 'utf8')
}

function run(logFile) {
  const fd = openSync(logFile, 'w')
  try {
    execFileSync(process.execPath, [TEST], {
      cwd: PLUGIN, stdio: ['ignore', fd, fd], timeout: 60000, env: { ...process.env }
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
    label: '还原成交付时的样子：批次不标间隔（删 gapOf 调用）',
    expect: '批次调用了 gapOf',
    from: '    const gap = prev === null ? \'\' : gapOf(timeOf(prev) * 1000, timeOf(message) * 1000)',
    to: '    const gap = \'\''
  },
  {
    id: 'M2',
    label: '还原：批次不标「你自己」',
    expect: '批次里有「你自己」分支',
    from: `    const name = selfUin !== '' && senderUin === selfUin
      ? '你自己'
      : ownerUin !== '' && senderUin === ownerUin`,
    to: `    const name = ownerUin !== '' && senderUin === ownerUin`
  },
  {
    id: 'M3',
    label: '算了间隔但没拼进行里（沉默的 bug）',
    expect: '每一条 return 都拼了间隔',
    from: '    return `${stampOf(message)}${gapPart}${refOf(message)}${name}: ${rendered}`',
    to: '    return `${stampOf(message)}${refOf(message)}${name}: ${rendered}`'
  }
]

const results = []
for (const item of MUTATIONS) {
  const sandbox = join(TMP, `mut-batchrender-${item.id}-${process.pid}`)
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

const baselineLog = join(TMP, `baseline-batchrender-${process.pid}.log`)
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
