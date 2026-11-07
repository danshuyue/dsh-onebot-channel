/**
 * split-delay-sim.mjs —— 分条间隔的两种模式（2026-11-07）。
 *
 * ## 这个测试存在的理由
 *
 * 用户报「连着发消息、太急」。查下来参数本来就有，但：
 *   ① 它在「高级」里，用户在「对话节奏」找不到 —— 找不到的配置等于没有；
 *   ② 算式是 `min + min(max-min, 字数×12)`，**两种意图都表达不清**：
 *      想固定就得同时改两个值；而 `max` 把按字数的增长截断了
 *      （实测 40 字封顶 700ms，再长也不等更久）。
 *
 * 所以改成「一个模式 + 一个数值」。这个文件守住的就是：
 *   · fixed 模式下，间隔**与字数无关**（这是「固定」的定义）
 *   · perChar 模式下，间隔**随字数增长且不被内部截断**（这是它的定义）
 *   · maxCapMs 只压最终取值，不改变计量方式
 *
 * ⚠️ 断言必须能区分两种模式。只断言「返回值 > 0」是假绿 —— 那两种模式都过。
 */
import { partDelayMs } from '../lib/split.js'

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}${extra ? '　' + extra : ''}`) }
  else { fail += 1; console.log(`  ✗ ${label}${extra ? '　' + extra : ''}`) }
}

/** 去掉抖动的平均值（多采几次，抵消随机）。 */
function avgDelay(part, options, times = 60) {
  let sum = 0
  for (let i = 0; i < times; i += 1) sum += partDelayMs(part, options)
  return sum / times
}

console.log('\n1. fixed 模式：间隔与字数无关（这是「固定」的定义）')
{
  const opts = { mode: 'fixed', fixedMs: 800 }
  const short = avgDelay('短', opts)
  const long = avgDelay('字'.repeat(200), opts)
  ok(Math.abs(short - 800) < 800 * 0.15 + 20, '1 字的平均值接近 800', `实测 ${short.toFixed(0)}ms`)
  ok(Math.abs(long - 800) < 800 * 0.15 + 20, '200 字的平均值也接近 800', `实测 ${long.toFixed(0)}ms`)
  ok(Math.abs(short - long) < 60, '⚠️ 字数差 200 倍，间隔几乎一样（固定模式的核心）',
    `差 ${Math.abs(short - long).toFixed(0)}ms`)
}

console.log('\n2. perChar 模式：间隔随字数增长')
{
  const opts = { mode: 'perChar', perCharMs: 100 }
  const d10 = avgDelay('字'.repeat(10), opts)
  const d40 = avgDelay('字'.repeat(40), opts)
  const d100 = avgDelay('字'.repeat(100), opts)
  ok(Math.abs(d10 - 1000) < 150, '10 字 ≈ 1000ms', `实测 ${d10.toFixed(0)}ms`)
  ok(Math.abs(d40 - 4000) < 600, '40 字 ≈ 4000ms', `实测 ${d40.toFixed(0)}ms`)
  ok(Math.abs(d100 - 10000) < 1500, '100 字 ≈ 10000ms', `实测 ${d100.toFixed(0)}ms`)
  ok(d40 > d10 * 3, '⚠️ 40 字的间隔明显大于 10 字（不是被截断的）')
  ok(d100 > d40 * 2, '⚠️ 100 字仍比 40 字长（旧实现在这里就封顶了）')
}

console.log('\n3. 旧实现在 40 字以后会封顶 —— 新模式不能重复这个毛病')
{
  // 旧实现：base = min + Math.min(max-min, 字数*12)，800 字也只到 max
  // 这里验证新实现**没有**这种内部截断
  const opts = { mode: 'perChar', perCharMs: 10 }
  const d50 = avgDelay('字'.repeat(50), opts)
  const d500 = avgDelay('字'.repeat(500), opts)
  ok(d500 > d50 * 5, '⚠️ 500 字 vs 50 字：仍是 10 倍关系，没有封顶',
    `${d50.toFixed(0)}ms → ${d500.toFixed(0)}ms`)
}

console.log('\n4. maxCapMs 只压最终取值，不改计量方式')
{
  const capped = { mode: 'perChar', perCharMs: 100, maxMs: 3000 }
  const d100 = avgDelay('字'.repeat(100), capped)
  ok(d100 <= 3000, '被上限压住了', `实测 ${d100.toFixed(0)}ms ≤ 3000`)
  ok(d100 > 2500, '⚠️ 压到上限附近，不是压成 0')

  // 不超上限时不该受影响
  const small = avgDelay('字'.repeat(5), capped)
  ok(Math.abs(small - 500) < 150, '没超上限时按原值算', `实测 ${small.toFixed(0)}ms`)
}

console.log('\n4b. maxMs = 0 表示「不封顶」（不是「上限 0 毫秒」）')
{
  // ⚠️ 这条是端到端验证时抓出来的真 bug：最初写成
  //      const capped = clampNumber(options.maxMs, 1, MAX, 0)
  //    于是 maxMs:0 被抬到 1 → 间隔变成 1ms → 看上去像「配置没生效」。
  //    单元测试当时没覆盖 maxMs:0，所以一直是绿的。
  const uncapped = { mode: 'perChar', perCharMs: 100, maxMs: 0 }
  const d50 = avgDelay('字'.repeat(50), uncapped)
  ok(d50 > 4000, '⚠️ maxMs:0 时不被压（50 字 ≈ 5000ms）', `实测 ${d50.toFixed(0)}ms`)

  const d200 = avgDelay('字'.repeat(200), uncapped)
  ok(d200 > 15000, '⚠️ 200 字 ≈ 20000ms，确实没有天花板', `实测 ${d200.toFixed(0)}ms`)
}

console.log('\n5. 容错：配置被手改坏也不炸')
{
  ok(partDelayMs('x', { mode: 'nonsense' }) > 0, '认不出的模式 → 当 fixed')
  ok(partDelayMs('x', { mode: 'fixed', fixedMs: 'abc' }) > 0, 'fixedMs 非数字 → 用默认')
  ok(partDelayMs('x', { mode: 'perChar', perCharMs: -5 }) >= 0, 'perCharMs 负数 → 不产生负间隔')
  ok(partDelayMs('', { mode: 'perChar', perCharMs: 100 }) === 0, '空串在 perChar 下是 0')
  ok(partDelayMs(null, { mode: 'fixed', fixedMs: 0 }) === 0, 'fixedMs 0 = 立刻发')
}

console.log('\n6. 默认值：不传任何选项时是 fixed 800（用户能感知的「不再连发」）')
{
  const d = avgDelay('任意内容', {})
  ok(Math.abs(d - 800) < 800 * 0.15 + 20, '默认约 800ms', `实测 ${d.toFixed(0)}ms`)
}

console.log(`\n结果：${pass} 过 / ${fail} 败`)
process.exitCode = fail === 0 ? 0 : 1
