/**
 * notice-route-sim.mjs —— 「系统消息发到哪」三选一（0.20.0）的行为看守。
 * node tests/run-isolated.mjs tests/notice-route-sim.mjs
 *
 * ## 用户需求原文（2026-11-08）
 * 「添加配置，系统消息回传，当前系统消息在默认的对话群聊中回传，包括错误提醒或者
 *   处理消息提醒，添加配置功能，系统消息原路回传（当前行为）、全回传私聊
 *   （来自群聊的系统消息也回传私聊但是要打上【XX群聊】这样的前缀）、不回传，
 *   即没有系统消息，三选一的配置，默认是原路回传。」
 *
 * ## 这个测试盯什么（每条都对应一个真会写错的地方）
 *   1. **默认是原路** —— DEFAULTS 必须是 'same'，否则升级后所有通知突然改道
 *   2. **same 档**：群里的故障发回群、私聊的发回私聊（与 0.19.x 逐字一致）
 *   3. **private 档**：群里的故障改投私聊，且**带【群聊 …】前缀**
 *   4. **private 档的前缀用群名**（关系卡里本来就有），不是光秃秃一个群号
 *   5. **private 档没配私聊号 → 退回原路**，不许把通知丢掉
 *   6. **off 档**：一条都不发（这是「不回传」的全部含义）
 *   7. **迁移**：老的 `notifyTurnFailures: false` 必须变成 `notifyTarget: 'off'`
 *      —— 不迁的话用户明明关过，升级后又开始收到系统消息
 *   8. **迁移不覆盖用户显式选的档**（自己选过的算数）
 *
 * 隔离：整个测试跑在临时 HOME 里，协议端用假 fetch 顶替，一个请求都不会真发出去。
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const SANDBOX_HOME = join(tmpdir(), `qq-bridge-notice-route-${process.pid}`)
const SANDBOX_DATA = join(SANDBOX_HOME, '.dsh')

// ⚠️ 必须在 import 插件模块之前改：env.js 的 DATA_DIR 是加载时求值的
mkdirSync(SANDBOX_DATA, { recursive: true })
process.env.USERPROFILE = SANDBOX_HOME
process.env.HOME = SANDBOX_HOME
process.on('exit', () => {
  try { rmSync(SANDBOX_HOME, { recursive: true, force: true }) } catch { /* 清不掉不算失败 */ }
})

const PEER = 1321833118
const SELF = 3566906627
const GROUP = '975663147'
const GROUP_NAME = '测试群'

writeFileSync(join(SANDBOX_DATA, 'qq-bridge.config.json'), JSON.stringify({
  enabled: true,
  selfUin: SELF,
  peerUin: PEER,
  ownerUin: PEER,
  onebotHttp: 'http://127.0.0.1:3000/',
  token: 'test-token',
  mergeWindowMs: 0,
  replyQuietMs: 0,
  splitReply: false,
  autoForwardPrivate: true,
  autoForwardGroup: true,
  backfillOnStart: false,
  memoryEnabled: false,
  wsEnabled: false,
  proactiveEnabled: false,
  outboundEntryTtlMs: 200,
  notifyTarget: 'same',
  groupUins: [GROUP],
  routes: { private: { [String(PEER)]: { sessionId: 'session-route-test' } }, group: { [GROUP]: { sessionId: 'session-route-test' } } }
}, null, 2), 'utf8')

writeFileSync(join(SANDBOX_DATA, 'qq-bridge-state.json'), JSON.stringify({
  lastId: 0, lastSeq: 1, lastTime: 1, privates: {}, groups: {}
}, null, 2), 'utf8')

// 关系卡里放群名：「private 档要带【群聊 名字】」这条就靠它验
writeFileSync(join(SANDBOX_DATA, 'qq-bridge-memory.json'), JSON.stringify({
  [`group:${GROUP}`]: { nick: GROUP_NAME, count: 3, lastSeen: Date.now() }
}, null, 2), 'utf8')

// ---- 假协议端 ----
const sent = []
globalThis.fetch = async (_url, options) => {
  const payload = JSON.parse(options.body)
  if (payload.action === 'send_private_msg' || payload.action === 'send_group_msg') sent.push(payload)
  return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) }
}

const configModule = await import(pathToFileURL(join(PLUGIN, 'lib', 'config.js')).href)
const notice = await import(pathToFileURL(join(PLUGIN, 'lib', 'notice.js')).href)
const memory = await import(pathToFileURL(join(PLUGIN, 'lib', 'memory.js')).href)

configModule.loadConfig()
const { getConfig, DEFAULTS, migrateNotifyTarget, normalizeNotifyTarget } = configModule

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.error(`  ✗ ${name}`) }
}
function eq(actual, expected, name) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, `${name}${same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`)
}

/** 每个用例前把态清干净：冷却账本 + 已发记录 + 把档位设成要测的那个。 */
function reset(mode) {
  notice.clearNoticeState()
  sent.length = 0
  getConfig().notifyTarget = mode
  getConfig().notifyTurnFailures = true
}

const GROUP_TARGET = { kind: 'group', id: GROUP }
const PRIVATE_TARGET = { kind: 'private', id: String(PEER) }

