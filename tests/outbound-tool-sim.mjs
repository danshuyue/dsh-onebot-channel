/**
 * 自动转发 vs qq_send 去重测试。
 *
 * 场景：模型这一回合**已经用 qq_send 发过**了，自动转发就不能再发一遍 ——
 * 否则群里会同时收到「工具正文」和「助手这一轮的完整正文」两条（实测踩过）。
 *
 * 对照：outbound-sim 是不用工具的回合，应当转发 1 条。
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = join(homedir(), '.dsh')
const CONFIG = join(DATA, 'qq-bridge.config.json')
const STATE = join(DATA, 'qq-bridge-state.json')
const PEER = 3472302240
const SELF = 3655191092

const configBackup = readFileSync(CONFIG, 'utf8')
let stateBackup = null
try { stateBackup = readFileSync(STATE, 'utf8') } catch { stateBackup = null }
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
cfg.selfUin = SELF
cfg.routes = { private: { [String(PEER)]: { sessionId: 'session-outbound-tool-test' } }, group: {} }
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
        data: {
          messages: [{
            message_id: -5, message_seq: 3488, time: 1792993000,
            sender: { user_id: PEER, nickname: '求道者见月' },
            message: [{ type: 'text', data: { text: '在吗' } }]
          }]
        }
      })
    }
  }
  return { ok: true, json: async () => ({ retcode: 0, data: [] }) }
}

// 这一回合：先调 qq_send，再产出助手正文（这段正文不该被转发）
const fakeAgent = {
  followup: () => {
    setTimeout(() => {
      events = [
        ...events,
        {
          type: 'tool/call', seq: 11,
          data: { turn: 1, step: 1, callId: 'call_1', name: 'qq_send', arguments: '{"text":"给群里的正文"}' }
        },
        {
          type: 'tool/result', seq: 12,
          data: { turn: 1, step: 1, callId: 'call_1', message: { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: '已发到 QQ' }] } }
        },
        {
          type: 'assistant/message', seq: 13,
          data: { message: { role: 'assistant', content: [{ type: 'text', text: '这句是给树树看的，不该发到群里' }] } }
        },
        { type: 'turn/end', seq: 14, data: { reason: { kind: 'completed' } } }
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

console.log('自动转发发出条数 =', sent.length)
for (const item of sent) console.log('  ', item.action, JSON.stringify(item.params).slice(0, 120))

const leaked = sent.filter((item) => {
  const text = JSON.stringify(item.params ?? '')
  return text.includes('不该发到群里')
})

if (leaked.length > 0) {
  console.error('\n✗ 自动转发把「已用 qq_send 发过」的回合又发了一遍')
  process.exit(1)
}
if (sent.length !== 0) {
  console.error('\n✗ 这一回合既然用了 qq_send，自动转发就应该完全不动作，实际发了', sent.length, '条')
  process.exit(1)
}
console.log('\n✓ 用了 qq_send 的回合，自动转发正确跳过')

process.exit(0)  // exit 钩子负责还原 state
