/**
 * autoforward-mutation.mjs —— 0.20.2 两处改动的变异验证。
 * node tests/autoforward-mutation.mjs，退出码 0 = 全部被抓住。
 *
 * ## 为什么必须有（本仓库最贵的一条纪律）
 * 新写的断言不验证就是「假绿温床」：0.19.0 的语音配置漏暴露（105 过 0 败漏到实机）、
 * 0.19.7 的恒真断言都栽在这上面。所以每条新断言都要**先把实现改坏**，
 * 确认它变红，且红的正是**预期那一条**。
 *
 * ## 这一版要钉住什么（以及**不**钉什么）
 *
 * ✅ B：按渠道的自动转发开关（群默认关、私聊默认开、两个开关各自生效）
 *    —— 这是用户报的「群里不该发汇报却发了」的正解。
 * ✅ PTC：run_code 里调的 qq_send 记的是 tool/ptc-dispatch*，旧判定只认 tool/call。
 *    —— 这是确实存在的第二个缺陷。
 *
 * ❌ **不**钉「跨扫描账本」：我最初以为长回合会丢失中途的 qq_send 记录，后来证明是错的
 *    （scanFrom 每轮都从同一位置重扫，entry.cursor 只在 turn/end 时推进）。
 *    把判定逐字还原成旧代码，「长回合中途用过 qq_send」那条照样绿 ——
 *    不区分实现的断言留着只会误导人，所以那条测试也已经删掉。
 *    如果你以后想验证这一点，正确的做法是**先证明旧代码会红**。
 *
 * ⚠️ 每个变异用**独立 HOME**：否则前一个变异残留的配置会污染后一个。
 * ⚠️ 子进程输出走**文件重定向**而不是管道：受限环境下管道会 EPERM。
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync, cpSync, openSync, closeSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0
let fail = 0
const report = []
function line(text) {
  process.stdout.write(`${text}\n`)
  report.push(text)
}
function ok(condition, name) {
  if (condition) { pass += 1; line(`  ✓ ${name}`) } else { fail += 1; line(`  ✗ ${name}`) }
}

/** 造一份独立 HOME + 插件副本；返回 { work, home, plugin }。 */
function sandbox(tag) {
  const work = join(tmpdir(), `qq-af-${tag}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
  const home = join(work, 'home')
  const plugin = join(work, 'plugin')
  mkdirSync(home, { recursive: true })
  cpSync(PLUGIN, plugin, {
    recursive: true,
    filter: (src) => !src.includes('node_modules') && !src.includes('.git') &&
      !src.includes('dist') && !src.includes('.tmp-test')
  })
  const data = join(home, '.dsh')
  mkdirSync(data, { recursive: true })
  writeFileSync(join(data, 'qq-bridge.config.json'), JSON.stringify({
    enabled: true, selfUin: 3566906627, peerUin: 1321833118, ownerUin: 1321833118,
    onebotHttp: 'http://127.0.0.1:3000/', token: 'test-token', splitReply: false,
    replyQuietMs: 0, mergeWindowMs: 0, backfillOnStart: false,
    memoryEnabled: false, proactiveEnabled: false, wsEnabled: false,
    groupUins: ['975663147'],
    routes: {
      private: { 1321833118: { sessionId: 'session-mut' } },
      group: { 975663147: { sessionId: 'session-mut' } }
    }
  }, null, 2), 'utf8')
  writeFileSync(join(data, 'qq-bridge-state.json'), JSON.stringify({
    lastId: 0, lastSeq: 1, lastTime: 1, privates: {}, groups: {}
  }, null, 2), 'utf8')
  return { work, home, plugin }
}

/**
 * 跑一次测试，返回 { status, output }。
 *
 * ⚠️ **stdio 必须重定向到文件**（2026-11-11 实测，坑 28）。
 *    本机 DSH 沙箱里子进程管道会 EPERM：`spawnSync(..., {encoding:'utf8'})`
 *    得到 `status=null, stdout=undefined, error=EPERM` ——
 *    现象是「baseline 就红 + 一条 ✗ 都没有 + 输出空白」，
 *    看着像被测代码坏了，其实一个字节都没读到。
 *    这个脚本原来用管道，所以在本机从来没真跑通过（以前不在 npm test 链里）。
 */
function runIn({ work, home, plugin }, test) {
  const log = join(work, 'out.txt')
  let fd
  let status = null
  try {
    fd = openSync(log, 'w')
    const result = spawnSync(process.execPath, [join(plugin, 'tests', test)], {
      cwd: plugin,
      env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: work, TEMP: work, TMP: work },
      stdio: ['ignore', fd, fd],
      timeout: 180000
    })
    status = result.status
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* 已关 */ } }
  }
  let output = ''
  try { output = readFileSync(log, 'utf8') } catch { output = '' }
  return { status, output }
}

function runMutation({ name, edits, test, expectRed }) {
  const box = sandbox('mut')
  let applied = true
  for (const edit of edits) {
    const file = join(box.plugin, edit.file)
    const source = readFileSync(file, 'utf8')
    const hits = source.split(edit.from).length - 1
    if (hits !== 1) {
      applied = false
      line(`  ✗ ${name}：变异没命中（file=${edit.file}，命中 ${hits} 次）`)
      break
    }
    writeFileSync(file, source.replace(edit.from, edit.to), 'utf8')
  }
  if (!applied) {
    rmSync(box.work, { recursive: true, force: true })
    return false
  }

  const { status, output } = runIn(box, test)
  const red = status !== 0
  const hasCross = output.includes('✗')
  const expectedLine = output
    .split(/\r?\n/)
    .filter((l) => l.includes('✗'))
    .some((l) => l.includes(expectRed))

  ok(red && hasCross && expectedLine, `${name} → 被抓住（红了，且是「${expectRed}」那条）`)
  if (!(red && hasCross && expectedLine)) {
    line(`     ↳ status=${status} 有✗=${hasCross} 命中预期=${expectedLine}`)
    line(`     ↳ 输出尾部：\n${output.split(/\r?\n/).slice(-10).map((l) => `       ${l}`).join('\n')}`)
  }

  rmSync(box.work, { recursive: true, force: true })
  return true
}

// ---- baseline：未变异时必须全绿，否则后面「红了」证明不了任何事 ----
line('== baseline：未变异时 dup-send-sim 必须全绿 ==')
{
  const box = sandbox('base')
  const { status, output } = runIn(box, 'dup-send-sim.mjs')
  const green = status === 0 && !output.includes('✗')
  ok(green, 'baseline dup-send-sim 全绿（未变异时不能红）')
  if (!green) {
    line(`     ↳ status=${status}\n${output.split(/\r?\n/).slice(-12).map((l) => `       ${l}`).join('\n')}`)
  }
  rmSync(box.work, { recursive: true, force: true })
}

line('\n== 变异 1~2：PTC（run_code）子调用识别 ==')

// 变异 1：不认 PTC 子调用 —— run_code 里调的 qq_send 会漏判，正文重复发一遍。
runMutation({
  name: '变异1 不认 PTC 子调用',
  edits: [{
    file: join('lib', 'outbound.js'),
    from: "  if (\n    type === 'tool/ptc-dispatch-start' || type === 'tool/ptc-dispatch' ||\n    type === 'tool/code-dispatch-start' || type === 'tool/code-dispatch'\n  ) {\n    return String(data?.subCallId ?? '')\n  }",
    to: '  // 变异：不认 PTC 子调用'
  }],
  test: 'dup-send-sim.mjs',
  expectRed: 'run_code 里调过 qq_send'
})

// 变异 2：PTC 失败信号丢掉 —— 失败了也当成成功，于是正文被吞掉（「她突然不回话了」）。
runMutation({
  name: '变异2 丢掉 PTC 的失败信号（该兜底的不兜底）',
  edits: [{
    file: join('lib', 'outbound.js'),
    from: "  if (type === 'tool/ptc-dispatch' || type === 'tool/code-dispatch') {\n    const callId = String(data?.subCallId ?? '')\n    if (callId !== '' && (data?.isError === true || Boolean(data?.error))) return callId\n  }",
    to: '  // 变异：丢掉 PTC 的失败信号'
  }],
  test: 'dup-send-sim.mjs',
  expectRed: 'run_code 里的 qq_send 失败了'
})

line('\n== 变异 3~5：按渠道的自动转发开关 ==')

// 变异 3：群也当私聊处理（群默认关失效）—— 群里那段汇报又会被推出去
runMutation({
  name: '变异3 群聊按私聊处理（群默认关失效）',
  edits: [{
    file: join('lib', 'config.js'),
    from: "  if (String(target?.kind ?? '') === 'group') return conf.autoForwardGroup === true\n  return conf.autoForwardPrivate !== false",
    to: '  return conf.autoForwardPrivate !== false'
  }],
  test: 'dup-send-sim.mjs',
  expectRed: '群里默认不自动转发'
})

// 变异 4：群开关写死成永远不发（用户开了也不生效）
runMutation({
  name: '变异4 群开关写死（打开也不生效）',
  edits: [{
    file: join('lib', 'config.js'),
    from: "  if (String(target?.kind ?? '') === 'group') return conf.autoForwardGroup === true",
    to: "  if (String(target?.kind ?? '') === 'group') return false"
  }],
  test: 'dup-send-sim.mjs',
  expectRed: '群里把开关打开后照常自动转发'
})

// 变异 5：私聊开关不生效（关掉了还照发）
runMutation({
  name: '变异5 私聊开关不生效（关掉了还照发）',
  edits: [{
    file: join('lib', 'config.js'),
    from: '  return conf.autoForwardPrivate !== false\n}',
    to: '  return true\n}'
  }],
  test: 'dup-send-sim.mjs',
  expectRed: '私聊开关关掉后也不自动转发'
})

line(`\n结果：${pass} 过 / ${fail} 败（变异全部被抓住才算通过）`)
process.exit(fail > 0 ? 1 : 0)
