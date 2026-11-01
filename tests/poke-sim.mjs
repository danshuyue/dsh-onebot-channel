/**
 * 戳一戳测试：node tests/poke-sim.mjs，退出码 0 = 全过。
 *
 * 覆盖 2026-11-02 修的那个 bug：**被戳了毫无反应**。
 *
 * 根因（真机抓到的证据）：戳一戳是 `post_type: 'notice'` 事件，
 * 而 handleWsEvent 开头就是 `if (event?.post_type !== 'message') return` ——
 * 所有 notice 事件被无条件丢掉。日志里 WS 收到 115 个事件、其中只有 29 条消息，
 * 剩下 86 个 notice 全被这一行吞掉。
 *
 * 这里同时钉住两种事件形状（用真实抓包字段，不是文档抄来的）：
 *   群戳  —— user_id 就是戳人者
 *   私聊戳 —— user_id 是**会话对端**，戳人者在 sender_id 里
 * 照抄 NapCat 文档直接读 user_id 会把「谁戳的」认错，所以这两个用例必须都在。
 */
import { isPokeEvent, parsePoke, shouldReact, sendPoke, pokeCooldownRemaining, markPokeReacted, claimPokeCooldown, releasePokeCooldown, resetPokeCooldown } from '../lib/poke.js'

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
async function throws(fn, name) {
  try {
    await fn()
    ok(false, `${name}（但没有抛错）`)
  } catch {
    ok(true, name)
  }
}

const SELF = '3566906627'
const OWNER = '1321833118'
const MEMBER = '1143859087'

/** 真实抓到的群戳事件（一字不改，含 action/suffix/action_img_url）。 */
const GROUP_POKE = {
  time: 1793558642,
  self_id: 3566906627,
  post_type: 'notice',
  notice_type: 'notify',
  sub_type: 'poke',
  group_id: 975663147,
  user_id: 3566906627,
  target_id: 1321833118,
  action: '戳了戳',
  suffix: '',
  action_img_url: 'http://tianquan.gtimg.cn/nudgeaction/item/0/expression.jpg'
}

/** 真实抓到的私聊戳事件 —— 注意没有 group_id，且有 sender_id。 */
const PRIVATE_POKE = {
  time: 1793558645,
  self_id: 3566906627,
  post_type: 'notice',
  notice_type: 'notify',
  sub_type: 'poke',
  user_id: 1321833118,
  sender_id: 3566906627,
  target_id: 1321833118,
  action: '戳了戳',
  suffix: '',
  action_img_url: 'http://tianquan.gtimg.cn/nudgeaction/item/0/expression.jpg'
}

// ---- 1. 事件识别 ----

console.log('isPokeEvent：')
{
  ok(isPokeEvent(GROUP_POKE), '群戳事件被认出来')
  ok(isPokeEvent(PRIVATE_POKE), '私聊戳事件被认出来')
  ok(!isPokeEvent({ post_type: 'message', sub_type: 'poke' }), '普通消息不算戳（post_type 不对）')
  ok(!isPokeEvent({ post_type: 'notice', notice_type: 'notify', sub_type: 'input_status' }), '别的 notify 子类型不算戳')
  ok(!isPokeEvent(null), 'null 不崩')
  ok(!isPokeEvent({}), '空对象不崩')
}

// ---- 2. 事件解析：两种形状的 user_id 语义不同 ----

