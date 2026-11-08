/**
 * 回合中断通知测试：node tests/turn-notice-sim.mjs，退出码 0 = 全过。
 *
 * 钉住这条用户要求（2026-11-03）：
 *   「模型出现报错等中断就不会发送任何消息，这会导致 QQ 侧用户迟迟收不到相应。
 *     插件侧检测异常中断，然后用工具将中断信息 send 出去，
 *     沿着绑定该会话的 qq 私聊或者群。如果该会话绑定了多个私聊或者群，
 *     就发给最近的一个。也就是当前正在互动的这个渠道。」
 *
 * 六个必须成立的点（每条都对应一个真实会出错的写法）：
 *   1. reason.kind === 'error' 且正文为空 → **真的**发出了一条带 [系统] 的通知
 *   2. 通知发到**这次投递的那个 target**，不是 peerUin / 不是别的群
 *   3. reason.kind === 'aborted'（用户自己点停止）→ **一个字都不发**
 *   4. reason.kind === 'completed' / 'max-tokens' → 不发通知（这不是故障）
 *   5. TTL 到点但 agent 还在跑 → 发「还在处理」且**保留条目**继续等，不丢回复
 *   6. TTL 到点且 agent 不跑了 → 发「没能发出来」并丢弃条目
 *
 * 隔离：整个测试跑在临时 HOME 里（DATA_DIR = <tmp>/.dsh），不碰真的 ~/.dsh，
 * 协议端用假 fetch 顶替 —— 一个请求都不会真的发出去。
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const SANDBOX_HOME = join(tmpdir(), `qq-bridge-notice-${process.pid}`)
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
const OTHER = 3472302240
const GROUP = '975663147'
const STRANGER = '5810550'
const SESSION = 'session-turn-notice-test'

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
  // 群必须在白名单里（groupUins ∪ routes.group），否则通知会被 allowlist 拦在 callOneBot，
  // 用例 2b 就测不到「发到群」这件事了。STRANGER 故意不放进来。
  groupUins: [GROUP],
  routes: { private: { [String(PEER)]: { sessionId: SESSION } }, group: { [GROUP]: { sessionId: SESSION } } }
}, null, 2), 'utf8')

writeFileSync(join(SANDBOX_DATA, 'qq-bridge-state.json'), JSON.stringify({
  lastId: 0, lastSeq: 1, lastTime: 1, privates: {}, groups: {}
}, null, 2), 'utf8')

// ---- 假协议端：记下每一个 send_*，别的 action 一律回空 ----
const sent = []
globalThis.fetch = async (_url, options) => {
  const payload = JSON.parse(options.body)
  if (payload.action === 'send_private_msg' || payload.action === 'send_group_msg') {
    sent.push(payload)
  }
  return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) }
}

const outbound = await import(pathToFileURL(join(PLUGIN, 'lib', 'outbound.js')).href)
const notice = await import(pathToFileURL(join(PLUGIN, 'lib', 'notice.js')).href)
const rhythm = await import(pathToFileURL(join(PLUGIN, 'lib', 'rhythm.js')).href)

// ⚠️ 必须显式 loadConfig()：config.js 的模块级 config 初值只有 DEFAULTS，
// 真正的 ~/.dsh/qq-bridge.config.json 是**由 index.js 的 apply() 去读**的。
// 这里直接驱动 flushOutbound，没人替我们读 —— 不调这一句，
// outboundEntryTtlMs 就还是默认的 300000，TTL 用例永远走不到。
const { loadConfig, getConfig } = await import(pathToFileURL(join(PLUGIN, 'lib', 'config.js')).href)
loadConfig()
if (Number(getConfig().outboundEntryTtlMs) !== 200) {
  console.error(`✗ 沙箱配置没生效（outboundEntryTtlMs=${getConfig().outboundEntryTtlMs}），TTL 用例无意义`)
  process.exit(1)
}

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.error(`  ✗ ${name}`) }
}

/** 造一个会话事件流：一条 user/message、一条 assistant/message、一个指定 reason 的 turn/end。 */
function turnWith({ reason, text = '' }) {
  const events = [
    { type: 'user/message', seq: 2, data: { message: { role: 'user', content: [] } } },
    { type: 'turn/end', seq: 3, data: { reason } }
  ]
  if (text !== '') {
    events.splice(1, 0, {
      type: 'assistant/message', seq: 2.5, data: { message: { role: 'assistant', content: [{ type: 'text', text }] } }
    })
  }
  return events
}

