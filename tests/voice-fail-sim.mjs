/**
 * 语音失败不该连累文字、更不该导致重发：node tests/voice-fail-sim.mjs，退出码 0 = 全过。
 *
 * ## 现象（用户 2026-11-07 反馈）
 *
 * > 「对话后 bot 会发两遍，一遍没切成多条的和一遍切成多条的。重复信息。
 * >   看思考里明明只调用了一次工具。」
 *
 * 模型**只调了一次** `qq_send`，用户在 QQ 上收到两遍正文：
 * 一遍按标点分条、一遍没分条。这句话里「一遍分条、一遍不分条」就是全部线索 ——
 * 两条路用了**不同的分段策略**：
 *
 * ## 根因
 *
 * 出站有**两条平行的路**：
 *   · `qq_send`（模型主动调）→ `sendToQQ` → 按标点/模型给的 segments 分条
 *   · 自动转发兜底（`autoForwardReply`）→ 回合结束后把正文再发一遍
 *
 * 正常情况下它们互斥：`flushOutbound` 会检查「本回合有没有成功的 qq_send 调用」
 * （`tool/call` + `tool/result` 未报错），有就跳过自动转发。
 *
 * 但 `qq_send` 内部是**先发文字、再发语音**两步。语音那一步原来没有 try/catch ——
 * 一旦它抛错，整个 `qq_send` 就被判成失败 → 自动转发判定「qq_send 失败了，
 * 改走兜底」→ **把已经发出去的正文再发一遍（这次不分条）**。
 *
 * 而语音恰恰是最容易失败的一步：读文件、上传、协议端转码，任一环出错都抛。
 * 所以这个 bug 只在「带语音的回合 + 语音失败」时出现 ——
 * 平时跑 `tests/run-isolated.mjs` 全是 mock 成功，永远碰不到。
 *
 * ## 修法
 *
 * 语音失败按「部分成功」处理（跟表情失败的处理一致，见 tool.js 里
 * 「表情失败不连累文字」的两处注释），只记日志 + 在返回值里给 `voice_error`。
 *
 * ## 本测试怎么验
 *
 * 不走完整工具（那条路要起 DSH 工具宿主），而是直接验**判定依据**：
 *   1. 语音失败时，tool.js 必须返回 ok（不抛）—— 用源码断言；
 *   2. 好让自动转发**不**兜底，靠的是「tool/result 里 isError 不为 true」；
 *   3. 反向：qq_send 真的整体失败时，兜底**必须**照旧生效（否则「她突然不回话」）。
 */
let passed = 0
let failed = 0
function ok(condition, name, detail) {
  if (condition) { passed += 1; console.log(`  ✓ ${name}${detail ? `　${detail}` : ''}`) }
  else { failed += 1; console.error(`  ✗ ${name}${detail ? `　${detail}` : ''}`) }
}
function eq(actual, expected, name) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, `${name}${same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`)
}

import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = join(homedir(), '.dsh')
const CONFIG = join(DATA, 'qq-bridge.config.json')
const STATE = join(DATA, 'qq-bridge-state.json')
const PEER = 1000000009

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
cfg.selfUin = 1000000008
cfg.routes = { private: { [String(PEER)]: { sessionId: 'session-vf' } }, group: {} }
writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), 'utf8')
writeFileSync(STATE, JSON.stringify({ lastId: 0, lastSeq: 100, lastTime: 1, groups: {} }, null, 2), 'utf8')

const sent = []
globalThis.fetch = async (_url, options) => {
  const payload = JSON.parse(options.body)
  if (payload.action === 'send_private_msg' || payload.action === 'send_group_msg') {
    sent.push(payload)
    return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) }
  }
  return { ok: true, json: async () => ({ retcode: 0, data: [] }) }
}

const outboundMod = await import('../lib/outbound.js')
const { enqueueOutbound, outbound, flushOutbound } = outboundMod

