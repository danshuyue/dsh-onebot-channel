/**
 * 对话窗口批次投递回归测试（0.16.3）。
 *
 * 踩过的事：群里 @ 之后当轮回得正常，但不带 @ 的续聊永远不进会话。
 * 真因是 deliverWindowBatch() 里引用了只存在于 handleGroupMessage() 函数作用域的
 * windowMode —— 批次一投就抛 ReferenceError，被窗口循环当成投递失败，
 * 无限指数退避重试，消息永远留在 pending 里。
 *
 * 之前的 window-sim 只测了攒批和资格，从没真正调用批次投递，所以漏掉了这条。
 * 这个测试直接调用 deliverWindowBatch，钉住「续聊真的会进会话」。
 *
 * 隔离：整个测试跑在临时 HOME 里，不碰真的 ~/.dsh。
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')
// 沙箱放在仓库内（同 window-sim）：系统临时目录在这台机器上受 ACL 限制，写不进去
const SANDBOX_HOME = join(HERE, '..', '..', '.tmp-test', `window-batch-${process.pid}`)
const SANDBOX_DATA = join(SANDBOX_HOME, '.dsh')

// env.js 的 DATA_DIR 在模块加载时求值，必须先改 HOME 再 import
mkdirSync(SANDBOX_DATA, { recursive: true })
process.env.USERPROFILE = SANDBOX_HOME
process.env.HOME = SANDBOX_HOME
process.on('exit', () => {
  try { rmSync(SANDBOX_HOME, { recursive: true, force: true }) } catch { /* 清不掉不算失败 */ }
})

const GROUP = '975663147'
const PEER = '3472302240'
const SELF = '3655191092'
const SESSION = 'session-window-batch-test'

writeFileSync(join(SANDBOX_DATA, 'qq-bridge.config.json'), JSON.stringify({
  enabled: true,
  selfUin: SELF,
  peerUin: PEER,
  ownerUin: PEER,
  onebotHttp: 'http://127.0.0.1:3000/',
  token: 'test-token',
  // 只钉「批次能不能投出去」，别让静默、分条、转发、探活掺进来
  mergeWindowMs: 0,
  replyQuietMs: 0,
  splitReply: false,
  autoForwardReply: false,
  backfillOnStart: false,
  memoryEnabled: false,
  proactiveEnabled: false,
  windowEnabled: true,
  groupOnlyWhenAt: true,
  routes: { private: {}, group: { [GROUP]: { sessionId: SESSION } } }
}, null, 2), 'utf8')

writeFileSync(join(SANDBOX_DATA, 'qq-bridge-state.json'), JSON.stringify({
  lastId: 0, lastSeq: 0, lastTime: 0, privates: {}, groups: {}
}, null, 2), 'utf8')

globalThis.fetch = async () => ({ ok: true, json: async () => ({ retcode: 0, data: [] }) })

const { loadConfig, getConfig } = await import('../lib/config.js')
const { loadState, getState } = await import('../lib/state.js')
const { openWindow, windowOf } = await import('../lib/window.js')
const { deliverWindowBatch } = await import('../lib/poll.js')

loadConfig()
loadState()
const cfg = getConfig()
Object.assign(cfg, {
  windowEnabled: true,
  groupOnlyWhenAt: true,
  waterWindows: ['00:00-23:59'],
  windowPerGroupDaily: 20,
  windowPerPeerDaily: 10
})
getState().windows = {}
getState().groups = {}
openWindow(GROUP, PEER)

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.error(`  ✗ ${name}`) }
}

/** 假 agent：只要 followup 被调用，就说明消息真的进了会话。 */
const delivered = []
const fakeAgent = {
  followup: (message) => { delivered.push(message) },
  session: { snapshotEvents: () => [] }
}
const ctx = {
  get: (key) => (key === 'agents'
    ? { get: () => fakeAgent, resume: async () => ({ agent: fakeAgent }) }
    : undefined),
  effect: () => {}
}

const msg = (uin, id, seq, text) => ({
  message_id: id,
  message_seq: seq,
  time: 1793600000,
  sender: { user_id: String(uin), nickname: '测试' },
  message: [{ type: 'text', data: { text } }]
})

const batch = [
  msg(PEER, 101, 11, '再补一句'),
  msg(PEER, 102, 12, '还有一件事')
]

let error = null
let result = null
try {
  result = await deliverWindowBatch(ctx, GROUP, batch)
} catch (thrown) {
  error = thrown
}

ok(error === null, `批次投递不抛错${error === null ? '' : `（实际抛了 ${error.name}: ${error.message}）`}`)
ok(result?.status === 'delivered', `批次返回 delivered${result?.status === 'delivered' ? '' : `（实际 ${JSON.stringify(result)}）`}`)
ok(delivered.length === 1, `续聊消息进了会话（followup 调用 ${delivered.length} 次）`)

const text = delivered[0]?.content?.[0]?.text ?? ''
ok(text.includes('再补一句') && text.includes('还有一件事'), '两条续聊正文都在投递内容里')
ok(windowOf(GROUP) !== null, '投递后窗口仍然开着')

// 窗口关掉时不该再投（关窗后 pending 清空、批次不再属于任何窗口）
console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
