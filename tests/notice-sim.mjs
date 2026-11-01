/**
 * notice 事件入口测试：node tests/notice-sim.mjs，退出码 0 = 全过。
 *
 * 钉住的就是那个真实 bug（2026-11-02）：**被戳了毫无反应**。
 *
 * 根因：`handleWsEvent` 开头是
 *     if (event?.post_type !== 'message') return
 * 戳一戳是 `post_type: 'notice'`，于是所有 notice 事件在这一行被无条件丢掉。
 * 现场证据：线上 WS 收到 115 个事件、其中 29 条是消息 —— 剩下 86 个全被吞掉，
 * 日志里连一条 notice 都没有（grep notice 计数 = 0）。
 *
 * 这个测试的价值在于：它跑的是真正的 handleWsEvent，而不是只测 poke.js 的纯函数。
 * 只要有人把那句 return 挪回 notice 分流之前，这里立刻变红。
 */
import { handleWsEvent } from '../lib/poll.js'

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

const SELF = '3566906627'
const MEMBER = '1143859087'

// ---- 假宿主：只需要 agents / llm 两个服务，够 deliver 走完 ----

const delivered = []
const fakeCtx = {
  get(name) {
    if (name === 'agents') {
      return {
        get: () => ({
          session: { snapshotEvents: () => [], seq: 0 },
          followup: async (message) => {
            delivered.push(message)
            return { ok: true }
          }
        })
      }
    }
    if (name === 'llm') {
      return { createUserMessage: (blocks) => ({ role: 'user', content: blocks, id: `m${delivered.length}` }) }
    }
    return undefined
  }
}

// 配置：把群绑一个会话，否则 deliver 会直接跳过。
// ⚠️ selfUin 必须显式设 —— 真实环境里它是「靠手填」的（SnowLuma 那份配置里没有），
//   隔离 HOME 下默认是 0，而 target_id === selfUin 正是「有没有戳我」的唯一判据。
//   不设这一行，本测试会稳定地测不到东西（我第一次跑就踩了这个坑）。
const { loadConfig, getConfig } = await import('../lib/config.js')
loadConfig()
const config = getConfig()
config.selfUin = SELF
config.peerUin = MEMBER
config.groupUins = ['975663147']
config.routes = { private: {}, group: { 975663147: { sessionId: 'session-fake-group' } } }
config.pokeEnabled = true
config.pokeCooldownMs = 0
config.fallbackToLiveSession = false

const { resetPokeCooldown } = await import('../lib/poke.js')

/**
 * 从投递出来的消息里抠出纯文本。
 *
 * deliver 的产物形状会随宿主版本变（content 可能是字符串 / 块数组 / 再包一层），
 * 所以这里只认「块」：type 为 text 的对象的 text 字段，以及裸字符串。
 * 不递归所有字符串 —— role / id 这些元数据会把断言搅乱（踩过一次）。
 */
function extractText(value) {
  const out = []
  const walk = (node) => {
    if (node === null || node === undefined) return
    if (typeof node === 'string') { out.push(node); return }
    if (Array.isArray(node)) { for (const item of node) walk(item); return }
    if (typeof node !== 'object') return
    // 文本块：优先认 type === 'text'，退一步认「有 text 字段且没有 role」的对象
    if (typeof node.text === 'string' && (node.type === 'text' || node.type === undefined && node.role === undefined)) {
      out.push(node.text)
      return
    }
    // 继续往下钻 content，但**不钻** role / id / source 这些元数据
    for (const key of ['content', 'blocks', 'parts']) {
      if (node[key] !== undefined) walk(node[key])
    }
  }
  walk(value)
  return out.join('')
}

/** 真实抓到的群戳事件（戳的是我）。 */
function groupPokeAtMe() {
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: Number(SELF),
    post_type: 'notice',
    notice_type: 'notify',
    sub_type: 'poke',
    group_id: 975663147,
    user_id: Number(MEMBER),
    target_id: Number(SELF),
    action: '戳了戳',
    suffix: '',
    action_img_url: 'http://tianquan.gtimg.cn/nudgeaction/item/0/expression.jpg'
  }
}

