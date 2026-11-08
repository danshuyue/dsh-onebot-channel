/**
 * wait-anchor-sim.mjs —— qq_wait 的「基线锚点」（0.20.0）。
 * node tests/run-isolated.mjs tests/wait-anchor-sim.mjs
 *
 * ## 用户实测的 bug（2026-11-08 原话）
 * 「qq_send 之后立刻就得到了其他回应不管是 @ 还是引用，在 qq_wait 之前就收到了，
 *   这会导致 qq_wait 期间认为没收到回应，从而跳过了回应。」
 *
 * ## 根因
 * 老实现把「**调用 qq_wait 那一刻**的历史」整体当成「已经知道的」，只把
 * 「等待期间新到的」当成新话。于是下面这条再普通不过的时序会翻车：
 *
 *     T1  她 qq_send 说了一句
 *     T2  对方立刻回了一句（@ 或引用）—— 这条已通过 steer 进了会话
 *     T3  她调 qq_wait 看看有没有下文
 *     T4  T3..T4 之间没人说话
 *     →   qq_wait 返回「没人接话」
 *     →   她据此判断「对方没回应」，于是跳过回应
 *
 * 那条 T2 的回复就被静默吞了。而它确实已经进了上下文 —— **两处信息互相矛盾**，
 * 她选了「没收到」那一侧。
 *
 * ## 修法（本测试要钉住的性质）
 * 基线改成「**我自己最后一条消息之后**」：锚点之后的一切都算新话，
 * 包括「调用之前就已经到了」的那些 —— 而且会标上 `beforeWait: true`。
 *
 * ## 六条断言（每条都对应一个真会写错的实现）
 *   1. 我发过话 → 之后对方回的话，即使早于调用，也必须报出来（核心）
 *   2. 那些「等之前就到」的条目要带 `beforeWait: true`（不然她当成两件事）
 *   3. 锚点**之前**的旧话不能被翻出来（否则每回合把整段历史重播一遍）
 *   4. 我还没说过话 → 退回老语义（调用那一刻的都不算新），不把历史当新话
 *   5. 连续两次 qq_wait 不能重复报同一条（锚点不变，就会重复）
 *   6. 等待期间真新到的，仍然正常报出来（别为了修 1 把 6 弄坏）
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const SANDBOX_HOME = join(tmpdir(), `qq-bridge-wait-anchor-${process.pid}`)
const SANDBOX_DATA = join(SANDBOX_HOME, '.dsh')
mkdirSync(SANDBOX_DATA, { recursive: true })
process.env.USERPROFILE = SANDBOX_HOME
process.env.HOME = SANDBOX_HOME
process.on('exit', () => {
  try { rmSync(SANDBOX_HOME, { recursive: true, force: true }) } catch { /* 清不掉不算失败 */ }
})

const SELF = 3566906627
const OTHER = 1321833118
const GROUP = '975663147'

writeFileSync(join(SANDBOX_DATA, 'qq-bridge.config.json'), JSON.stringify({
  enabled: true,
  selfUin: SELF,
  peerUin: OTHER,
  ownerUin: OTHER,
  onebotHttp: 'http://127.0.0.1:3000/',
  token: 'test-token',
  replyQuietMs: 0,
  splitReply: false,
  autoForwardPrivate: false,
  autoForwardGroup: false,
  backfillOnStart: false,
  memoryEnabled: false,
  proactiveEnabled: false,
  wsEnabled: false,
  // 等待额度给足，别让「额度」变成干扰因素
  waitMaxMs: 60000,
  waitTurnMaxMs: 600000,
  routes: { private: { [String(OTHER)]: { sessionId: 'session-wait-anchor' } }, group: {} },
  groupUins: [GROUP]
}, null, 2), 'utf8')
writeFileSync(join(SANDBOX_DATA, 'qq-bridge-state.json'), JSON.stringify({
  lastId: 0, lastSeq: 0, lastTime: 0, privates: {}, groups: {}
}, null, 2), 'utf8')

