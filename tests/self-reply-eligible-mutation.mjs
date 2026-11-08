/**
 * self-reply-eligible-sim 的变异验证（2026-11-09）。
 *
 * 这条最关键：**把 tool.js 的 noteReply 判据还原成 0.20.3 的旧代码**，
 * 测试必须变红。这正是本项目铁律（docs/维护索引.md §4 坑 27）要求的
 * 「写完一条断言就把实现改坏再跑一遍」。
 *
 * 如果还原成旧代码后测试**照样绿**，说明我这个「根因」判断是错的 ——
 * 那就得重新找原因，而不是急着交付。
 * （这个教训本项目踩过：2026-11-08 的 0.20.2 就是「账本白加」的那次。）
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')
const TEST = 'tests/self-reply-eligible-sim.mjs'

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

const toolFile = join(PLUGIN, 'lib', 'tool.js')
const windowFile = join(PLUGIN, 'lib', 'window.js')

const MUTATIONS = [
  {
    id: 'M1',
    // ⚠️ 这一条就是「还原成 0.20.3 的旧代码」——最关键的那次验证。
    label: 'noteReply 判据还原成旧代码（单条发送时恒假）',
    expect: '单条发送后 selfMessageIds 记下了 message_id',
    file: toolFile,
    from: `          if (target.kind === 'group') {
            const replyIds = Array.isArray(messageIds) ? messageIds : [messageIds]
            const usable = replyIds
              .map((id) => String(id ?? '').trim())
              .filter((id) => /^-?\\d+$/.test(id) && id !== '0' && id !== '-0')
            if (usable.length > 0) noteReply(String(target.id), usable)
          }`,
    to: `          if (target.kind === 'group' && (Array.isArray(result?.data?.message_ids) ? result.data.message_ids.length > 0 : Number.isFinite(messageId) && messageId !== 0)) {
            noteReply(String(target.id), Array.isArray(result?.data?.message_ids) ? result.data.message_ids : messageId)
          }`
  },
  {
    id: 'M2',
    label: 'noteReply 干脆不调用（彻底断开）',
    expect: '单条发送后 selfMessageIds 记下了 message_id',
    file: toolFile,
    from: '            if (usable.length > 0) noteReply(String(target.id), usable)',
    to: '            if (false) noteReply(String(target.id), usable)'
  },
  {
    id: 'M3',
    label: 'isWindowEligible 去掉「引用她」那一档',
    expect: '群友引用她刚说的那句',
    file: windowFile,
    from: `  if (target === null || !Array.isArray(win.selfMessageIds)) return false
  const wanted = String(target.id ?? '').trim()
  return wanted !== '' && win.selfMessageIds.some((id) => String(id) === wanted)`,
    to: '  return false'
  }
]

const results = []
for (const item of MUTATIONS) {
  const sandbox = join(TMP, `mut-selfreply-${item.id}-${process.pid}`)
  mkdirSync(sandbox, { recursive: true })
  const logFile = join(sandbox, 'out.log')
  let restore
  try {
    restore = mutate(item.file, item.from, item.to)
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

const baselineLog = join(TMP, `baseline-selfreply-${process.pid}.log`)
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
  if (!baseline.ok) console.error(baseline.output.slice(-800))
  process.exit(1)
}
console.log(`✓ ${results.length} 个变异全部被抓住，基线绿`)
console.log('')
console.log('★ M1 是「把实现还原成 0.20.3 旧代码」的验证 —— 它变红说明根因判断成立。')
process.exit(0)
