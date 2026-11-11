/**
 * wake-mutation —— 唤醒词（0.23.0）变异验证。
 *
 * ## 它为什么必须存在
 *
 * `wake-sim.mjs` 的 52 条断言全绿，**只说明「现在的代码满足这些断言」**。
 * 它不说明「这些断言能区分对与错」—— 一条只写了 `ok(true, ...)` 的断言也全绿。
 * 唯一能证明断言有效的办法：**把实现逐条改坏，看它是不是真的变红**，
 * 而且红的必须是**那一条**（不是别的错连坐）。这是维护索引 §4 坑 27 的纪律。
 *
 * ## 三个必须守住的工程细节（都踩过）
 *
 * ① **子进程 stdout 重定向到文件，不用管道**：受限环境下 `stdio:'pipe'` 会 EPERM，
 *    读到 0 字节 —— 现象是「变异一个都没被抓住」，看着像测试假绿，其实是一个字节都没读到（坑 28）。
 * ② **每个变异一个独立 HOME**：`run-isolated` 之外的模块单例是跨 import 共享的，
 *    前一个变异的残留配置会污染后一个，表现是「单跑绿、整串红」。
 * ③ **`patch()` 必须真的替换到**：没命中就直接报错，不能静默跳过 ——
 *    否则「变异没生效」会被误读成「变异没被抓住」。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, closeSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')

function pickRoot() {
  for (const root of [
    join(tmpdir(), `wake-mut-${process.pid}`),
    join(PLUGIN, '..', '.tmp-test', `wake-mut-${process.pid}`)
  ]) {
    try { mkdirSync(root, { recursive: true }); return root } catch { /* 换下一个 */ }
  }
  throw new Error('没有可写的临时目录')
}

const ROOT = pickRoot()
mkdirSync(ROOT, { recursive: true })

function makeHome(tag) {
  const home = join(ROOT, `home-${tag}`)
  mkdirSync(join(home, '.dsh'), { recursive: true })
  return home
}

function makeCopy(tag) {
  const dir = join(ROOT, `copy-${tag}`)
  cpSync(PLUGIN, dir, {
    recursive: true,
    filter: (src) => !src.includes('node_modules') && !src.includes('.git') && !src.includes('.tmp-test')
  })
  return dir
}

function runTest(copyDir, testRel, home) {
  const log = join(home, `log-${Math.random().toString(36).slice(2)}.txt`)
  let fd
  try {
    fd = openSync(log, 'w')
    execFileSync(process.execPath, [join(copyDir, testRel)], {
      cwd: copyDir,
      stdio: ['ignore', fd, fd],
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        DSH_TEST_HOME: home,
        TMPDIR: home,
        TEMP: home,
        TMP: home
      }
    })
    closeSync(fd); fd = undefined
    return { ok: true, output: '' }
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* 已关 */ } }
    let output = ''
    try { output = readFileSync(log, 'utf8') } catch { output = '' }
    return { ok: false, output: output || `（读不到输出：${error instanceof Error ? error.message : error}）` }
  }
}

function patch(copyDir, rel, from, to) {
  const file = join(copyDir, rel)
  const src = readFileSync(file, 'utf8')
  if (!src.includes(from)) throw new Error(`变异没命中：${rel} 里找不到\n${from.slice(0, 240)}`)
  writeFileSync(file, src.replace(from, to), 'utf8')
}

const TEST = 'tests/wake-sim.mjs'

// ---- baseline：原始代码必须绿 ----------------------------------------------
{
  const dir = makeCopy('baseline')
  const baseline = runTest(dir, TEST, makeHome('baseline'))
  if (!baseline.ok) {
    console.error('✗ baseline 就红了 —— 后面的变异结论没意义，先把它修绿：\n')
    console.error(baseline.output.split('\n').filter((l) => l.includes('✗') || /Error/.test(l)).slice(0, 20).join('\n'))
    process.exit(1)
  }
  console.log('✓ baseline 绿（原始代码）')
  rmSync(dir, { recursive: true, force: true })
}

