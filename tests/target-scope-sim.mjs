/**
 * 「这一回合投给谁」必须按会话分开记（0.19.6）。
 *
 * 用户报的缺陷：**内容全发到群里**。
 *
 * 根因不在发送那一步，而在「兜底目标」：`lib/rhythm.js` 的最近投递原先是一个
 * 模块级单例 `let lastDelivery = null` —— 全进程只记最后一个。
 * 同一台机器上群里消息比私聊多得多（用户日志实测：群投递 59 次 vs 私聊 1 次），
 * 于是「最后一次投递」几乎永远是某个群。私聊回合里模型调不带参数的
 * qq_close / qq_pass / qq_skip 时，`targetOf()` 就拿到那个群 ——
 * 抑制记到群头上、节奏账本按群算 key，跟当前对话完全对不上。
 *
 * 这个测试钉住四件事：
 *   1. 两个会话各记各的投递，互不可见
 *   2. 工具不带参数时，用的是**本会话**的投递
 *   3. 取不到 sessionId 时**绝不**兜到群（退回 config.peerUin 私聊）
 *   4. clearDelivery 的粒度（单个会话 / 全部）
 *
 * ⚠️ 这里断言的是**行为**（哪个 key 被记进了抑制表 / skip 表），
 *    不是「源码里有没有那个字符串」—— 后者抓不住「改了但没生效」。
 *
 * 隔离：整个测试跑在临时 HOME 里，不碰真的 ~/.dsh。
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { useIsolatedHome } from './isolated-home.mjs'

const HOME_DIR = useIsolatedHome('target-scope-')

const PEER = '3472302240'
const SELF = '3655191092'
const GROUP = '975663147'

writeFileSync(join(HOME_DIR, '.dsh', 'qq-bridge.config.json'), JSON.stringify({
  enabled: true,
  selfUin: SELF,
  peerUin: PEER,
  ownerUin: PEER,
  onebotHttp: 'http://127.0.0.1:3000/',
  token: 'test-token',
  mergeWindowMs: 0,
  replyQuietMs: 0,
  splitReply: false,
  autoForwardReply: false,
  backfillOnStart: false,
  memoryEnabled: false,
  proactiveEnabled: false,
  allowSendToAny: true,
  windowEnabled: false,
  routes: { private: {}, group: {} }
}, null, 2), 'utf8')
writeFileSync(join(HOME_DIR, '.dsh', 'qq-bridge-state.json'), JSON.stringify({
  lastId: 0, lastSeq: 0, lastTime: 0, privates: {}, groups: {}
}, null, 2), 'utf8')

// 这个测试不该发任何网络请求；真发了说明工具路径跑偏了，直接炸出来。
globalThis.fetch = async () => {
  throw new Error('target-scope-sim 不该发网络请求')
}

const { loadConfig, getConfig } = await import('../lib/config.js')
const { loadState } = await import('../lib/state.js')
const {
  rememberDelivery, recentDelivery, clearDelivery,
  skipTurnRequested, suppressedKeys, clearTurnHandled
} = await import('../lib/rhythm.js')
const { registerSkipTool, registerPassTool } = await import('../lib/tool.js')

loadConfig()
loadState()
Object.assign(getConfig(), { allowSendToAny: true, peerUin: PEER, ownerUin: PEER })

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

const regs = new Map()
const toolCtx = {
  get: (name) => (name === 'tools'
    ? { register: (t) => { regs.set(t.name, t); return () => {} } }
    : undefined),
  effect: () => {}
}
await registerSkipTool(toolCtx)
await registerPassTool(toolCtx)
const skip = regs.get('qq_skip')
const pass = regs.get('qq_pass')

/** 造一个「在某个会话里调工具」的 exec。 */
const execOf = (sessionId) => ({ agent: { session: { header: { id: sessionId } } } })

const SESSION_A = 'session-target-scope-a'
const SESSION_B = 'session-target-scope-b'
const GROUP_TARGET = { kind: 'group', id: GROUP }
const PEER_TARGET = { kind: 'private', id: PEER }

/** 每次用例前把账本清干净，免得互相污染。 */
function resetLedger() {
  clearDelivery()
  clearTurnHandled(`group:${GROUP}`)
  clearTurnHandled(`private:${PEER}`)
}