console.log('parsePoke：')
{
  const p = parsePoke(GROUP_POKE, SELF)
  eq(p.groupId, '975663147', '群戳带 groupId')
  eq(p.peerUin, '', '群戳没有 peerUin')
  eq(p.fromUin, SELF, '群戳：user_id 就是戳人者')
  eq(p.toUin, OWNER, '群戳：target_id 是被戳者')
  eq(p.targetsSelf, false, '群戳别人 → 不是戳我')
  eq(p.selfPoke, true, '自己发起的戳 → selfPoke')
  eq(p.action, '戳了戳', 'action 带出来了')
}
{
  // 私聊：别人戳我。这需要构造一条 user_id=对端、sender_id=对方、target_id=我
  const ev = { ...PRIVATE_POKE, user_id: MEMBER, sender_id: MEMBER, target_id: 3566906627 }
  const p = parsePoke(ev, SELF)
  eq(p.groupId, '', '私聊戳没有 groupId')
  eq(p.peerUin, MEMBER, '私聊戳的 peerUin 是会话对端')
  eq(p.fromUin, MEMBER, '私聊戳的戳人者取 sender_id')
  eq(p.targetsSelf, true, 'target_id === self → 戳的是我')
  eq(p.selfPoke, false, '别人戳的，不是自己')
}
{
  // ⚠️ 关键回归：私聊戳里 user_id 不是戳人者（是会话对端）。
  // 这条用例锁住「照抄 NapCat 文档读 user_id」的错误写法。
  const ev = { ...PRIVATE_POKE, user_id: MEMBER, sender_id: OWNER, target_id: '3566906627' }
  const p = parsePoke(ev, SELF)
  eq(p.fromUin, OWNER, '私聊戳：戳人者取 sender_id，不是 user_id')
  ok(p.fromUin !== p.peerUin, 'sender_id 与 user_id 不同时，fromUin 不应该等于 peerUin')
}
{
  // sender_id 缺失时退回 user_id（老协议端可能没有这个字段）
  const ev = { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: MEMBER, target_id: SELF }
  const p = parsePoke(ev, SELF)
  eq(p.fromUin, MEMBER, 'sender_id 缺失时退回 user_id')
}
{
  // 群里戳我
  const ev = { ...GROUP_POKE, user_id: MEMBER, target_id: 3566906627 }
  const p = parsePoke(ev, SELF)
  eq(p.targetsSelf, true, '群里被戳 → targetsSelf')
  eq(p.fromUin, MEMBER, '群戳的戳人者')
}
{
  eq(parsePoke({ post_type: 'message' }, SELF), null, '不是戳事件返回 null')
}

// ---- 2b. self_id 优先于 config.selfUin（审核发现的静默失效） ----

console.log('认「我是谁」：')
{
  // ⭐ 这条是这轮审核最重要的回归：config.selfUin 默认 0，String(0) = '0'，
  //    以前拿它跟 target_id 比永远不成立 → 所有戳被静默判成 not-for-me。
  //    事件自带 self_id，必须优先用它。
  const ev = { ...GROUP_POKE, user_id: MEMBER, target_id: 3566906627 }
  const p = parsePoke(ev, 0)
  eq(p.selfKnown, true, 'config.selfUin=0 时，靠事件 self_id 仍能认出本号')
  eq(p.targetsSelf, true, 'config.selfUin=0 时，仍能判定「戳的是我」')
}
{
  // 两处都没有：要明确报 self-unknown，而不是静默 not-for-me
  const ev = { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: MEMBER, target_id: 3566906627 }
  const p = parsePoke(ev, 0)
  eq(p.selfKnown, false, '事件没 self_id、配置也是 0 → selfKnown=false')
  eq(shouldReact(p, { pokeEnabled: true }).reason, 'self-unknown', '原因要报 self-unknown（可操作），不是 not-for-me')
}
{
  // 配置里的 selfUin 与事件的 self_id 冲突时，以事件为准（配置可能过期）
  const ev = { ...GROUP_POKE, self_id: 3566906627, user_id: MEMBER, target_id: 3566906627 }
  const p = parsePoke(ev, 999999999)
  eq(p.targetsSelf, true, 'self_id 与 config 冲突时以事件为准')
}

// ---- 3. 该不该接话 ----

