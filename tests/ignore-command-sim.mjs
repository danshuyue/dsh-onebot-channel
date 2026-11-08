/**
 * ignore-command-sim.mjs —— 忽略指令（0.20.1）。
 * node tests/run-isolated.mjs tests/ignore-command-sim.mjs
 *
 * ## 用户需求原文（2026-11-08）
 * 「由于 snowluma 有关键词 #sl 用于查看状态。添加忽略指令配置，默认 #sl，
 *   就是发送的是 #sl 就不处理。可配置。」
 *
 * ## 为什么这个功能会以三种方式写错
 *   1. **做成前缀匹配** → `#sl 你好` 被吞，那是人话。仓库红线「绝不吞用户的话」。
 *   2. **只拦一条、不拦整批** → 私聊批次是「多条合并成一次投递」，
 *      挖掉一条会让她看到半句话（「你：A」然后没有 B，而 B 是给 SnowLuma 的命令）。
 *   3. **拦了但不推进游标** → 轮询每 2 秒把同一条 `#sl` 重投一遍，
 *      日志刷屏，而且「忽略」根本没生效。
 *
 * 所以这个测试盯的正是这三点 + 两条入站通路（轮询 / WS）都要覆盖到。
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const SANDBOX_HOME = join(tmpdir(), `qq-bridge-ignore-${process.pid}`)
const SANDBOX_DATA = join(SANDBOX_HOME, '.dsh')
mkdirSync(SANDBOX_DATA, { recursive: true })
process.env.USERPROFILE = SANDBOX_HOME
process.env.HOME = SANDBOX_HOME
process.on('exit', () => {
  try { rmSync(SANDBOX_HOME, { recursive: true, force: true }) } catch { /* 清不掉不算失败 */ }
})

const SELF = 3566906627
const PEER = 1321833118
const GROUP = '975663147'

writeFileSync(join(SANDBOX_DATA, 'qq-bridge.config.json'), JSON.stringify({
  enabled: true,
  selfUin: SELF,
  peerUin: PEER,
  ownerUin: PEER,
  onebotHttp: 'http://127.0.0.1:3000/',
  token: 'test-token',
  replyQuietMs: 0,
  mergeWindowMs: 0,
  splitReply: false,
  autoForwardPrivate: false,
  autoForwardGroup: false,
  backfillOnStart: false,
  memoryEnabled: false,
  proactiveEnabled: false,
  wsEnabled: true,          // WS 路径要测
  windowEnabled: false,
  ignoreCommands: ['#sl'],
  routes: {
    private: { [String(PEER)]: { sessionId: 'session-ignore' } },
    group: { [GROUP]: { sessionId: 'session-ignore' } }
  },
  groupUins: [GROUP]
}, null, 2), 'utf8')
writeFileSync(join(SANDBOX_DATA, 'qq-bridge-state.json'), JSON.stringify({
  lastId: 0, lastSeq: 0, lastTime: 0, privates: {}, groups: {}
}, null, 2), 'utf8')

// 假协议端：send_* 记下来，其余回空
const sent = []
globalThis.fetch = async (_url, options) => {
  const payload = JSON.parse(options.body)
  if (String(payload.action ?? '').startsWith('send_')) sent.push(payload)
  return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { messages: [], message_id: 1 } }) }
}

const { isIgnoredMessage, hasIgnoredMessage } = await import(pathToFileURL(join(PLUGIN, 'lib', 'commands.js')).href)
const { loadConfig, getConfig } = await import(pathToFileURL(join(PLUGIN, 'lib', 'config.js')).href)
const poll = await import(pathToFileURL(join(PLUGIN, 'lib', 'poll.js')).href)

loadConfig()

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.error(`  ✗ ${name}`) }
}

// ---- 造一条协议端形状的消息 ----
let seq = 500
function msg(text, from = PEER) {
  seq += 1
  return {
    message_id: seq,
    message_seq: seq,
    time: Math.floor(Date.now() / 1000),
    user_id: from,
    group_id: Number(GROUP),
    sender: { nickname: '对方', card: '' },
    message: [{ type: 'text', data: { text } }]
  }
}

