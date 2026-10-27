/**
 * 断言测试：node tests/assert.mjs，退出码 0 = 全过，1 = 有失败。
 *
 * 覆盖两块：
 *   1. split.js 纯函数（分条规则）
 *   2. outbound.js 回复转发 —— 重点回归「队列化」修复：
 *      旧版 outbound.set 覆盖游标时，同一会话背靠背两条消息的前一回合回复
 *      会被静默跳过、或发给错误的对象。
 *
 * 不碰真 QQ（mock fetch）、不碰真会话（假 agent 事件数组）。
 */
import { splitMessage, partDelayMs } from '../lib/split.js'
import { outbound, enqueueOutbound, flushOutbound } from '../lib/outbound.js'

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

// ---- split.js ----

console.log('split.js：')
{
  // 「好呀。」只有 3 字 < minChars(4)，按设计并进前一条
  const parts = splitMessage('今天天气不错。我们去吃饭吧！好呀。')
  eq(parts, ['今天天气不错。', '我们去吃饭吧！好呀。'], '按句末标点切（短尾并入前条）')
}
{
  const parts = splitMessage('今天天气不错。我们去吃饭吧！好的没问题。')
  eq(parts, ['今天天气不错。', '我们去吃饭吧！', '好的没问题。'], '按句末标点切（都够长时逐条切）')
}
{
  const parts = splitMessage('嗯。好。')
  eq(parts.length, 1, '太短的碎片并进相邻条')
}
{
  const parts = splitMessage('一。二。三。四。五。六。', { maxParts: 3 })
  ok(parts.length <= 3, '段数不超上限')
}
{
  const long = '这是一段没有任何句末标点的很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长的话'
  const parts = splitMessage(long, { maxChars: 20 })
  ok(parts.every((p) => p.length <= 20), '超长段在逗号/上限处再切')
}
{
  eq(splitMessage(''), [], '空文本返回空数组')
  eq(splitMessage('  \n  '), [], '纯空白返回空数组')
}
{
  const d = partDelayMs('短句', { minDelayMs: 200, maxDelayMs: 700 })
  ok(d >= 200 && d <= 700, '停顿在配置区间内')
}

// ---- outbound.js（mock fetch + 假 agent）----

console.log('outbound.js：')

// mock OneBot：记录每次发送的 target 和文本
const sent = []
globalThis.fetch = async (url, init) => {
  const payload = JSON.parse(init.body)
  const params = payload.params
  sent.push({
    action: payload.action,
    user_id: params.user_id,
    group_id: params.group_id,
    text: params.message[0].data.text
  })
  return { ok: true, json: async () => ({ retcode: 0, data: { message_id: 1 } }) }
}

/** 假 agent：事件数组 + followup 记录。
 *  session 带 DSH 的真实 API 形状（seq getter + 带范围的 snapshotEvents），
 *  recorder 记录 snapshotEvents 的调用参数，用来断言「没有全量扫描」。 */
function fakeAgent(events, recorder) {
  const session = {
    get seq() {
      return events.length > 0 ? Number(events[events.length - 1].seq) : 0
    },
    firstLiveSeq: 0,
    snapshotEvents(from, to) {
      if (recorder !== undefined) recorder.push([from, to])
      return events.filter((event) => {
        const seq = Number(event.seq)
        if (from !== undefined && seq <= Number(from)) return false
        if (to !== undefined && seq >= Number(to)) return false
        return true
      })
    }
  }
  return { session }
}

// 场景一（竞态回归）：同一会话背靠背两条消息，A 的回合刚结束、
// B 就投递进来 —— 旧版覆盖游标后 A 的回复永远不转发。
{
  sent.length = 0
  outbound.clear()
  const events = [
    { seq: 1, type: 'user/message', data: {} },
    { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'A 的回复' }] } } },
    { seq: 3, type: 'turn/end', data: { reason: { kind: 'stop' } } },
    { seq: 4, type: 'user/message', data: {} },
    { seq: 5, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'B 的回复' }] } } },
    { seq: 6, type: 'turn/end', data: { reason: { kind: 'stop' } } },
  ]
  const agent = fakeAgent(events)
  // A 投递时游标 0；B 投递时 A 的回合已结束（游标 4）—— 竞态窗口
  enqueueOutbound('session-S', agent, 0, { kind: 'private', id: '111' })
  enqueueOutbound('session-S', agent, 4, { kind: 'private', id: '222' })

  await flushOutbound()

  const to111 = sent.filter((m) => m.user_id === 111).map((m) => m.text).join('|')
  const to222 = sent.filter((m) => m.user_id === 222).map((m) => m.text).join('|')
  ok(to111.includes('A 的回复'), 'A 的回复发给了 A（旧版在这里丢失）')
  ok(to222.includes('B 的回复'), 'B 的回复发给了 B（旧版会发错对象）')
  ok(outbound.size === 0, '消化完的会话从队列里移除')
}

