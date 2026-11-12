/**
 * 对话窗口离线模拟：状态、资格、攒批、预算与跨午夜边界。
 * 运行：node tests/window-sim.mjs（建议隔离 HOME）。
 */
import { readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SANDBOX_HOME = join(HERE, '..', '..', '.tmp-test', `window-${process.pid}`)
const DATA = join(SANDBOX_HOME, '.dsh')
mkdirSync(DATA, { recursive: true })
process.env.HOME = SANDBOX_HOME
process.env.USERPROFILE = SANDBOX_HOME
const STATE_FILE = join(DATA, 'qq-bridge-state.json')
const CONFIG_FILE = join(DATA, 'qq-bridge.config.json')
writeFileSync(CONFIG_FILE, '{}\n', 'utf8')
function restore() {
  rmSync(SANDBOX_HOME, { recursive: true, force: true })
}
process.on('exit', restore)

const { getConfig, loadConfig } = await import('../lib/config.js')
const { getState, loadState, saveState } = await import('../lib/state.js')
const {
  windowOf, openWindow, touchWindow, closeWindow, noteReply, notePass,
  queueWindowMessage, windowMessages, startWindowLoop, resetWindowDay,
  isWindowEligible, isWithinWaterWindows, atUinForWindow
} = await import('../lib/window.js')

loadConfig()
const cfg = getConfig()
Object.assign(cfg, {
  groupUins: ['window-test'],
  routes: { private: {}, group: { 'window-test': { sessionId: 'window-test-session' } } },
  windowEnabled: true,
  windowIdleMs: 120000,
  windowMaxMs: 600000,
  windowMaxReplies: 5,
  windowPerPeerDaily: 10,
  windowPerGroupDaily: 20,
  waterWindows: ['00:00-23:59']
})
getState().windows = {}
saveState({ windows: {} })

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.error(`  ✗ ${name}`) }
}
function eq(actual, expected, name) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${name}${JSON.stringify(actual) === JSON.stringify(expected) ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`)
}
const msg = (uin, id, seq, content = '继续') => ({
  message_id: id,
  message_seq: seq,
  sender: { user_id: String(uin), nickname: '测试' },
  message: [{ type: 'text', data: { text: content } }]
})
const at = (uin, id, seq) => ({
  ...msg(uin, id, seq),
  message: [{ type: 'at', data: { qq: '999999' } }, { type: 'text', data: { text: '在吗' } }]
})
const quote = (uin, id, seq, target) => ({
  ...msg(uin, id, seq),
  message: [{ type: 'reply', data: { id: String(target) } }, { type: 'text', data: { text: '接着说' } }]
})

console.log('资格与窗口生命周期：')
// 使用当前日、全日活动段，避免测试依赖机器当前小时。
ok(openWindow('window-test', 'peer-1') === true, '触发 @ 后可开窗')
const win = windowOf('window-test')
ok(win !== null, '能取到活动窗口')
ok(isWindowEligible(win, msg('peer-1', 1, 1), { selfUin: '999999', ownerUin: 'owner-1' }), '触发者普通消息算窗口内')
ok(isWindowEligible(win, msg('owner-1', 7, 7), { selfUin: '999999', ownerUin: 'owner-1' }), '其他人触发窗口后，用户本人普通消息也算窗口内')
ok(isWindowEligible(win, at('other', 2, 2), { selfUin: '999999', ownerUin: 'owner-1' }), '@ 她的消息算窗口内')
ok(!isWindowEligible(win, msg('other', 3, 3), { selfUin: '999999', ownerUin: 'owner-1' }), '其他人普通闲聊不算')
ok(!isWindowEligible(win, quote('other', 4, 4, 777), { selfUin: '999999', ownerUin: 'owner-1' }), '引用窗口前消息不算')
noteReply('window-test', '777')
ok(isWindowEligible(windowOf('window-test'), quote('other', 5, 5, 777), { selfUin: '999999' }), '引用窗口内她发的消息算')

eq(atUinForWindow(windowOf('window-test'), 'peer-1', '999999'), 'peer-1', '窗口前两条回复带 @')
noteReply('window-test', '778')
eq(atUinForWindow(windowOf('window-test'), 'peer-1', '999999'), '', '窗口第三条回复起不带 @')
closeWindow('window-test', 'test')
ok(windowOf('window-test') === null, '主动关窗清除活动状态')

console.log('攒批：')
openWindow('window-test', 'peer-1')
queueWindowMessage('window-test', msg('peer-1', 10, 10))
queueWindowMessage('window-test', msg('peer-1', 11, 11))
queueWindowMessage('window-test', msg('peer-1', 12, 12))
let batches = []
const stopBatch = startWindowLoop({}, async (_ctx, groupId, messages) => {
  batches.push([groupId, messages.length])
  return { status: 'delivered' }
})
await new Promise((resolve) => setTimeout(resolve, 30))
stopBatch()
eq(batches, [['window-test', 3]], '攒够三条立即 flush')
// 空池不会空转调用 handler。
const emptyCount = batches.length
await new Promise((resolve) => setTimeout(resolve, 30))
queueWindowMessage('window-test', msg('peer-1', 20, 20))
queueWindowMessage('window-test', msg('peer-1', 21, 21))
queueWindowMessage('window-test', msg('peer-1', 22, 22))
const stopFail = startWindowLoop({}, async () => { throw new Error('transient') })
await new Promise((resolve) => setTimeout(resolve, 30))
ok(windowMessages('window-test').length === 3, '处理器失败时保留整个批次')
stopFail()
// 失败后重启轻量巡检；退避未到期时不得再次调用 handler。
let retryCalls = 0
const stopRetry = startWindowLoop({}, async () => { retryCalls += 1; return true })
await new Promise((resolve) => setTimeout(resolve, 40))
stopRetry()
eq(retryCalls, 0, '失败批次退避期间不会每秒重试')
eq(windowMessages('window-test').length, 3, '退避期间仍保留 pending 消息')
closeWindow('window-test', 'test')

console.log('跨午夜活动时间段：')
const water = ['18:00-09:00']
for (const [hour, minute, expected, label] of [
  [0, 0, true, '00:00'], [8, 59, true, '08:59'], [9, 0, false, '09:00'],
  [17, 59, false, '17:59'], [18, 0, true, '18:00']
]) {
  ok(isWithinWaterWindows(new Date(2026, 10, 1, hour, minute), water) === expected, `${label} 跨午夜判定`)
}

console.log('直接 @ 与唤醒词的时段规则：')
// 空时段保证一直处在时段外，避免回归依赖运行时刻。
cfg.waterWindows = []
ok(openWindow('window-test', 'peer-1', 'wake') === false, '时段外唤醒词不能开窗')
ok(openWindow('window-test', 'peer-1'), '时段外直接 @ 仍可开窗')
eq(windowOf('window-test')?.openedBy, 'at', '时段外直接 @ 保留开窗来源')
closeWindow('window-test', 'hours-test')
cfg.windowEnabled = false
ok(openWindow('window-test', 'peer-1') === false, '时段外直接 @ 仍尊重窗口总开关')
cfg.windowEnabled = true
cfg.waterWindows = ['00:00-12:00', '12:00-00:00']
ok(openWindow('window-test', 'peer-1', 'wake'), '活跃时段内唤醒词仍可开窗')
closeWindow('window-test', 'hours-test')

console.log('预算与收尾：')
Object.assign(cfg, { waterWindows: [], windowPerPeerDaily: 1, windowPerGroupDaily: 1, windowMaxReplies: 3 })
getState().windows = {}
saveState({ windows: {} })
ok(openWindow('window-test', 'peer-1'), '预算内第一窗可开')
noteReply('window-test', 'a')
noteReply('window-test', 'b')
noteReply('window-test', 'c')
ok(windowOf('window-test') === null, '达到单窗回复上限立即关窗')
ok(openWindow('window-test', 'peer-1') === false, '同日达到群/个人开窗额度后不开新窗')
getState().windows['window-test'].openedToday = 1
getState().windows['window-test'].peersToday['peer-1'] = 1
ok(openWindow('window-test', 'peer-1') === false, '超过每日群/个人预算不开窗')
cfg.windowPerGroupDaily = 20
ok(openWindow('window-test', 'peer-1') === false, '群预算充足时，时段外直接 @ 仍受个人额度限制')
ok(openWindow('window-test', 'peer-2'), '个人额度耗尽不影响其他群友开窗')
closeWindow('window-test', 'budget-test')
cfg.windowPerGroupDaily = 2
ok(openWindow('window-test', 'peer-3') === false, '个人预算充足时，时段外直接 @ 仍受群额度限制')
ok(resetWindowDay('window-test', '2099-01-01'), '跨天可重置窗口计数')
eq(getState().windows['window-test'].openedToday, 0, '跨天重置 openedToday')
eq(getState().windows['window-test'].peersToday, {}, '跨天重置 peersToday')

console.log('状态持久化：')
getState().windows['window-test'] = { openedAt: Date.now(), triggerUin: 'peer-1', active: true }
saveState({ windows: getState().windows })
loadState()
ok(getState().windows['window-test'] !== undefined, 'loadState 能读回 windows')

restore()
console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed > 0 ? 1 : 0)