// ---- 假宿主：只为让 deliver 走得下去 ----
const delivered = []
function fakeCtx(agentStatus) {
  return {
    get(name) {
      if (name === 'agents') {
        return {
          get: () => ({
            status: agentStatus,
            session: { snapshotEvents: () => [], seq: 0 },
            followup: async (message) => { delivered.push(message); return { ok: true } },
            steer: async (message) => { delivered.push(message); return { ok: true } }
          })
        }
      }
      if (name === 'llm') return undefined
      return undefined
    }
  }
}

function reset() {
  delivered.length = 0
  sent.length = 0
}

console.log('1. 纯函数 isIgnoredMessage：整条相等才算')
{
  ok(isIgnoredMessage('#sl', ['#sl']) === true, '完全相等 → 命中')
  ok(isIgnoredMessage('  #sl  ', ['#sl']) === true, '前后空格算是同一条（trim 后相等）')
  ok(isIgnoredMessage('#sl 你好', ['#sl']) === false, '⚠️「#sl 你好」不命中 —— 那是人话，不能吞')
  ok(isIgnoredMessage('你好 #sl', ['#sl']) === false, '⚠️ 出现在句尾也不命中（不是前缀匹配）')
  ok(isIgnoredMessage('#SL', ['#sl']) === false, '大小写不同不命中（严格相等，不做模糊匹配）')
  ok(isIgnoredMessage('', ['#sl']) === false, '空消息不算命中')
  ok(isIgnoredMessage('#sl', []) === false, '空表 = 关闭功能，什么都不忽略')
  ok(isIgnoredMessage('#sl', undefined) === false, '配置缺失（undefined）不炸，按关闭处理')
  ok(isIgnoredMessage('#sl', ['', '#sl']) === true, '表里有空元素也能正常命中（空串不参与匹配）')
  ok(isIgnoredMessage('随便什么', ['', '']) === false, '⚠️ 表里全是空串 ≠ 忽略所有消息')
  ok(isIgnoredMessage('/status', ['#sl', '/status']) === true, '多条目表里任意一条都能命中')
}

console.log('\n2. 纯函数 hasIgnoredMessage：一批里任意一条命中就算整批')
{
  const textOf = (segments) => (Array.isArray(segments) ? segments.map((s) => String(s?.data?.text ?? '')).join('') : String(segments ?? ''))
  ok(hasIgnoredMessage([msg('你好'), msg('#sl')], textOf, ['#sl']) === true, '批里有 #sl → 整批算命中')
  ok(hasIgnoredMessage([msg('你好'), msg('再见')], textOf, ['#sl']) === false, '批里没有 → 不命中')
  ok(hasIgnoredMessage([], textOf, ['#sl']) === false, '空批 → 不命中')
  ok(hasIgnoredMessage([msg('#sl 你好')], textOf, ['#sl']) === false, '带正文的不算命中（整批照常投）')
}

console.log('\n3. 私聊轮询通路：命中 → 不投递，但游标要推进')
{
  reset()
  const ctx = fakeCtx('idle')
  const result = await poll.handlePrivateMessages(ctx, String(PEER), [msg('#sl')])
  ok(result === 'ignored', `返回值是 'ignored'（实际 ${JSON.stringify(result)}）`)
  ok(delivered.length === 0, `一条都没投给她（实际 ${delivered.length} 条）`)

  // 游标推进：否则轮询会反复重投同一条
  const { getState } = await import(pathToFileURL(join(PLUGIN, 'lib', 'state.js')).href)
  const st = getState()
  const bucket = st.privates[String(PEER)] ?? {}
  ok(Number(bucket.lastTime) > 0, `游标推进了（lastTime=${bucket.lastTime}）—— 否则每 2 秒重投一次`)
}

console.log('\n4. 私聊：普通消息照常投（别为了忽略把正常消息也吞了）')
{
  reset()
  const ctx = fakeCtx('idle')
  const result = await poll.handlePrivateMessages(ctx, String(PEER), [msg('你好呀')])
  ok(result !== 'ignored' && result !== '', `正常消息照常投递（返回值 ${JSON.stringify(result)}）`)
  ok(delivered.length === 1, `真的投出去了（实际 ${delivered.length}）`)
}

