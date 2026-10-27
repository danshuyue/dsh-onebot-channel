/**
 * 群聊模式的离线模拟测试：不需要真加群，也不需要 DSH。
 * 用一个假 fetch 喂历史，用假 agent 收投递，验证三件事：
 *   1. 没 @ 的群消息只推进游标、不投递；
 *   2. @ 到的消息投递，且带上群号 / 群名 / 发言人；
 *   3. 私聊链路没被改坏。
 * 跑完自动还原 config 与 state。
 */
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const SELF = 1000000002

const configBackup = readFileSync(CONFIG, 'utf8')
let stateBackup = null
try { stateBackup = readFileSync(STATE, 'utf8') } catch { stateBackup = null }

// 崩了也要还原，不然把真实配置和游标改坏
process.on('exit', () => {
  writeFileSync(CONFIG, configBackup, 'utf8')
  if (stateBackup !== null) writeFileSync(STATE, stateBackup, 'utf8')
  else rmSync(STATE, { force: true })
})

const cfg = JSON.parse(configBackup)
cfg.groupUins = ['123456']
// selfUin 必须显式设：群消息的 @ 段要跟它比对，继承真实配置的话 @ 永远认不出来
cfg.selfUin = SELF
writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), 'utf8')
writeFileSync(STATE, JSON.stringify({
  lastId: 3000000001,
  lastSeq: 3485,
  lastTime: 1792935655,
  groups: { '123456': { lastSeq: 100, lastTime: 0 } }
}, null, 2), 'utf8')

const fakeHistory = {
  '123456': [
    { message_id: -1, message_seq: 101, time: 1792991900, sender: { user_id: 999, nickname: '小明' },
      message: [{ type: 'text', data: { text: '大家好' } }] },
    { message_id: -2, message_seq: 102, time: 1792991910, sender: { user_id: 999, nickname: '小明' },
      message: [{ type: 'at', data: { qq: String(SELF) } }, { type: 'text', data: { text: ' 在吗机器人' } }] },
    { message_id: -3, message_seq: 103, time: 1792991920, sender: { user_id: 999, nickname: '小明' },
      message: [{ type: 'at', data: { qq: 'all' } }, { type: 'text', data: { text: ' 全体注意' } }] }
  ]
}

globalThis.fetch = async (_url, options) => {
  const payload = JSON.parse(options.body)
  let data = {}
  if (payload.action === 'get_friend_msg_history') data = { messages: [] }
  else if (payload.action === 'get_group_list') data = [{ group_id: 123456, group_name: '测试群' }]
  else if (payload.action === 'get_group_msg_history') data = { messages: fakeHistory[String(payload.params.group_id)] ?? [] }
  else if (payload.action === 'send_private_msg' || payload.action === 'send_group_msg') data = { message_id: 42 }
  return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data }) }
}

const delivered = []
const fakeAgent = { followup: (message) => delivered.push(message) }
const ctx = {
  get: (key) => (key === 'agents' ? { get: () => fakeAgent } : undefined),
  effect: () => {}
}

const module = await import(`${pathToFileURL(join(PLUGIN, 'lib', 'index.js')).href}?t=${Date.now()}`)
module.apply(ctx)
await new Promise((resolve) => setTimeout(resolve, 2500))

console.log('投递条数 =', delivered.length)
for (const item of delivered) {
  const text = Array.isArray(item?.content) ? item.content.map((b) => b?.text ?? '').join('') : JSON.stringify(item)
  console.log('  →', text)
}
console.log('\nstate.groups =', JSON.stringify(JSON.parse(readFileSync(STATE, 'utf8')).groups))
const log = readFileSync(join(DATA, 'qq-bridge-load.log'), 'utf8').trim().split('\n').slice(-8).join('\n')
console.log('\n最近日志:\n' + log)

process.exit(0)  // exit 钩子负责还原 config 与 state