function makeAgent({ events, status = 'idle' }) {
  return {
    status,
    // followup / steer 什么都不做：这个测试只要 flushOutbound 的判定
    followup() {},
    steer() {},
    session: {
      seq: events.length === 0 ? 0 : Math.max(...events.map((e) => Number(e.seq) || 0)),
      snapshotEvents: () => events
    }
  }
}

/** 重置：队列、notice 冷却、抑制表全清，保证用例之间互不影响。 */
function reset() {
  outbound.clearOutbound()
  notice.clearNoticeState()
  sent.length = 0
}

const TARGET = { kind: 'private', id: String(PEER) }

// ================= 1 & 2：error → 必须发，且发对目标 =================
{
  reset()
  const agent = makeAgent({ events: turnWith({ reason: { kind: 'error', error: { message: 'API 报错', code: 'UNKNOWN' } } }) })
  outbound.enqueueOutbound(SESSION, agent, 1, TARGET, {})
  await outbound.flushOutbound()

  ok(sent.length === 1, `error 回合发出了通知（实际 ${sent.length} 条）`)
  const payload = sent[0] ?? {}
  ok(payload.action === 'send_private_msg', `走的是私聊出口（实际 ${payload.action ?? '无'}）`)
  ok(Number(payload.params?.user_id) === PEER, `发给了这次投递的 ${PEER}（实际 ${payload.params?.user_id}）`)
  const body = JSON.stringify(payload.params?.message ?? '')
  ok(body.includes('[系统]'), '通知带 [系统] 前缀（不冒充她说话）')
  ok(body.includes('没能发出来'), '通知说明了「回复没能发出来」')
  ok(!body.includes('API 报错'), '不把底层错误原文发给对面')
}

// ================= 2b：多绑定会话时，发到当前互动的那个渠道 =================
{
  reset()
  const agent = makeAgent({ events: turnWith({ reason: { kind: 'error', error: { message: 'boom' } } }) })
  // 同一个会话同时被一个群用着 —— 必须发给**这个群**，不是 peerUin
  outbound.enqueueOutbound(SESSION, agent, 1, { kind: 'group', id: GROUP }, {})
  await outbound.flushOutbound()

  ok(sent.length === 1, '群渠道也发得出通知')
  ok(sent[0]?.action === 'send_group_msg', `走的是群出口（实际 ${sent[0]?.action ?? '无'}）`)
  ok(String(sent[0]?.params?.group_id) === GROUP, `发给了这个群 ${GROUP}（实际 ${sent[0]?.params?.group_id}）`)
}

