/**
 * 连发消息导致重复发送的专项测试：node tests/dup-send-sim.mjs，退出码 0 = 全过。
 *
 * 现象（树树 2026-10-28 反馈）：
 *   「我昨天教她收藏表情包，有一次我没有等她发完消息就发下一条了，
 *     结果她一条回复的消息连续发了好几遍。」
 *
 * 根因：
 *   连着发两条 = 两次 deliver() = outbound 队列里两个条目。
 *   每个条目各自记一个 cursor，起点是投递那一刻的 maxEventSeq(agent)。
 *   ⚠️ 但 agent 跑回合期间 session.seq **不会推进** ——
 *   所以「没等她发完就发下一条」时，两个条目的 cursor **完全相同**。
 *
 *   队列逐条消化：条目 A 从 cursor=10 找到 turn/end(seq=13)，把回复发出去，
 *   cursor 推到 13；条目 B 的 cursor **还停在 10**，
 *   下一轮又从 10 开始找 —— 又找到同一个 turn/end(seq=13) → **同一条回复再发一遍**。
 *
 *   连发 N 条 = 发 N 遍。这就是「连续发了好几遍」的来源。
 *
 * 不碰真 QQ（mock fetch）、不碰真会话（假 agent 事件数组）。
 */
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

import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = join(homedir(), '.dsh')
const CONFIG = join(DATA, 'qq-bridge.config.json')
const STATE = join(DATA, 'qq-bridge-state.json')
const PEER = 1000000001

const configBackup = readFileSync(CONFIG, 'utf8')
let stateBackup = null
try { stateBackup = readFileSync(STATE, 'utf8') } catch { stateBackup = null }
process.on('exit', () => {
  writeFileSync(CONFIG, configBackup, 'utf8')
  if (stateBackup !== null) writeFileSync(STATE, stateBackup, 'utf8')
  else rmSync(STATE, { force: true })
})

const cfg = JSON.parse(configBackup)
cfg.peerUin = PEER
cfg.ownerUin = PEER
cfg.selfUin = 1000000002
cfg.routes = { private: { [String(PEER)]: { sessionId: 'session-dup-test' } }, group: {} }
writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), 'utf8')
writeFileSync(STATE, JSON.stringify({ lastId: 0, lastSeq: 3487, lastTime: 1, groups: {} }, null, 2), 'utf8')

const sent = []
globalThis.fetch = async (_url, options) => {
  const payload = JSON.parse(options.body)
  if (payload.action === 'send_private_msg' || payload.action === 'send_group_msg') {
    sent.push(payload)
    return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) }
  }
  if (payload.action === 'get_friend_msg_history') {
    return {
      ok: true,
      json: async () => ({
        retcode: 0,
        data: {
          messages: [
            { message_id: -5, message_seq: 3488, time: 1792993000, sender: { user_id: PEER, nickname: '示例好友' }, message: [{ type: 'text', data: { text: '第一条' } }] },
            { message_id: -6, message_seq: 3489, time: 1792993001, sender: { user_id: PEER, nickname: '示例好友' }, message: [{ type: 'text', data: { text: '第二条' } }] }
          ]
        }
      })
    }
  }
  return { ok: true, json: async () => ({ retcode: 0, data: [] }) }
}

/**
 * 假 agent：事件数组 + followup。
 *
 * ⚠️ 关键：followup 里**不立刻**推进 seq —— 模拟真实情况
 *   （agent 跑回合期间 session.seq 不会推进，所以连着投递的两条消息
 *    取到的 maxEventSeq 是同一个值 → 两个队列条目 cursor 相同）。
 */
let events = []
let seq = 10
const fakeAgent = {
  followup: () => {
    // 什么都不做：等测试手动推进事件
  },
  session: {
    get seq() { return seq },
    firstLiveSeq: 0,
    snapshotEvents(from, to) {
      return events.filter((e) => {
        const s = Number(e.seq)
        if (from !== undefined && s <= Number(from)) return false
        if (to !== undefined && s >= Number(to)) return false
        return true
      })
    }
  }
}

const { enqueueOutbound, outbound, flushOutbound } = await import('../lib/outbound.js')

console.log('连发消息 → 重复发送：')

