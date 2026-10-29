/**
 * 合并窗口（标记已读的中间态）测试：node tests/merge-sim.mjs，退出码 0 = 全过。
 *
 * 这块最容易错的三件事：
 *   1. 攒着攒着不放行（对方一直发就永远不回）—— 靠 maxWaitMs 兜底
 *   2. 同一会话被两个批次并发投递 —— 靠 inFlight 串行
 *   3. 窗口关着时行为必须和以前一模一样 —— 一条消息一个回合
 *
 * 全程用注入的 settings，不读真实配置。
 */
import { createMergeQueue } from '../lib/merge.js'
import { readFileSync } from 'node:fs'

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`) } else { failed += 1; console.error(`  ✗ ${name}`) }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---- 1. 窗口关着：一条一批（老行为） ----------------------------------------
{
  const batches = []
  const q = createMergeQueue(
    async (uin, messages) => { batches.push(messages.map((m) => m.id)); return 's1' },
    () => ({ windowMs: 0, maxWaitMs: 0, maxMessages: 10 })
  )
  const first = q.push({ tag: 'ctx' }, '100', { id: 1 })
  ok(first.queued === false, 'windowMs=0 时不入池，直接投递')
  const used = await first.done
  ok(used === 's1', '返回投递结果的会话 id')
  ok(batches.length === 1 && batches[0].length === 1, '一条消息一个批次')
  ok(q.size() === 0, '池子是空的')
}

// ---- 2. 窗口内连发三条：合成一批、顺序不变 ----------------------------------
{
  const batches = []
  const q = createMergeQueue(
    async (uin, messages) => { batches.push(messages.map((m) => m.id)); return 's1' },
    () => ({ windowMs: 40, maxWaitMs: 1000, maxMessages: 10 })
  )
  q.push({}, '100', { id: 1 })
  await sleep(10)
  q.push({}, '100', { id: 2 })
  await sleep(10)
  q.push({}, '100', { id: 3 })
  ok(batches.length === 0, '窗口内还没放行')
  ok(q.size() === 3, '池子里攒着 3 条')
  await sleep(90)
  ok(batches.length === 1, '窗口到点只放行一次')
  ok(batches[0].join(',') === '1,2,3', '三条合成一批，顺序保持')
}

// ---- 3. 攒太多就别攒了：maxMessages 立刻放行 --------------------------------
{
  const batches = []
  const q = createMergeQueue(
    async (uin, messages) => { batches.push(messages.length); return 's1' },
    () => ({ windowMs: 5000, maxWaitMs: 60000, maxMessages: 2 })
  )
  q.push({}, '100', { id: 1 })
  ok(batches.length === 0, '一条还不放行')
  q.push({}, '100', { id: 2 })
  await sleep(10)
  ok(batches.length === 1 && batches[0] === 2, '到 maxMessages 立刻放行')
}

// ---- 4. maxWaitMs 兜底：对方一直发也要回 -------------------------------------
{
  const batches = []
  const q = createMergeQueue(
    async (uin, messages) => { batches.push({ n: messages.length, at: Date.now() }); return 's1' },
    () => ({ windowMs: 1000, maxWaitMs: 120, maxMessages: 100 })
  )
  const start = Date.now()
  for (let i = 0; i < 4; i += 1) {
    q.push({}, '100', { id: i })
    await sleep(30)
  }
  const waited = Date.now() - start
  ok(batches.length === 1, `窗口 1000ms 但 maxWait 120ms → 到点强制放行（实际等了 ${waited}ms）`)
  ok(batches[0].n >= 3, '放行时带走池子里已有的消息')
}

// ---- 5. 投递抛错不能带崩定时器 ----------------------------------------------
{
  let calls = 0
  const q = createMergeQueue(
    async () => { calls += 1; throw new Error('boom') },
    () => ({ windowMs: 20, maxWaitMs: 500, maxMessages: 10 })
  )
  q.push({}, '100', { id: 1 })
  await sleep(60)
  ok(calls === 1, '抛错后不再重试（交给上游回滚游标）')
  q.push({}, '100', { id: 2 })
  await sleep(60)
  ok(calls === 2, '抛错之后队列还能继续工作')
}

// ---- 6. 不同对象各成池，互不干扰 ---------------------------------------------
{
  const batches = []
  const q = createMergeQueue(
    async (uin, messages) => { batches.push(`${uin}:${messages.length}`); return 's1' },
    () => ({ windowMs: 30, maxWaitMs: 500, maxMessages: 10 })
  )
  q.push({}, '100', { id: 1 })
  q.push({}, '200', { id: 2 })
  q.push({}, '100', { id: 3 })
  q.push({}, '200', { id: 4 })
  await sleep(80)
  const sorted = [...batches].sort()
  ok(sorted.join('|') === '100:2|200:2', `两个号各自合并（${batches.join(' / ')}）`)
}

// ---- 7. 卸载时能丢弃并报出丢了多少 -------------------------------------------
{
  const q = createMergeQueue(
    async () => 's1',
    () => ({ windowMs: 5000, maxWaitMs: 60000, maxMessages: 100 })
  )
  q.push({}, '100', { id: 1 })
  q.push({}, '100', { id: 2 })
  q.push({}, '200', { id: 3 })
  const dropped = q.discard()
  const total = dropped.reduce((sum, item) => sum + item.count, 0)
  ok(total === 3, 'discard 报出丢弃条数')
  ok(q.size() === 0, 'discard 之后池子空了')
}

// ---- 8. 接线检查：队列真的接在入站通路上 -------------------------------------
// （全链路模拟要 mock OneBot + agents 服务，成本太高；这里只钉住「接线断没断」）
{
  const pollSrc = readFileSync(new URL('../lib/poll.js', import.meta.url), 'utf8')
  ok(/privateMerge\.push\(/.test(pollSrc), 'WS 私聊分支走的是合并队列（不是直接投递）')
  ok(/mergeSnapshots\.set\(uin, prevBucket\)/.test(pollSrc), '入池前存了游标快照（投递失败可回滚）')
  ok(/mergeSnapshots\.delete\(uin\)[\s\S]{0,120}st\.privates\[uin\] = snapshot/.test(pollSrc), '投递失败会把「已读」记账撤回去')
  ok(/notePeerSpoke\(`private:\$\{String\(uin\)\}`\)/.test(pollSrc), '投递成功才记「他这次真的说过话」')
  ok(!/mergeWindowMs/.test(readFileSync(new URL('../lib/ws.js', import.meta.url), 'utf8')), '合并窗口没有散落到 ws.js（逻辑只在 poll.js 一处）')
}

console.log(`\n${passed} 过 ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
