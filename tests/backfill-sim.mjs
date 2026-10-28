/**
 * 上线补历史专项测试：node tests/backfill-sim.mjs，退出码 0 = 全过。
 *
 * 要防的那个坑（2026-10-28）：
 *   轮询每轮只拉 `count: 10`。DSH 关久一点，攒的消息超过 10 条 →
 *   重启后只拿到最新 10 条，游标直接推到最新，**中间的全丢**，日志一片安静。
 *
 * 所以这里模拟「离线期间攒了 55 条」：
 *   · 翻页能不能把 55 条都捞出来（不是只捞最新 10 条）
 *   · 游标之前的那 5 条会不会被误投（不能）
 *   · 超过投递上限时只投最近 N 条、并且明确告诉 agent「还有多少条没展开」
 *   · 群聊只投 @ 我的，但游标要推进到窗口最新（否则每次重启都重扫）
 *
 * 会临时改写 ~/.dsh 下的 config / state 文件，退出时恢复（同 dup-send-sim）。
 */
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}`)
  }
}
function eq(actual, expected, name) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, `${name}${same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`)
}

const DATA = join(homedir(), '.dsh')
const CONFIG = join(DATA, 'qq-bridge.config.json')
const STATE = join(DATA, 'qq-bridge-state.json')
const PEER = 1000000001
const FRIEND = 1000000004
const GROUP = 2000000001

const configBackup = readFileSync(CONFIG, 'utf8')
let stateBackup = null
try { stateBackup = readFileSync(STATE, 'utf8') } catch { stateBackup = null }
process.on('exit', () => {
  try { writeFileSync(CONFIG, configBackup, 'utf8') } catch {}
  try {
    if (stateBackup !== null) writeFileSync(STATE, stateBackup, 'utf8')
    else rmSync(STATE, { force: true })
  } catch {}
})

// 造 60 条私聊消息，time 从 1000 递增。游标定在 1005 → 应漏 1005..1059 共 55 条。
const TOTAL = 60
const BASE_TIME = 1000
const CURSOR_TIME = BASE_TIME + 5
const privateMessages = Array.from({ length: TOTAL }, (_, i) => ({
  message_id: 1000 + i, // 故意不带负号：ids 单调，方便测翻页锚点
  message_seq: 5000 + i,
  time: BASE_TIME + i,
  sender: { user_id: FRIEND, nickname: '示例好友' },
  message: [{ type: 'text', data: { text: `第 ${i} 条` } }]
}))

// 群消息：30 条，其中 3 条 @ 我（seq 10/16/22）
const groupMessages = Array.from({ length: 30 }, (_, i) => ({
  message_id: 2000 + i,
  message_seq: 100 + i,
  time: 3000 + i,
  user_id: 777,
  group_id: GROUP,
  sender: { user_id: 777, nickname: '群友甲' },
  message: i === 10 || i === 16 || i === 22
    ? [{ type: 'at', data: { qq: '1000000002' } }, { type: 'text', data: { text: ` @ 你 ${i}` } }]
    : [{ type: 'text', data: { text: `普通群聊 ${i}` } }]
}))

/** 按 message_id 锚点切一页（模拟协议端：message_id=0 取最新，否则取该 id 之前）。 */
function pageOf(list, count, beforeId) {
  const before = Number(beforeId) || 0
  const eligible = before === 0 ? list : list.filter((item) => item.message_id < before)
  return eligible.slice(-count)
}

let calls = []
globalThis.fetch = async (_url, init) => {
  const payload = JSON.parse(init.body)
  calls.push(payload)
  const p = payload.params ?? {}
  if (payload.action === 'get_friend_msg_history') {
    return { ok: true, json: async () => ({ retcode: 0, data: { messages: pageOf(privateMessages, p.count, p.message_id) } }) }
  }
  if (payload.action === 'get_group_msg_history') {
    return { ok: true, json: async () => ({ retcode: 0, data: { messages: pageOf(groupMessages, p.count, p.message_id) } }) }
  }
  return { ok: true, json: async () => ({ retcode: 0, data: [] }) }
}

// 假的宿主上下文：deliver 需要一个带 followup 的 agent
const delivered = []
const fakeAgent = {
  followup(message) {
    const blocks = Array.isArray(message?.content) ? message.content : []
    delivered.push(blocks.map((block) => (block?.type === 'text' ? String(block.text ?? '') : '[image]')).join(''))
  },
  session: { seq: 1, firstLiveSeq: 0, snapshotEvents: () => [] }
}
const ctx = {
  get: () => undefined,
  agents: { get: () => fakeAgent }
}

// 写测试配置 + 游标
const cfg = JSON.parse(configBackup)
cfg.peerUin = PEER
cfg.ownerUin = PEER
cfg.selfUin = 1000000002
cfg.autoForwardReply = false // 不测转发，免得给 outbound 加负担
cfg.backfillOnStart = true
cfg.backfillMaxPages = 5
cfg.backfillDeliver = 20
cfg.routes = {
  private: { [String(PEER)]: { sessionId: 'session-peer' }, [String(FRIEND)]: { sessionId: 'session-friend' } },
  group: { [String(GROUP)]: { sessionId: 'session-group' } }
}
cfg.groupUins = [GROUP]
cfg.groupOnlyWhenAt = true
cfg.groupContextCount = 3
writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), 'utf8')
writeFileSync(STATE, JSON.stringify({
  lastId: 0,
  privates: {
    [String(FRIEND)]: { lastTime: CURSOR_TIME, lastSeq: 5005, seenIds: [] }
  },
  groups: {
    [String(GROUP)]: { lastSeq: 100, lastDeliveredSeq: 100 }
  }
}, null, 2), 'utf8')

const { loadConfig } = await import('../lib/config.js')
const { loadState, getState } = await import('../lib/state.js')
loadConfig()
loadState()

const { runBackfill } = await import('../lib/backfill.js')

/**
 * 重置游标。
 *
 * ⚠️ 每个测试块都必须重置 —— 补历史会推进游标 + 写 seenIds，
 *   上一块跑完的副作用会让下一块「看起来没漏消息」（第一版就是这么误判的）。
 */
function resetState(patch = {}) {
  writeFileSync(STATE, JSON.stringify({
    lastId: 0,
    privates: {
      [String(FRIEND)]: { lastTime: CURSOR_TIME, lastSeq: 5005, seenIds: [] }
    },
    groups: {
      [String(GROUP)]: { lastSeq: 100, lastDeliveredSeq: 100 }
    },
    ...patch
  }, null, 2), 'utf8')
  loadState()
}

/** 投递出去、且带「还有 N 条」提示的那一条（用来区分私聊补历史和群补历史）。 */
const backfillBody = () => delivered.find((text) => text.includes('还有 35 条更早的消息没展开')) ?? ''

console.log('补历史（私聊 55 条漏消息）：')
resetState()
{
  calls = []
  delivered.length = 0
  const result = await runBackfill(ctx, { maxPages: 5, deliverMax: 20 })

  const one = result.privates.find((item) => item.uin === String(FRIEND))
  ok(one !== undefined, '私聊对象被处理了')
  eq(one?.missed, 55, '识别出 55 条漏消息（不是只拿到最新 10 条）')
  eq(one?.delivered, 20, '只投递最近 20 条')
  eq(one?.skipped, 35, '更早的 35 条只报数不展开')
  ok(one?.complete === true, '窗口翻到了游标之前（complete）')

  const pageCalls = calls.filter((item) => item.action === 'get_friend_msg_history' && item.params.user_id === FRIEND)
  ok(pageCalls.length >= 2, `确实翻了多页（实际 ${pageCalls.length} 次请求）`)
  eq(pageCalls[0].params.count, 50, '每页拉 50 条')
  ok(pageCalls[0].params.message_id === undefined || pageCalls[0].params.message_id === 0, '第一页从最新开始')

  const body = backfillBody()
  ok(body !== '', '55 条合并成一条投递（不是刷 55 条）')
  ok(body.includes('第 59 条'), '正文里包含最新的那条')
  ok(!body.includes('第 4 条（'), '游标之前的老消息没被误投')

  // 同一轮里群也被处理了：只投 @ 我的 3 条
  const group = result.groups.find((item) => item.groupId === String(GROUP))
  eq(group?.missed, 29, '同一轮里群识别出 29 条窗口内消息（seq 101..129）')
  eq(group?.atMe, 3, '群里 3 条 @ 了我')
  eq(delivered.length, 4, '总共投递 4 次（私聊 1 次合并 + 群里 3 条 @）')
}

console.log('游标推进：')
{
  const cursor = getState().privates[String(FRIEND)] ?? {}
  eq(cursor.lastTime, BASE_TIME + TOTAL - 1, '私聊游标推进到窗口最新（1059）')
  ok(Array.isArray(cursor.seenIds) && cursor.seenIds.length > 0, '补过的消息进了 seenIds，下次不会重投')
  eq(getState().groups[String(GROUP)]?.lastSeq, 129, '群游标推进到窗口最新（不推进的话每次重启都重扫）')
}

console.log('幂等（再补一次不该重复投）：')
{
  delivered.length = 0
  calls = []
  const result = await runBackfill(ctx, { maxPages: 5, deliverMax: 20 })
  const one = result.privates.find((item) => item.uin === String(FRIEND))
  eq(one?.missed, 0, '第二次补：没有新漏消息')
  eq(delivered.length, 0, '第二次补：一条都没重复投递')
}

console.log('页数上限（窗口没补完时要标 incomplete）：')
{
  // 游标退到最老，制造「漏 60 条 > 一页 50 条」，再限制只翻 1 页
  resetState({
    privates: { [String(FRIEND)]: { lastTime: BASE_TIME - 100, lastSeq: 4000, seenIds: [] } },
    groups: {}
  })
  delivered.length = 0
  const result = await runBackfill(ctx, { maxPages: 1, deliverMax: 20 })
  const one = result.privates.find((item) => item.uin === String(FRIEND))
  ok(one !== undefined, '页数受限时仍然处理了')
  eq(one?.pages, 1, '只翻了 1 页')
  ok(one?.complete === false, '标记为窗口未补完（complete=false）')
  eq(one?.missed, 50, '一页就是 50 条')
}

console.log('群聊只投 @ 我的：')
{
  // 私聊游标设到最新（不干扰），群游标退回 100
  resetState({
    privates: { [String(FRIEND)]: { lastTime: BASE_TIME + TOTAL, lastSeq: 5100, seenIds: [] } }
  })
  delivered.length = 0
  const result = await runBackfill(ctx, { maxPages: 5, deliverMax: 20 })
  const one = result.groups.find((item) => item.groupId === String(GROUP))
  eq(one?.missed, 29, '群识别出 29 条窗口内消息')
  eq(one?.atMe, 3, '其中 3 条 @ 了我')
  eq(delivered.length, 3, '只投递 @ 我的那 3 条（普通群聊不投递）')
  ok(delivered.every((text) => text.includes('@ 你')), '投出去的都是 @ 我的那几条')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
