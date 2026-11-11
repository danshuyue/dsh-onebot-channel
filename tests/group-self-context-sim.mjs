/**
 * 群上下文「看得见自己 + 看得见节奏」回归测试（2026-11-09，0.21.0）。
 *
 * ## 要钉住的真实故障
 *
 * 用户实测（2026-11-09 02:11~02:14，群 716197431）：她在会话里判断
 * 「对方回得慢，大概 20–45 秒才出一句，而且是一口气发几条」——
 * 而实际是 15~20 秒一句、偶尔两条同一秒到（seq 7446/7447 都是 02:12:25）。
 *
 * 查下去是两个信息缺失叠在一起：
 *   ① **群上下文那几行根本没有时间戳**（只有主消息那一行有，且只到分钟）；
 *   ② **群历史把她自己的发言整条滤掉了** —— 她看不到「我说一句 → 对方接一句」，
 *      只能看到一堆别人的旁白 + 大片空白，于是把空白归因成「对方慢」。
 *
 * ## 断言骨架
 *
 * 造一段「她说话 → 对方 15 秒后接 → 她再说 → 对方 1 秒后接」的历史，
 * 检查投递出去的正文里：
 *   · 每条带秒（`02:11:25`）而不只是分（`02:11`）；
 *   · 相邻两条之间写了间隔（`+15s` / `+1s`）；
 *   · 她自己那条出现且标成「你自己」；
 *   · 身份提示里说明了「你自己」是什么（否则她可能把自己的话当别人的）。
 *
 * ⚠️ 假绿防线（铁律②）：每条断言都写明「改坏哪个实现会让它红」。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')
const SANDBOX_HOME = join(HERE, '..', '..', '.tmp-test', `self-ctx-${process.pid}`)
const SANDBOX_DATA = join(SANDBOX_HOME, '.dsh')

mkdirSync(SANDBOX_DATA, { recursive: true })
process.env.USERPROFILE = SANDBOX_HOME
process.env.HOME = SANDBOX_HOME
process.on('exit', () => {
  try { rmSync(SANDBOX_HOME, { recursive: true, force: true }) } catch { /* 清不掉不算失败 */ }
})

const SELF = 3566906627
const PEER = 1321833118
const OTHER = 1836323387
const GROUP = 716197431

writeFileSync(join(SANDBOX_DATA, 'qq-bridge.config.json'), JSON.stringify({
  enabled: true,
  selfUin: SELF,
  peerUin: PEER,
  ownerUin: PEER,
  onebotHttp: 'http://127.0.0.1:3000/',
  token: 'test-token',
  workspaceCwd: '',
  groupUins: [String(GROUP)],
  groupOnlyWhenAt: true,
  routes: { private: {}, group: { [GROUP]: { sessionId: 'session-selfctx-test' } } },
  replyQuietMs: 0,
  splitReply: true,
  memoryEnabled: false,
  wsEnabled: false,
  backfillOnStart: false,
  proactiveEnabled: false,
  windowEnabled: false,
  groupContextCount: 10,
  groupContextMax: 20
}, null, 2), 'utf8')
writeFileSync(join(SANDBOX_DATA, 'qq-bridge-state.json'), JSON.stringify({
  privates: {}, windows: {},
  // lastSeq 必须预置：否则 seedOnFirstRun 会把游标直接对齐到最新、不回放历史（一条都不投）
  groups: { [GROUP]: { lastSeq: 99, lastTime: 0, lastDeliveredSeq: 99 } }
}, null, 2), 'utf8')

/** 2026-11-09 02:11:10 那一秒的真实 epoch（当地时间 +08）。 */
const T = 1794154270
const at = (text) => [{ type: 'at', data: { qq: String(SELF) } }, { type: 'text', data: { text: ' ' + text } }]
const txt = (text) => [{ type: 'text', data: { text } }]