const MUTATIONS = [
  // ---- 纯函数层 ----
  {
    label: '单字不再拒收（「鱼」进入词表 → 整个群每句话都在叫她）',
    apply: (dir) => patch(dir, 'lib/wake.js',
      'const chars = Array.from(word).length\n    if (chars < WAKE_WORD_MIN_LENGTH) {',
      'const chars = Array.from(word).length\n    if (chars < 0) {'),
    expect: ['单字被拒：鱼 / 你 都不进词表']
  },
  {
    label: '长度按 .length 算（emoji 被当成 2 字，单 emoji 反而能通过护栏）',
    apply: (dir) => patch(dir, 'lib/wake.js',
      'const chars = Array.from(word).length',
      'const chars = word.length'),
    // ⚠️ 抓它的是「单个 emoji 被拒」那条，不是「emoji 2 字符通过」：
    //    `.length` 只会让**短**的 emoji 词变长（🐟 从 1 变 2，于是绕过护栏），
    //    而 2 字符的 emoji 词在两种算法下都通过 —— 那条断言区分不了这个变异。
    //    这正是「判定条件被多个因素同时满足」的又一种形态：
    //    断言本身没错，只是它盯的不是这个变异改动的那个方向。
    expect: ['单个 emoji 仍算「1 字」，被拒']
  },
  {
    label: '多个词命中时返回第一个而不是最长的（提示词里写不出具体那个词）',
    apply: (dir) => patch(dir, 'lib/wake.js',
      'if (needle.length > best.length) best = String(word).trim()',
      'if (best === \'\') best = String(word).trim()'),
    expect: ['多个词同时命中时返回**最长**的那个']
  },
  {
    label: '区分大小写（英文唤醒词 BIGFISH 命中不了 bigfish）',
    apply: (dir) => patch(dir, 'lib/wake.js',
      'const haystack = body.toLowerCase()',
      'const haystack = body'),
    expect: ['英文命中不区分大小写']
  },
  {
    label: '模板只替换第一个 {word}（后面的原样留在大括号里）',
    apply: (dir) => patch(dir, 'lib/wake.js',
      "return tpl.replace(/\\{word\\}/g, String(word ?? '').trim())",
      "return tpl.replace('{word}', String(word ?? '').trim())"),
    expect: ['多次出现全部替换（不能只替第一个）']
  },
  {
    label: '节流把 limit=0 当成「永久拦住」（用户关掉限流反而全禁了）',
    apply: (dir) => patch(dir, 'lib/wake.js',
      'const limitAllowed = Number.isFinite(cap) && cap > 0',
      'const limitAllowed = Number.isFinite(cap)'),
    expect: ['limit=0 = 不限（0 不是「关」的反面，是显式不限）']
  },
  {
    label: '节流窗口不做滑动清理（一小时前的记录永远算数 → 用过三次就永久静音）',
    apply: (dir) => patch(dir, 'lib/wake.js',
      'const list = (wakeHits.get(key) ?? []).filter((at) => now - at < WAKE_THROTTLE_WINDOW_MS)\n  if (list.length !== (wakeHits.get(key) ?? []).length) wakeHits.set(key, list)',
      'const list = (wakeHits.get(key) ?? [])'),
    expect: ['一小时窗口滑动：t0 那条已过期，只剩 2 条']
  },
  {
    label: '节流按全局计数而不是按群（A 群叫够了，B 群也叫不动）',
    apply: (dir) => patch(dir, 'lib/wake.js',
      'const key = String(groupId ?? \'\').trim()\n  const cap = Number(limit)',
      "const key = '::all::'\n  const cap = Number(limit)"),
    // ⚠️ 抓它的是「用满 3 次 → 拒绝」那一节：`wakeQuotaOf` 和 `noteWakeUsed`
    //    **两处**都改成全局键才一致；只改一处的话，记的键和查的键不同，
    //    于是「用满 3 次」这条直接红（used 恒 0）。
    //    这也说明一个提醒：**同一个常量在图里出现两次时，变异要一起改**，
    //    否则被抓住的是「不一致」而不是「设计错」。
    expect: ['用满 3 次 → 拒绝', 'used 报出真实次数']
  },

  // ---- 接线层 ----
  {
    label: '入队判定去掉 !wakeMe（窗口开着时唤醒词被当续聊入队，不立刻回）',
    apply: (dir) => patch(dir, 'lib/poll.js',
      'if (windowMode && win !== null && !atMe && !wakeMe && shouldQueueForWindow(win, message, config)) {',
      'if (windowMode && win !== null && !atMe && shouldQueueForWindow(win, message, config)) {'),
    expect: ['入队判定里带 !wakeMe']
  },
  {
    label: '首句 atUin 不判 wakeMe（唤醒也会 @ 回触发者 —— 用户明确不要）',
    apply: (dir) => patch(dir, 'lib/poll.js',
      'const atUin = wakeMe\n    ? \'\'',
      'const atUin = false\n    ? \'\''),
    expect: ['首句自动 @ 计算里判了 wakeMe']
  },
  {
    label: 'atUinForWindow 不认 openedBy（窗口内第二句就 @ 回去了 —— 「只挡第一句」）',
    apply: (dir) => patch(dir, 'lib/window.js',
      "if (String(win.openedBy ?? 'at') === 'wake') return ''",
      "if (false) return ''"),
    expect: ['atUinForWindow 对 openedBy=wake 的窗口恒返回空串']
  },
  {
    label: 'openedBy 归一化删掉（老记录缺键 → 行为变成未定义）',
    apply: (dir) => patch(dir, 'lib/window.js',
      "if (win.openedBy !== 'wake') win.openedBy = 'at'",
      ''),
    expect: ['normalizeRecord 把老记录（缺 openedBy）归一化成 at']
  },
  {
    label: '唤醒开窗不传 openedBy=wake（窗口被当成 @ 开的，前两句都会 @）',
    apply: (dir) => patch(dir, 'lib/poll.js',
      "openWindow(groupId, String(message?.sender?.user_id ?? ''), 'wake')",
      "openWindow(groupId, String(message?.sender?.user_id ?? ''))"),
    expect: ["唤醒开窗时传了 openedBy='wake'"]
  },
  {
    label: '删掉唤醒节流（词表一喊就能把窗口额度烧完）',
    apply: (dir) => patch(dir, 'lib/poll.js',
      'const quota = wakeQuotaOf(groupId, config.wakePerGroupHourly)',
      'const quota = { allowed: true, used: 0, limit: 0 }'),
    expect: ['投递前查了唤醒节流（wakeQuotaOf）']
  },
  {
    label: '唤醒后不 holdWindowBatches（攒批抢在唤醒那条前面 → 顺序颠倒）',
    apply: (dir) => patch(dir, 'lib/poll.js',
      "    if (openWindow(groupId, String(message?.sender?.user_id ?? ''), 'wake')) {\n      win = windowOf(groupId)\n      holdWindowBatches(groupId, triggerId)",
      "    if (openWindow(groupId, String(message?.sender?.user_id ?? ''), 'wake')) {\n      win = windowOf(groupId)"),
    expect: ['唤醒开窗后也 holdWindowBatches']
  },
  {
    label: '唤醒提示不拼进正文（配置了模板但模型从没看到过那句话）',
    apply: (dir) => patch(dir, 'lib/poll.js',
      "const headWithWake = wakeNoteRaw === '' ? head : `${head}\\n${wakeNoteRaw}`",
      'const headWithWake = head'),
    expect: ['唤醒提示拼在 head 之后']
  },
  {
    label: '唤醒投递失败不结算门控（白挡 90 秒 + 漏扣一次额度）',
    apply: (dir) => patch(dir, 'lib/poll.js',
      'if ((atMe || wakeMe) && windowMode) settleWindowOpening(groupId, triggerId, false)\n    throw error',
      'if (atMe && windowMode) settleWindowOpening(groupId, triggerId, false)\n    throw error'),
    expect: ['唤醒投递失败也结算门控']
  },
  {
    label: '兜底开窗不再只给 @（唤醒没开成时这里补一个 at 窗 → 不 @ 立刻失效）',
    apply: (dir) => patch(dir, 'lib/poll.js',
      'if (win === null && atMe) openWindow(groupId, senderUin)',
      'if (win === null) openWindow(groupId, senderUin)'),
    expect: ['兜底开窗只给 @ 用']
  },
  {
    label: 'buffer 传函数而不是快照（10 分钟后再取缓冲，前因早被挤掉）',
    apply: (dir) => patch(dir, 'lib/poll.js',
      'buffer: groupBuffer(groupId).slice(),',
      'buffer: groupBuffer(groupId),'),
    expect: ['buffer 传的是**此刻的快照**']
  }
]

