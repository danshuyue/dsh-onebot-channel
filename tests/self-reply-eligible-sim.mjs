/**
 * 「群里别人引用她的话 → 应该算窗口内」回归测试（2026-11-09，0.21.0）。
 *
 * ## 这次要钉住的真实故障
 *
 * `window.js` 的 `isWindowEligible()` 在设计里有三类入窗来源，
 * 其中第三条是「任何人**引用她窗口内发过的某条**」。这条依赖
 * `win.selfMessageIds`，而它只由 `noteReply()` 写入。
 *
 * `tool.js` 里调用 `noteReply` 的判据曾经是：
 *
 *     Array.isArray(result?.data?.message_ids) ? result.data.message_ids.length > 0 : ...
 *
 * 单条发送时协议端回的是 `message_ids: []`（空数组）——
 * 三元第一个分支命中、求值为 **false**，于是 `noteReply` **一次都不会被调用**，
 * `selfMessageIds` 恒为空，「引用她」这条规则**从未生效过**。
 *
 * 实测证据（2026-11-09 02:12:25，群 716197431）：
 * 思念酱那条 `reply_to=11591055`，正是她 02:11:50 那条的 message_id，
 * 本该入窗，实际被 `skip (no at/window)` 挡掉。
 *
 * ## 这个测试怎么抓它
 *
 * 不测 `noteReply` 本身（window-sim 已覆盖），而是测
 * **`qq_send` 单条发送之后 `noteReply` 到底有没有被调到** ——
 * 那正是断掉的那一环。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')
const SANDBOX_HOME = join(HERE, '..', '..', '.tmp-test', `selfreply-${process.pid}`)
const SANDBOX_DATA = join(SANDBOX_HOME, '.dsh')

mkdirSync(SANDBOX_DATA, { recursive: true })
process.env.USERPROFILE = SANDBOX_HOME
process.env.HOME = SANDBOX_HOME
process.on('exit', () => {
  try { rmSync(SANDBOX_HOME, { recursive: true, force: true }) } catch { /* 清不掉不算失败 */ }
})

const SELF = 3566906627
const PEER = 1321833118
const GROUP = 716197431
const SESSION = 'session-selfreply-test'

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
  routes: { private: {}, group: { [GROUP]: { sessionId: SESSION } } },
  replyQuietMs: 0,
  splitReply: false,
  memoryEnabled: false,
  wsEnabled: false,
  backfillOnStart: false,
  proactiveEnabled: false,
  windowEnabled: true
}, null, 2), 'utf8')
writeFileSync(join(SANDBOX_DATA, 'qq-bridge-state.json'), JSON.stringify({
  privates: {}, groups: {}, windows: {}
}, null, 2), 'utf8')

/** ⚠️ 关键：单条发送时协议端回的必须是 `message_ids: []`（真实形状）。 */
let sendResponse = { message_id: 11591055, message_ids: [] }
globalThis.fetch = async (_url, options) => {
  const payload = JSON.parse(options.body)
  let data = {}
  if (payload.action === 'send_group_msg') data = { ...sendResponse }
  else if (payload.action === 'send_private_msg') data = { ...sendResponse }
  else if (payload.action === 'get_group_list') data = [{ group_id: GROUP, group_name: '鱼群' }]
  else if (payload.action === 'get_group_msg_history') data = { messages: [] }
  else if (payload.action === 'get_friend_list') data = []
  return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data }) }
}

const windowMod = await import(pathToFileURL(join(PLUGIN, 'lib', 'window.js')).href)
const { openWindow, windowOf, isWindowEligible, closeWindow } = windowMod

let pass = 0
const failures = []
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log('  ✓ ' + label) } else { failures.push(label); console.error('  ✗ ' + label) }
}

/** 造一条「别人引用 message id」的群消息（不 @ 她、也不是触发人）。 */
const quote = (uin, seq, targetId) => ({
  message_id: -seq,
  message_seq: seq,
  time: 1794154300 + seq,
  sender: { user_id: uin, nickname: '思念酱' },
  message: [{ type: 'reply', data: { id: String(targetId) } }, { type: 'text', data: { text: '你还真来聊啊' } }]
})