/**
 * 假历史：测试脚本直接摆一份「协议端会返回什么」。
 * ⚠️ 故意用**新→旧**的顺序（`get_*_msg_history` 的 reverse_order 默认是 true），
 *   这正是老实现「找最后一条」会踩坑的地方 —— 顺序反了，锚点会锚到最旧那条。
 */
let history = []
globalThis.fetch = async (_url, options) => {
  const payload = JSON.parse(options.body)
  if (payload.action === 'get_group_msg_history' || payload.action === 'get_friend_msg_history') {
    return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { messages: history } }) }
  }
  return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) }
}

const { registerWaitTool, clearWaitReportState } = await import(pathToFileURL(join(PLUGIN, 'lib', 'tool.js')).href)
const { clearWaitBudget } = await import(pathToFileURL(join(PLUGIN, 'lib', 'rhythm.js')).href)
const { loadConfig } = await import(pathToFileURL(join(PLUGIN, 'lib', 'config.js')).href)
loadConfig()

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.error(`  ✗ ${name}`) }
}

/** 造一条协议端形状的消息。`at` 是秒级时间戳（协议端就是这么给的）。 */
function msg({ id, from, text, at }) {
  return {
    message_id: id,
    message_seq: id,
    time: at,
    user_id: from,
    group_id: Number(GROUP),
    sender: { nickname: String(from) === String(SELF) ? '我' : '对方', card: '' },
    message: [{ type: 'text', data: { text } }]
  }
}

let seq = 100
function nextId() { seq += 1; return seq }
const NOW_SEC = Math.floor(Date.now() / 1000)

const registered = new Map()
const ctx = {
  get(name) { return name === 'tools' ? { register(tool) { registered.set(tool.name, tool); return () => {} } } : undefined },
  effect() {}
}
await registerWaitTool(ctx, new AbortController().signal)
const waitTool = registered.get('qq_wait')
if (waitTool === undefined) {
  console.error('✗ qq_wait 没注册出来')
  process.exit(1)
}

/** 每个用例前清账本，并把历史换成这个用例要的那份。 */
function scenario(messages) {
  clearWaitBudget()
  clearWaitReportState()
  history = messages
}

const GROUP_KEY = { group_id: GROUP }

console.log('1. 核心：我发完、对方秒回、然后我才 qq_wait → 那条回复必须报出来')
{
  // 时序：我说话(T-3) → 对方回(T-2) → **[调用那一刻]** → 等 0ms
  const mine = msg({ id: nextId(), from: SELF, text: '我说了一句', at: NOW_SEC - 3 })
  const reply = msg({ id: nextId(), from: OTHER, text: '我回你了', at: NOW_SEC - 2 })
  scenario([reply, mine]) // 新→旧，模拟协议端的默认顺序

  const value = await waitTool.execute({ ...GROUP_KEY, ms: 0 })
  ok(Number(value?.newCount) === 1, `报出 1 条（实际 ${value?.newCount}）`)
  ok(String(value?.newMessages?.[0]?.text ?? '') === '我回你了', `报的是那条回复（实际「${value?.newMessages?.[0]?.text}」）`)
  ok(value?.newMessages?.[0]?.beforeWait === true, '带 beforeWait 标记（它是调用之前就到了的）')
  const rendered = String(waitTool.output?.render?.({}, value)?.[0]?.text ?? '')
  ok(rendered.includes('等之前就到了'), `render 里把它标出来了（实际：${rendered.split('\n')[1] ?? ''}）`)
}

console.log('\n2. 锚点之前的旧话不能被翻出来')
{
  // ⚠️ 这一组的构造必须让「锚点取最旧那条自己消息」**必然变红**，
  //    所以要有**两条我自己发的**：一条旧、一条新。
  //    取最新锚点 → 中间那条对方的话（在旧锚点之后、新锚点之前）不该报；
  //    取最旧锚点 → 它会落进「锚点之后」→ 被误报 → 这条断言变红。
  const oldMine = msg({ id: nextId(), from: SELF, text: '很久以前我说的', at: NOW_SEC - 200 })
  const oldReply = msg({ id: nextId(), from: OTHER, text: '很久以前的回复', at: NOW_SEC - 150 })
  const newMine = msg({ id: nextId(), from: SELF, text: '刚说的', at: NOW_SEC - 40 })
  scenario([newMine, oldReply, oldMine])
  const value = await waitTool.execute({ ...GROUP_KEY, ms: 0 })
  const texts = (value?.newMessages ?? []).map((m) => m.text)
  ok(Number(value?.newCount) === 0, `锚点之前的话不算新（实际 ${value?.newCount} 条：${JSON.stringify(texts)}）`)
}

