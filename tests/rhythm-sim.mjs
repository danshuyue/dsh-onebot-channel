/**
 * 节奏与收尾测试：node tests/rhythm-sim.mjs，退出码 0 = 全过。
 *
 * 这块测的都是**看不见的行为** —— 「她没有说话」在日志里几乎不留下痕迹，
 *  一旦判断逻辑写错，表现就是「她怎么突然不理人了」，而且极难排查。
 *  所以每个分支都要钉住：
 *    · closure：什么时候该收（尤其是「对方还在问 → 不许收」这条硬规矩）
 *    · rhythm：补静默的续期、划走标记会不会过期自愈（最怕永久失声）
 *
 * 纯逻辑 + 短定时，不碰真 QQ、不碰真会话。
 */
import { assessClosure, classifyUtterance, describeClosure } from '../lib/closure.js'
import { targetKey, suppress, consumeSuppress, suppressedKeys, waitQuiet, markIncoming, clampLimit, SUPPRESS_TTL_MS, isStageOnly } from '../lib/rhythm.js'

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}`)
  }
}
function eq(actual, expected, name) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, `${name}${same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`)
}

// ---- closure.js：一句话属于哪一类 ----

console.log('closure · 分类：')
{
  eq(classifyUtterance('晚安'), 'ending', '道别 → ending')
  eq(classifyUtterance('拜拜'), 'ending', '再见 → ending')
  eq(classifyUtterance('你怎么还没睡？'), 'question', '带问号 → question')
  eq(classifyUtterance('这个是怎么回事'), 'question', '含疑问词 → question')
  eq(classifyUtterance('帮我查一下明天的天气'), 'request', '求助 → request')
  eq(classifyUtterance('哈哈'), 'ack', '短附和 → ack')
  eq(classifyUtterance('确实'), 'ack', '同意词 → ack')
  eq(classifyUtterance('我今天去看了电影，超好看的'), 'substantive', '有内容 → substantive')
  eq(classifyUtterance(''), 'empty', '空串 → empty')
  eq(classifyUtterance('   '), 'empty', '纯空白 → empty')
}

// ---- closure.js：该不该收 ----

console.log('closure · 判断：')
{
  // 硬规矩：对方还在问，分数再高也不能收
  const r = assessClosure({ mine: '嗯嗯好', theirs: '那这个到底怎么弄啊？' })
  ok(r.openQuestion === true, '对方还在提问 → 认出未闭环')
  eq(r.level, 'continue', '有未答提问硬判继续（不许用收尾逃避回答）')
  ok(r.score < 0.45, `未答提问把分数压到 linger 以下（实际 ${r.score}）`)
}
{
  const r = assessClosure({ mine: '好的', theirs: '帮我看看这个功能怎么用' })
  eq(r.level, 'continue', '对方在求助同样不许收尾')
}
{
  // 双方都收尾式 + 对方道别 → 应该能收
  const r = assessClosure({
    mine: '哈哈好，晚安～',
    theirs: '晚安，我也睡了',
    recent: [{ mine: '那就这样吧' }, { mine: '嗯' }],
  })
  eq(r.level, 'close', '双方道别 + 越回越短 → 可以收了')
  ok(r.score >= 0.62, `收尾分够高（实际 ${r.score}）`)
  ok(r.reasons.length > 0, '给了判断依据（可解释）')
}
{
  // 我想说还没说完 → 不想收
  const r = assessClosure({ mine: '嗯', theirs: '哈哈', pendingThought: '想问他那个东西后来怎么样了' })
  ok(r.score < 0.62, `还惦记着要说的话 → 不急着收（实际 ${r.score}）`)
  ok(r.reasons.includes('我还有想说没说的话'), '理由里写明了还有话没说')
}
{
  // 话题还在推进（对方在讲实质内容）→ 不该收
  const r = assessClosure({ mine: '嗯嗯', theirs: '我跟你说，今天那事还有后续……' })
  ok(r.myKind !== 'empty', '我方末句分类有效')
  ok(r.level !== 'close', '对方还在讲正事时不会误判成该收')
}
{
  const r = assessClosure({ mine: '在等他回我？', theirs: '嗯' })
  ok(r.myKind === 'question', '我在等他回答时被认出来')
  ok(r.level !== 'close', '我还等着回话时不收尾')
}
{
  const text = describeClosure(assessClosure({ mine: '好', theirs: '晚安' }))
  ok(typeof text === 'string' && text.length > 0, '给模型看的判断说明非空')
}

// ---- rhythm.js：目标 key ----

console.log('rhythm · 目标：')
{
  eq(targetKey({ kind: 'group', id: '123' }), 'group:123', '群 key')
  eq(targetKey({ kind: 'private', id: '456' }), 'private:456', '私聊 key')
  eq(targetKey({}), '', '空 target 不给 key（避免误用空 key 串在哪也不错）')
}

// ---- rhythm.js：划走必须能被消费，也必须会自愈 ----

console.log('rhythm · 划走：')
{
  suppress('group:900', 'unit-test')
  ok(suppressedKeys().includes('group:900'), '划走后出现在清单里')
  ok(consumeSuppress('group:900') === true, '第一次消费命中')
  ok(consumeSuppress('group:900') === false, '第二次不再命中（一次性消费）')
  ok(!suppressedKeys().includes('group:900'), '消费后从清单里消失')
}
{
  // ⚠️ 最关键的一条：标记如果没被消费（那一回合没走到转发），
  //    绝不能把下一次正常回复吃掉 —— 表现成「她再也不说话了」。
  suppress('private:901', 'unit-test-stale')
  // 手推时间戳到过期之后
  const original = Date.now
  Date.now = () => original() + SUPPRESS_TTL_MS + 1000
  try {
    ok(consumeSuppress('private:901') === false, '过期标记当作没划走过（自愈）')
    ok(!suppressedKeys().includes('private:901'), '过期标记被清理掉')
  } finally {
    Date.now = original
  }
}

// ---- rhythm.js：补静默 ----

console.log('rhythm · 补静默：')
{
  const r0 = await waitQuiet('group:902', 0)
  ok(r0.waitedMs === 0 && r0.skipped === true, '配置为 0 时立刻返回（功能关闭时零开销）')
}
{
  const key = 'group:903'
  markIncoming(key, Date.now())
  const started = Date.now()
  const r = await waitQuiet(key, 250)
  const cost = Date.now() - started
  ok(cost >= 200, `确实等待了（实际 ${cost}ms）`)
  ok(r.waitedMs >= 200, `返回了等待时长（实际 ${r.waitedMs}ms）`)
}
{
  // 连发续期：等待途中又有新话 → 从新那条重新计时，不能抢答
  const key = 'group:904'
  markIncoming(key, Date.now())
  const timer = setTimeout(() => { markIncoming(key, Date.now()) }, 150)
  const started = Date.now()
  await waitQuiet(key, 300)
  clearTimeout(timer)
  const cost = Date.now() - started
  ok(cost >= 400, `中途来新话会续期（实际 ${cost}ms，应 ≥ 150+300）`)
}
{
  // 预算保护：永远有人说话时不能把她吊死
  const key = 'group:905'
  const timer = setInterval(() => { markIncoming(key, Date.now()) }, 50)
  const started = Date.now()
  const r = await waitQuiet(key, 5000, 400)
  clearInterval(timer)
  ok(r.budgetExceeded === true, '刷屏时超预算放行，不会永久等待')
  ok(Date.now() - started < 2000, `总耗时受预算约束（实际 ${Date.now() - started}ms）`)
}

// ---- rhythm.js：坏配置不能变成「无限」 ----

console.log('rhythm · 限额：')
{
  eq(clampLimit(undefined, 0, 0, 60000), 0, 'undefined 回默认值')
  eq(clampLimit('abc', 0, 0, 60000), 0, '非数字回默认值')
  eq(clampLimit(999999, 0, 0, 60000), 60000, '超上限被夹住')
  eq(clampLimit(-5, 0, 0, 60000), 0, '负数被夹住')
}

console.log('rhythm · 「只有动作」的判定（主动搭话回合用）：')
{
  eq(isStageOnly('（尾巴慢慢摆了两下，趴在窗边没出声）'), true, '整条都是括号动作 → 算沉默')
  eq(isStageOnly('（耳朵动了动，继续安静待着）……'), true, '动作 + 省略号 → 还是沉默')
  eq(isStageOnly('（安静趴着，耳朵偶尔抖一下）\n（尾巴卷了一下）'), true, '多条动作拼起来 → 沉默')
  eq(isStageOnly('（笑）好呀，那我在教室等你'), false, '动作 + 真话 → 照发')
  eq(isStageOnly('嗯'), false, '一个字也是话')
  eq(isStageOnly('[表情:呲牙]'), false, '只有表情标记不算动作描写（表情本身是能发的）')
  eq(isStageOnly('   '), true, '纯空白 → 没什么可发')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed > 0 ? 1 : 0)