let caught = 0
const missed = []
const REPORT = join(PLUGIN, '..', '.tmp-test', 'wake-mutation-report.txt')
const report = []
function both(line, isError = false) {
  report.push(line)
  if (isError) console.error(line); else console.log(line)
}

for (const item of MUTATIONS) {
  const tag = `m${caught + missed.length}`
  const dir = makeCopy(tag)
  const home = makeHome(tag)
  try {
    item.apply(dir)
  } catch (error) {
    both(`✗ 变异没生效：${item.label}\n  ${error instanceof Error ? error.message : error}`, true)
    missed.push(item.label)
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    continue
  }
  const result = runTest(dir, TEST, home)
  if (result.ok) {
    missed.push(item.label)
    both(`✗ 没被抓住：${item.label}`, true)
  } else {
    const reds = result.output.split('\n').filter((line) => line.includes('✗')).map((line) => line.trim())
    // ⚠️ 判据别写成 `output.includes('✗ ' + label)`：有些标签中间夹着变量，
    //    「红了但抓错了」会被误判成「没命中」（坑 26d 的变体）。
    const hit = item.expect.some((label) => reds.some((line) => line.includes(label)))
    if (hit) {
      caught += 1
      both(`✓ 抓住：${item.label}`)
      both(`    └─ ${reds.slice(0, 2).join(' / ')}`)
    } else {
      missed.push(`${item.label}（红了但不是预期那几条）`)
      both(`✗ 红的不是预期断言：${item.label}`, true)
      both(`   预期含：${item.expect.join(' / ')}`, true)
      both(`   实际红：${reds.slice(0, 5).join(' / ') || '（没有 ✗ 行）'}`, true)
    }
  }
  rmSync(dir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}

rmSync(ROOT, { recursive: true, force: true })

both(`\n${caught} 个变异被抓住 / ${missed.length} 个漏网`)
if (missed.length > 0) {
  both('\n漏网的变异：', true)
  for (const label of missed) both(`  - ${label}`, true)
}

try {
  mkdirSync(dirname(REPORT), { recursive: true })
  writeFileSync(REPORT, report.join('\n'), 'utf8')
} catch { /* 写报告失败不影响结论 */ }

process.exit(missed.length === 0 ? 0 : 1)