// ================= 2c：通知也走白名单硬闸 =================
{
  reset()
  const agent = makeAgent({ events: turnWith({ reason: { kind: 'error', error: { message: 'boom' } } }) })
  // STRANGER 既不在 groupUins 也不在 routes.group → allowlist 必须拦住
  outbound.enqueueOutbound(SESSION, agent, 1, { kind: 'group', id: STRANGER }, {})
  let threw = ''
  try {
    await outbound.flushOutbound()
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  ok(sent.length === 0, `白名单外的目标不会收到通知（实际发了 ${sent.length} 条）`)
  ok(threw === '', '被拦住时 flushOutbound 不抛错')
}

// ================= 3：用户自己点停止 → 一个字都不发 =================
{
  reset()
  const agent = makeAgent({ events: turnWith({ reason: { kind: 'aborted', reason: { kind: 'user' } } }) })
  outbound.enqueueOutbound(SESSION, agent, 1, TARGET, {})
  await outbound.flushOutbound()

  ok(sent.length === 0, `用户主动停止不发通知（实际发了 ${sent.length} 条）`)
  // 条目必须照常消化掉，否则下一次回复会被它堵住
  ok((outbound.outbound.get(SESSION) ?? []).length === 0, 'aborted 的条目已出队，没堵住后续转发')
}

// ================= 3b：DSH 卸载 / 钩子取消 也不发 =================
{
  reset()
  for (const reason of [{ kind: 'aborted', reason: { kind: 'disposed' } }, { kind: 'aborted', reason: { kind: 'hook', reason: 'x' } }]) {
    const agent = makeAgent({ events: turnWith({ reason }) })
    outbound.enqueueOutbound(SESSION, agent, 1, TARGET, {})
    await outbound.flushOutbound()
  }
  ok(sent.length === 0, `disposed / hook 取消不发通知（实际发了 ${sent.length} 条）`)
}

// ================= 4：正常结束 → 不发通知，但正文照发 =================
{
  reset()
  const SAYS = '好啦，弄完了'
  const agent = makeAgent({ events: turnWith({ reason: { kind: 'completed' }, text: SAYS }) })
  outbound.enqueueOutbound(SESSION, agent, 1, TARGET, {})
  await outbound.flushOutbound()

  ok(sent.length === 1, `completed 只发正文、不发通知（实际 ${sent.length} 条）`)
  const body = JSON.stringify(sent[0]?.params?.message ?? '')
  ok(body.includes(SAYS), '正文照常转发')
  ok(!body.includes('[系统]'), 'completed 不带 [系统] 字样')
}

// ================= 4b：max-tokens（截断也是正常收尾）不发通知 =================
{
  reset()
  const agent = makeAgent({ events: turnWith({ reason: { kind: 'max-tokens' }, text: '说到一半' }) })
  outbound.enqueueOutbound(SESSION, agent, 1, TARGET, {})
  await outbound.flushOutbound()
  ok(!JSON.stringify(sent).includes('[系统]'), 'max-tokens 不发通知（截断不是故障）')
}

// ================= 4c：interrupted（崩溃后补的合成收尾）要发 =================
{
  reset()
  const agent = makeAgent({ events: turnWith({ reason: { kind: 'interrupted' } }) })
  outbound.enqueueOutbound(SESSION, agent, 1, TARGET, {})
  await outbound.flushOutbound()
  ok(sent.length === 1 && JSON.stringify(sent[0]).includes('中断'), 'interrupted 回合发出「被中断」通知')
}

// ================= 5：TTL 到点但 agent 还在跑 → 保留条目 + 说一声 =================
{
  reset()
  const agent = makeAgent({ events: [], status: 'running' })
  const entry = { agent, cursor: 1, target: TARGET, userSeq: null, createdAt: Date.now() - 10_000 }
  outbound.outbound.set(SESSION, [entry])
  await outbound.flushOutbound()

  ok(sent.length === 1, `长任务到点会先说明情况（实际 ${sent.length} 条）`)
  ok(JSON.stringify(sent[0] ?? {}).includes('还在处理'), '说的是「还在处理」，不是「出错了」')
  ok((outbound.outbound.get(SESSION) ?? []).length === 1, '条目被保留，回复没丢')
  ok(Number(entry.ttlKeeps) === 1, `保留计数记上了（实际 ${entry.ttlKeeps}）`)
}

// ================= 5b：保留次数超上限 → 按丢失处理并丢弃 =================
{
  reset()
  const agent = makeAgent({ events: [], status: 'running' })
  const entry = { agent, cursor: 1, target: TARGET, userSeq: null, createdAt: Date.now() - 10_000, ttlKeeps: 2 }
  outbound.outbound.set(SESSION, [entry])
  await outbound.flushOutbound()

  ok(sent.length === 1, '超过保留上限仍会通知一次')
  ok(JSON.stringify(sent[0] ?? {}).includes('中断'), '超过上限改说「中断」')
  ok((outbound.outbound.get(SESSION) ?? []).length === 0, '超过上限必须丢弃，不能永久堵住队列')
}

// ================= 6：TTL 到点且 agent 不跑了 → 通知 + 丢弃 =================
{
  reset()
  const agent = makeAgent({ events: [], status: 'idle' })
  outbound.outbound.set(SESSION, [{
    agent, cursor: 1, target: TARGET, userSeq: null, createdAt: Date.now() - 10_000
  }])
  await outbound.flushOutbound()

  ok(sent.length === 1, `丢掉的回合也通知了（实际 ${sent.length} 条）`)
  ok(JSON.stringify(sent[0] ?? {}).includes('中断'), '说的是「中断了，没能发出来」')
  ok((outbound.outbound.get(SESSION) ?? []).length === 0, '条目已丢弃')
}

// ================= 7：冷却 —— 连续故障不刷屏 =================
{
  reset()
  for (let i = 0; i < 3; i += 1) {
    const agent = makeAgent({ events: turnWith({ reason: { kind: 'error', error: { message: `e${i}` } } }) })
    outbound.enqueueOutbound(SESSION, agent, 1, TARGET, {})
    await outbound.flushOutbound()
  }
  ok(sent.length === 1, `冷却期内只发一条（实际 ${sent.length} 条）`)
}

// ================= 7b：冷却是**按目标**算的，不是全局的 =================
// 一个群出故障不能把另一个聊天的通知也一起静音 —— 那是两个互不相关的人。
{
  reset()
  const groupTarget = { kind: 'group', id: GROUP }
  const firstAgent = makeAgent({ events: turnWith({ reason: { kind: 'error', error: { message: 'a' } } }) })
  outbound.enqueueOutbound(SESSION, firstAgent, 1, groupTarget, {})
  await outbound.flushOutbound()

  const secondAgent = makeAgent({ events: turnWith({ reason: { kind: 'error', error: { message: 'b' } } }) })
  outbound.enqueueOutbound(SESSION, secondAgent, 1, TARGET, {})
  await outbound.flushOutbound()

  ok(sent.length === 2, `群和私聊各收到一条（实际 ${sent.length} 条）`)
  ok(sent.some((item) => item.action === 'send_group_msg'), '群那条发到了群')
  ok(sent.some((item) => item.action === 'send_private_msg'), '私聊那条发到了私聊')
}

// ================= 8：同一条目同一类型只播报一次 =================
// ⚠️ 必须把「时间冷却」这个因素**排除掉**，否则这条断言是假绿的
//   （维护索引 §4 坑 27）：两次调用间隔不到 60 秒，光靠冷却就已经只发一条了，
//   把条目级去重整个删掉这条照样过。所以中途 clearNoticeState() 清冷却账本，
//   只留「这条条目有没有播过」这一个条件在挡。
{
  reset()
  const entry = { agent: makeAgent({ events: [], status: 'running' }), cursor: 1, target: TARGET, userSeq: null, createdAt: Date.now() - 10_000 }
  const first = await notice.notifyEntryOnce(entry, 'stalled', 'a')
  const afterFirst = sent.length
  notice.clearNoticeState() // 冷却清空 —— 现在唯一还能挡住第二次的只有 entry.noticeSent
  const second = await notice.notifyEntryOnce(entry, 'stalled', 'b')
  ok(first === true && afterFirst === 1, `第一次播报发出去了（${first}，${afterFirst} 条）`)
  ok(second === false && sent.length === 1, `冷却已清空，仍是同条目只播一次（${second}，共 ${sent.length} 条）`)
}

// ================= 9：发送失败不能把 flush 带崩、也不能吃错回复 =================
{
  reset()
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    throw new Error('协议端挂了')
  }
  const agent = makeAgent({ events: turnWith({ reason: { kind: 'error', error: { message: 'x' } } }) })
  outbound.enqueueOutbound(SESSION, agent, 1, TARGET, {})
  let threw = ''
  try {
    await outbound.flushOutbound()
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  globalThis.fetch = originalFetch
  ok(threw === '', `通知发不出去时 flushOutbound 不抛错（实际：${threw || '无'}）`)
  ok(calls >= 1, '确实尝试过发送')
  ok((outbound.outbound.get(SESSION) ?? []).length === 0, '失败的条目照样出队，不堵后续')
}

// ================= 10：qq_skip / qq_pass 的回合作不该被当成故障 =================
{
  reset()
  const agent = makeAgent({ events: turnWith({ reason: { kind: 'completed' } }) })
  rhythm.suppress(`private:${PEER}`, 'qq_pass: 测试')
  outbound.enqueueOutbound(SESSION, agent, 1, TARGET, {})
  await outbound.flushOutbound()
  ok(sent.length === 0, 'qq_pass 的回合仍然是「有意为之的沉默」，不发通知')
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exit(1)
console.log('turn-notice-sim: all assertions passed')
process.exit(0)
