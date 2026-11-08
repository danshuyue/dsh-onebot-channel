/**
 * window-queue-all-sim 的变异验证（2026-11-09）。
 *
 * ## 为什么必须做
 *
 * 项目铁律（docs/维护索引.md §4 坑 27、29）：**写完一条断言，就把对应实现改坏再跑一遍，
 * 确认它变红**。否则很容易写出「删掉实现照样绿」的假测试 —— 0.16.12 和 2026-11-06
 * 各踩过一次，症状都是「测试全绿，功能是坏的」。
 *
 * ## 本次要验证的五个变异
 *
 *   M1 删掉 `shouldQueueForWindow` 的放宽分支（退回只认 isWindowEligible）
 *      → 「第三方普通接话要进队列」必须变红（这正是本次故障本体）
 *   M2 删掉 `windowQueueAll === false` 的开关判断
 *      → 「windowQueueAll=false 时退回旧行为」必须变红
 *   M3 删掉「自己发的消息不入队」
 *      → 「她自己发的消息不进批次队列」必须变红
 *   M4 把 isWindowEligible 也改宽（跟着 shouldQueueForWindow 走）
 *      → 「isWindowEligible 仍然是窄口径」必须变红（防止开回合被一起放宽）
 *   M5 删掉队列裁剪循环
 *      → 「队列被裁到上限内」必须变红
 *
 * ⚠️ 每个变异用**独立沙箱**：本项目踩过「前一个变异残留的配置污染后一个」，
 *    现象是每次红的项都不一样（坑 30）。
 *
 * ⚠️ 子进程输出用**文件重定向**而不是管道：受限环境下管道会 EPERM，
 *    连 stdout 都读不到，看着像「变异一个都没被抓住」（坑 28）。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')
const TEST = 'tests/window-queue-all-sim.mjs'

/** 挑一个真的写得进去的临时根（本机系统临时目录有 ACL 限制）。 */
function pickTmp() {
  for (const base of [join(PLUGIN, '..', '.tmp-mutation'), tmpdir()]) {
    try {
      mkdirSync(base, { recursive: true })
      return base
    } catch { /* 试下一个 */ }
  }
  throw new Error('找不到可写的临时目录')
}
const TMP = pickTmp()

/** 变异：把文件的某段字面量替换掉，并断言**真的替换到了**（没命中就是假验证）。 */
function mutate(file, from, to) {
  const source = readFileSync(file, 'utf8')
  if (!source.includes(from)) {
    throw new Error(`变异没命中：${file} 里找不到\n---\n${from}\n---`)
  }
  writeFileSync(file, source.replace(from, to), 'utf8')
  return () => writeFileSync(file, source, 'utf8')
}

function run(script, logFile) {
  const fd = openSync(logFile, 'w')
  try {
    execFileSync(process.execPath, [script], {
      cwd: PLUGIN,
      stdio: ['ignore', fd, fd],
      timeout: 120000,
      env: { ...process.env }
    })
    return { ok: true, output: readFileSync(logFile, 'utf8') }
  } catch (error) {
    let output = ''
    try { output = readFileSync(logFile, 'utf8') } catch { /* 读不到就空 */ }
    return { ok: false, output }
  } finally {
    closeSync(fd)
  }
}

const windowFile = join(PLUGIN, 'lib', 'window.js')
const MUTATIONS = [
  {
    id: 'M1',
    label: '删掉「窗口内任何人都进队列」的放宽（退回 isWindowEligible）',
    expect: '第三方普通接话要进队列',
    file: windowFile,
    from: '  if (config?.windowQueueAll === false) return isWindowEligible(win, message, config)',
    to: '  return isWindowEligible(win, message, config); if (config?.windowQueueAll === false) return isWindowEligible(win, message, config)'
  },
  {
    id: 'M2',
    label: '删掉 windowQueueAll 开关判断（永远放宽）',
    expect: 'windowQueueAll=false 时退回旧行为',
    file: windowFile,
    from: '  if (config?.windowQueueAll === false) return isWindowEligible(win, message, config)',
    to: '  if (false) return isWindowEligible(win, message, config)'
  },
  {
    id: 'M3',
    label: '删掉「自己发的消息不入队」',
    expect: '她自己发的消息不进批次队列',
    file: windowFile,
    from: '  if (senderUin !== \'\' && senderUin === String(config?.selfUin ?? \'\').trim()) return false',
    to: ''
  },
  {
    id: 'M4',
    label: '把 isWindowEligible 也改宽（跟着 shouldQueueForWindow 走）',
    expect: 'isWindowEligible 仍然是窄口径',
    file: windowFile,
    from: 'export function isWindowEligible(win, message, config = getConfig()) {\n  if (!activeOf(win) || message === null || typeof message !== \'object\') return false',
    to: 'export function isWindowEligible(win, message, config = getConfig()) {\n  if (!activeOf(win) || message === null || typeof message !== \'object\') return false\n  if (config?.windowQueueAll !== false) return true'
  },
  {
    id: 'M5',
    label: '删掉队列裁剪循环',
    expect: '队列被裁到上限内',
    file: windowFile,
    from: '  while (list.length > cap) {',
    to: '  while (false) {'
  }
]

const results = []
for (const item of MUTATIONS) {
  // 每个变异用独立沙箱，避免遗留状态污染（坑 30）
  const sandbox = join(TMP, `mut-${item.id}-${process.pid}`)
  mkdirSync(sandbox, { recursive: true })
  const logFile = join(sandbox, 'out.log')
  const restore = (() => {
    try { return mutate(item.file, item.from, item.to) } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  })()
  if (typeof restore !== 'function') {
    results.push({ ...item, caught: false, reason: `变异构造失败：${restore.error}` })
    continue
  }
  const outcome = run(join(PLUGIN, TEST), logFile)
  restore()
  rmSync(sandbox, { recursive: true, force: true })
  const caught = outcome.ok === false && outcome.output.includes(item.expect)
  results.push({
    ...item,
    caught,
    reason: caught ? '已变红' : (outcome.ok ? '仍然全绿（假测试！）' : `红了但不是预期那条（找「${item.expect}」）`)
  })
}

// 基线：不改任何东西时必须绿
const baselineLog = join(TMP, `baseline-${process.pid}.log`)
const baseline = run(join(PLUGIN, TEST), baselineLog)
try { rmSync(baselineLog, { force: true }) } catch { /* 忽略 */ }

console.log('=== 基线 ===')
console.log(baseline.ok ? '  ✓ 原样运行全绿' : '  ✗ 原样运行就是红的（先修基线，否则变异无用）')
console.log('')
console.log('=== 变异结果 ===')
let missed = 0
for (const item of results) {
  const mark = item.caught ? '✓' : '✗'
  if (!item.caught) missed += 1
  console.log(`  ${mark} ${item.id} ${item.label}`)
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
