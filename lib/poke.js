/**
 * poke.js —— 戳一戳（拍一拍）：识别别人戳她，以及她主动戳人。
 *
 * 为什么单独一个模块：戳一戳**不是消息**，它是一条 notice 事件，
 * 没有 message_id、没有正文、没有昵称。它走的链路跟消息完全不同
 * （不进去重游标、不参与合并窗口、不算「发言」），混进 poll.js 会把那条链弄脏。
 *
 * 协议事实（2026-11-02 真机实测 SnowLuma 2.2.1，抓的是真实 WS 上报）：
 *
 *   群戳：{ post_type:'notice', notice_type:'notify', sub_type:'poke',
 *           group_id, user_id:<戳人者>, target_id:<被戳者>,
 *           action:'戳了戳', suffix:'', action_img_url:'http://...' }
 *
 *   私聊戳：{ post_type:'notice', notice_type:'notify', sub_type:'poke',
 *            user_id:<会话对端>, sender_id:<戳人者>, target_id:<被戳者>, action, ... }
 *
 *   ⚠️⚠️ 两种形状的 `user_id` 语义**不一样**：群戳的 user_id 就是戳人者；
 *     私聊戳的 user_id 是「会话对端」（SnowLuma 内部的 peerUin），真正的戳人者
 *      在 sender_id 里。照抄 NapCat 文档直接读 user_id 会把「谁戳的」认错。
 *     统一判据是 **target_id === self_id**（我被戳了），两种形状下都成立。
 *
 * 出站三个 action 都实测可用（retcode 0）：friend_poke / group_poke / send_poke。
 */
import { callOneBot } from './onebot.js'
import { note } from './env.js'
import { assertSendAllowed } from './allowlist.js'

/** 这个事件是不是戳一戳。 */
export function isPokeEvent(event) {
  return event?.post_type === 'notice'
    && String(event?.notice_type ?? '') === 'notify'
    && String(event?.sub_type ?? '') === 'poke'
}

/**
 * 拿「我是谁」。
 *
 * ⚠️ 优先用**事件自带的 self_id**，而不是配置里的 selfUin（2026-11-02 审核发现）：
 *   config.selfUin 是**手填**的，默认值 0。而 String(0) = '0'（不是空串），
 *   于是 `target_id === '0'` 永远不成立 —— 所有戳都被静默判成「不是戳我」，
 *   表现跟「功能没做」一模一样，日志里只有一句 not-for-me。
 *   实测抓包每条 poke 事件都带 self_id，用它当主来源最稳，配置只做兜底。
 *
 * 两处都没有可用值时返回 ''，调用方据此判「认不出我是谁」并给出可操作的提示，
 * 而不是闷掉。
 */
function selfOf(event, selfUin) {
  const fromEvent = String(event?.self_id ?? '').trim()
  if (fromEvent !== '' && fromEvent !== '0') return fromEvent
  const fromConfig = String(selfUin ?? '').trim()
  if (fromConfig !== '' && fromConfig !== '0') return fromConfig
  return ''
}

/**
 * 把事件拆成统一形状。
 *
 * @returns {null | { groupId: string, peerUin: string, fromUin: string, toUin: string,
 *   targetsSelf: boolean, selfPoke: boolean, selfKnown: boolean, action: string }}
 *   groupId  群戳才有；空串 = 私聊戳
 *   peerUin  私聊戳的会话对端
 *   fromUin  戳人者
 *   toUin    被戳者
 *   selfKnown 有没有认出「我是谁」（认不出就无法判 targetsSelf）
 */