// ---------------------------------------------------------------------------
// 1. 各会话各记各的（纯模块层）
// ---------------------------------------------------------------------------
console.log('投递记忆 · 按会话分开：')
{
  resetLedger()
  rememberDelivery(GROUP_TARGET, Date.now(), SESSION_A)
  rememberDelivery(PEER_TARGET, Date.now(), SESSION_B)

  eq(recentDelivery(SESSION_A), GROUP_TARGET, 'A 会话记得自己投给的是群')
  eq(recentDelivery(SESSION_B), PEER_TARGET, 'B 会话记得自己投给的是私聊')
  eq(recentDelivery('session-never-used'), null, '没用过的会话查不到投递（不会串到别人的）')

  // 关键回归：A 投群**不能**污染 B
  eq(recentDelivery(SESSION_B), PEER_TARGET, 'A 投群不影响 B 的私聊兜底')

  // 同一个会话再投一次，覆盖的是自己那一条
  rememberDelivery(GROUP_TARGET, Date.now(), SESSION_A)
  eq(recentDelivery(SESSION_B), PEER_TARGET, 'A 重复投递仍不影响 B')
}

// ---------------------------------------------------------------------------
// 2. 工具不带参数时，用本会话的投递
// ---------------------------------------------------------------------------
console.log('qq_skip / qq_pass · 不带参数时按会话兜底：')
{
  resetLedger()
  rememberDelivery(GROUP_TARGET, Date.now(), SESSION_A)
  rememberDelivery(PEER_TARGET, Date.now(), SESSION_B)

  // A 会话（投给群）里 qq_skip → 应该记在群头上
  await skip.execute({}, execOf(SESSION_A))
  ok(skipTurnRequested(`group:${GROUP}`), 'A 会话 qq_skip 记到了 group（它这一回合确实在群里）')

  // B 会话（投给私聊）里 qq_skip → 必须记在私聊头上，**不能**是群
  await skip.execute({}, execOf(SESSION_B))
  ok(skipTurnRequested(`private:${PEER}`), 'B 会话 qq_skip 记到了 private（不是群）')

  // qq_pass 走抑制表，同理
  resetLedger()
  rememberDelivery(GROUP_TARGET, Date.now(), SESSION_A)
  rememberDelivery(PEER_TARGET, Date.now(), SESSION_B)
  await pass.execute({}, execOf(SESSION_B))
  const keys = suppressedKeys()
  ok(keys.includes(`private:${PEER}`), 'B 会话 qq_pass 抑制的是 private')
  ok(!keys.includes(`group:${GROUP}`), 'B 会话 qq_pass 没有抑制群（这就是原来那个 bug）')
}

// ---------------------------------------------------------------------------
// 3. 取不到 sessionId 时绝不兜到群
// ---------------------------------------------------------------------------
console.log('取不到会话 · 绝不兜到群：')
{
  resetLedger()
  rememberDelivery(GROUP_TARGET, Date.now(), SESSION_A)

  // 没传 exec（宿主没给会话）→ targetOf 拿不到 sessionId
  await skip.execute({})
  ok(skipTurnRequested(`private:${PEER}`), '没有会话时兜到 config.peerUin（私聊）')
  ok(!skipTurnRequested(`group:${GROUP}`), '没有会话时**不**兜到群')

  // 形状怪异的 exec 也一样（取不到就当没有，别猜）
  resetLedger()
  await skip.execute({}, { agent: null })
  ok(skipTurnRequested(`private:${PEER}`), 'exec.agent 是 null 时也兜到私聊')
  resetLedger()
  await skip.execute({}, { agent: { session: null } })
  ok(skipTurnRequested(`private:${PEER}`), 'session 是 null 时也兜到私聊')
}

// ---------------------------------------------------------------------------
// 4. 显式给号优先于一切
// ---------------------------------------------------------------------------
console.log('显式给号 · 优先于兜底：')
{
  resetLedger()
  rememberDelivery(PEER_TARGET, Date.now(), SESSION_A)

  // 会话 A 的兜底是私聊，但显式要求跳过某个群 → 必须按群的
  await skip.execute({ group_id: GROUP }, execOf(SESSION_A))
  ok(skipTurnRequested(`group:${GROUP}`), '显式 group_id 压过会话兜底')
  ok(!skipTurnRequested(`private:${PEER}`), '显式 group_id 时没有顺手记私聊')

  resetLedger()
  await skip.execute({ user_id: PEER }, execOf(SESSION_A))
  ok(skipTurnRequested(`private:${PEER}`), '显式 user_id 走私聊')
}

// ---------------------------------------------------------------------------
// 5. clearDelivery 的粒度
// ---------------------------------------------------------------------------
console.log('clearDelivery · 粒度：')
{
  resetLedger()
  rememberDelivery(GROUP_TARGET, Date.now(), SESSION_A)
  rememberDelivery(PEER_TARGET, Date.now(), SESSION_B)

  clearDelivery(SESSION_A)
  eq(recentDelivery(SESSION_A), null, '清 A 之后 A 查不到')
  eq(recentDelivery(SESSION_B), PEER_TARGET, '清 A 不影响 B')

  clearDelivery()
  eq(recentDelivery(SESSION_B), null, 'clearDelivery() 全清')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed > 0 ? 1 : 0)
