/**
 * 唤醒词（wake.js）验证 —— 0.23.0。
 *
 * 分三块：
 *   ① 归一化：分隔符、去重、长度护栏、上限
 *   ② 命中：子串匹配、最长优先、纯文字口径
 *   ③ 节流：一小时内上限、`0` = 不限、窗口滑动
 *
 * ⚠️ 每条断言都要能区分「实现存在」与「实现缺失」。
 *   写完必须做变异验证（见 `wake-mutation.mjs`），否则就是假绿。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  normalizeWakeWords, matchWakeWord, renderWakeNote,
  wakeQuotaOf, noteWakeUsed, resetWakeThrottle,
  WAKE_WORD_MAX, WAKE_THROTTLE_WINDOW_MS
} from '../lib/wake.js'
import { textSegmentsOf } from '../lib/commands.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')

let pass = 0
const failures = []
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log('  ✓ ' + label) } else { failures.push(label); console.error('  ✗ ' + label) }
}
const eq = (actual, expected, label) => {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, `${label}${same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`)
}

// ===========================================================================
// 1. 归一化

console.log('归一化：')
eq(normalizeWakeWords('').words, [], '空串 → 空词表（= 功能关闭，不是错误）')
eq(normalizeWakeWords(null).words, [], 'null → 空词表')
eq(normalizeWakeWords(undefined).words, [], 'undefined → 空词表')

eq(
  normalizeWakeWords('大肥鱼,肥鱼，阿鱼、老鱼\n小鱼').words,
  ['大肥鱼', '肥鱼', '阿鱼', '老鱼', '小鱼'],
  '中英文逗号 / 顿号 / 换行 都是分隔符'
)

eq(
  normalizeWakeWords('大肥鱼，大肥鱼， 大肥鱼 ').words,
  ['大肥鱼'],
  '重复项去重（含首尾空白）'
)

eq(
  normalizeWakeWords('BigFish，bigfish').words,
  ['BigFish'],
  '英文去重不区分大小写，但保留用户写的原样'
)

{
  const result = normalizeWakeWords('鱼,大肥鱼,你')
  eq(result.words, ['大肥鱼'], '单字被拒：鱼 / 你 都不进词表')
  eq(result.rejected.length, 2, '单字被拒时要回显两条原因（不能静默丢）')
  ok(result.rejected.every((row) => row.why.includes('太短')), '拒绝原因写明「太短」')
}

{
  // emoji 词：`'🐟🐟'.length === 4` 但只有 2 个字符，
  // 用 length 判长度会把一个码点当成两个字 —— 这里钉死按字符数算。
  const result = normalizeWakeWords('🐟🐟')
  eq(result.words, ['🐟🐟'], 'emoji 唤醒词按字符数（2 字符）通过，不是被 length 骗成 4')
  eq(normalizeWakeWords('🐟').rejected.length, 1, '单个 emoji 仍算「1 字」，被拒')
}

{
  const long = '一'.repeat(33)
  const result = normalizeWakeWords(long)
  eq(result.words, [], '超过 32 字的词被拒')
  ok(result.rejected[0].why.includes('太长'), '拒绝原因写明「太长」')
}

{
  const many = Array.from({ length: WAKE_WORD_MAX + 3 }, (_, i) => `词${String(i).padStart(2, '0')}`)
  const result = normalizeWakeWords(many.join(','))
  eq(result.words.length, WAKE_WORD_MAX, `词表上限 ${WAKE_WORD_MAX}，超出部分丢弃`)
  eq(result.rejected.length, 3, '超上限的 3 个词要回显原因')
}

eq(normalizeWakeWords(['大肥鱼', '', '肥鱼']).words, ['大肥鱼', '肥鱼'], '数组输入同样清洗（空元素丢掉）')

// ===========================================================================
// 2. 命中

console.log('命中：')
eq(matchWakeWord('大肥鱼你在吗', ['大肥鱼']), '大肥鱼', '子串命中（前面没有分隔符也一样）')
eq(matchWakeWord('今天大肥鱼没来', ['大肥鱼']), '大肥鱼', '词在句子中间也命中')
eq(matchWakeWord('今天天气不错', ['大肥鱼']), '', '没提到就不命中')
eq(matchWakeWord('', ['大肥鱼']), '', '空正文不命中')
eq(matchWakeWord('大肥鱼', []), '', '词表为空时恒不命中（功能关闭）')

eq(
  matchWakeWord('大肥鱼和肥鱼都在', ['肥鱼', '大肥鱼']),
  '大肥鱼',
  '多个词同时命中时返回**最长**的那个（提示词要写得更具体）'
)

eq(matchWakeWord('BIGFISH 来了', ['bigfish']), 'bigfish', '英文命中不区分大小写')

{
  // ⚠️ 这条是口径断言：判据必须是纯文字段。
  //    `textOf` 会把 at 段渲染成 `@3566906627`，于是「@ 她 + 正文没提唤醒词」
  //    在 textOf 里看起来像正文里多了个数字串 —— 不该命中唤醒词。
  //    这里直接拿段数组走 textSegmentsOf，验证它剔掉了 at 段。
  const segments = [
    { type: 'at', data: { qq: '3566906627' } },
    { type: 'text', data: { text: ' 在吗' } }
  ]
  const plain = textSegmentsOf(segments)
  eq(plain, '在吗', 'textSegmentsOf 剔掉 at 段，只留纯文字')
  eq(matchWakeWord(plain, ['3566906627']), '', '纯文字口径下，「@ 她那串号」不会命中号本身')
}

{
  // 真正的「@ + 提到了词」：应当命中（这正是设计要的：@ 和唤醒同时出现，算一次唤醒）
  const segments = [
    { type: 'at', data: { qq: '3566906627' } },
    { type: 'text', data: { text: ' 大肥鱼 你去看看' } }
  ]
  eq(matchWakeWord(textSegmentsOf(segments), ['大肥鱼']), '大肥鱼', '@ 与唤醒词同时出现时，纯文字里仍能命中')
}

// ===========================================================================
// 3. 提示词渲染

console.log('提示词：')
eq(renderWakeNote('', '大肥鱼'), '', '模板空串 = 不加这一行')
eq(renderWakeNote('   ', '大肥鱼'), '', '模板只有空白也视为空')
eq(
  renderWakeNote('（有人提到了你（「{word}」），去看看吧）', '大肥鱼'),
  '（有人提到了你（「大肥鱼」），去看看吧）',
  '{word} 被替换'
)
eq(
  renderWakeNote('{word} 和 {word}', '肥鱼'),
  '肥鱼 和 肥鱼',
  '多次出现全部替换（不能只替第一个）'
)

// ===========================================================================
// 4. 节流

console.log('节流：')
resetWakeThrottle()
{
  const t0 = 1000
  eq(wakeQuotaOf('g1', 3, t0).allowed, true, '还没用过 → 允许')
  noteWakeUsed('g1', t0)
  noteWakeUsed('g1', t0 + 1000)
  noteWakeUsed('g1', t0 + 2000)
  const blocked = wakeQuotaOf('g1', 3, t0 + 3000)
  eq(blocked.allowed, false, '用满 3 次 → 拒绝')
  eq(blocked.used, 3, 'used 报出真实次数')
  eq(wakeQuotaOf('g2', 3, t0 + 3000).allowed, true, '别的群不受影响（按群独立计数）')
}

resetWakeThrottle()
{
  const t0 = 10_000
  noteWakeUsed('g1', t0)
  noteWakeUsed('g1', t0 + 60_000)
  noteWakeUsed('g1', t0 + 120_000)
  // 窗口滑到第 4 次那个时刻：第一条（t0）已滑出 1 小时窗口
  const later = t0 + WAKE_THROTTLE_WINDOW_MS + 1
  const quota = wakeQuotaOf('g1', 3, later)
  eq(quota.used, 2, '一小时窗口滑动：t0 那条已过期，只剩 2 条')
  eq(quota.allowed, true, '滑出窗口后重新放行')
}

resetWakeThrottle()
{
  noteWakeUsed('g1', 5000)
  eq(wakeQuotaOf('g1', 0, 5000).allowed, true, 'limit=0 = 不限（0 不是「关」的反面，是显式不限）')
  eq(wakeQuotaOf('g1', -1, 5000).allowed, true, '负数同样视为不限')
  eq(wakeQuotaOf('g1', Number.NaN, 5000).allowed, true, '脏值 NaN 退回「不限」，不是「永久拦住」')
  eq(wakeQuotaOf('g1', undefined, 5000).allowed, true, '没配 limit 时不禁用')
}

resetWakeThrottle()

// ===========================================================================
// 5. 接线（源码断言）
//
// ⚠️ 为什么这里必须用源码断言：上面那些纯函数全绿，**只证明组件对**，
//    完全不证明「它们真的被接上了」。0.21.1 就是组件对、接线漏，而测试全绿。
//
// ⚠️ 判据纪律（维护索引 §4 坑 26d）：不要断言「某个字符串在不在文件里」——
//    同一模式出现两处时，改坏一处仍然绿。这里断言的每一条都是**完整的一行**，
//    并且互补断（把行改回去必须不成立）。变异验证见 wake-mutation.mjs。
console.log('接线：')
{
  const poll = readFileSync(join(PLUGIN, 'lib/poll.js'), 'utf8')
  const windowSrc = readFileSync(join(PLUGIN, 'lib/window.js'), 'utf8')

  // ① 窗口开着时不入队（用户明确要的：当普通续聊处理，不重复唤醒）
  ok(
    poll.includes('if (windowMode && win !== null && !atMe && !wakeMe && shouldQueueForWindow(win, message, config)) {'),
    '入队判定里带 !wakeMe（窗口开着时唤醒词不入队）'
  )
  // ② 唤醒不 @ 回去（首句）
  ok(
    poll.includes('const atUin = wakeMe'),
    '首句自动 @ 计算里判了 wakeMe'
  )
  ok(
    poll.includes("? ''\n    : (win === null"),
    '唤醒时 atUin 取自「空串」分支（不是走原来的 atMe 分支）'
  )
  // ③ 窗口记录带 openedBy，且 atUinForWindow 认这个标记
  ok(
    windowSrc.includes("if (String(win.openedBy ?? 'at') === 'wake') return ''"),
    'atUinForWindow 对 openedBy=wake 的窗口恒返回空串（窗口内第二句也不 @）'
  )
  ok(
    windowSrc.includes("if (win.openedBy !== 'wake') win.openedBy = 'at'"),
    'normalizeRecord 把老记录（缺 openedBy）归一化成 at'
  )
  // ④ 节流真的挂在投递前
  ok(
    poll.includes('const quota = wakeQuotaOf(groupId, config.wakePerGroupHourly)'),
    '投递前查了唤醒节流（wakeQuotaOf）'
  )
  ok(
    poll.includes('noteWakeUsed(groupId)'),
    '通过节流后记了一次唤醒（noteWakeUsed）'
  )
  // ⑤ 唤醒开窗要标 by='wake'
  ok(
    poll.includes("openWindow(groupId, String(message?.sender?.user_id ?? ''), 'wake')"),
    "唤醒开窗时传了 openedBy='wake'"
  )
  // ⑥ 门控：唤醒开窗后也要 holdWindowBatches（与 @ 同款，缺它顺序就反）
  ok(
    /wakeMe && windowMode && win === null[\s\S]{0,900}?holdWindowBatches\(groupId, triggerId\)/.test(poll),
    '唤醒开窗后也 holdWindowBatches（否则攒批会抢在唤醒那条前面）'
  )
  // ⑦ 唤醒提示真的拼进了正文
  ok(
    poll.includes('const headWithWake = wakeNoteRaw === \'\' ? head : `${head}\\n${wakeNoteRaw}`'),
    '唤醒提示拼在 head 之后（非唤醒时 headWithWake === head，逐字不变）'
  )
  // ⑧ 结算：唤醒也要 settle（否则门控永不释放、额度漏扣）
  //
  // ⚠️ 这条断言必须**切片锁定 catch 块**，不能只查那一行字符串：
  //    `if ((atMe || wakeMe) && windowMode) settleWindowOpening(groupId, triggerId, false)`
  //    在 `deliverGroupMessage` 里出现**两处**（catch 分支、used === '' 分支），
  //    只查字符串的话，改坏其中一处、另一处照样满足 —— 变异验证第一次就是
  //    这么漏网的（维护索引 §4 坑 26d 的教科书形态）。
  //    所以这里取「catch (error) {」到「throw error」之间那段来断言。
  {
    const catchAt = poll.indexOf('} catch (error) {\n    // 0.23.0：唤醒这条路也要结算门控')
    const throwAt = poll.indexOf('throw error', catchAt)
    const catchBlock = catchAt >= 0 && throwAt > catchAt ? poll.slice(catchAt, throwAt) : ''
    ok(catchBlock !== '', '能定位到 deliver 的 catch 块')
    ok(
      catchBlock.includes('if ((atMe || wakeMe) && windowMode) settleWindowOpening(groupId, triggerId, false)'),
      '唤醒投递失败也结算门控（catch 块里判的是 atMe || wakeMe，不是只有 atMe）'
    )
  }
  ok(
    poll.includes('if (win === null && atMe) openWindow(groupId, senderUin)'),
    '兜底开窗只给 @ 用（唤醒若没开成，这里不能再开一个 at 窗，否则不 @ 立刻失效）'
  )
  // ⑨ buffer 必须是快照（这条断言与 interest-wiring-sim 里那条重复是有意的：
  //    两个文件分别对着「唤醒」与「兴趣点」两套变异脚本，各要能独立抓住它）
  ok(poll.includes('buffer: groupBuffer(groupId).slice(),'), 'buffer 传的是**此刻的快照**（.slice()），不是 groupBuffer 函数')
  ok(poll.includes("groupName: groupNames.get(groupId) ?? ''"), 'groupName 由 poll.js 交过去（interest.js 对 poll.js 零依赖）')
}

// ===========================================================================
// 结论

console.log('')
if (failures.length === 0) {
  console.log(`全部通过：${pass} 项`)
  process.exit(0)
}
console.error(`失败 ${failures.length} 项 / 共 ${pass + failures.length} 项：`)
for (const label of failures) console.error('  · ' + label)
process.exit(1)