// 场景：树树连着发两条，agent 还没跑完第一回合
{
  sent.length = 0
  outbound.clear()
  events = []
  seq = 10

  // 两条消息在 agent 跑回合期间投递 —— before 都取到 session.seq = 10
  enqueueOutbound('session-D', fakeAgent, 10, { kind: 'private', id: String(PEER) })
  enqueueOutbound('session-D', fakeAgent, 10, { kind: 'private', id: String(PEER) })

  // agent 跑完一个回合（两条消息被合进同一回合）
  // ⚠️ 事件 seq 要对齐真实语义：cursor 是「投递那一刻最后一个已分配的 seq」，
  //   followup 之后 user/message 占用**新的** seq（cursor+1）。
  events = [
    { seq: 11, type: 'user/message' },
    { seq: 12, type: 'user/message' },
    { seq: 13, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '收到啦喵' }] } } },
    { seq: 14, type: 'turn/end' }
  ]
  seq = 14

  await flushOutbound()
  await flushOutbound()

  const texts = sent.map((m) => m.params.message[0].data.text)
  eq(texts.length, 1, '同一条回复只发一遍（连发两条不重复）')
  eq(texts, ['收到啦喵'], '发出去的是那一轮的回复内容')
  ok(outbound.size === 0, '队列消化干净')
}

// 场景：连发三条 → 也只发一遍
{
  sent.length = 0
  outbound.clear()
  events = []
  seq = 10

  enqueueOutbound('session-E', fakeAgent, 10, { kind: 'private', id: String(PEER) })
  enqueueOutbound('session-E', fakeAgent, 10, { kind: 'private', id: String(PEER) })
  enqueueOutbound('session-E', fakeAgent, 10, { kind: 'private', id: String(PEER) })

  events = [
    { seq: 11, type: 'user/message' },
    { seq: 12, type: 'user/message' },
    { seq: 13, type: 'user/message' },
    { seq: 14, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '三条都收到喵' }] } } },
    { seq: 15, type: 'turn/end' }
  ]
  seq = 15

  await flushOutbound()
  await flushOutbound()

  eq(sent.length, 1, '连发三条也只发一遍')
}

// 场景（不能被误伤）：**等她发完**再发下一条 → 两个回合，两条回复，都该发出去
{
  sent.length = 0
  outbound.clear()
  events = []
  seq = 10

  // 第一条投递，agent 跑完回合
  enqueueOutbound('session-F', fakeAgent, 10, { kind: 'private', id: String(PEER) })
  events = [
    { seq: 11, type: 'user/message' },
    { seq: 12, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '回复一' }] } } },
    { seq: 13, type: 'turn/end' }
  ]
  seq = 13
  await flushOutbound()

  // 第二条投递（这回合已经结束了，cursor 自然落在 turn/end 之后）
  enqueueOutbound('session-F', fakeAgent, 13, { kind: 'private', id: String(PEER) })
  events = [
    ...events,
    { seq: 14, type: 'user/message' },
    { seq: 15, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '回复二' }] } } },
    { seq: 16, type: 'turn/end' }
  ]
  seq = 16
  await flushOutbound()

  const texts = sent.map((m) => m.params.message[0].data.text)
  eq(texts, ['回复一', '回复二'], '等她发完再发下一条：两个回合的回复都要发出去')
}

// 场景：工具调用过的回合不能既走工具又走自动转发
{
  sent.length = 0
  outbound.clear()
  events = []
  seq = 10

  enqueueOutbound('session-G', fakeAgent, 10, { kind: 'private', id: String(PEER) })
  events = [
    { seq: 11, type: 'user/message' },
    { seq: 12, type: 'tool/call', data: { name: 'qq_send', callId: 'c1' } },
    { seq: 13, type: 'tool/result', data: { message: { isError: false } } },
    { seq: 14, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '我用工具发了' }] } } },
    { seq: 15, type: 'turn/end' }
  ]
  seq = 15

  await flushOutbound()
  eq(sent.length, 0, '用过 qq_send 的回合不再自动转发（避免发两遍）')
}

// 场景（真实事件形状）：一轮里有多条 assistant/message（reasoning + text 混合）
// —— 实测 2026-10-28 的真实会话就是这样：一轮 3 条 assistant/message（178/184/190）。
// 转发时只取最后一条的正文，且**不能**把 reasoning 当成正文发出去。
{
  sent.length = 0
  outbound.clear()
  events = []
  seq = 10

  enqueueOutbound('session-H', fakeAgent, 10, { kind: 'private', id: String(PEER) })
  events = [
    { seq: 11, type: 'user/message' },
    { seq: 12, type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: '先想一下' }] } } },
    { seq: 13, type: 'tool/call', data: { name: 'qq_emoji_search', callId: 'c1' } },
    { seq: 14, type: 'tool/result', data: { message: { isError: false } } },
    { seq: 15, type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: '工具结果不错' }] } } },
    { seq: 16, type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: '好了' }, { type: 'text', text: '发好啦喵' }] } } },
    { seq: 17, type: 'turn/end' }
  ]
  seq = 17

  await flushOutbound()
  eq(sent.length, 1, '一轮里多条 assistant/message 只转发一条')
  // sent 里存的是完整 payload，正文在 params.message[0].data.text
  eq(sent[0]?.params?.message?.[0]?.data?.text, '发好啦喵', '转发的是最后一条的正文（reasoning 不混进去）')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed > 0 ? 1 : 0)
