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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')

// ⚠️ 必须在**隔离 HOME** 下跑（2026-11-09 补，这是本文件唯一的红因）。
//
// ## 为什么（真实现象与根因，别再花时间重查）
//
//   `run-isolated.mjs` 下它是绿的；直接 `node tests/group-context-sim.mjs` 红，
//   而且红法很迷惑：**「投递条数 = 0」且一条日志都没有**，
//   看着像群消息处理坏了。真实原因是 `lib/instance.js` 的**单实例锁**：
//
//     [health] OneBot 已就绪
//     [apply] 另一个实例已在收发（pid=20668，起于 …）→ 本实例只注册工具与设置页，不启动轮询/WS
//
//   生产 DSH 正在跑（它持有 ~/.dsh/qq-bridge-instance.lock），
//   于是**测试进程降级成「只出站」**，入站通路（轮询/WS）根本没启动 ——
//   自然一条都投不出去。而本文件原来读的是 `homedir()` 的真实 `~/.dsh`。
//
//   ⚠️ 关键：不要为了让测试过而去 mock `get_login_info` / 删锁文件。
//      锁是**故意**存在的（两个实例同时收发会把游标互相覆盖、消息投两遍）。
//      正确做法就是换一个 HOME，跟 `run-isolated.mjs` 一样。
//   ⚠️ 也别在别处「顺手」绕过 sandbox-guard：它防的是测试写坏真实 ~/.dsh。
const SANDBOX_HOME = join(PLUGIN, '..', '.tmp-test', `group-context-${process.pid}`)
const DATA = join(SANDBOX_HOME, '.dsh')
mkdirSync(DATA, { recursive: true })
process.env.HOME = SANDBOX_HOME
process.env.USERPROFILE = SANDBOX_HOME
// ⚠️ 清理钩子只注册**一个**（原来下面还有个「写回备份」的 exit 钩子）。
//    两个 on('exit') 抢着删/写同一个沙箱目录时，先跑的那个把目录删掉，
//    后跑的那个在 exit 里 writeFileSync → ENOENT 抛错，把本来通过的测试弄红。
//    这里统一成：清理，不写回 —— 沙箱目录整个丢掉就是最干净的还原。
process.on('exit', () => {
  try { rmSync(SANDBOX_HOME, { recursive: true, force: true }) } catch { /* 清不掉不算失败 */ }
})

const CONFIG = join(DATA, 'qq-bridge.config.json')
const STATE = join(DATA, 'qq-bridge-state.json')

// 沙箱里没有配置就造一份（原来是从真实 ~/.dsh 备份出发再改 —— 那在隔离 HOME 下不存在）。
// ⚠️ 这份**必须是完整可跑的形状**：缺 groupUins / routes 会让 openWindow 直接返回 false，
//    缺口全体现在「投递 0 条」，而日志什么都不说 —— 那是本仓库最典型的静默失效。
const SELF = 3655191092
const OWNER = 3472302240
const STRANGER = 1742196292
const GROUP = 123456

if (!existsSync(CONFIG)) {
  writeFileSync(CONFIG, JSON.stringify({
    enabled: true,
    selfUin: SELF,
    peerUin: OWNER,
    ownerUin: OWNER,
    onebotHttp: 'http://127.0.0.1:3000/',
    token: 'test-token',
    workspaceCwd: '',
    groupUins: [String(GROUP)],
    groupOnlyWhenAt: true,
    routes: { private: {}, group: { [GROUP]: { sessionId: 'session-context-test' } } },
    replyQuietMs: 0,
    splitReply: false,
    memoryEnabled: false,
    wsEnabled: false,
    backfillOnStart: false,
    proactiveEnabled: false,
    windowEnabled: false,
    // 全天可开窗：默认 waterWindows 只有 12-14 / 18-09，别的时段跑测试会静默失败
    waterWindows: ['00:00-23:59']
  }, null, 2), 'utf8')
}

// 只读一份基线，**不再注册写回钩子**（原来的写回钩子会把沙箱目录在 exit 时写崩）。
const configBackup = readFileSync(CONFIG, 'utf8')

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