// 场景二：回合失败（reason=error）→ 不转发但出队，不堵死后面
{
  sent.length = 0
  outbound.clear()
  const events = [
    { seq: 1, type: 'user/message', data: {} },
    { seq: 2, type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'boom' } } } },
    { seq: 3, type: 'user/message', data: {} },
    { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '后来的回复' }] } } },
    { seq: 5, type: 'turn/end', data: { reason: { kind: 'stop' } } },
  ]
  const agent = fakeAgent(events)
  enqueueOutbound('session-E', agent, 0, { kind: 'private', id: '333' })
  enqueueOutbound('session-E', agent, 3, { kind: 'private', id: '333' })

  await flushOutbound()

  const to333 = sent.filter((m) => m.user_id === 333).map((m) => m.text).join('|')
  ok(!to333.includes('boom'), '失败回合不转发')
  ok(to333.includes('后来的回复'), '失败回合出队后不堵后面的条目')
  ok(outbound.size === 0, '失败回合也消化干净')
}

// 场景三：回合未跑完（还没有 turn/end）→ 留在队头等下一轮
{
  sent.length = 0
  outbound.clear()
  const events = [
    { seq: 1, type: 'user/message', data: {} },
    // 没有 turn/end：回合还在跑
  ]
  const agent = fakeAgent(events)
  enqueueOutbound('session-W', agent, 0, { kind: 'private', id: '444' })

  await flushOutbound()

  ok(sent.length === 0, '回合未结束不发送')
  ok(outbound.size === 1, '条目留在队列里等下一轮')
}

// 场景四：增量扫描 —— 必须带范围参数取事件，不能全量拉
{
  sent.length = 0
  outbound.clear()
  const calls = []
  const events = []
  for (let i = 1; i <= 500; i += 1) {
    events.push({ seq: i, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'x' }] } } })
  }
  events.push({ seq: 501, type: 'turn/end', data: { reason: { kind: 'stop' } } })
  const agent = fakeAgent(events, calls)
  // 游标放在 400：只有 401~501 这段是新的
  enqueueOutbound('session-I', agent, 400, { kind: 'private', id: '555' })

  await flushOutbound()

  ok(calls.length > 0, '调用了 snapshotEvents')
  ok(calls[0][0] === 400, `取事件时带上了起点（实际 ${String(calls[0][0])}，期望 400）`)
  ok(calls[0][1] === 502, `取事件时带上了终点（实际 ${String(calls[0][1])}，期望 502 = seq+1，避开开区间漏掉 turn/end）`)
  ok(calls.every((call) => call[0] !== undefined && call[0] !== 0), '每次调用都带起点（不是无参全量）')
}

// 场景五：群消息缓冲 —— 按 seq 去重、排序、超上限丢最老
{
  const { pushToBuffer, groupBuffer } = await import('../lib/poll.js')
  const gid = 'buffer-test-group'
  pushToBuffer(gid, { message_seq: 3, message: [] })
  pushToBuffer(gid, { message_seq: 1, message: [] })
  pushToBuffer(gid, { message_seq: 3, message: [] })
  pushToBuffer(gid, { message_seq: 2, message: [] })
  const buffer = groupBuffer(gid)
  ok(buffer.length === 3, '同一个 seq 只留一条')
  eq(buffer.map((item) => item.message_seq), [1, 2, 3], '缓冲按 seq 升序')
  for (let i = 1; i <= 40; i += 1) pushToBuffer(gid, { message_seq: 100 + i, message: [] })
  ok(groupBuffer(gid).length === 30, '缓冲有上限（30 条）')
  eq(groupBuffer(gid)[29].message_seq, 140, '超出上限时丢的是最老的')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed > 0 ? 1 : 0)