console.log('\n5. 私聊：一批里混了 #sl → 整批都不投（不挖半句话出来）')
{
  reset()
  const ctx = fakeCtx('idle')
  const result = await poll.handlePrivateMessages(ctx, String(PEER), [msg('先说一句'), msg('#sl')])
  ok(result === 'ignored', `整批被忽略（实际 ${JSON.stringify(result)}）`)
  ok(delivered.length === 0, `「先说一句」也没投 —— 否则她看到的是半句话（实际投了 ${delivered.length}）`)
}

console.log('\n6. 群聊通路：@ 她 + #sl 也不处理')
{
  reset()
  const ctx = fakeCtx('idle')
  const m = msg('#sl', PEER)
  // 群里 @ 她的段：at + text。textOf 会把 @ 渲染掉，所以正文仍是 #sl
  m.message = [{ type: 'at', data: { qq: String(SELF) } }, { type: 'text', data: { text: ' #sl' } }]
  const result = await poll.handleGroupMessage(ctx, GROUP, m, [])
  ok(result?.status === 'skipped', `群里的 #sl 被跳过（实际 ${JSON.stringify(result)}）`)
  ok(delivered.length === 0, `没投给她（实际 ${delivered.length}）`)
}

console.log('\n7. WS 通路：私聊事件命中忽略 → 不进会话')
{
  reset()
  const ctx = fakeCtx('idle')
  await poll.handleWsEvent(ctx, {
    post_type: 'message',
    message_type: 'private',
    user_id: PEER,
    self_id: SELF,
    message_id: 9001,
    time: Math.floor(Date.now() / 1000),
    message: [{ type: 'text', data: { text: '#sl' } }],
    sender: { nickname: '对方' }
  })
  ok(delivered.length === 0, `WS 私聊的 #sl 没投进会话（实际 ${delivered.length}）`)
}

console.log('\n8. 配置可改：把表换成别的词就按新词忽略（不是写死 #sl）')
{
  const cfg = getConfig()
  const saved = cfg.ignoreCommands
  cfg.ignoreCommands = ['/status']
  reset()
  const ctx = fakeCtx('idle')
  const r1 = await poll.handlePrivateMessages(ctx, String(PEER), [msg('/status')])
  ok(r1 === 'ignored', '/status 在新配置下被忽略')
  const r2 = await poll.handlePrivateMessages(ctx, String(PEER), [msg('#sl')])
  ok(r2 !== 'ignored', '#sl 在新配置下**不再**被忽略（证明没写死）')
  cfg.ignoreCommands = saved
}

console.log('\n9. 默认值就是 #sl')
{
  const { DEFAULTS } = await import(pathToFileURL(join(PLUGIN, 'lib', 'config.js')).href)
  ok(Array.isArray(DEFAULTS.ignoreCommands) && DEFAULTS.ignoreCommands.includes('#sl'),
    `DEFAULTS.ignoreCommands 含 #sl（实际 ${JSON.stringify(DEFAULTS.ignoreCommands)}）`)
}

console.log('\n10. 配置可写：applyTunables 收得住、也洗得干净')
{
  const api = await import(pathToFileURL(join(PLUGIN, 'lib', 'api.js')).href)
  const cfg = getConfig()
  const saved = cfg.ignoreCommands

  api.applyTunables({ ignoreCommands: ['#sl', ' #status ', '#sl', ''] })
  ok(JSON.stringify(cfg.ignoreCommands) === JSON.stringify(['#sl', '#status']),
    `trim + 去空 + 去重（实际 ${JSON.stringify(cfg.ignoreCommands)}）`)

  api.applyTunables({ ignoreCommands: [] })
  ok(Array.isArray(cfg.ignoreCommands) && cfg.ignoreCommands.length === 0,
    '⚠️ 空数组能存住（= 关闭功能），不能被兜回默认表')

  // publicConfig 必须把那两件事如实吐出来，否则设置页一打开又显示成 #sl
  const pub = api.publicConfig(cfg)
  ok(Array.isArray(pub.ignoreCommands) && pub.ignoreCommands.length === 0,
    'publicConfig 如实返回空表 —— 否则用户清空了、重进面板又变回 #sl')

  cfg.ignoreCommands = saved
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