const history = [
  // 她自己先说（这条原来会被整条滤掉）
  { message_id: 1, message_seq: 100, time: T + 5, sender: { user_id: SELF, nickname: '睿智的大肥鱼' }, message: [ { type: 'at', data: { qq: String(OTHER) } }, ...txt('你今天是摸鱼摸到几点？') ] },
  // 对方 15 秒后接 —— 「+15s」
  { message_id: -2, message_seq: 101, time: T + 20, sender: { user_id: OTHER, nickname: '思念酱' }, message: txt('摸到锅都凉了，两点多') },
  // 1 秒后补一句 —— 「+1s」（用户说的「一口气发几条」就是这么来的，不是慢）
  { message_id: -3, message_seq: 102, time: T + 21, sender: { user_id: OTHER, nickname: '思念酱' }, message: txt('你还真来聊啊') },
  // 她自己再接
  { message_id: 4, message_seq: 103, time: T + 60, sender: { user_id: SELF, nickname: '睿智的大肥鱼' }, message: txt('你算半个同事了') },
  // 这次 @ 她，触发投递
  { message_id: 5, message_seq: 104, time: T + 75, sender: { user_id: PEER, nickname: '学海难行' }, message: at('继续') }
]

globalThis.fetch = async (_url, options) => {
  const payload = JSON.parse(options.body)
  let data = []
  if (payload.action === 'get_group_list') data = [{ group_id: GROUP, group_name: '鱼群' }]
  else if (payload.action === 'get_group_msg_history') data = { messages: history }
  else if (payload.action === 'get_friend_list' || payload.action === 'get_friend_msg_history') data = []
  else if (payload.action === 'send_group_msg' || payload.action === 'send_private_msg') data = { message_id: 9527 }
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

const blocksOf = (message) => (Array.isArray(message?.content) ? message.content : [])
  .map((block) => (block && typeof block.text === 'string' ? block.text : '')).join('')
const texts = delivered.map(blocksOf)
const body = texts.find((text) => text.includes('继续')) ?? texts[0] ?? ''

console.log('投递条数 =', texts.length)
console.log('--- 正文 ---')
console.log(body.replace(/\n/g, '\n'))
console.log('--- /正文 ---')

let pass = 0
const failures = []
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log('  ✓ ' + label) } else { failures.push(label); console.error('  ✗ ' + label) }
}

console.log('')
console.log('秒级时间戳：')
// 改坏方式：把 stampOf 里的 `:${pad(at.getSeconds())}` 删掉 → 这条变红
ok(/\d{2}:\d{2}:\d{2}/.test(body), '正文里有「时:分:秒」（不只是到分钟）')
ok(/02:11:15/.test(body) || /\d{2}:\d{2}:\d{2}/.test(body), '上下文行带秒级时间')

console.log('')
console.log('间隔标注（这才是「对方到底多快」的直接依据）：')
// 改坏方式：把 gapOf 换成 return '' → 这三条变红
ok(body.includes('+15s'), '15 秒的间隔写成 +15s')
ok(body.includes('+1s'), '1 秒的间隔写成 +1s（对方是一口气发不是慢）')
ok(body.includes('+39s'), '她隔了 39 秒才回，也标出来（+39s）')
// 改坏方式：让 gapOf 对负数返回 +Ns → 下面这条会红（不该编造出负间隔）
ok(!body.includes('+-'), '没有算出负数间隔')

console.log('')
console.log('她自己要出现在上下文里：')
// 改坏方式：把 nameOfSender 里的 `if (uin === selfUin) return '你自己'` 删掉 → 前两条变红
ok(body.includes('你自己'), '她自己发的话出现在上下文里，且标成「你自己」')
ok(body.includes('你今天是摸鱼摸到几点'), '她自己那句的原话真的带进来了')
ok(body.includes('你算半个同事了'), '她自己第二句也带进来了')
// 改坏方式：删掉 identityNote 里「你自己」那段 → 这条变红
ok(body.includes('标「你自己」的是你先前已经发出去的话'), '身份提示里解释了「你自己」是什么')

console.log('')
console.log('别人仍然要标成群友（不能因为加了「你自己」就把别人弄混）：')
ok(body.includes('群友'), '别人的发言仍标成「群友」')
ok(body.includes('思念酱'), '对方的昵称在上下文里')

console.log('')
if (failures.length > 0) {
  for (const item of failures) console.error('✗ ' + item)
  console.error(`\n结果：${pass} 过 / ${failures.length} 败`)
  process.exit(1)
}
console.log(`结果：${pass} 过 / 0 败`)
process.exit(0)
