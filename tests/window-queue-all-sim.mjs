/**
 * 「窗口期内整段对话都进队列」回归测试（2026-11-09，0.21.0）。
 *
 * ## 这次要钉住的真实故障
 *
 * 用户实测（群 716197431，2026-11-09 02:11~02:14）：@ 她一次之后，
 * 思念酱（第三方）在窗口期内接了 **6 条**话，**0 条**进过她的上下文；
 * 她只能对着最初那一条 @ 连说三轮 —— 表现就是「聊得不连贯」。
 *
 * 机制：入窗判定复用 `isWindowEligible()`，它只认「触发人 / @ 她 / 引用她」三类。
 * 而「别人接话」这一档在设计稿 §3 里是写着的，实现却压成了「引用她」一条窄路；
 * 那条窄路还因为 `noteReply` 的判据写错（单条发送时 message_ids 是空数组）
 * 而**恒假** —— 两个缺陷叠在一起，等于「别人说话她永远收不到」。
 *
 * ## 这个测试怎么抓它
 *
 * 直接对 `shouldQueueForWindow()` 断言，并**同时**钉住两条不能混的边界：
 *   · 进队列（便宜）—— 窗口内任何人（除她自己）的发言都要进；
 *   · 开回合（贵）—— 仍然是 `isWindowEligible` 的窄口径，不能跟着放宽。
 * 第二条必须一起测，否则「放宽」会被实现成「所有闲聊都触发模型调用」。
 *
 * ⚠️ 假绿防线（本项目铁律②）：每条断言都必须能在**把实现改坏之后变红**。
 *    下面用 `expectRedOnBreak()` 之外，注释里写明「改坏哪个函数会让这条红」。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')
const SANDBOX_HOME = join(HERE, '..', '..', '.tmp-test', `queue-all-${process.pid}`)
const SANDBOX_DATA = join(SANDBOX_HOME, '.dsh')

mkdirSync(SANDBOX_DATA, { recursive: true })
process.env.USERPROFILE = SANDBOX_HOME
process.env.HOME = SANDBOX_HOME
process.on('exit', () => {
  try { rmSync(SANDBOX_HOME, { recursive: true, force: true }) } catch { /* 清不掉不算失败 */ }
})

const SELF = '3655191092'
const OWNER = '3472302240'
const STRANGER = '1836323387'
const GROUP = '716197431'

writeFileSync(join(SANDBOX_DATA, 'qq-bridge.config.json'), JSON.stringify({
  enabled: true,
  selfUin: SELF,
  peerUin: OWNER,
  ownerUin: OWNER,
  onebotHttp: 'http://127.0.0.1:3000/',
  token: 'test-token',
  workspaceCwd: '',
  groupUins: [GROUP],
  groupOnlyWhenAt: true,
  routes: { private: {}, group: { [GROUP]: { sessionId: 'session-queue-all-test' } } },
  replyQuietMs: 0,
  splitReply: true,
  windowEnabled: true,
  windowQueueAll: true,
  windowQueueMax: 20
}, null, 2), 'utf8')
writeFileSync(join(SANDBOX_DATA, 'qq-bridge-state.json'), JSON.stringify({
  privates: {}, groups: {}, windows: {}
}, null, 2), 'utf8')

const windowMod = await import(pathToFileURL(join(PLUGIN, 'lib', 'window.js')).href)
const {
  shouldQueueForWindow, isWindowEligible, openWindow, windowOf, closeWindow,
  queueWindowMessage, windowMessages
} = windowMod

