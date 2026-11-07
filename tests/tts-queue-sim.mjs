/**
 * tts-queue-sim.mjs —— 全局串行队列（0.19.0）。
 *
 * 守的是两件事：
 *   ① **不重叠**：同时来 3 条，实际执行必须首尾相接。
 *      依据是实测的 Breeze Free 档 `max_concurrent_generations: 1`，
 *      以及 GPT-SoVITS 是单进程 uvicorn（workers=1）—— 两边都扛不住并发。
 *   ② **失败不卡死队列**：第 1 条失败之后，第 2 条必须还能成功。
 *      这条是最容易漏的：`chain = chain.then(task)` 一旦让链变成 rejected，
 *      以后每条都会瞬间失败，而现象是「用过一次坏数据之后就再也发不出语音了」。
 *
 * ⚠️ 断言必须能区分「真的串行」和「只是碰巧没撞上」：
 *   这里记录每条的**进入与退出时刻**，断言「下一条的进入 >= 上一条的退出」，
 *   而不是「顺序看起来对」——后者在并发下也会通过。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { useIsolatedHome } from './isolated-home.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// 隔离 HOME：见 tests/isolated-home.mjs（本机沙箱只有工作区根下的 .tmp-test 能建目录）
const HOME_DIR = useIsolatedHome('tts-queue-')
mkdirSync(join(HOME_DIR, '.dsh', 'voice'), { recursive: true })

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}${extra ? '　' + extra : ''}`) }
  else { fail += 1; console.log(`  ✗ ${label}${extra ? '　' + extra : ''}`) }
}

const tts = await import('../lib/tts.js')
tts.resetTtsQueue()

console.log('\n1. 三条并发 → 必须首尾相接，不重叠：')
{
  const spans = []
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const task = (name, ms) => async () => {
    const start = Date.now()
    await sleep(ms)
    spans.push({ name, start, end: Date.now() })
    return name
  }

  // 同时排进去（不 await）
  const p1 = tts.enqueue(task('a', 40))
  const p2 = tts.enqueue(task('b', 20))
  const p3 = tts.enqueue(task('c', 10))
  const results = await Promise.all([p1, p2, p3])

  ok(results.join(',') === 'a,b,c', '三条都完成，顺序按入队', results.join(','))
  ok(spans.length === 3, '三条都真的跑了')

  // 核心断言：串行 = 后一条的开始 >= 前一条的结束
  let overlapped = false
  for (let i = 1; i < spans.length; i += 1) {
    if (spans[i].start < spans[i - 1].end) overlapped = true
  }
  ok(overlapped === false, '⚠️ 没有任何两条在时间上重叠（真串行）',
    spans.map((s) => `${s.name}:${s.end - s.start}ms`).join(' '))

  // 另外：总耗时应该 >= 三者之和（串行的必然结果）
  const total = spans[spans.length - 1].end - spans[0].start
  ok(total >= 60, `总耗时 ${total}ms >= 40+20+10=70 的下界附近（串行证据）`)
}

console.log('\n2. 第一条失败 → 第二条仍能成功（队列不能被卡死）：')
{
  tts.resetTtsQueue()
  const order = []
  const p1 = tts.enqueue(async () => {
    order.push('a-start')
    await new Promise((r) => setTimeout(r, 10))
    order.push('a-end')
    throw new Error('故意失败')
  })
  const p2 = tts.enqueue(async () => {
    order.push('b-start')
    return 'b-ok'
  })

  let firstError = null
  try { await p1 } catch (error) { firstError = error }
  const second = await p2

  ok(firstError !== null && String(firstError.message).includes('故意失败'), '第一条的异常传到了调用方（不被队列吞掉）')
  ok(second === 'b-ok', '⚠️ 第二条成功执行（队列没被 rejected 污染）')
  ok(order.join(',') === 'a-start,a-end,b-start', '顺序正确', order.join(','))
}

console.log('\n3. 连续多次失败后仍然可用：')
{
  tts.resetTtsQueue()
  for (let i = 0; i < 3; i += 1) {
    const p = tts.enqueue(async () => { throw new Error(`fail-${i}`) })
    try { await p } catch { /* 预期失败 */ }
  }
  const after = await tts.enqueue(async () => 'alive')
  ok(after === 'alive', '失败 3 次之后第 4 条仍然能跑')
}

console.log('\n4. 排队超过上限就拒，且拒得干净：')
{
  tts.resetTtsQueue()
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const hang = () => tts.enqueue(async () => { await sleep(60); return 'x' })

  const first = hang()
  const second = hang()
  const third = hang()
  // 第 4 条应该被拒（MAX_QUEUED = 3）
  const fourth = tts.enqueue(async () => 'should-not-run')

  let rejected = null
  try { await fourth } catch (error) { rejected = error }
  ok(rejected !== null, `第 ${tts.MAX_QUEUED + 1} 条被拒`)
  ok(rejected !== null && String(rejected.message).includes(String(tts.MAX_QUEUED)), '错误里说了上限',
    rejected === null ? '' : rejected.message)

  // 前面三条仍然正常完成（拒绝不该影响在排的）
  const done = await Promise.all([first, second, third])
  ok(done.join(',') === 'x,x,x', '在排的三条都正常完成')
  ok(tts.queueDepth() === 0, '队列回到 0')
}

console.log(`\n结果：${pass} 过 / ${fail} 败`)
process.exitCode = fail === 0 ? 0 : 1
