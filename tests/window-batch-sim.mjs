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
/** 群里第三个号：用来测「夹在队列消息之间、但没进队列」的上下文。 */
const STRANGER = '1742196292'
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
const { loadState, getState, saveState } = await import('../lib/state.js')
const { openWindow, windowOf, closeWindow, windowMessages, startWindowLoop, queueWindowMessage } = await import('../lib/window.js')
const { deliverWindowBatch, handleGroupMessage } = await import('../lib/poll.js')

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
let failNextFollowup = false
const fakeAgent = {
  followup: (message) => {
    if (failNextFollowup) {
      failNextFollowup = false
      throw new Error('simulated followup failure')
    }
    delivered.push(message)
  },
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

console.log('并发续聊顺序与失败重试：')
closeWindow(GROUP, 'race-test-reset')
getState().windows = {}
getState().groups[GROUP] = { lastSeq: 12, lastDeliveredSeq: 12 }
cfg.forwardExpandEnabled = true
delivered.length = 0
let releaseForward
let forwardReady
const forwardBlocked = new Promise((resolve) => { releaseForward = resolve })
const requestedForward = new Promise((resolve) => { forwardReady = resolve })
globalThis.fetch = async (_url, options) => {
  const payload = JSON.parse(options.body)
  if (payload.action === 'get_forward_msg') {
    forwardReady()
    await forwardBlocked
  }
  return { ok: true, json: async () => ({ retcode: 0, data: { messages: [] } }) }
}
const trigger = {
  ...msg(PEER, 201, 13, '开启连续对话'),
  message: [{ type: 'at', data: { qq: SELF } }, { type: 'text', data: { text: '开启连续对话' } }, { type: 'forward', data: { id: 'race-forward' } }]
}
const stopWindowLoop = startWindowLoop(ctx, async (...args) => deliverWindowBatch(...args))
failNextFollowup = true
const opening = handleGroupMessage(ctx, GROUP, trigger, [])
await requestedForward
const followups = await Promise.all([
  handleGroupMessage(ctx, GROUP, msg(PEER, 202, 14, '紧接着补充')),
  handleGroupMessage(ctx, GROUP, msg(PEER, 203, 15, '又补一句')),
  handleGroupMessage(ctx, GROUP, msg(PEER, 204, 16, '第三句续聊'))
])
ok(followups.every((item) => item.status === 'queued'), '开窗投递期间三条续聊都入队')
ok(windowMessages(GROUP).length === 3, '达到立即刷批上限，三条消息仍在 pending')
await new Promise((resolve) => setTimeout(resolve, 1200))
ok(delivered.length === 0, '触发 @ 未投递前窗口循环不提前 flush')
releaseForward()
const failedTrigger = await opening
ok(failedTrigger.status === 'failed', '模拟首次触发 @ 投递失败')
ok(windowOf(GROUP)?.openedToday === 0, '开窗投递失败后退还每日窗口额度')
await new Promise((resolve) => setTimeout(resolve, 1100))
ok(delivered.length === 0, '触发 @ 失败后批次继续等待重试，不越过失败消息')
const retry = await handleGroupMessage(ctx, GROUP, trigger, [])
ok(retry.status === 'delivered', '同一条 @ 重试成功')
ok(windowOf(GROUP)?.openedToday === 1, '重试成功后再计入每日窗口额度')
const waitUntil = Date.now() + 3000
while (delivered.length < 2 && Date.now() < waitUntil) await new Promise((resolve) => setTimeout(resolve, 25))
stopWindowLoop()
ok(delivered.length === 2, `触发 @ 和续聊批次都投递（共 ${delivered.length} 次）`)
const firstText = delivered[0]?.content?.[0]?.text ?? ''
const secondText = delivered[1]?.content?.[0]?.text ?? ''
ok(firstText.includes('开启连续对话'), '会话首先收到开窗 @ 触发消息')
ok(secondText.includes('紧接着补充') && secondText.includes('第三句续聊'), '续聊批次在触发消息之后到达')

// ---------------------------------------------------------------------------
// 开窗门控的持久化与寿命（审核发现：重启后 pending 会先于失败的 @ flush）
// ---------------------------------------------------------------------------
console.log('开窗门控的重启语义与过期：')
{
  const { holdWindowBatches, settleWindowOpening, openingIdOf, resetRecoveredWindows, OPENING_HOLD_TTL_MS } =
    await import('../lib/window.js')

  // 1. 无 seq / 无 message_id 的消息也必须拿到稳定且唯一的门控号。
  const noId = { sender: { user_id: PEER }, message: [{ type: 'text', data: { text: '没有编号' } }] }
  const firstId = openingIdOf(noId)
  ok(firstId !== '' && firstId === openingIdOf(noId), `无 seq/message_id 时门控号稳定（${firstId}）`)
  const otherNoId = { sender: { user_id: PEER }, message: [{ type: 'text', data: { text: '另一条' } }] }
  ok(openingIdOf(otherNoId) !== firstId, '两条无编号消息不会撞号')
  // message_seq 为 null 时不能退化成 seq:0（会撞号）
  ok(!openingIdOf({ message_seq: null, message_id: '4242' }).startsWith('seq:'), 'seq=null 时改用 message_id')

  // 2. 失败 → 退额度、门控与预约落盘。
  closeWindow(GROUP, 'restart-test-reset')
  getState().windows = {}
  getState().groups[GROUP] = { lastSeq: 30, lastDeliveredSeq: 30 }
  openWindow(GROUP, PEER)
  ok(windowOf(GROUP) !== null, '重启测试：窗口已开')
  const failId = 'seq:31'
  const chargedBefore = Number(windowOf(GROUP)?.openedToday)
  ok(holdWindowBatches(GROUP, failId) === true, '重启测试：开窗 @ 建立门控')
  ok(getState().windows[GROUP].opening?.id === failId, '门控预约已落盘')
  settleWindowOpening(GROUP, failId, false)
  ok(getState().windows[GROUP].opening?.id === failId, '失败后预约仍在盘上（等重试或过期）')
  ok(Number(windowOf(GROUP)?.openedToday) === chargedBefore - 1, '失败一次退一次每日额度')
  // 续聊在 @ 失败期间入队（同时把 pending 写进 state 文件）
  queueWindowMessage(GROUP, msg(PEER, 202, 32, '等待重试期间说的话'))
  ok(getState().windows[GROUP].pending?.length === 1, '等待期间的续聊已落盘')

  // 模拟「进程重启」：内存态全丢，只有 state 文件还在。
  //
  // ⚠️ 必须把盘上的 pendingSince 推老，否则这条断言是**空的**（审核发现）：
  //    pendingSince 是刚才入队的时刻，重启后只过了几百毫秒，
  //    光靠「不够 3 条且不满 8 秒」就足以让 shouldFlush 返回 false ——
  //    把整个门控删掉这条断言照样绿。推老之后时间条件不再能挡，
  //    唯一还挡着批次的就只剩门控本身，这才真的验证了重启语义。
  getState().windows[GROUP].pendingSince = Date.now() - 60000
  saveState({ windows: getState().windows })
  resetRecoveredWindows()
  ok(windowMessages(GROUP).length === 1, '重启后 pending 恢复进内存')
  ok(windowOf(GROUP) !== null, '重启后窗口仍然 active')
  ok(getState().windows[GROUP].opening?.id === failId, '重启后盘上的预约仍在（等重试结算）')

  // 核心断言：重启后门控必须还在，批次不能抢在那条失败的 @ 前面。
  let restartFlushes = 0
  const stopBlocked = startWindowLoop({}, async () => { restartFlushes += 1; return { status: 'delivered' } })
  await new Promise((resolve) => setTimeout(resolve, 1500))
  stopBlocked()
  ok(restartFlushes === 0, '重启后门控仍在，批次没有抢先 flush（时间条件已满足仍被挡住）')
  // 同一条 @ 重试成功 → 放行批次（补两条，凑满立即刷批上限，不必等 8 秒窗口）
  queueWindowMessage(GROUP, msg(PEER, 203, 33, '第二句'))
  queueWindowMessage(GROUP, msg(PEER, 204, 34, '第三句'))
  const beforeRetry = Number(windowOf(GROUP)?.openedToday)
  settleWindowOpening(GROUP, failId, true)
  ok(Number(windowOf(GROUP)?.openedToday) === beforeRetry + 1, '重试成功后重新计入每日额度')
  const stopRestart = startWindowLoop({}, async () => { restartFlushes += 1; return { status: 'delivered' } })
  const restartDeadline = Date.now() + 2000
  while (restartFlushes === 0 && Date.now() < restartDeadline) await new Promise((resolve) => setTimeout(resolve, 25))
  stopRestart()
  ok(restartFlushes > 0, '重试成功后批次被放行')

  // 2b. 结算的幂等与 id 精确匹配（并发双 @ 的安全性全靠这两条）。
  getState().windows = {}
  getState().groups[GROUP] = { lastSeq: 50, lastDeliveredSeq: 50 }
  openWindow(GROUP, PEER)
  holdWindowBatches(GROUP, 'seq:51')
  const chargedOnce = Number(windowOf(GROUP)?.openedToday)
  ok(settleWindowOpening(GROUP, 'seq:51', false) === true, '首次失败结算生效')
  ok(Number(windowOf(GROUP)?.openedToday) === chargedOnce - 1, '失败结算退一次额度')
  ok(settleWindowOpening(GROUP, 'seq:51', false) === true, '同一 id 重复失败结算仍返回 true')
  ok(Number(windowOf(GROUP)?.openedToday) === chargedOnce - 1, '重复失败结算【不】再退一次（幂等）')
  // 别的 id 不能动这笔预约
  ok(settleWindowOpening(GROUP, 'seq:999', true) === false, '不匹配的 id 结算被拒绝')
  ok(Number(windowOf(GROUP)?.openedToday) === chargedOnce - 1, '不匹配的 id 不会误补计额度')
  ok(getState().windows[GROUP].opening?.id === 'seq:51', '不匹配的 id 不会误清预约')
  settleWindowOpening(GROUP, 'seq:51', true)
  closeWindow(GROUP, 'idempotent-test-done')

  // 3. 没有 pending 的窗口在启动时被关掉，预约随之清掉（不能残留）。
  getState().windows = {}
  getState().groups[GROUP] = { lastSeq: 35, lastDeliveredSeq: 35 }
  openWindow(GROUP, PEER)
  holdWindowBatches(GROUP, 'seq:36')
  ok(getState().windows[GROUP].opening !== undefined, '准备：预约已落盘')
  saveState({ windows: getState().windows })
  resetRecoveredWindows()
  ok(getState().windows[GROUP]?.active !== true, '重启后没有 pending 的窗口被关闭')
  ok(getState().windows[GROUP]?.opening === undefined, '关窗时预约一并清除')

  // 4. 过期门控必须放行批次，否则这个群会被永久锁在攒批状态。
  getState().windows = {}
  getState().groups[GROUP] = { lastSeq: 40, lastDeliveredSeq: 40 }
  openWindow(GROUP, PEER)
  // 直接用「已经过期」的时刻建立门控，模拟那条 @ 永远不来了
  holdWindowBatches(GROUP, 'seq:41', Date.now() - OPENING_HOLD_TTL_MS - 1000)
  ok(getState().windows[GROUP].opening !== undefined, '准备：过期预约仍在盘上')
  queueWindowMessage(GROUP, msg(PEER, 301, 42, '过期后的续聊'))
  queueWindowMessage(GROUP, msg(PEER, 302, 43, '再来一条'))
  queueWindowMessage(GROUP, msg(PEER, 303, 44, '第三条'))
  const expiredBatches = []
  const stopExpired = startWindowLoop({}, async (_ctx, groupId, messages) => {
    expiredBatches.push(messages.length)
    return { status: 'delivered' }
  })
  const expiredDeadline = Date.now() + 2000
  while (expiredBatches.length === 0 && Date.now() < expiredDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  stopExpired()
  ok(expiredBatches.length > 0, `门控过期后批次被放行（${expiredBatches.length} 次）`)
  ok(getState().windows[GROUP]?.opening === undefined, '过期时盘上的预约被清掉')
  closeWindow(GROUP, 'expire-test-done')
}

// ---------------------------------------------------------------------------
// @ 是话题边界：先投积压的续聊，再投这条 @（0.16.13）
//
// 用户实测的缺陷：对方持续/间歇 @ 时，不带 @ 的句子堆在队列里，等当前这轮结束才成批
// 投递 —— 模型于是一边回新话题、一边收到几轮之前的旧话，接着旧话题往下聊。
// ---------------------------------------------------------------------------
console.log('@ 之前先投递积压的续聊：')
{
  const { pendingAgeMs, hasOpeningHold, holdWindowBatches, settleWindowOpening } = await import('../lib/window.js')

  /** 重置成一个「窗口已开、队列空」的干净现场，并让循环用真的批次投递。 */
  const resetWindow = async () => {
    closeWindow(GROUP, 'at-flush-test-reset')
    getState().windows = {}
    getState().groups[GROUP] = { lastSeq: 60, lastDeliveredSeq: 60 }
    openWindow(GROUP, PEER)
    await new Promise((resolve) => setTimeout(resolve, 30))
    delivered.length = 0
  }
  const at = (uin, id, seq, text) => ({
    ...msg(uin, id, seq, text),
    message: [{ type: 'at', data: { qq: SELF } }, { type: 'text', data: { text } }]
  })
  const bodyOf = (index) => delivered[index]?.content?.[0]?.text ?? ''

  const stopAtLoop = startWindowLoop(ctx, async (...args) => deliverWindowBatch(...args))

  // A. 顺序：攒着的续聊先到，@ 后到。
  await resetWindow()
  const early = [
    msg(PEER, 601, 61, 'A 那个我再补充一句'),
    msg(PEER, 602, 62, '不过 B 更重要')
  ]
  for (const item of early) queueWindowMessage(GROUP, item)
  ok(windowMessages(GROUP).length === 2, '准备：两条续聊在队列里（未满 3 条、未到 8 秒）')
  ok(pendingAgeMs(GROUP) >= 0, 'pendingAgeMs 能读到积压时长')
  const history = early.slice()
  const atResult = await handleGroupMessage(ctx, GROUP, at(PEER, 603, 63, '那 B 呢'), history)
  ok(atResult.status === 'delivered', '@ 照常投递')
  ok(delivered.length === 2, `一次 @ 触发两次 followup（续聊批次 + @），实际 ${delivered.length}`)
  ok(bodyOf(0).includes('A 那个我再补充一句') && bodyOf(0).includes('不过 B 更重要'), '模型先收到积压的续聊批次')
  ok(bodyOf(1).includes('那 B 呢'), '模型随后才收到这条 @')
  ok(windowMessages(GROUP).length === 0, '@ 投完后队列已清空（这批不会再投第二遍）')
  // ⚠️ 这条是文档里没写、探针发现的关键点：pending 里的消息本来会作为「未读上下文」
  //   塞进 @ 的正文（[这段时间的群聊]）。不剔除 + 不抬基准，同一批话就到了模型面前两遍。
  ok(!bodyOf(1).includes('A 那个我再补充一句'), '@ 的正文里不再重复那批已投过的旧话')
  ok(!bodyOf(1).includes('[这段时间的群聊]'), '@ 的正文里没有重复的上下文块')

  // A2. 轮询路径的形状：`sinceSeqOverride` 是**这一批消息开始前**的旧快照。
  //     真实轮询里 `pollGroup` 先取 baseDeliveredSeq 再逐条处理，所以那条 @ 拿到的
  //     基准比 pending 里那些消息的 seq 更老。
  //     （审核式变异发现：不做这条，把「剔除已投那批」整段删掉测试照样全绿。）
  await resetWindow()
  const oldBase = 60 // 这一批开始处理之前的基准
  const a2 = [
    msg(PEER, 605, 65, 'A2 第一句续聊'),
    msg(PEER, 606, 66, 'A2 第二句续聊')
  ]
  for (const item of a2) queueWindowMessage(GROUP, item)
  const a2Result = await handleGroupMessage(ctx, GROUP, at(PEER, 607, 67, 'A2 的 @'), a2.slice(), oldBase)
  ok(a2Result.status === 'delivered', '旧基准场景：@ 照常投递')
  ok(delivered.length === 2 && bodyOf(0).includes('A2 第一句续聊'), '旧基准场景：积压批次先投')
  ok(!bodyOf(1).includes('A2 第一句续聊'), '旧基准场景：@ 正文里不再重复那批旧话（已按身份剔除）')
  ok(!bodyOf(1).includes('[这段时间的群聊]'), '旧基准场景：@ 正文里没有重复的上下文块')
  // 但「夹在队列消息之间、没进队列」的消息必须留下 —— 她没看过它，那是有效上下文。
  // 这正是「按身份剔除」而不是「把基准抬到批次 maxSeq」的理由：后者按 seq 区间过滤，
  // 会把这条一起删掉（丢消息）。
  await resetWindow()
  const skippedOne = msg(STRANGER, 608, 68, '夹在中间但没进队列的一句')
  queueWindowMessage(GROUP, msg(PEER, 609, 69, '队列里的第一句'))
  queueWindowMessage(GROUP, msg(PEER, 610, 70, '队列里的第二句'))
  const mixedHistory = [skippedOne, ...windowMessages(GROUP)]
  const mixed = await handleGroupMessage(ctx, GROUP, at(PEER, 611, 71, '夹杂场景的 @'), mixedHistory, 60)
  ok(mixed.status === 'delivered', '夹杂场景：@ 照常投递')
  const mixedBody = bodyOf(delivered.length - 1)
  ok(!mixedBody.includes('队列里的第一句'), '夹杂场景：队列里投过的那批不再重复')
  ok(mixedBody.includes('夹在中间但没进队列的一句'), '夹杂场景：没进队列的群友发言仍作为上下文保留（不误删）')

  // B. 零开销：队列空时 @ 不产生额外的 followup。
  await resetWindow()
  ok(pendingAgeMs(GROUP) === 0, 'pendingAgeMs 无积压时返回 0')
  const plain = await handleGroupMessage(ctx, GROUP, at(PEER, 604, 64, '只有这一句'), [])
  ok(plain.status === 'delivered', '队列空时 @ 照常投递')
  ok(delivered.length === 1, `队列空时 @ 只产生一次 followup（实际 ${delivered.length}）`)

  // C. 与开窗门控协同：门控在的时候不抢着投，门控释放后再投。
  await resetWindow()
  const holdId = 'seq:71'
  holdWindowBatches(GROUP, holdId)
  ok(hasOpeningHold(GROUP) === true, '准备：开窗门控已建立')
  queueWindowMessage(GROUP, msg(PEER, 701, 71, '门控期间的续聊'))
  const heldResult = await handleGroupMessage(ctx, GROUP, at(PEER, 702, 72, '门控期间的 @'), [])
  ok(heldResult.status === 'delivered', '门控期间的 @ 照常投递（门控不阻塞 @ 本身）')
  ok(delivered.length === 1, `门控挡着时续聊没有抢在 @ 前面（followup ${delivered.length} 次）`)
  ok(windowMessages(GROUP).length === 1, '被门控挡住的续聊仍然留在队列里')
  settleWindowOpening(GROUP, holdId, true)
  ok(hasOpeningHold(GROUP) === false, '结算后门控已释放')
  delivered.length = 0
  const afterHold = await handleGroupMessage(ctx, GROUP, at(PEER, 703, 73, '门控释放后的 @'), [])
  ok(afterHold.status === 'delivered', '门控释放后的 @ 照常投递')
  ok(delivered.length === 2 && bodyOf(0).includes('门控期间的续聊'), '门控释放后积压的续聊先投、@ 后投')

  // D. 失败不阻塞：积压投不出去时，@ 仍然要投递成功，且积压留着等重试。
  await resetWindow()
  const stuck = msg(PEER, 801, 81, '投不出去的续聊')
  queueWindowMessage(GROUP, stuck)
  failNextFollowup = true
  const failFlush = await handleGroupMessage(ctx, GROUP, at(PEER, 802, 82, '失败时的 @'), [stuck])
  ok(failFlush.status === 'delivered', '积压投递失败时 @ 仍然投递成功')
  ok(delivered.length === 1 && bodyOf(0).includes('失败时的 @'), '失败时模型只收到那条 @')
  ok(windowMessages(GROUP).length === 1, '投递失败的续聊留在队列里等重试')
  // 失败那批既没投出去，游标也没前进，所以它照旧作为 @ 的上下文露一次面 ——
  // 这是失败路径上的重复（成功路径已经靠「先投 + 抬基准」消掉了），可以接受：
  // 重试才是它真正的投递，这里只是背景。
  ok(bodyOf(0).includes('投不出去的续聊'), '投不出去的续聊仍作为 @ 的上下文交给模型（不丢消息）')

  // E. 批次正文要标明「这是刚才的，不是现在的」。
  await resetWindow()
  const agedBatch = [msg(PEER, 901, 91, '攒了很久的第一条'), msg(PEER, 902, 92, '攒了很久的第二条')]
  for (const item of agedBatch) queueWindowMessage(GROUP, item)
  await new Promise((resolve) => setTimeout(resolve, 1100))
  const agedBody = await deliverWindowBatch(ctx, GROUP, agedBatch)
  ok(agedBody.status === 'delivered', '正文头部用例：批次投递成功')
  const agedText = delivered[delivered.length - 1]?.content?.[0]?.text ?? ''
  ok(agedText.includes('这是刚才攒下的 2 条'), `批次正文标了条数（实际：${agedText.split('\n')[1] ?? ''}）`)
  ok(/时间跨度约 \d+ 秒/.test(agedText), '批次正文标了时间跨度秒数')
  ok(agedText.includes('可能已经过时，优先回最新的'), '措辞是「可能过时、优先回最新的」，不是「请忽略」')
  ok(!agedText.includes('请忽略'), '没有写成「请忽略」（那会让模型整批丢掉有效内容）')

  // F. 并发双 @ 的投递顺序不能被打乱（0.16.16 审核发现）
  //    @ 路径里有 `await flushPendingNow`，一旦 await，同群第二条 @ 会抢先投递 ——
  //    实测顺序反成 #104 → #103（0.16.12 是正确的 #103 → #104）。
  //    这正好是本次要修的「顺序错乱」的另一种形态，所以必须钉住。
  await resetWindow()
  const c1 = msg(PEER, 1101, 101, '并发第一条')
  const c2 = msg(PEER, 1102, 102, '并发第二条')
  for (const item of [c1, c2]) queueWindowMessage(GROUP, item)
  const concurrent = await Promise.all([
    handleGroupMessage(ctx, GROUP, at(PEER, 1103, 103, '并发 @ 甲'), []),
    handleGroupMessage(ctx, GROUP, at(PEER, 1104, 104, '并发 @ 乙'), [])
  ])
  ok(concurrent.every((r) => r.status === 'delivered'), '两条并发 @ 都投递成功')
  ok(delivered.length === 3, `并发场景共 3 次 followup（批次 + 两条 @），实际 ${delivered.length}`)
  ok(bodyOf(0).includes('并发第一条'), '积压批次排在最前')
  ok(bodyOf(1).includes('并发 @ 甲') && bodyOf(2).includes('并发 @ 乙'), '两条 @ 按到达顺序投递（甲在前、乙在后）')
  ok(delivered.filter((m) => (m.content?.[0]?.text ?? '').includes('并发第一条')).length === 1,
    '积压批次只投一次（并发 @ 不会各投一遍）')

  stopAtLoop()
  closeWindow(GROUP, 'at-flush-test-done')
}

// ---------------------------------------------------------------------------
// 独立审核发现的 8 条（0.16.16）
//
// 这一段的每条都对应审核员用探针实测复现过的问题。它们有个共同点：
// **79 条既有断言全绿，缺陷照样在** —— 因为既有断言只测「主路径走没走」，
// 没测并发、退避、skipped、基准回拨、关盘落盘这些分支。
// ---------------------------------------------------------------------------
console.log('审核发现 #5：handler 返回 skipped 时消息不能消失：')
{
  const { windowMessages: wm, startWindowLoop: swl, setWindowBatchHandler, flushPendingNow } = await import('../lib/window.js')
  const { getState: gs } = await import('../lib/state.js')
  gs().windows = {}
  gs().groups = { [GROUP]: { lastSeq: 300, lastDeliveredSeq: 300 } }
  openWindow(GROUP, PEER)
  // handler 明确说「这次没投」—— 消息必须留着
  setWindowBatchHandler(async () => ({ status: 'skipped' }))
  queueWindowMessage(GROUP, msg(PEER, 3001, 301, 'skipped 测试'))
  const r = await flushPendingNow({}, GROUP)
  ok(r.status === 'skipped', `flushPendingNow 返回 skipped（实际 ${r.status}）`)
  ok(wm(GROUP).length === 1, 'skipped 后消息【仍在】队列里（旧实现会静默剔除 = 丢消息）')
  ok((r.deliveredIds ?? []).length === 0, 'skipped 时不返回 deliveredIds（否则 poll 会把上下文也剔掉）')
  closeWindow(GROUP, 'skipped-test-done')
}

console.log('审核发现 #6：退避期内不强投：')
{
  const { setWindowBatchHandler, flushPendingNow, windowMessages: wm } = await import('../lib/window.js')
  const { getState: gs } = await import('../lib/state.js')
  gs().windows = {}
  gs().groups = { [GROUP]: { lastSeq: 310, lastDeliveredSeq: 310 } }
  openWindow(GROUP, PEER)
  let calls = 0
  setWindowBatchHandler(async () => { calls += 1; return { status: 'failed' } })
  queueWindowMessage(GROUP, msg(PEER, 3101, 311, '总失败'))
  const first = await flushPendingNow({}, GROUP)
  ok(first.status === 'failed', '第一次真投（失败）')
  const callsAfterFirst = calls
  const second = await flushPendingNow({}, GROUP)
  ok(calls === callsAfterFirst, `退避期内【没有】再投一次（实际多投了 ${calls - callsAfterFirst} 次）`)
  ok(second.status === 'skipped', `退避期内返回 skipped（实际 ${second.status}）`)
  ok(wm(GROUP).length === 1, '失败的消息仍在队列里等重试')
  closeWindow(GROUP, 'retry-test-done')
}

console.log('审核发现 #3：stop() 要清掉 handler：')
{
  const { startWindowLoop: swl, flushPendingNow, setWindowBatchHandler } = await import('../lib/window.js')
  const { getState: gs } = await import('../lib/state.js')
  gs().windows = {}
  gs().groups = { [GROUP]: { lastSeq: 320, lastDeliveredSeq: 320 } }
  openWindow(GROUP, PEER)
  let oldCalled = 0
  const stop = swl({}, async () => { oldCalled += 1; return { status: 'delivered' } })
  stop()
  queueWindowMessage(GROUP, msg(PEER, 3201, 321, '卸载后不该被旧 handler 投'))
  const r = await flushPendingNow({}, GROUP)
  ok(oldCalled === 0, `stop() 之后旧 handler【没有】被调用（实际调了 ${oldCalled} 次）`)
  ok(r.status === 'skipped', `没有 handler 时返回 skipped（实际 ${r.status}）`)
  ok(windowMessages(GROUP).length === 1, '消息留着等新 handler')
  closeWindow(GROUP, 'stop-test-done')
}

console.log('审核发现 #4：身份口径（seq:null 不能撞成 seq:0）：')
{
  const { messageIdentities } = await import('../lib/window.js')
  const { getState: gs } = await import('../lib/state.js')
  gs().windows = {}
  gs().groups = { [GROUP]: { lastSeq: 330, lastDeliveredSeq: 330 } }
  openWindow(GROUP, PEER)
  // message_seq: null 的两条不同消息，不能撞同一个身份
  const a = { message_id: '', message_seq: null, sender: { user_id: PEER }, message: [{ type: 'text', data: { text: 'A' } }] }
  const b = { message_id: '', message_seq: null, sender: { user_id: PEER }, message: [{ type: 'text', data: { text: 'B' } }] }
  ok(!messageIdentities(a).includes('seq:0'), 'seq:null 不产出 seq:0')
  const qa = queueWindowMessage(GROUP, a)
  const qb = queueWindowMessage(GROUP, b)
  ok(qa === true && qb === true, '两条无 id 无 seq 的消息都能入队（不会把第二条当重复丢掉）')
  ok(windowMessages(GROUP).length === 2, `两条都在队列里（实际 ${windowMessages(GROUP).length}）`)
  // 同一条消息的两种形状要能互相识别
  const wsShape = { message_id: '', message_seq: 331, sender: { user_id: PEER }, message: [] }
  const httpShape = { message_id: '-123456', message_seq: 331, sender: { user_id: PEER }, message: [] }
  const ids = messageIdentities(wsShape)
  const ids2 = messageIdentities(httpShape)
  ok(ids.includes('seq:331') && ids2.includes('seq:331'), '两种形状都带 seq:331（跨通路能对上）')
  ok(ids2.includes('id:-123456'), 'HTTP 形状额外带 id')
  closeWindow(GROUP, 'identity-test-done')
}

console.log('审核发现 #8b：关窗后盘上的 pending 不能复活：')
{
  const { getState: gs, saveState } = await import('../lib/state.js')
  const { resetRecoveredWindows } = await import('../lib/window.js')
  gs().windows = {}
  gs().groups = { [GROUP]: { lastSeq: 340, lastDeliveredSeq: 340 } }
  openWindow(GROUP, PEER)
  queueWindowMessage(GROUP, msg(PEER, 3401, 341, '关窗前的旧话'))
  ok(gs().windows[GROUP]?.pending?.length === 1, '准备：pending 已落盘')
  closeWindow(GROUP, 'persist-test-done')
  ok(gs().windows[GROUP]?.pending === undefined, '关窗后盘上的 pending 被删掉')
  ok(gs().windows[GROUP]?.pendingSince === undefined, '关窗后盘上的 pendingSince 被删掉')
  saveState({ windows: gs().windows })
  resetRecoveredWindows()
  ok(windowMessages(GROUP).length === 0, '重启恢复不会把上个窗口丢弃的旧话捞回来')
}

console.log('审核发现 #8a：lastDeliveredSeq 不能回拨：')
{
  const { getState: gs } = await import('../lib/state.js')
  gs().windows = {}
  gs().groups = { [GROUP]: { lastSeq: 400, lastDeliveredSeq: 400 } }
  openWindow(GROUP, PEER)
  // 模拟：先投一条 seq 大的 @（基准推到 402），再投一批 seq 小的旧批次（403 之前）
  await deliverWindowBatch(ctx, GROUP, [msg(PEER, 4001, 402, '先到的大 seq')])
  const afterBig = gs().groups[GROUP].lastDeliveredSeq
  await deliverWindowBatch(ctx, GROUP, [msg(PEER, 4002, 401, '后投的小 seq')])
  const afterSmall = gs().groups[GROUP].lastDeliveredSeq
  ok(afterSmall >= afterBig, `基准只前进不回拨（${afterBig} → ${afterSmall}）`)
  closeWindow(GROUP, 'seq-test-done')
}

console.log('审核发现 #7：跨度不能低报：')
{
  const { pendingAgeMs, setWindowBatchHandler } = await import('../lib/window.js')
  const { getState: gs } = await import('../lib/state.js')
  gs().windows = {}
  gs().groups = { [GROUP]: { lastSeq: 500, lastDeliveredSeq: 500 } }
  openWindow(GROUP, PEER)
  // 老消息先入队，等一会儿，再来一条新的
  queueWindowMessage(GROUP, msg(PEER, 5001, 501, '等了很久的老消息'))
  await new Promise((resolve) => setTimeout(resolve, 120))
  queueWindowMessage(GROUP, msg(PEER, 5002, 502, '刚到的新消息'))
  ok(pendingAgeMs(GROUP) >= 100, `跨度按最早那条算（实际 ${pendingAgeMs(GROUP)}ms）`)
  // 只投掉老的那条，剩下的新消息跨度应该≈0，不能变成「也很久」
  setWindowBatchHandler(async () => ({ status: 'delivered' }))
  const { flushPendingNow } = await import('../lib/window.js')
  await flushPendingNow({}, GROUP) // 投掉两条
  ok(windowMessages(GROUP).length === 0, '全部投完')
  ok(pendingAgeMs(GROUP) === 0, '队列空了跨度归 0')
  closeWindow(GROUP, 'age-test-done')
}

// 窗口关掉时不该再投（关窗后 pending 清空、批次不再属于任何窗口）
console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
