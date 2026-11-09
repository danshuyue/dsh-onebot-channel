/**
 * crowd-hint-mutation.mjs —— 0.21.4「消息过多提示」的变异验证。
 * node tests/crowd-hint-mutation.mjs，退出码 0 = 全部被抓住。
 *
 * ## 为什么必须有（本仓库最贵的一条纪律）
 *
 * 新写的断言不验证就是「假绿温床」。**这个文件的第一版就当场抓到了一个真缺陷**：
 * `crowdHintText` 原本写的是 `Math.max(0, Number(raw) || 0)`，
 * 配置里是脏值（'abc'）时 `Number('abc')` 是 NaN，`NaN || 0` 得 0 ——
 * 于是**阈值变成 0、整个提示被静默关掉**，而用户只会以为提示坏了。
 * 是 `crowd-hint-sim` 里那条「脏字符串 → 回默认 5」的断言把它逼出来的。
 *
 * ## 这一版要钉住什么
 *
 * ✅ H1 判据写成 `>` 而不是 `>=` —— 默认 5 时提示永不出现
 *      （一次性 @ 的上下文软上限恰好就是 5，这是**最容易犯**的错）
 * ✅ H2 把 0 吞成默认 5（用户关掉了，插件却开始提示）
 * ✅ H3 窗口批次那条路没接上（0.21.1 就是这么栽的：只改一条路）
 * ✅ H4 一次性 @ 那条路没接上
 *
 * ⚠️ 每个变异用**独立 HOME**：否则前一个变异残留的配置会污染后一个。
 *    （本插件对 crowd hint 用的是源码断言 + 纯函数调用，污染风险小，
 *      但保持一致 —— 以后有人把它改成集成测试就不用改这里。）
 * ⚠️ 子进程输出走**文件重定向**而不是管道：受限环境下管道会 EPERM。
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const TEST = 'tests/crowd-hint-sim.mjs'

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

/** 造一份独立 HOME + 插件副本。 */
function sandbox(tag) {
  const work = join(tmpdir(), `qq-ch-${tag}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
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
  return { work, home, plugin }
}

function runIn({ work, home, plugin }) {
  const log = join(work, 'out.txt')
  const result = spawnSync(process.execPath, [TEST], {
    cwd: plugin,
    env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: work, TEMP: work, TMP: work },
    encoding: 'utf8',
    timeout: 120000
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  try { writeFileSync(log, output, 'utf8') } catch { /* 尽力 */ }
  return { status: result.status, output }
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
    line(`     ↳ 输出尾部：\n${output.split(/\r?\n/).slice(-12).map((l) => `       ${l}`).join('\n')}`)
  }

  rmSync(box.work, { recursive: true, force: true })
  return true
}

// ---- baseline：未变异时必须全绿，否则后面「红了」证明不了任何事 ----
line('== baseline：未变异时 crowd-hint-sim 必须全绿 ==')
{
  const box = sandbox('base')
  const { status, output } = runIn(box)
  const green = status === 0 && !output.includes('✗')
  ok(green, 'baseline crowd-hint-sim 全绿（未变异时不能红）')
  if (!green) {
    line(`     ↳ status=${status}\n${output.split(/\r?\n/).slice(-14).map((l) => `       ${l}`).join('\n')}`)
  }
  rmSync(box.work, { recursive: true, force: true })
}

line('\n== 变异 1~2：判据本身（prompt.js 的 crowdHintText）==')

// 变异 1：>= 改成 > —— 默认 5 时提示永不出现。
// ⚠️ 这是本改动**最容易犯**的错：一次性 @ 的上下文软上限恰好就是 5。
runMutation({
  name: '变异1 判据写成 >（默认 5 时永不提示）',
  edits: [{
    file: join('lib', 'prompt.js'),
    from: '  if (count < limit) return \'\'',
    to: '  if (count <= limit) return \'\''
  }],
  expectRed: '5 条（正好达到默认阈值 5）'
})

// 变异 2：把 0 吞成默认 5 —— 用户明确关掉了，插件却开始提示。
runMutation({
  name: '变异2 把 0 吞成默认 5（关不掉）',
  edits: [{
    file: join('lib', 'prompt.js'),
    from: '  if (limit <= 0) return \'\'',
    to: '  if (limit < 0) return \'\''
  }],
  expectRed: '阈值设 0'
})

line('\n== 变异 3~4：两条投递路的接线（poll.js）==')

// 变异 3：窗口批次那条路不接 —— 绝大多数续聊走这条路，提示等于没做。
//
// ⚠️ 预期红的是「**调用了** crowdHintText」那条，不是「拼进了正文 body」：
//    把调用换成空串时 `${crowdLine}` 这个占位符还在，所以「拼进正文」那条**照样绿**。
//    这正是「判定条件被多个因素满足」的形态 —— 两条断言各管一半，
//    所以这里钉的是真正会红的**那一条**（这个值是我实测出来的，不是猜的）。
runMutation({
  name: '变异3 窗口批次没接（只接一次性 @）',
  edits: [{
    file: join('lib', 'poll.js'),
    from: '  const crowdNote = crowdHintText(lines.length, config)',
    to: '  const crowdNote = \'\' /* 变异：窗口批次不提示 */'
  }],
  expectRed: '【窗口批次】调用了 crowdHintText'
})

// 变异 4：一次性 @ 那条路不接。同理，红的是「调用了」那条。
runMutation({
  name: '变异4 一次性 @ 没接（只接窗口批次）',
  edits: [{
    file: join('lib', 'poll.js'),
    from: '  const crowdNote = crowdHintText(context.length, config)',
    to: '  const crowdNote = \'\' /* 变异：一次性 @ 不提示 */'
  }],
  expectRed: '【一次性 @】调用了 crowdHintText'
})

// 变异 5：算了但不用（拼进正文那一步漏了）—— 验证「算出来 ≠ 用上了」。
runMutation({
  name: '变异5 算了不用（crowdLine 没拼进正文）',
  edits: [{
    file: join('lib', 'poll.js'),
    from: "    + `\\n[这段时间的群聊]\\n${crowdLine}${lines.join('\\n')}`",
    to: "    + `\\n[这段时间的群聊]\\n${lines.join('\\n')}`"
  }],
  expectRed: '【窗口批次】把提示拼进了正文 body'
})

// 变异 6：判据换成 unread 总量（几乎每回合都触发 = 噪音）。
// 这条验证的是「判据用的是 context.length」那份断言真的在起作用。
runMutation({
  name: '变异6 判据换成未读总量（unread.length）',
  edits: [{
    file: join('lib', 'poll.js'),
    from: '  const crowdNote = crowdHintText(context.length, config)',
    to: '  const crowdNote = crowdHintText(unread.length, config)'
  }],
  expectRed: '判据用的是 context.length'
})

line(`\n结果：${pass} 过 / ${fail} 败（变异全部被抓住才算通过）`)
process.exit(fail > 0 ? 1 : 0)