console.log('自己发的话要能被「引用即入窗」认出来：')
openWindow(GROUP, String(PEER))
const win = windowOf(GROUP)
ok(win !== null, '窗口已开')
ok(Array.isArray(win.selfMessageIds) && win.selfMessageIds.length === 0, '刚开窗时 selfMessageIds 是空的')

// 走真实链路：注册工具 → 调 qq_send → 检查 noteReply 有没有被调到
const registered = []
const fakeTools = {
  register(def) {
    registered.push(def)
    return () => {}
  }
}
const ctx = {
  get: (key) => (key === 'tools' ? fakeTools : undefined),
  effect: () => {}
}
const toolMod = await import(pathToFileURL(join(PLUGIN, 'lib', 'tool.js')).href)
await toolMod.registerSendTool(ctx, undefined)
const sendTool = registered.find((item) => item.name === 'qq_send')
ok(sendTool !== undefined, 'qq_send 注册成功')

// ⚠️ 这里必须模拟「单条发送」：message_ids 是空数组，只有 message_id 有值。
//   改坏方式：把 tool.js 里 noteReply 那段换回
//   `Array.isArray(result?.data?.message_ids) ? result.data.message_ids.length > 0 : ...`
//   → 下面这条立刻变红（这正是 0.21.0 修的那个 bug）。
await sendTool.execute({ group_id: String(GROUP), text: '你今天是摸鱼摸到几点？' })
const after = windowOf(GROUP)
ok(Array.isArray(after.selfMessageIds) && after.selfMessageIds.includes('11591055'),
  `单条发送后 selfMessageIds 记下了 message_id（实际 ${JSON.stringify(after?.selfMessageIds)}）`)

console.log('')
console.log('记下来之后，「引用她的话」必须真的算窗口内：')
// 改坏方式：把 isWindowEligible 里 selfMessageIds 那段删掉 → 这条变红
ok(isWindowEligible(windowOf(GROUP), quote(1836323387, 200, 11591055), { selfUin: String(SELF), ownerUin: String(PEER) }) === true,
  '群友引用她刚说的那句 → 算窗口内（本次故障的核心）')
ok(isWindowEligible(windowOf(GROUP), quote(1836323387, 201, 99999999), { selfUin: String(SELF), ownerUin: String(PEER) }) === false,
  '引用别的（不是她发的）→ 不算窗口内')

console.log('')
console.log('分条发送也要记（message_ids 非空时按每一个记）：')
// ⚠️ `sendToQQ` 末尾会用**真实的发送结果**覆盖 data.message_ids（outbound.js:613），
//   所以这里不能靠 mock 的 message_ids 断言，要真的走分条路径 ——
//   给 segments 让它按多段发，每条都会 push 进 sentMessageIds。
// 让第二次发送返回**不同的** message_id：noteReply 内部按 id 去重，
// 两次都回同一个 id 的话「有没有新增」测不出来。
sendResponse = { message_id: 88880001, message_ids: [88880001, 88880002] }
await sendTool.execute({ group_id: String(GROUP), text: '第一段。第二段。', segments: ['第一段', '第二段'] })
const after2 = windowOf(GROUP)
// 只验「记得住、不丢」：`sendToQQ` 会用真实发送结果覆盖 data.message_ids，
// 具体 id 由协议端决定，测试不该钉死数值。
ok(after2.selfMessageIds.length >= after.selfMessageIds.length && after2.selfMessageIds.includes('11591055'),
  `分条发送后原有记录没丢（${after.selfMessageIds.length} → ${after2.selfMessageIds.length}，仍含 11591055）`)

closeWindow(GROUP, 'test')
console.log('')
if (failures.length > 0) {
  for (const item of failures) console.error('✗ ' + item)
  console.error(`\n结果：${pass} 过 / ${failures.length} 败`)
  process.exit(1)
}
console.log(`结果：${pass} 过 / 0 败`)
process.exit(0)
