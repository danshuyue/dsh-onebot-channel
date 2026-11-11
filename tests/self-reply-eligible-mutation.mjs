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
const TEST = 'tests/self-reply-eligible-sim.mjs'

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
    // ⚠️ 这一条就是「还原成 0.20.3 的旧代码」——最关键的那次验证。
    label: 'noteReply 判据还原成旧代码（单条发送时恒假）',
    expect: '单条发送后 selfMessageIds 记下了 message_id',
    file: 'lib/tool.js',
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
    file: 'lib/tool.js',
    from: '            if (usable.length > 0) noteReply(String(target.id), usable)',
    to: '            if (false) noteReply(String(target.id), usable)'
  },
  {
    id: 'M3',
    label: 'isWindowEligible 去掉「引用她」那一档',
    expect: '群友引用她刚说的那句',
    file: 'lib/window.js',
    from: `  if (target === null || !Array.isArray(win.selfMessageIds)) return false
  const wanted = String(target.id ?? '').trim()
  return wanted !== '' && win.selfMessageIds.some((id) => String(id) === wanted)`,
    to: '  return false'
  }
]

const results = []
for (const item of MUTATIONS) {
  // 每个变异用**独立副本**（避免遗留状态污染，坑 30；也避免改到真实源码）
  const copyDir = makeCopy(`selfreply-${item.id}`)
  const logFile = join(copyDir, 'out.log')
  try {
    // 变异在副本里做（真实源码只读不写 —— 见文件头注释）
    mutate(copyDir, item.file, item.from, item.to)
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
const baselineCopy = makeCopy('selfreply-baseline')
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
  if (!baseline.ok) console.error(baseline.output.slice(-800))
  process.exit(1)
}
console.log(`✓ ${results.length} 个变异全部被抓住，基线绿`)
console.log('')
console.log('★ M1 是「把实现还原成 0.20.3 旧代码」的验证 —— 它变红说明根因判断成立。')
process.exit(0)
