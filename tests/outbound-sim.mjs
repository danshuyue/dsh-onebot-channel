/**
 * 回复转发（outbound）离线测试：假 agent + 假 session 事件流。
 * 流程：轮询拉到一条新私聊 → followup → 回合结束 → 把该回合最后一条助手文本发回 QQ。
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 两个目录必须分开：
//   PLUGIN = 插件本体（模块从这里 import）
//   DATA   = ~/.dsh（配置 / 状态在这里，不随插件重装丢）
const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = join(homedir(), '.dsh')
const CONFIG = join(DATA, 'qq-bridge.config.json')
const STATE = join(DATA, 'qq-bridge-state.json')
const PEER = 1000000001

const configBackup = readFileSync(CONFIG, 'utf8')
let stateBackup = null
try { stateBackup = readFileSync(STATE, 'utf8') } catch { stateBackup = null }
// 崩了也要还原，不然把真实配置和游标改坏
process.on('exit', () => {
  writeFileSync(CONFIG, configBackup, 'utf8')
  if (stateBackup !== null) writeFileSync(STATE, stateBackup, 'utf8')
  else rmSync(STATE, { force: true })
})

// peerUin / selfUin 必须显式设：私聊消息要按 peerUin 路由，
// 继承真实配置的话测试消息认不出归属，回复会发到别处
const cfg = JSON.parse(configBackup)
cfg.peerUin = PEER
cfg.ownerUin = PEER
cfg.selfUin = 1000000002
cfg.routes = { private: { [String(PEER)]: { sessionId: 'session-outbound-test' } }, group: {} }
writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), 'utf8')
writeFileSync(STATE, JSON.stringify({ lastId: 0, lastSeq: 3487, lastTime: 1, groups: {} }, null, 2), 'utf8')

const sent = []
let events = []

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
        data: { messages: [{ message_id: -5, message_seq: 3488, time: 1792993000, sender: { user_id: PEER, nickname: '示例好友' }, message: [{ type: 'text', data: { text: '在吗' } }] }] }
      })
    }
  }
  // 兜底：群列表/群历史这类统一给空数组，别给 {} —— 插件会当成"拿不到"然后打一堆错
  return { ok: true, json: async () => ({ retcode: 0, data: [] }) }
}

const delivered = []
const fakeAgent = {
  followup: (message) => {
    delivered.push(message)
    setTimeout(() => {
      events = [
        ...events,
        { type: 'assistant/message', seq: 11, data: { message: { content: [{ type: 'text', text: '喵，我在呢' }] } } },
        { type: 'turn/end', seq: 12, data: { reason: { kind: 'completed' } } }
      ]
    }, 300)
  },
  session: { snapshotEvents: () => events }
}

const ctx = {
  get: (key) => (key === 'agents' ? { get: () => fakeAgent, resume: async () => ({ agent: fakeAgent }) } : undefined),
  effect: () => {}
}

const module = await import(`${pathToFileURL(join(PLUGIN, 'lib', 'index.js')).href}?t=${Date.now()}`)
module.apply(ctx)
await new Promise((r) => setTimeout(r, 3500))

console.log('发出条数 =', sent.length)
for (const item of sent) console.log('  ', item.action, JSON.stringify(item.params).slice(0, 160))

// 关键：投递出去的消息必须带 id，否则 DSH 会把这条会话判成 corrupt
// （"session event at seq N lacks an identified message"）。这个 bug 已经弄坏过一条真会话。
const bad = delivered.filter((m) => m === null || typeof m !== 'object' || typeof m.id !== 'string' || m.id === '')
console.log('\n投递消息数 =', delivered.length, ' 缺 id 的 =', bad.length)
if (delivered.length === 0) {
  console.error('没投递任何消息，测试没意义')
  process.exit(1)
}
if (bad.length > 0) {
  console.error('投递的消息缺 id：', JSON.stringify(bad[0]))
  process.exit(1)
}
console.log('投递消息都带 id ✓')

process.exit(0)  // exit 钩子负责还原 state