console.log('0. 默认值与归一化：')
{
  eq(DEFAULTS.notifyTarget, 'same', 'DEFAULTS.notifyTarget 是 same（升级不会把通知偷偷改道）')
  eq(normalizeNotifyTarget(undefined), 'same', '没配 → same')
  eq(normalizeNotifyTarget('PRIVATE'), 'same', '大写/不认识的值 → same（往旧行为那边倒）')
  eq(normalizeNotifyTarget('private'), 'private', '合法值原样保留')
  eq(normalizeNotifyTarget('off'), 'off', 'off 保留')
}

console.log('\n1. same（原路，默认）：')
{
  reset('same')
  await notice.notifyTurn(GROUP_TARGET, 'error', 'test')
  ok(sent.length === 1, `群里的故障发了一条（实际 ${sent.length}）`)
  ok(sent[0]?.action === 'send_group_msg', `走的是群出口（实际 ${sent[0]?.action ?? '无'}）`)
  ok(String(sent[0]?.params?.group_id) === GROUP, `发回这个群（实际 ${sent[0]?.params?.group_id}）`)
  ok(!JSON.stringify(sent[0]?.params?.message ?? '').includes('【'), '原路不加群名前缀（群里看得到群名，加了是噪音）')

  reset('same')
  await notice.notifyTurn(PRIVATE_TARGET, 'error', 'test')
  ok(sent.length === 1 && sent[0]?.action === 'send_private_msg', '私聊的故障发回私聊')
}

console.log('\n2. private（全回传私聊）：')
{
  reset('private')
  await notice.notifyTurn(GROUP_TARGET, 'error', 'test')
  ok(sent.length === 1, `群里的故障也发出去了（实际 ${sent.length}）`)
  ok(sent[0]?.action === 'send_private_msg', `改走私聊出口（实际 ${sent[0]?.action ?? '无'}）`)
  ok(Number(sent[0]?.params?.user_id) === PEER, `发给了用户本人 ${PEER}（实际 ${sent[0]?.params?.user_id}）`)
  const body = JSON.stringify(sent[0]?.params?.message ?? '')
  ok(body.includes('【'), `带【】前缀（实际 ${body}）`)
  ok(body.includes(GROUP_NAME), `前缀里是群名「${GROUP_NAME}」而不是光秃秃的群号（实际 ${body}）`)
  ok(body.includes('[系统]'), '仍然是 [系统] 前缀的通知，不是她的话')

  // 私聊来源在 private 档下不该被加群名前缀
  reset('private')
  await notice.notifyTurn(PRIVATE_TARGET, 'error', 'test')
  const privateBody = JSON.stringify(sent[0]?.params?.message ?? '')
  ok(!privateBody.includes('【'), '私聊来源不加群名前缀（它本来就不属于任何群）')
}

console.log('\n3. private 档没配私聊号 → 退回原路（不许丢通知）：')
{
  reset('private')
  const savedOwner = getConfig().ownerUin
  const savedPeer = getConfig().peerUin
  getConfig().ownerUin = 0
  getConfig().peerUin = 0
  await notice.notifyTurn(GROUP_TARGET, 'error', 'test')
  ok(sent.length === 1, `通知没被丢掉（实际 ${sent.length}）`)
  ok(sent[0]?.action === 'send_group_msg', `退回原路：仍然发到群（实际 ${sent[0]?.action ?? '无'}）`)
  getConfig().ownerUin = savedOwner
  getConfig().peerUin = savedPeer
}

console.log('\n4. off（不回传）：')
{
  reset('off')
  await notice.notifyTurn(GROUP_TARGET, 'error', 'test')
  await notice.notifyTurn(PRIVATE_TARGET, 'stalled', 'test')
  eq(sent.length, 0, 'off 档一条都不发')
}

console.log('\n5. 存量布尔仍然有效（防有人手改配置写回来）：')
{
  reset('same')
  getConfig().notifyTurnFailures = false
  await notice.notifyTurn(GROUP_TARGET, 'error', 'test')
  eq(sent.length, 0, 'notifyTurnFailures=false 仍然能让通知闭嘴')
  getConfig().notifyTurnFailures = true
}

console.log('\n6. 迁移：notifyTurnFailures:false → notifyTarget:off')
{
  const cfg = { ...DEFAULTS, notifyTarget: 'same', notifyTurnFailures: true }
  eq(migrateNotifyTarget(cfg, { notifyTurnFailures: false }), true, '迁移发生了')
  eq(cfg.notifyTarget, 'off', '迁成了 off')

  const cfg2 = { ...DEFAULTS, notifyTarget: 'same', notifyTurnFailures: true }
  eq(migrateNotifyTarget(cfg2, { notifyTurnFailures: true }), false, 'true 不触发迁移（本来就在发）')
  eq(cfg2.notifyTarget, 'same', '档位不动')

  const cfg3 = { ...DEFAULTS, notifyTarget: 'private', notifyTurnFailures: false }
  eq(migrateNotifyTarget(cfg3, { notifyTurnFailures: false, notifyTarget: 'private' }), false,
    '用户显式选过的档不被旧布尔覆盖')
  eq(cfg3.notifyTarget, 'private', '私聊档保住了')

  eq(migrateNotifyTarget({ ...DEFAULTS }, null), false, '没有配置文件时不迁（全新安装）')
}

console.log('\n7. 群名读得到关系卡（前缀不能只会显示群号）：')
{
  const card = memory.loadMemory(`group:${GROUP}`)
  eq(String(card?.nick ?? ''), GROUP_NAME, '关系卡里确实存着群名（private 档的前缀靠它）')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
