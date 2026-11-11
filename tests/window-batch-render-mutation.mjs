/**
 * window-batch-render-sim 的变异验证（2026-11-09 复查；2026-11-11 改成副本内变异）。
 *
 * 要证明的是：那几条源码断言**真的在测东西**。
 * 把 `deliverWindowBatch` 的渲染退回 0.21.0 交付时的样子（没有 gapOf / 你自己），
 * 测试必须变红 —— 那正是这次复查揪出来的缺口。
 *
 * ## ⚠️ 为什么必须在副本里改，不能原地改
 *
 * 原来这里是 `mutate(TARGET, ...)` —— 直接改**真实的** `lib/poll.js`，跑完再还原。
 * 它在开发者机器上能跑，但在两种环境下必然失败：
 *   ① DSH 沙箱把工作区源码设成只读 → `EPERM`，三个变异全部「构造失败」；
 *   ② 中途崩溃/被 kill → **还原不执行**，源码留在被改坏的状态。
 *      那比测试失败严重得多：下一次跑测试会对着坏源码跑，而报错看起来像别的问题。
 *
 * 现在改成：复制一份插件到临时目录 → 在副本里变异 → 跑副本里的测试。
 * 真实源码**只读不写**，崩溃也不会留下脏状态（沙箱目录由 rmSync 清）。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')
const TEST = 'tests/window-batch-render-sim.mjs'

function pickTmp() {
  for (const base of [join(PLUGIN, '..', '.tmp-mutation'), tmpdir()]) {
    try { mkdirSync(base, { recursive: true }); return base } catch { /* 下一个 */ }
  }
  throw new Error('找不到可写的临时目录')
}
const TMP = pickTmp()

/** 复制一份插件（只复制跑测试需要的部分），变异在副本里做。 */
function makeCopy(tag) {
  const dir = join(TMP, `copy-batchrender-${tag}-${process.pid}`)
  cpSync(PLUGIN, dir, {
    recursive: true,
    filter: (src) => !src.includes('node_modules') && !src.includes('.git') && !src.includes('.tmp-test')
      && !src.includes('.tmp-mutation') && !src.includes('_tmp-')
  })
  return dir
}

/** 在副本里替换文本；没命中直接抛（不能静默跳过，否则「没生效」会被当成「没抓住」）。 */
function mutate(copyDir, rel, from, to) {
  const file = join(copyDir, rel)
  const source = readFileSync(file, 'utf8')
  if (!source.includes(from)) throw new Error(`变异没命中：${rel}\n---\n${from.slice(0, 120)}\n---`)
  writeFileSync(file, source.replace(from, to), 'utf8')
}

/** 跑副本里的测试，输出走文件重定向（管道在沙箱里 EPERM，见坑 28）。 */
function run(copyDir, logFile) {
  let fd
  let ok = false
  try {
    fd = openSync(logFile, 'w')
    execFileSync(process.execPath, [join(copyDir, TEST)], {
      cwd: copyDir, stdio: ['ignore', fd, fd], timeout: 60000, env: { ...process.env }
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
  const copyDir = makeCopy(item.id)
  const logFile = join(copyDir, 'out.log')
  try {
    // 变异在**副本**里做（真实源码只读不写 —— 见文件头注释）
    mutate(copyDir, 'lib/poll.js', item.from, item.to)
  } catch (error) {
    results.push({ ...item, caught: false, reason: `变异构造失败：${error.message}` })
    rmSync(copyDir, { recursive: true, force: true })
    continue
  }
  const outcome = run(copyDir, logFile)
  rmSync(copyDir, { recursive: true, force: true })
  const caught = outcome.ok === false && outcome.output.includes(item.expect)
  results.push({ ...item, caught, reason: caught ? '已变红' : (outcome.ok ? '仍然全绿（假测试！）' : `红了但不是预期那条（找「${item.expect}」）`) })
}

// 基线：在**副本**上原样跑一次（不在真实目录里跑，免得它对被改过的源码跑）
const baselineCopy = makeCopy('baseline')
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