console.log('shouldReact：')
{
  const me = parsePoke({ ...GROUP_POKE, user_id: MEMBER, target_id: 3566906627 }, SELF)
  eq(shouldReact(me, { pokeEnabled: true }).react, true, '别人戳我 + 开关开 → 接话')
  eq(shouldReact(me, { pokeEnabled: false }).reason, 'off', '开关关了 → 不接')
  eq(shouldReact(me, {}).react, true, '配置缺字段时默认接（默认值是 true）')
}
{
  const other = parsePoke({ ...GROUP_POKE, user_id: MEMBER, target_id: OWNER }, SELF)
  eq(shouldReact(other, { pokeEnabled: true }).reason, 'not-for-me', '群友互戳 → 不接话')
}
{
  const mine = parsePoke({ ...GROUP_POKE, user_id: SELF, target_id: OWNER }, SELF)
  eq(shouldReact(mine, { pokeEnabled: true }).reason, 'self-poke', '自己戳的 → 不接话（防自问自答）')
}
{
  eq(shouldReact(null, { pokeEnabled: true }).react, false, 'null 不接')
}

// ---- 4. 冷却 ----

console.log('冷却：')
{
  resetPokeCooldown()
  const poke = parsePoke({ ...GROUP_POKE, user_id: MEMBER, target_id: 3566906627 }, SELF)
  eq(pokeCooldownRemaining(poke, { pokeCooldownMs: 10000 }), 0, '没戳过 → 没有冷却')
  markPokeReacted(poke)
  ok(pokeCooldownRemaining(poke, { pokeCooldownMs: 10000 }) > 0, '刚回过 → 冷却中')
  eq(pokeCooldownRemaining(poke, { pokeCooldownMs: 0 }), 0, '冷却设 0 → 不限')
}
{
  // 冷却按群算：同一个群里换个人戳，仍然在冷却内（避免一群人群殴她）
  resetPokeCooldown()
  const a = parsePoke({ ...GROUP_POKE, user_id: MEMBER, target_id: 3566906627 }, SELF)
  const b = parsePoke({ ...GROUP_POKE, user_id: OWNER, target_id: 3566906627 }, SELF)
  markPokeReacted(a)
  ok(pokeCooldownRemaining(b, { pokeCooldownMs: 10000 }) > 0, '同一个群里换个人戳 → 同一份冷却')
}
{
  // 私聊按人算：戳 A 冷却了，不影响戳 B
  resetPokeCooldown()
  const toA = parsePoke({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: MEMBER, sender_id: MEMBER, target_id: SELF }, SELF)
  const toB = parsePoke({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: OWNER, sender_id: OWNER, target_id: SELF }, SELF)
  markPokeReacted(toA)
  ok(pokeCooldownRemaining(toA, { pokeCooldownMs: 10000 }) > 0, '私聊戳 A → A 冷却')
  eq(pokeCooldownRemaining(toB, { pokeCooldownMs: 10000 }), 0, '私聊戳 B 不受 A 影响')
}
{
  // ⭐ 并发竞态：handleWsEvent 是 fire-and-forget 调起的，两条戳会同时跑到冷却检查。
  //    「查 → 投递 → 再记时间」的顺序下，两边都会看到没冷却 → 双投递。
  //    改成「先占位」之后，第二次必须立刻看到冷却。
  resetPokeCooldown()
  const poke = parsePoke({ ...GROUP_POKE, user_id: MEMBER, target_id: 3566906627 }, SELF)
  const cfg = { pokeCooldownMs: 10000 }
  eq(pokeCooldownRemaining(poke, cfg), 0, '并发前：没有冷却')
  claimPokeCooldown(poke)   // 第一个事件占位
  ok(pokeCooldownRemaining(poke, cfg) > 0, '第二个并发事件立刻看到冷却（先占位才挡得住）')
  // 投递失败要能撤回，否则这一戳会把后续正常戳一起吞掉
  releasePokeCooldown(poke)
  eq(pokeCooldownRemaining(poke, cfg), 0, '投递失败撤掉占位 → 冷却归零，可以重试')
}
resetPokeCooldown()

// ---- 5. 出站 ----

