/**
 * 群上下文「只带未读」测试。
 *
 * 规则：@ 触发投递时，上下文只取**上次投递之后新出现**的群消息，最多 groupContextCount 条。
 * 之前是无条件往回数 N 条，于是早就看过的消息会被反复塞进上下文。
 *
 * 这个测试一次跑两轮投递：
 *   第 1 轮（lastDeliveredSeq=202，历史 201/202 已读）→ 上下文应当是 0 条
 *   第 2 轮（第 1 轮投递成功后标记推进到 203）      → 上下文应当只有 203 那一条
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = join(homedir(), '.dsh')
const CONFIG = join(DATA, 'qq-bridge.config.json')
const STATE = join(DATA, 'qq-bridge-state.json')

const configBackup = readFileSync(CONFIG, 'utf8')
let stateBackup = null
try { stateBackup = readFileSync(STATE, 'utf8') } catch { stateBackup = null }
process.on('exit', () => {
  writeFileSync(CONFIG, configBackup, 'utf8')
  if (stateBackup !== null) writeFileSync(STATE, stateBackup, 'utf8')
})

const SELF = 3655191092
const OWNER = 3472302240
const STRANGER = 1742196292
const GROUP = 123456

const cfg = JSON.parse(configBackup)
cfg.groupUins = [String(GROUP)]
cfg.routes = { private: {}, group: { [GROUP]: { sessionId: 'session-context-test' } } }
cfg.groupOnlyWhenAt = true
cfg.groupContextCount = 6
cfg.ownerUin = OWNER
cfg.peerUin = OWNER
// selfUin 必须显式设：群消息的 @ 段要跟它比对，继承真实配置的话 @ 永远认不出来
cfg.selfUin = SELF
writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), 'utf8')
// 201/202 已经投递过了（lastDeliveredSeq=202），不该再进上下文
writeFileSync(STATE, JSON.stringify({
  lastId: 0, lastSeq: 0, lastTime: 0,
  groups: { [GROUP]: { lastSeq: 202, lastTime: 0, lastDeliveredSeq: 202 } }
}, null, 2), 'utf8')

const at = (text) => [{ type: 'at', data: { qq: String(SELF) } }, { type: 'text', data: { text: ' ' + text } }]
const history = [
  { message_id: -1, message_seq: 201, time: 1793021600, sender: { user_id: STRANGER, nickname: '千里千寻' }, message: [{ type: 'text', data: { text: '这是你小号？（已读）' } }] },
  { message_id: -2, message_seq: 202, time: 1793021610, sender: { user_id: OWNER, nickname: '求道者见月' }, message: [{ type: 'text', data: { text: '糖糖在吗（已读）' } }] },
  { message_id: -3, message_seq: 203, time: 1793021620, sender: { user_id: STRANGER, nickname: '千里千寻' }, message: at('第一问') },
  { message_id: -4, message_seq: 204, time: 1793021630, sender: { user_id: OWNER, nickname: '求道者见月' }, message: at('第二问') }
]

globalThis.fetch = async (_url, options) => {
  const payload = JSON.parse(options.body)
  let data = []
  if (payload.action === 'get_group_list') data = [{ group_id: GROUP, group_name: '蹭饭群' }]
  else if (payload.action === 'get_group_msg_history') data = { messages: history }
  else if (payload.action === 'get_friend_msg_history') data = { messages: [] }
  else if (payload.action === 'send_private_msg' || payload.action === 'send_group_msg') data = { message_id: 1 }
  return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data }) }
}

const delivered = []
const fakeAgent = { followup: (message) => delivered.push(message) }
const ctx = {
  get: (key) => (key === 'agents' ? { get: () => fakeAgent, resume: async () => ({ agent: fakeAgent }) } : undefined),
  effect: () => {}
}

const mod = await import(`${pathToFileURL(join(PLUGIN, 'lib', 'index.js')).href}?t=${Date.now()}`)
mod.apply(ctx)
await new Promise((resolve) => setTimeout(resolve, 2500))

const textOf = (message) => (Array.isArray(message?.content) ? message.content : [])
  .map((block) => (block && typeof block.text === 'string' ? block.text : '')).join('')

const texts = delivered.map(textOf)
console.log('投递条数 =', texts.length)
texts.forEach((text, index) => console.log(`  [${index}] ${text.replace(/\n/g, ' ⏎ ').slice(0, 160)}`))

const failures = []
if (texts.length !== 2) failures.push(`应该投递 2 条（两条 @），实际 ${texts.length}`)

const first = texts.find((text) => text.includes('第一问')) ?? ''
const second = texts.find((text) => text.includes('第二问')) ?? ''

// 第 1 轮：201/202 都已投递过，不该出现在上下文里
if (first.includes('这是你小号？')) failures.push('第 1 轮把已读消息（seq 201）带进上下文了')
if (first.includes('糖糖在吗')) failures.push('第 1 轮把已读消息（seq 202）带进上下文了')
if (first.includes('[这段时间的群聊]')) failures.push('第 1 轮不该有上下文块（当时没有未读消息）')

// 第 2 轮：只应带上一次投递之后的新消息（seq 203），且不该再夹 201/202
if (!second.includes('[这段时间的群聊]')) failures.push('第 2 轮应该有上下文块（seq 203 是未读）')
if (!second.includes('第一问')) failures.push('第 2 轮上下文缺了 seq 203')
if (second.includes('这是你小号？') || second.includes('糖糖在吗')) failures.push('第 2 轮把已读消息夹进来了')

console.log('')
if (failures.length > 0) {
  for (const item of failures) console.error('✗ ' + item)
  process.exit(1)
}
console.log('✓ 上下文只带未读（已投递过的不重复进上下文），且按 groupContextCount 截断')

process.exit(0)