export function parsePoke(event, selfUin) {
  if (!isPokeEvent(event)) return null
  const self = selfOf(event, selfUin)
  const groupId = String(event?.group_id ?? '').trim()
  const isGroup = groupId !== ''

  // 私聊戳：user_id 是会话对端，sender_id 才是戳人者（见文件头实测）。
  // sender_id 缺了就退回 user_id —— 至少比「认不出谁戳的」强。
  const rawUser = String(event?.user_id ?? '').trim()
  const rawSender = String(event?.sender_id ?? '').trim()
  const fromUin = isGroup ? rawUser : (rawSender !== '' ? rawSender : rawUser)
  const toUin = String(event?.target_id ?? '').trim()
  const peerUin = isGroup ? '' : rawUser

  const selfKnown = self !== ''
  const targetsSelf = selfKnown && toUin === self
  // 自己戳的（含她自己戳别人、或者在多端上她自己戳自己）不该触发回合
  const selfPoke = selfKnown && fromUin === self

  return {
    groupId,
    peerUin,
    fromUin,
    toUin,
    targetsSelf,
    selfPoke,
    selfKnown,
    // 把「我是谁」一起带出去：下游拼正文时也要用它，
    // 不能各自去读 config.selfUin（默认 0 会判错）
    selfUin: self,
    action: String(event?.action ?? '').trim()
  }
}

/**
 * 去重键（**目前没有启用**，留着给「需要幂等」的场景）。
 *
 * 戳事件没有 message_id，只能自己合成。用「时间 + 双方 + 群」：
 * 同一秒内完全相同的重复上报会被当成重复（可接受 —— QQ 那边一秒内
 * 同一个人戳同一个人两次本来也看不出区别）。
 *
 * 为什么入站链路**不用它**做去重：戳一戳没有游标、没有重投机制，
 * 投递失败时我们靠「不消费冷却」让它下次能重试 —— 用键去重反而会把
 * 「上次没投出去的那一戳」永久吞掉。所以现在只靠冷却挡连戳。
 */
export function pokeDedupKey(poke) {
  if (poke === null || poke === undefined) return ''
  return `poke:${String(poke.groupId)}:${String(poke.fromUin)}:${String(poke.toUin)}:${String(poke.at ?? '')}`
}

/**
 * 这一戳该不该触发一次回合。
 *
 * 判据顺序有讲究，从「最便宜且最能排除」的开始：
 *   1. 开关关着 → 不回（但仍然记账，见调用方）
 *   2. 自己戳的 → 不回（避免自问自答）
 *   3. 不是戳我 → 不回（群友互戳不该唤醒她）
 *   4. 群没绑会话 → 不回
 */
export function shouldReact(poke, config) {
  if (poke === null || poke === undefined) return { react: false, reason: 'not-a-poke' }
  if (config?.pokeEnabled === false) return { react: false, reason: 'off' }
  // 认不出「我是谁」时不能装没事：无法判断这一戳是不是戳我，
  // 闷掉的话现场表现就是「功能没反应」，还查不出来（selfUin 手填默认 0 就会这样）。
  if (poke.selfKnown === false) return { react: false, reason: 'self-unknown' }
  if (poke.selfPoke) return { react: false, reason: 'self-poke' }
  if (!poke.targetsSelf) return { react: false, reason: 'not-for-me' }
  return { react: true, reason: 'ok' }
}

/**
 * 冷却：同一个群（或同一个人）短时间内被连戳，只回一次。
 *
 * 为什么必须有：戳一戳的触发成本极低（双击头像），群里几个人闹起来
 * 一秒能戳十下。没有冷却就是「被戳一下就回一句」的刷屏机器。
 *
 * ⚠️ 为什么是「先占位再投递」而不是「投递成功才记时间」（2026-11-02 审核发现）：
 *   `handleWsEvent` 是 fire-and-forget 调起的（index.js: `void handleWsEvent(...)`），
 *   两条戳事件会**并发**跑进 handleNoticeEvent。如果时间戳放在 `await deliver(...)`
 *   之后，两边都会看到「没有冷却」→ 双双投递 → 冷却是形同虚设的。
 *   deliver 里还有冷启动（读日志、组 preset），这个窗口是秒级的，不是理论问题。
 *   所以：查到没有冷却就**立刻占位**，投递失败再撤掉（见 releasePokeCooldown）。
 */
const lastReactAt = new Map()

export function pokeCooldownKey(poke) {
  if (poke === null || poke === undefined) return ''
  const groupId = String(poke.groupId ?? '').trim()
  return groupId !== '' ? `group:${groupId}` : `private:${String(poke.fromUin ?? '').trim()}`
}