console.log('sendPoke：')
{
  const calls = []
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body)
    calls.push(payload)
    return { ok: true, json: async () => ({ retcode: 0, data: null }) }
  }
  const { loadConfig } = await import('../lib/config.js')
  loadConfig()
  const r = await sendPoke({ userUin: OWNER, groupId: '975663147', selfUin: SELF })
  eq(calls[0].action, 'group_poke', '带 group_id → group_poke')
  eq(calls[0].params.group_id, 975663147, 'group_id 是数字')
  eq(calls[0].params.user_id, Number(OWNER), 'user_id 是数字')
  eq(r.groupId, '975663147', '返回 groupId')
}
{
  const calls = []
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body))
    return { ok: true, json: async () => ({ retcode: 0, data: null }) }
  }
  await sendPoke({ userUin: OWNER, groupId: '', selfUin: SELF })
  eq(calls[0].action, 'friend_poke', '不带 group_id → friend_poke')
}
{
  await throws(async () => sendPoke({ userUin: '', groupId: '1', selfUin: SELF }), '没给 user_id → 报错')
  await throws(async () => sendPoke({ userUin: 'abc', groupId: '', selfUin: SELF }), 'user_id 不是数字 → 报错')
  await throws(async () => sendPoke({ userUin: '0', groupId: '', selfUin: SELF }), 'user_id = 0 → 报错')
  await throws(async () => sendPoke({ userUin: SELF, groupId: '', selfUin: SELF }), '戳自己 → 报错')
}
{
  // 协议端拒绝时要把原因带回来，不能静默当成功
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ retcode: 100, wording: '频率限制' }) })
  await throws(async () => sendPoke({ userUin: OWNER, groupId: '', selfUin: SELF }), 'retcode 非 0 → 抛错')
}

// ---- 6. 白名单：群戳不许戳群里的任何人 ----

console.log('白名单（拍一拍的目标必须是服务对象）：')
{
  // ⚠️ 这一段是这轮审核的关键回归。之前 poke-sim 只 loadConfig()，
  //    隔离 HOME 下白名单**是空的** → assertSendAllowed 走「完全没配置时放行」
  //    那条边界 → 任何目标都放行 → 「白名单断言」其实什么都没测。
  //    所以这里先把白名单配起来，再验群戳的目标号真的受管。
  const { getConfig } = await import('../lib/config.js')
  const { allowedPokeTargets } = await import('../lib/allowlist.js')
  const cfg = getConfig()
  cfg.allowSendToAny = false
  cfg.ownerUin = OWNER
  cfg.peerUin = OWNER
  cfg.routes = { private: { [OWNER]: { sessionId: 'x' } }, group: { 975663147: {} } }
  cfg.groupUins = ['975663147']
  ok(allowedPokeTargets().has(OWNER), '用户本人在「可戳」集合里')
  ok(!allowedPokeTargets().has('555555555'), '没绑定的群友不在「可戳」集合里')

  globalThis.fetch = async () => ({ ok: true, json: async () => ({ retcode: 0, data: null }) })
  // 戳已绑定的用户：放行
  const okResult = await sendPoke({ userUin: OWNER, groupId: '975663147', selfUin: SELF })
  eq(okResult.userUin, OWNER, '群戳用户本人 → 放行')
  // 戳群里的陌生人：必须被拦（这是审核发现的安全缺口）
  await throws(
    async () => sendPoke({ userUin: '555555555', groupId: '975663147', selfUin: SELF }),
    '群戳未绑定的群友 → 被白名单拦（以前是直接放行）'
  )
  await throws(
    async () => sendPoke({ userUin: '999999999', groupId: '975663147', selfUin: SELF }),
    '群戳任意号码 → 被白名单拦'
  )
  // group_id 形状不合法：要在本地就拒，不能带着 NaN/null 发出去
  await throws(
    async () => sendPoke({ userUin: OWNER, groupId: '不是群号', selfUin: SELF }),
    'group_id 不是数字 → 本地就拒（以前会带 group_id:null 发 group_poke）'
  )
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed > 0 ? 1 : 0)