// ---- 1. 核心回归：notice 不再被吞 ----

console.log('notice 事件分流（原 bug 的回归）：')
{
  resetPokeCooldown()
  delivered.length = 0
  await handleWsEvent(fakeCtx, groupPokeAtMe())
  eq(delivered.length, 1, '群里被戳 → 真的投递了一次（不再被 post_type 判断吞掉）')
  // 取投递正文的纯文本：deliver 会把字符串包成 content 块数组
  const body = extractText(delivered[0])
  ok(body.includes('戳'), `投递正文里说清了「戳」这件事（实际：${body.slice(0, 80)}）`)
  ok(body.includes(MEMBER), '正文里带了戳人者的 QQ 号')
  ok(body.includes('用户本人') || body.includes('群友'), '正文里带了身份标记（群友 vs 用户本人）')
  // 句子必须只有一个动词。之前是「群友 A 戳了戳 你」和私聊的「拍了拍你（戳了戳）」
  // 两种写法混着，前者主语后面多了空格、后者叠了两个动词 —— 这类文案 bug
  // 不影响功能，但会直接进模型上下文，所以钉住。
  ok(!body.includes('拍了拍你（'), '正文没有「拍了拍你（戳了戳）」这种叠词')
  ok(/戳了戳你。$/.test(body) || /戳了戳你。\s*$/.test(body), `正文以「戳了戳你。」收尾（实际结尾：${body.slice(-20)}）`)
}

// ---- 2. 不该接话的情况 ----

console.log('不该接话：')
{
  resetPokeCooldown()
  delivered.length = 0
  const ev = groupPokeAtMe()
  ev.user_id = Number(SELF)  // 自己戳的
  await handleWsEvent(fakeCtx, ev)
  eq(delivered.length, 0, '自己戳的 → 不投递')
}
{
  resetPokeCooldown()
  delivered.length = 0
  const ev = groupPokeAtMe()
  ev.target_id = 999999  // 戳的是别人
  await handleWsEvent(fakeCtx, ev)
  eq(delivered.length, 0, '群友互戳（没戳我）→ 不投递')
}
{
  resetPokeCooldown()
  delivered.length = 0
  config.pokeEnabled = false
  await handleWsEvent(fakeCtx, groupPokeAtMe())
  eq(delivered.length, 0, '开关关掉 → 不投递')
  config.pokeEnabled = true
}
{
  resetPokeCooldown()
  delivered.length = 0
  const ev = groupPokeAtMe()
  ev.group_id = 123456  // 没绑会话的群
  await handleWsEvent(fakeCtx, ev)
  eq(delivered.length, 0, '未绑会话的群 → 不投递（不乱投到别的会话）')
}

// ---- 3. 别的 notice 不受影响 ----

console.log('别的 notice 不该被误处理：')
{
  resetPokeCooldown()
  delivered.length = 0
  await handleWsEvent(fakeCtx, {
    time: Math.floor(Date.now() / 1000),
    post_type: 'notice',
    notice_type: 'group_increase',
    group_id: 975663147,
    user_id: 123456
  })
  eq(delivered.length, 0, '群成员增加（别的 notice）→ 不投递，也不崩')
}
{
  delivered.length = 0
  await handleWsEvent(fakeCtx, {
    time: Math.floor(Date.now() / 1000),
    post_type: 'meta_event',
    meta_event_type: 'heartbeat'
  })
  eq(delivered.length, 0, '心跳事件 → 忽略')
}

// ---- 4. 冷却真的会挡住第二次 ----

console.log('冷却：')
{
  resetPokeCooldown()
  delivered.length = 0
  config.pokeCooldownMs = 60000
  await handleWsEvent(fakeCtx, groupPokeAtMe())
  eq(delivered.length, 1, '第一次戳 → 回复')
  await handleWsEvent(fakeCtx, groupPokeAtMe())
  eq(delivered.length, 1, '冷却期内第二次戳 → 只记账不回复（不刷屏）')
  config.pokeCooldownMs = 0
}
resetPokeCooldown()

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed > 0 ? 1 : 0)