console.log('\n3. 我还没说过话 → 退回老语义，不把历史当新话')
{
  const a = msg({ id: nextId(), from: OTHER, text: '你先在吗', at: NOW_SEC - 10 })
  const b = msg({ id: nextId(), from: OTHER, text: '在吗', at: NOW_SEC - 5 })
  scenario([b, a])
  const value = await waitTool.execute({ ...GROUP_KEY, ms: 0 })
  ok(Number(value?.newCount) === 0, `没开口过 → 已有的都不算新（实际 ${value?.newCount}）`)
}

console.log('\n4. 连续两次 qq_wait 不重复报同一条')
{
  const mine = msg({ id: nextId(), from: SELF, text: '我说', at: NOW_SEC - 3 })
  const reply = msg({ id: nextId(), from: OTHER, text: '只回一次', at: NOW_SEC - 2 })
  scenario([reply, mine])

  const first = await waitTool.execute({ ...GROUP_KEY, ms: 0 })
  ok(Number(first?.newCount) === 1, `第一次报出 1 条（实际 ${first?.newCount}）`)
  const second = await waitTool.execute({ ...GROUP_KEY, ms: 0 })
  ok(Number(second?.newCount) === 0, `第二次不再重复报（实际 ${second?.newCount}）—— 否则她以为对方说了两遍`)
}

console.log('\n5. 等待期间真新到的，仍然正常报出来')
{
  const mine = msg({ id: nextId(), from: SELF, text: '我说', at: NOW_SEC - 3 })
  scenario([mine])
  // 等到一半时「对方」发来一条
  setTimeout(() => {
    history = [msg({ id: nextId(), from: OTHER, text: '等的时候来的', at: NOW_SEC - 1 }), mine]
  }, 120)
  const value = await waitTool.execute({ ...GROUP_KEY, ms: 600 })
  ok(Number(value?.newCount) === 1, `等待期间新到的报出来了（实际 ${value?.newCount}）`)
  ok(String(value?.newMessages?.[0]?.text ?? '') === '等的时候来的', '内容对得上')
  ok(Number(value?.waitedMs) >= 400, `真的等了（实际 ${value?.waitedMs}ms）`)
}

console.log('\n6. 我自己发的消息永远不算「新话」')
{
  // ⚠️ 先说清一件事（变异验证抓出来的）：在「锚点 = 我最后一条消息」这个语义下，
  //    「跳过自己发的消息」那条过滤**在正常路径上不可达** —— 锚点之后按定义不可能
  //    再有我的消息。所以这一组**测不到那条过滤**（删掉它这组照样绿，实测确认过）。
  //    它保留在实现里是防御性的；这里能测到的是「我的消息不会出现在结果里」这个**行为**，
  //    而它由锚点本身保证 —— 那也是有价值的（改坏锚点就会红）。
  const mine1 = msg({ id: nextId(), from: SELF, text: '第一句我说的', at: NOW_SEC - 50 })
  const theirs = msg({ id: nextId(), from: OTHER, text: '对方插了一句', at: NOW_SEC - 30 })
  const mine2 = msg({ id: nextId(), from: SELF, text: '第二句我说的', at: NOW_SEC - 20 })
  scenario([mine2, theirs, mine1])
  const value = await waitTool.execute({ ...GROUP_KEY, ms: 0 })
  const texts = (value?.newMessages ?? []).map((m) => m.text)
  ok(Number(value?.newCount) === 0,
    `我自己发的不算新话（实际 ${value?.newCount} 条：${JSON.stringify(texts)}）`)
  ok(!texts.includes('第一句我说的') && !texts.includes('第二句我说的'),
    `两条「我说的」都不在结果里（实际 ${JSON.stringify(texts)}）`)
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