let pass = 0
const failures = []
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log('  ✓ ' + label) } else { failures.push(label); console.error('  ✗ ' + label) }
}
const eq = (actual, expected, label) => ok(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`)

const msg = (uin, seq, text = '随便说一句', extra = []) => ({
  message_id: -seq,
  message_seq: seq,
  time: 1793000000 + seq,
  sender: { user_id: uin, nickname: 'n' + uin },
  message: [...extra, { type: 'text', data: { text } }]
})
const cfg = { selfUin: SELF, ownerUin: OWNER, windowQueueAll: true }

console.log('shouldQueueForWindow：窗口内任何人（除自己）都要进队列')
openWindow(GROUP, OWNER)
const win = windowOf(GROUP)
ok(win !== null, '窗口已开')

// 这是本次故障的主角：第三方接话，既没 @ 也没引用。
// 改坏方式：把 shouldQueueForWindow 的 `return true` 改成 `return isWindowEligible(...)`
// → 这一条立刻变红（isWindowEligible 对陌生人是 false）。
ok(shouldQueueForWindow(win, msg(STRANGER, 10), cfg) === true, '第三方普通接话要进队列（本次故障的核心）')

// 开关关掉时**必须**退回旧行为 —— 否则「可配置」是假的。
// 改坏方式：把 `config?.windowQueueAll === false` 那行删掉 → 这条变红。
ok(shouldQueueForWindow(win, msg(STRANGER, 11), { ...cfg, windowQueueAll: false }) === false,
  'windowQueueAll=false 时退回旧行为（第三方普通接话不进队列）')

// 她自己发的话不进队列：那是「已经说出去的话」，不是「要回的话」。
// 改坏方式：删掉 senderUin === selfUin 那段 → 这条变红。
ok(shouldQueueForWindow(win, msg(SELF, 12), cfg) === false, '她自己发的消息不进批次队列')

// 空消息（没有 text、段数组也空）不进队列，省一次模型调用。
ok(shouldQueueForWindow(win, { message_id: -13, message_seq: 13, time: 1793000013, sender: { user_id: STRANGER }, message: [] }, cfg) === false,
  '完全空的消息不进队列')

console.log('')
console.log('窄口径必须保持不变：进队列放宽 ≠ 开回合放宽')

// ⚠️ 这条是本测试最容易被「顺手改宽」的地方。
// 窗口内第三方普通发言**仍然不该**被 isWindowEligible 判成「在跟我说话」，
// 否则窗口一开，群里每句闲聊都会给她开一个新回合。
// 改坏方式：让 isWindowEligible 也调用 shouldQueueForWindow → 这条变红。
ok(isWindowEligible(win, msg(STRANGER, 14), cfg) === false,
  'isWindowEligible 仍然是窄口径（第三方普通发言不单独开回合）')
ok(isWindowEligible(win, msg(OWNER, 15), cfg) === true, '触发人（用户本人）的发言算在跟她说话')
ok(isWindowEligible(win, msg(STRANGER, 16, '在吗', [{ type: 'at', data: { qq: SELF } }]), cfg) === true,
  '@ 她的发言算在跟她说话')

console.log('')
console.log('队列上限：超了丢最老的')

// 用户 2026-11-09 原话：「应该配置上限，例如一轮中最多 20 条，超过了就不要了，丢消息也无所谓。」
// 改坏方式：删掉 queueWindowMessage 里的 while(list.length > cap) 循环 → 这条变红。
for (let i = 0; i < 30; i += 1) queueWindowMessage(GROUP, msg(STRANGER, 100 + i))
const queued = windowMessages(GROUP)
ok(queued.length <= 20, `队列被裁到上限内（实际 ${queued.length} 条 ≤ 20）`)
// 丢的必须是最老的：留下的是 seq 最大的那批
const seqs = queued.map((item) => item.message_seq)
ok(Math.min(...seqs) > 100, `丢的是最老的（留下的最小 seq=${Math.min(...seqs)} > 100）`)
ok(Math.max(...seqs) === 129, '最新的一条留在队列里')

closeWindow(GROUP, 'test')
console.log('')
if (failures.length > 0) {
  for (const item of failures) console.error('✗ ' + item)
  console.error(`\n结果：${pass} 过 / ${failures.length} 败`)
  process.exit(1)
}
console.log(`结果：${pass} 过 / 0 败`)
process.exit(0)
