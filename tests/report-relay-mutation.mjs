/**
 * report-relay-mutation.mjs —— 0.21.4「群汇报不进群 / 按需回传私聊」的变异验证。
 * node tests/report-relay-mutation.mjs，退出码 0 = 全部被抓住。
 *
 * ## 现场（用户 2026-11-09 实测报的第二个问题）
 *
 *   「依旧有部分汇报类回复被 qq_send 发送到群聊里」
 *   —— 其实**不是** qq_send 发的。日志铁证：
 *     05:10:44 [rhythm] 已抑制自动转发 key=group:716197431（qq_pass: …不必再接）
 *     05:10:49 [out] qq_pass 但正文写了真话（161 字），按「说出口了」照发 key=group:716197431
 *     05:10:56 [out] 已转发回复 161 字 -> group
 *
 *   根因是**结构性**的：渠道闸门 `autoForwardEnabledFor` 排在 `qq_pass` 之后，
 *   而 qq_pass 分支直接 continue —— 于是「群里不自动转发」对它**完全失效**。
 *
 * ## 这一版要钉住什么
 *
 * ✅ R1 闸门退回 qq_pass 之后（洞原样复现）
 * ✅ R2 qq_pass 分支对群也放行（绕开闸门的另一种写法）
 * ✅ R3 回传开关写死成开（用户关不掉）
 * ✅ R4 回传开关写死成关（用户开了不生效）
 * ✅ R5 回传目标写死成群（回传变成「又发一遍到群里」——最坏的那种修法）
 * ✅ R6 私聊那条既有决策被一刀切掉（「说出口了照发」不许误伤）
 * ✅ R7 私聊纯动作时不再按下不发（旧行为回归）
 *
 * ⚠️ 每个变异用**独立 HOME**：否则前一个变异残留的配置会污染后一个。
 * ⚠️ 子进程输出走**文件重定向**而不是管道：受限环境下管道会 EPERM。
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const TEST = 'tests/dup-send-sim.mjs'

let pass = 0
let fail = 0
function line(text) { process.stdout.write(`${text}\n`) }
function ok(condition, name) {
  if (condition) { pass += 1; line(`  ✓ ${name}`) } else { fail += 1; line(`  ✗ ${name}`) }
}

function sandbox(tag) {
  const work = join(tmpdir(), `qq-rr-${tag}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
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
  // 隔离 HOME 下必须放一份够用的配置：dup-send-sim 会读它再备份
  // （少了这个文件它会当场 ENOENT —— 那不是代码坏了，是沙箱没铺好）
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

function runIn({ work, home, plugin }) {
  const result = spawnSync(process.execPath, [TEST], {
    cwd: plugin,
    env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: work, TEMP: work, TMP: work },
    encoding: 'utf8',
    timeout: 180000
  })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function runMutation({ name, edits, expectRed }) {
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

  const { status, output } = runIn(box)
  const red = status !== 0
  const hasCross = output.includes('✗')
  const expectedLine = output
    .split(/\r?\n/)
    .filter((l) => l.includes('✗'))
    .some((l) => l.includes(expectRed))

  ok(red && hasCross && expectedLine, `${name} → 被抓住（红了，且是「${expectRed}」那条）`)
  if (!(red && hasCross && expectedLine)) {
    line(`     ↳ status=${status} 有✗=${hasCross} 命中预期=${expectedLine}`)
    line(`     ↳ 输出尾部：\n${output.split(/\r?\n/).slice(-14).map((l) => `       ${l}`).join('\n')}`)
  }

  rmSync(box.work, { recursive: true, force: true })
  return true
}

line('== baseline：未变异时 dup-send-sim 必须全绿 ==')
{
  const box = sandbox('base')
  const { status, output } = runIn(box)
  const green = status === 0 && !output.includes('✗')
  ok(green, 'baseline dup-send-sim 全绿（未变异时不能红）')
  if (!green) {
    line(`     ↳ status=${status}\n${output.split(/\r?\n/).slice(-14).map((l) => `       ${l}`).join('\n')}`)
  }
  rmSync(box.work, { recursive: true, force: true })
}

line('\n== 变异 1~2：闸门位置（这个洞本身就是「位置错了」）==')

// 变异 1：把渠道闸门退回 qq_pass **之后**（0.20.2 的原样）——
// 洞原样复现：群里 qq_pass 后写了汇报，正文照样进群。
// 实现方式：把闸门的判断条件改成 `false`（等于「这里永远不拦」），
// 效果与「闸门在后面」等价 —— 因为 qq_pass 分支会先 continue 掉。
runMutation({
  name: '变异1 闸门对群失效（洞复现）',
  edits: [{
    file: join('lib', 'outbound.js'),
    from: '          if (!autoForwardEnabledFor(entry.target, config)) {',
    to: '          if (false && !autoForwardEnabledFor(entry.target, config)) {'
  }],
  expectRed: '群里 qq_pass 后写了汇报正文 → 依然一条都不进群'
})

// 变异 2：闸门只对私聊生效 —— 群聊漏过闸门，洞换个地方重开。
// ⚠️ 这是「只补一半」的典型写法：修的人以为自己在改渠道判断，
//    实际上把群整个放行了。红的是**群里默认不自动转发**那条
//    （它是最先撞上的一道群断言，且与变异 1 红的不是同一条）。
runMutation({
  name: '变异2 闸门只对私聊生效（群漏过）',
  edits: [{
    file: join('lib', 'outbound.js'),
    from: '          if (!autoForwardEnabledFor(entry.target, config)) {',
    to: '          if (String(entry.target?.kind ?? \'\') === \'private\' && !autoForwardEnabledFor(entry.target, config)) {'
  }],
  expectRed: '群里默认不自动转发'
})

line('\n== 变异 3~5：回传开关（groupReportToPrivate）==')

// 变异 3：开关写死成开 —— 用户关不掉（默认就该是关的）。
runMutation({
  name: '变异3 回传开关写死成开（用户关不掉）',
  edits: [{
    file: join('lib', 'outbound.js'),
    from: '  if (config?.groupReportToPrivate !== true) {',
    to: '  if (false) {'
  }],
  expectRed: '默认关：群里的汇报正文直接丢弃'
})

// 变异 4：开关写死成关 —— 用户开了不生效。
runMutation({
  name: '变异4 回传开关写死成关（用户开了不生效）',
  edits: [{
    file: join('lib', 'outbound.js'),
    from: '  if (config?.groupReportToPrivate !== true) {',
    to: '  if (true) {'
  }],
  expectRed: '打开后：汇报回传到私聊'
})

// 变异 5：回传目标写死成群 —— 最坏的修法：把「回传私聊」做成「又发一遍进群」。
runMutation({
  name: '变异5 回传目标写死成群（等于又发进群）',
  edits: [{
    file: join('lib', 'outbound.js'),
    from: '  const privateTarget = privateRouteTarget()',
    to: '  const privateTarget = { kind: \'group\', id: String(target?.id ?? \'\') }'
  }],
  expectRed: '走的是**私聊**出口'
})

line('\n== 变异 6~7：私聊那条既有决策不许被误伤 ==')

// 变异 6：一刀切（把「说出口了照发」整段删掉）—— 私聊里她真说了话却发不出去。
runMutation({
  name: '变异6 私聊「说出口了照发」被一刀切掉',
  edits: [{
    file: join('lib', 'outbound.js'),
    from: '            if (!isStageOnly(text)) {',
    to: '            if (false) {'
  }],
  expectRed: '私聊 qq_pass + 正文写了真话 → 照发'
})

// 变异 7：连纯动作也放行 —— 私聊退回旧行为（「（尾巴摆了摆）」被发出去）。
runMutation({
  name: '变异7 私聊纯动作正文也放行（旧行为回归）',
  edits: [{
    file: join('lib', 'outbound.js'),
    from: '            if (!isStageOnly(text)) {',
    to: '            if (true) {'
  }],
  expectRed: '私聊 qq_pass + 纯动作正文 → 真按下不发'
})

line(`\n结果：${pass} 过 / ${fail} 败（变异全部被抓住才算通过）`)
process.exit(fail > 0 ? 1 : 0)
