/**
 * qq_pass 与正文的关系测试（0.9.3）。
 *
 * 踩过的事：主动搭话投进去，她先写了一句正文，又觉得「这时候再补一句太催了」→ 调 qq_pass。
 * 结果会话里她明明说了一句话，QQ 上什么都没收到 —— 用户报的是「她发了消息，但我没收到」，
 * 看起来像转发坏了，其实是 qq_pass 把刚写的话一起吞掉了。
 *
 * 现在的规矩：
 *   · 正文是纯动作 / 纯标点 → qq_pass 生效，什么都不发
 *   · 正文里有真话       → 写了就算说出口，照发（本测试钉这一条）
 *
 * 隔离：整个测试跑在临时 HOME 里（DATA_DIR = <tmp>/.dsh），
 * 不碰真的 ~/.dsh —— 否则会改到正在跑的 DSH 的配置、游标和单实例锁。
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const SANDBOX_HOME = join(tmpdir(), `qq-bridge-pass-${process.pid}`)
const SANDBOX_DATA = join(SANDBOX_HOME, '.dsh')

// ⚠️ 必须在 import 插件模块之前改：env.js 的 DATA_DIR 是在模块加载时求值的
mkdirSync(SANDBOX_DATA, { recursive: true })
process.env.USERPROFILE = SANDBOX_HOME
process.env.HOME = SANDBOX_HOME
process.on('exit', () => {
  try { rmSync(SANDBOX_HOME, { recursive: true, force: true }) } catch { /* 清不掉不算失败 */ }
})

const PEER = 3472302240
const SELF = 3655191092
const SESSION = 'session-pass-forward-test'

writeFileSync(join(SANDBOX_DATA, 'qq-bridge.config.json'), JSON.stringify({
  enabled: true,
  selfUin: SELF,
  peerUin: PEER,
  ownerUin: PEER,
  onebotHttp: 'http://127.0.0.1:3000/',
  token: 'test-token',
  workspaceCwd: '',
  // 这条测试只管「转发还是不发」，别让合并窗口和静默掺进来
  mergeWindowMs: 0,
  replyQuietMs: 0,
  splitReply: false,
  autoForwardReply: true,
  backfillOnStart: false,
  memoryEnabled: false,
  wsEnabled: false,
  proactiveEnabled: false,
  routes: { private: { [String(PEER)]: { sessionId: SESSION } }, group: {} }
}, null, 2), 'utf8')

writeFileSync(join(SANDBOX_DATA, 'qq-bridge-state.json'), JSON.stringify({
  lastId: 0, lastSeq: 3487, lastTime: 1, privates: {}, groups: {}
}, null, 2), 'utf8')

const sent = []
let events = []
const MSG_TEXT = '在吗'
const SAYS = '好呀，那我在教室门口等你'

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
            message: [{ type: 'text', data: { text: MSG_TEXT } }]
          }]
        }
      })
    }
  }
  return { ok: true, json: async () => ({ retcode: 0, data: [] }) }
}

// 抑制要发生在回合中间：真实链路上是模型先调 qq_pass，再产出这一回合的正文
const fakeAgent = {
  followup: () => {
    setTimeout(async () => {
      const rhythm = await import(pathToFileURL(join(PLUGIN, 'lib', 'rhythm.js')).href)
      rhythm.suppress(`private:${PEER}`, 'qq_pass: 测试')
      events = [
        {
          type: 'tool/call', seq: 11,
          data: { turn: 1, step: 1, callId: 'call_pass', name: 'qq_pass', arguments: '{}' }
        },
        {
          type: 'tool/result', seq: 12,
          data: {
            turn: 1, step: 1, callId: 'call_pass',
            message: { role: 'tool', toolCallId: 'call_pass', content: [{ type: 'text', text: '划走了' }] }
          }
        },
        {
          type: 'assistant/message', seq: 13,
          data: { message: { role: 'assistant', content: [{ type: 'text', text: SAYS }] } }
        },
        { type: 'turn/end', seq: 14, data: { reason: { kind: 'completed' } } }
      ]
    }, 300)
  },
  session: { snapshotEvents: () => events }
}

const ctx = {
  get: (key) => (key === 'agents'
    ? { get: () => fakeAgent, resume: async () => ({ agent: fakeAgent }) }
    : undefined),
  effect: () => {}
}

const module = await import(pathToFileURL(join(PLUGIN, 'lib', 'index.js')).href)
module.apply(ctx)
await new Promise((r) => setTimeout(r, 3500))

console.log('发出去的条数 =', sent.length)
for (const item of sent) console.log('  ', item.action, JSON.stringify(item.params).slice(0, 120))

if (sent.length === 0) {
  console.error('\n✗ 正文里有真话，却因为 qq_pass 一个字都没发出去（这正是用户报过的问题）')
  process.exit(1)
}
if (!sent.some((item) => JSON.stringify(item.params ?? '').includes(SAYS))) {
  console.error('\n✗ 发了消息，但发的不是她写的那句')
  process.exit(1)
}
console.log('\n✓ qq_pass 但正文有真话 → 照发（写了就算说出口）')

process.exit(0)