let events = []
let seq = 10
const fakeAgent = {
  followup: () => {},
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

const toolSrc = readFileSync(join(PLUGIN, 'lib', 'tool.js'), 'utf8')

console.log('1. 语音那一步必须兜住失败（源码断言）：')
{
  // 定位「语音：在文字之后单独发一条」到「取 messageIds」之间的那段
  const start = toolSrc.indexOf('语音：在文字之后单独发一条')
  const end = toolSrc.indexOf('取 messageIds 必须', start)
  ok(start > 0, '能找到语音发送段')
  ok(end > start, '能定位到该段结尾')
  const block = toolSrc.slice(start, end)
  ok(block.includes('try {'), '语音发送包在 try 里')
  ok(block.includes('catch'), '有 catch 兜住失败')
  ok(block.includes('voiceError'), '失败记进 voiceError（不吞掉、也不抛出）')
  // 关键：catch 里**不能** rethrow —— 一抛就又变回「整次失败」了
  const catchBlock = block.slice(block.indexOf('catch'))
  ok(!/\bthrow\b/.test(catchBlock), 'catch 里没有 rethrow（rethrow 就回到原来的 bug）')
}

console.log('\n2. 返回值把失败说清楚（不静默）：')
{
  ok(toolSrc.includes('shape.voice_error = voiceError'), 'voice_error 进了返回值')
  ok(toolSrc.includes('shape.voice_sent = true'), '成功时仍然回 voice_sent')
  // 没给 voice 的回合输出形状不能变（回归保护）
  ok(/const shape = \{ message_id: messageId \}/.test(toolSrc), '基础形状仍只有 message_id')
}

console.log('\n3. qq_send 成功（含语音失败但文字成功）→ 自动转发必须跳过：')
{
  sent.length = 0
  outbound.clear()
  events = []
  seq = 10
  enqueueOutbound('session-vf', fakeAgent, 10, { kind: 'private', id: String(PEER) })
  events = [
    { seq: 11, type: 'user/message' },
    { seq: 12, type: 'tool/call', data: { name: 'qq_send', callId: 'c1' } },
    // 修复后：语音失败也被吞在工具内部 → 整个工具**不是** error
    { seq: 13, type: 'tool/result', data: { message: { isError: false } } },
    { seq: 14, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '这句话已经用工具发出去了' }] } } },
    { seq: 15, type: 'turn/end' }
  ]
  seq = 15
  await flushOutbound()
  eq(sent.length, 0, 'qq_send 成功的回合不再自动转发（这就是「只发一遍」的保证）')
}

console.log('\n4. 反向：qq_send 整体失败时，兜底必须照旧生效（不能把这条修坏）：')
{
  sent.length = 0
  outbound.clear()
  events = []
  seq = 20
  enqueueOutbound('session-vf', fakeAgent, 20, { kind: 'private', id: String(PEER) })
  events = [
    { seq: 21, type: 'user/message' },
    { seq: 22, type: 'tool/call', data: { name: 'qq_send', callId: 'c2' } },
    { seq: 23, type: 'tool/result', data: { message: { isError: true, toolCallId: 'c2' } } },
    { seq: 24, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '兜底发出来的正文' }] } } },
    { seq: 25, type: 'turn/end' }
  ]
  seq = 25
  await flushOutbound()
  eq(sent.length, 1, 'qq_send 真失败时走兜底（话不能丢）')
  eq(sent[0]?.params?.message?.[0]?.data?.text, '兜底发出来的正文', '兜底发的是正文')
}

console.log('\n5. 语音发送函数本身的错误形态（抛错是对的，拦截在调用方）：')
{
  const voiceout = await import('../lib/voiceout.js')
  // 传一个不存在的文件：应当抛错（而不是静默返回）
  let threw = false
  try {
    await voiceout.sendVoiceToQQ({ kind: 'private', id: String(PEER) }, join(DATA, 'no-such-voice-file.wav'))
  } catch { threw = true }
  ok(threw, '语音文件不存在时抛错（工具层负责兜住）')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed > 0 ? 1 : 0)
