/**
 * 连发消息导致重复发送的专项测试：node tests/dup-send-sim.mjs，退出码 0 = 全过。
 *
 * 现象（用户 2026-10-28 反馈）：
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
// ⚠️ 必须显式 loadConfig()（0.21.4 发现的测试债）：
//    本文件从头到尾没调过它，于是 getConfig() 一直返回 DEFAULTS
//    （peerUin/ownerUin 都是 0）。以前无所谓 —— 没有哪条断言需要真实的号；
//    但 0.21.4 的「群汇报回传私聊」要靠 ownerUin/peerUin 定位收件人，
//    不加载配置就永远取不到目标，回传静默失败（测试报「期望 1 实得 0」）。
//    别再删掉这一行：它不是在「读一个无关紧要的默认值」，
//    而是在把刚写进 CONFIG 的那份测试配置真正装进单例。
const { loadConfig } = await import('../lib/config.js')
loadConfig()

console.log('连发消息 → 重复发送：')

// 场景：用户连着发两条，agent 还没跑完第一回合
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

// ===========================================================================
// 0.20.2：qq_send 判定要认出 PTC（run_code）子调用 + 同会话两回合不许串账
// ===========================================================================
//
// ## 先说清楚一个**被推翻**的假设（免得后人重犯）
//
// 线上现场（诊断包 2026-11-08T13-59-37）确实是自动转发把 225 字发进群了：
//   13:56:58 [out] 分 4 条发送，字数 22/107/30/61
//   13:56:58 [out] 已转发回复 225 字 -> group
// 但原因**不是**「长回合里 qq_send 记录丢了」。我一开始这么以为，后来做变异验证时
// 把判定逐字还原成 0.20.1 的旧代码，下面「长回合中途用过 qq_send」那条**照样绿**
// —— 说明旧代码本来就看得见。原因是 `scanFrom = Math.min(entry.cursor, state.matchCursor)`，
// 而 entry.cursor 只在找到 turn/end 时才推进，所以回合进行中每轮都从同一位置重扫。
//
// 真正的原因是两件事各占一半：
//   ① 群聊**本来就会**自动转发（autoForwardReply 是个全局开关，从没区分渠道）
//      —— 这才是用户报的「群里不该发汇报却发了」的正解，见本文件末尾的渠道开关一节；
//   ② `run_code` 里调的 qq_send 记的是 `tool/ptc-dispatch*`，不是 `tool/call`，
//      所以那类回合确实会被判成「没用过 qq_send」→ 重复转发。这一节测的就是它。
console.log('\nqq_send 判定：PTC（run_code）子调用也要认出来（0.20.2）：')

// 场景 1：run_code 里调 qq_send —— 事件是 tool/ptc-dispatch*，没有 tool/call。
// 修复前：判定只认 tool/call → 认为没用过 → 自动转发再发一遍（本断言变红）。
{
  sent.length = 0
  outbound.clear()
  events = []
  seq = 10

  enqueueOutbound('session-PTC', fakeAgent, 10, { kind: 'private', id: String(PEER) })
  events = [
    { seq: 11, type: 'user/message' },
    { seq: 12, type: 'tool/call', data: { name: 'run_code', callId: 'root-1' } },
    { seq: 13, type: 'tool/ptc-dispatch-start', data: { name: 'qq_send', subCallId: 'sub-1', parentCallId: 'root-1' } },
    { seq: 14, type: 'tool/ptc-dispatch', data: { name: 'qq_send', subCallId: 'sub-1', isError: false } },
    { seq: 15, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '汇报：都改好了' }] } } },
    { seq: 16, type: 'turn/end' }
  ]
  seq = 16
  await flushOutbound()

  eq(sent.length, 0, 'run_code 里调过 qq_send → 正文不再自动转发一遍')
}

// 场景 2（反向保护）：run_code 里的 qq_send **失败**了 → 必须改走自动转发兜底，
// 否则那条回复就永远发不出去（「她突然不回话了」）。
{
  sent.length = 0
  outbound.clear()
  events = []
  seq = 10

  enqueueOutbound('session-PTCF', fakeAgent, 10, { kind: 'private', id: String(PEER) })
  events = [
    { seq: 11, type: 'user/message' },
    { seq: 12, type: 'tool/call', data: { name: 'run_code', callId: 'root-2' } },
    { seq: 13, type: 'tool/ptc-dispatch-start', data: { name: 'qq_send', subCallId: 'sub-2', parentCallId: 'root-2' } },
    { seq: 14, type: 'tool/ptc-dispatch', data: { name: 'qq_send', subCallId: 'sub-2', isError: true, error: 'fetch failed' } },
    { seq: 15, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '这条要兜底。' }] } } },
    { seq: 16, type: 'turn/end' }
  ]
  seq = 16
  await flushOutbound()

  eq(sent.length, 1, 'run_code 里的 qq_send 失败了 → 自动转发兜底（不能把她的话吞掉）')
}

// 场景 3（同会话两回合）：第一回合用 qq_send，第二回合没用 ——
// 第二回合的正文**必须**照常转发。
// ⚠️ 这条钉的是「判定不许跨回合串味」：一旦有人把判定改成「这个会话见过 qq_send 就永远算」，
//    第二回合就会被静默吞掉，用户看到的是「她突然不回话了」。
{
  sent.length = 0
  outbound.clear()
  events = []
  seq = 10

  // 第一回合：调了 qq_send
  enqueueOutbound('session-TWO', fakeAgent, 10, { kind: 'private', id: String(PEER) })
  events = [
    { seq: 11, type: 'user/message' },
    { seq: 12, type: 'tool/call', data: { name: 'qq_send', callId: 's-1' } },
    { seq: 13, type: 'tool/result', data: { message: { isError: false, toolCallId: 's-1' } } },
    { seq: 14, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一回合用工具发了' }] } } },
    { seq: 15, type: 'turn/end' }
  ]
  seq = 15
  await flushOutbound()
  eq(sent.length, 0, '（第一回合）用过 qq_send → 不自动转发')

  // 第二回合：没调 qq_send
  enqueueOutbound('session-TWO', fakeAgent, 15, { kind: 'private', id: String(PEER) })
  events = [
    ...events,
    { seq: 16, type: 'user/message' },
    { seq: 17, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第二回合只说话。' }] } } },
    { seq: 18, type: 'turn/end' }
  ]
  seq = 18
  await flushOutbound()

  eq(sent.length, 1, '同会话第二回合没用 qq_send → 正文照常转发（判定不跨回合串味）')
  eq(sent[0]?.params?.message?.[0]?.data?.text, '第二回合只说话。', '发出去的是第二回合的正文')
}


// ===========================================================================
// 0.20.2：群聊默认不自动转发（autoForwardPrivate / autoForwardGroup）
// ===========================================================================
//
// 用户的原话：「群里不要自动转发……默认仅私聊激活自动转发，群里默认关闭」。
// 场景：群回合跑完、没调 qq_send（否则上面那条 sendCalls 分支先拦掉了，
//       测不到渠道开关本身）→ 正文必须**留在本地**，一条都不发。
console.log('\n渠道开关（0.20.2）：')
{
  const GROUP = '975663147'
  const { getConfig } = await import('../lib/config.js')
  const gcfg = getConfig()
  const savedPrivate = gcfg.autoForwardPrivate
  const savedGroup = gcfg.autoForwardGroup

  // --- 群默认关：不发 ---
  sent.length = 0
  outbound.clear()
  events = []
  seq = 10
  gcfg.autoForwardGroup = false

  enqueueOutbound('session-GRP', fakeAgent, 10, { kind: 'group', id: GROUP })
  events = [
    { seq: 11, type: 'user/message' },
    { seq: 12, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '已确认 X，改了 Y，测试过了。' }] } } },
    { seq: 13, type: 'turn/end' }
  ]
  seq = 13
  await flushOutbound()

  eq(sent.length, 0, '群里默认不自动转发：这段汇报不进群')
  ok(outbound.size === 0, '群里这条也正常出队（不能卡在队头堵住后面的转发）')

  // --- 兴趣点明确启用的单回合答题：只对这个群目标临时放行 ---
  sent.length = 0
  outbound.clear()
  events = []
  seq = 10
  enqueueOutbound('session-INTEREST', fakeAgent, 10, { kind: 'group', id: GROUP }, {
    forceForward: true,
    replyTo: '-12345'
  })
  events = [
    { seq: 11, type: 'user/message' },
    { seq: 12, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '这道题可以先对两边求导。' }] } } },
    { seq: 13, type: 'turn/end' }
  ]
  seq = 13
  await flushOutbound()

  eq(sent.length, 1, '兴趣点答题在全局群转发关闭时仍发出一条')
  eq(sent[0]?.action, 'send_group_msg', '兴趣点答题仍走群发送出口')
  eq(sent[0]?.params?.group_id, Number(GROUP), '答复目标是触发时的原群')
  ok(sent[0]?.params?.message?.some((part) => part.type === 'reply' && String(part.data?.id) === '-12345'), '答复引用原触发消息')

  // --- 群开关打开后又能发（证明不是「群这条路彻底坏了」）---
  sent.length = 0
  outbound.clear()
  events = []
  seq = 10
  gcfg.autoForwardGroup = true

  enqueueOutbound('session-GRP2', fakeAgent, 10, { kind: 'group', id: GROUP })
  events = [
    { seq: 11, type: 'user/message' },
    { seq: 12, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '在的，群里说话了。' }] } } },
    { seq: 13, type: 'turn/end' }
  ]
  seq = 13
  await flushOutbound()

  eq(sent.length, 1, '群里把开关打开后照常自动转发（开关真的生效，不是写死）')
  eq(sent[0]?.action, 'send_group_msg', '走的仍然是群出口')

  // --- 私聊不受影响（默认开）---
  sent.length = 0
  outbound.clear()
  events = []
  seq = 10
  gcfg.autoForwardPrivate = true

  enqueueOutbound('session-PRV', fakeAgent, 10, { kind: 'private', id: String(PEER) })
  events = [
    { seq: 11, type: 'user/message' },
    { seq: 12, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '私聊照常。' }] } } },
    { seq: 13, type: 'turn/end' }
  ]
  seq = 13
  await flushOutbound()

  eq(sent.length, 1, '私聊默认仍然自动转发（存量行为不变）')
  eq(sent[0]?.action, 'send_private_msg', '走的是私聊出口')

  // --- 私聊关掉后也不发 ---
  sent.length = 0
  outbound.clear()
  events = []
  seq = 10
  gcfg.autoForwardPrivate = false

  enqueueOutbound('session-PRV2', fakeAgent, 10, { kind: 'private', id: String(PEER) })
  events = [
    { seq: 11, type: 'user/message' },
    { seq: 12, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '私聊也不该发。' }] } } },
    { seq: 13, type: 'turn/end' }
  ]
  seq = 13
  await flushOutbound()

  eq(sent.length, 0, '私聊开关关掉后也不自动转发')

  gcfg.autoForwardPrivate = savedPrivate
  gcfg.autoForwardGroup = savedGroup
}

// ===========================================================================
// 0.21.4：qq_pass 绕过群渠道闸门（用户 2026-11-09 实测报的那个洞）
// ===========================================================================
//
// ## 现场（真实日志，抓到的就是这个）
//
//   05:10:44 [rhythm] 已抑制自动转发 key=group:716197431（qq_pass: …不必再接）
//   05:10:49 [out] qq_pass 但正文写了真话（161 字），按「说出口了」照发 key=group:716197431
//   05:10:49 [out] 分 3 条发送，字数 14/107/36
//   05:10:56 [out] 已转发回复 161 字 -> group
//
// 那 161 字是**写给他的汇报**（「这条我划过去了，没有回复。原因：小鲸鱼只是又甩了一遍
// 那张『巨碗照』…」），当众念进了群，还拆成了三条。
//
// ## 根因（结构性，不是配置）
//
//   `qq_pass` 分支里有一条「正文写了真话就照发」，它直接 continue 结账，
//   而渠道闸门 `autoForwardEnabledFor` 排在**它后面** —— 于是群渠道关闭**对它完全失效**。
//   用户当时 `autoForwardGroup` 甚至是 true，所以即便把它关掉也拦不住。
//
// ## 修法
//
//   渠道闸门提前到 qq_pass **之前**；群渠道一律只认显式 qq_send。
//   「说出口了照发」这条规矩**只对私聊保留**（一对一才成立）。
//
// ⚠️ 下面两条是**成对**的：第一条钉「群里不再发」，第二条钉「私聊那条决策一个字没改」。
//    只写第一条的话，一个「把 qq_pass 整段删掉」的粗暴修法也能让它绿 —— 那会顺手
//    破坏私聊里「她真说了话但用户没收到」那个既有决策。
console.log('\nqq_pass 不许绕过渠道闸门（0.21.4）：')
{
  const GROUP = '975663147'
  const { getConfig } = await import('../lib/config.js')
  const { suppress, consumeSuppress } = await import('../lib/rhythm.js')
  const gcfg = getConfig()
  const savedPrivate = gcfg.autoForwardPrivate
  const savedGroup = gcfg.autoForwardGroup

  // --- 群里：qq_pass 之后正文仍然不许进群 ---
  sent.length = 0
  outbound.clear()
  events = []
  seq = 10
  gcfg.autoForwardGroup = false
  // 复现现场：她调了 qq_pass，但回合正文里写了一整段「写给他的汇报」。
  suppress(`group:${GROUP}`, '已收档，这只是收尾后的反应表情包，不必再接')

  enqueueOutbound('session-GRP-PASS', fakeAgent, 10, { kind: 'group', id: GROUP })
  events = [
    { seq: 11, type: 'user/message' },
    { seq: 12, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '这条我划过去了，没有再回复。原因：对方只是又甩了一遍那张图。' }] } } },
    { seq: 13, type: 'turn/end' }
  ]
  seq = 13
  await flushOutbound()

  eq(sent.length, 0, '群里 qq_pass 后写了汇报正文 → 依然一条都不进群（闸门提前到 qq_pass 之前）')
  ok(outbound.size === 0, '这条也正常出队（不能卡在队头堵住后面的转发）')

  // --- 同一个开关打开时，群里照常能发（证明拦的是渠道，不是把 qq_pass 弄坏了）---
  sent.length = 0
  outbound.clear()
  events = []
  seq = 10
  gcfg.autoForwardGroup = true
  suppress(`group:${GROUP}`, '同上')

  enqueueOutbound('session-GRP-PASS2', fakeAgent, 10, { kind: 'group', id: GROUP })
  events = [
    { seq: 11, type: 'user/message' },
    { seq: 12, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '在的，群里说话。' }] } } },
    { seq: 13, type: 'turn/end' }
  ]
  seq = 13
  await flushOutbound()

  eq(sent.length, 1, '群里把开关打开后，qq_pass + 有正文仍然照发（开关真的生效）')

  // --- 私聊：既有决策**一个字都没改**（「说出口了照发」）---
  sent.length = 0
  outbound.clear()
  events = []
  seq = 10
  gcfg.autoForwardPrivate = true
  suppress(`private:${PEER}`, '这次先不开口')

  enqueueOutbound('session-PRV-PASS', fakeAgent, 10, { kind: 'private', id: String(PEER) })
  events = [
    { seq: 11, type: 'user/message' },
    { seq: 12, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '我看了，这次先不说。' }] } } },
    { seq: 13, type: 'turn/end' }
  ]
  seq = 13
  await flushOutbound()

  eq(sent.length, 1, '私聊 qq_pass + 正文写了真话 → 照发（既有决策保留，不能被一刀切掉）')

  // --- 私聊：纯动作时 qq_pass 仍然真按下不发 ---
  sent.length = 0
  outbound.clear()
  events = []
  seq = 10
  suppress(`private:${PEER}`, '这次先不开口')

  enqueueOutbound('session-PRV-PASS2', fakeAgent, 10, { kind: 'private', id: String(PEER) })
  events = [
    { seq: 11, type: 'user/message' },
    { seq: 12, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '（尾巴摆了摆）' }] } } },
    { seq: 13, type: 'turn/end' }
  ]
  seq = 13
  await flushOutbound()

  eq(sent.length, 0, '私聊 qq_pass + 纯动作正文 → 真按下不发（没退回旧行为）')

  // ⚠️ 清干净抑制标记：群渠道关闭时闸门在 qq_pass 之前 continue，
  //    所以那条标记**没被消费**（这是修法的已知代价，靠 TTL 自然过期）。
  //    不清的话它会飘到下一个场景去误伤 —— 那正是「测试有跨运行状态污染」那类假绿。
  consumeSuppress(`group:${GROUP}`)
  consumeSuppress(`private:${PEER}`)
  gcfg.autoForwardPrivate = savedPrivate
  gcfg.autoForwardGroup = savedGroup
}

// ===========================================================================
// 0.21.4：群里的汇报回传到私聊（groupReportToPrivate，默认关）
// ===========================================================================
console.log('\ngroupReportToPrivate（0.21.4）：')
{
  const GROUP = '975663147'
  const { getConfig } = await import('../lib/config.js')
  const gcfg = getConfig()
  const savedGroup = gcfg.autoForwardGroup
  const savedRelay = gcfg.groupReportToPrivate
  gcfg.autoForwardGroup = false

  // --- 默认关：丢 ---
  sent.length = 0
  outbound.clear()
  events = []
  seq = 10
  gcfg.groupReportToPrivate = false

  enqueueOutbound('session-REL1', fakeAgent, 10, { kind: 'group', id: GROUP })
  events = [
    { seq: 11, type: 'user/message' },
    { seq: 12, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '这段汇报两个地方都不该去。' }] } } },
    { seq: 13, type: 'turn/end' }
  ]
  seq = 13
  await flushOutbound()

  eq(sent.length, 0, '默认关：群里的汇报正文直接丢弃（不进群、也不发私聊）')

  // --- 打开：走私聊出口，带【群聊 …】前缀 ---
  sent.length = 0
  outbound.clear()
  events = []
  seq = 10
  gcfg.groupReportToPrivate = true

  enqueueOutbound('session-REL2', fakeAgent, 10, { kind: 'group', id: GROUP })
  events = [
    { seq: 11, type: 'user/message' },
    { seq: 12, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '这条我划过去了，没有回复。' }] } } },
    { seq: 13, type: 'turn/end' }
  ]
  seq = 13
  await flushOutbound()

  eq(sent.length, 1, '打开后：汇报回传到私聊（发出去一条）')
  eq(sent[0]?.action, 'send_private_msg', '走的是**私聊**出口，不是群出口')
  eq(sent[0]?.params?.user_id, PEER, '发给了私聊对象（ownerUin/peerUin）')
  ok(String(sent[0]?.params?.message?.[0]?.data?.text ?? '').includes('【群聊'),
    '正文带【群聊 …】前缀（和他一眼看出这是哪个群的事）')
  ok(String(sent[0]?.params?.message?.[0]?.data?.text ?? '').includes('这条我划过去了'),
    '回传的是正文本身')

  gcfg.groupReportToPrivate = savedRelay
  gcfg.autoForwardGroup = savedGroup
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed > 0 ? 1 : 0)