export function pokeCooldownRemaining(poke, config) {
  const cooldownMs = Math.max(0, Number(config?.pokeCooldownMs ?? 0) || 0)
  if (cooldownMs === 0) return 0
  const key = pokeCooldownKey(poke)
  if (key === '') return 0
  const previous = lastReactAt.get(key)
  if (previous === undefined) return 0
  const remaining = cooldownMs - (Date.now() - previous)
  return remaining > 0 ? remaining : 0
}

/** 占住冷却位（投递前调）。返回 true = 抢到了。 */
export function claimPokeCooldown(poke) {
  const key = pokeCooldownKey(poke)
  if (key === '') return false
  lastReactAt.set(key, Date.now())
  // 别让这张表无限长：超过 200 个目标就把最老的清掉
  if (lastReactAt.size > 200) {
    const oldest = [...lastReactAt.entries()].sort((a, b) => a[1] - b[1]).slice(0, 50)
    for (const [k] of oldest) lastReactAt.delete(k)
  }
  return true
}

/** 投递失败时把占位撤掉 —— 否则「上次没投出去的那一戳」会把后续正常戳一起吞掉。 */
export function releasePokeCooldown(poke) {
  const key = pokeCooldownKey(poke)
  if (key !== '') lastReactAt.delete(key)
}

/** 兼容旧签名（= claimPokeCooldown）。 */
export function markPokeReacted(poke) {
  claimPokeCooldown(poke)
}

/** 测试用：清掉冷却表。 */
export function resetPokeCooldown() {
  lastReactAt.clear()
}

/**
 * 主动戳一个人（出站）。三个 action 里挑最合适的那个：
 *   有 group_id → group_poke（群拍一拍）
 *   没有        → friend_poke（好友拍一拍）
 *
 * 为什么不用 send_poke：它也能用（实测 retcode 0），但它的路由行为依赖
 * 协议端自己判断「有没有 group_id」，显式选 action 更不容易被别的实现带偏。
 *
 * 白名单：走 callOneBot，闸门自然生效（sendTargetOf 已经认得这三个 action）。
 */
export async function sendPoke(target) {
  const groupId = String(target?.groupId ?? '').trim()
  const userUin = String(target?.userUin ?? '').trim()
  if (!/^\d+$/.test(userUin) || userUin === '0') {
    throw new Error(`要戳谁？给一个正的 QQ 号（收到的是「${target?.userUin ?? ''}」）`)
  }
  // ⚠️ 群号也要校验形状（2026-11-02 审核发现）：
  //   以前 `Number('不是群号')` = NaN，JSON 序列化成 `null` 照样发 group_poke，
  //   而白名单因为 normUin(NaN) 返回空串，会转去按「私聊目标」校验 ——
  //   校验的对象和真正发出去的 action 根本不是一回事。
  if (groupId !== '' && (!/^\d+$/.test(groupId) || groupId === '0')) {
    throw new Error(`群号不合法（收到的是「${target?.groupId ?? ''}」）。在群里戳就给纯数字群号，私聊戳就别传 group_id。`)
  }
  const selfUin = String(target?.selfUin ?? '').trim()
  if (selfUin !== '' && userUin === selfUin) {
    throw new Error('不戳自己 —— 那是无意义动作，还容易被当成刷屏')
  }

  const action = groupId !== '' ? 'group_poke' : 'friend_poke'
  const params = groupId !== ''
    ? { group_id: Number(groupId), user_id: Number(userUin) }
    : { user_id: Number(userUin) }

  // 提前显式拦一道：callOneBot 里也拦，但如果这里先拦，报错信息能直接告诉她该怎么做
  assertSendAllowed(action, params)

  const result = await callOneBot({ action, params })
  if (result?.retcode !== 0) {
    throw new Error(
      `戳一戳失败：retcode=${result?.retcode} ${result?.wording ?? result?.message ?? ''}`
      + '（QQ 对戳一戳有频率限制，连戳太多次会被拒）'
    )
  }
  note('poke', `已戳 ${groupId !== '' ? `群 ${groupId} 的 ` : ''}${userUin}`)
  return { groupId, userUin }
}
