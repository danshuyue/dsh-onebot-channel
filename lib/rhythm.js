/**
 * rhythm.js —— 给她「什么时候说话」的主动权。
 *
 * 原插件这条链路是死的：消息进来 → followup → 模型必须说点什么 → 回合结束转发回 QQ。
 * 模型哪怕觉得「这句话没什么可回的」也回不了嘴外的选择，所以永远只能像客服。
 *
 * 这个模块把三种**合法的沉默**变成可实现的操作：
 *   1. 等    —— waitQuiet：回复前先把静默补足，别对方刚发完就秒回
 *   2. 划走  —— suppress：这回合不转发任何东西（掠过就是掠过，不是失败）
 *   3. 收尾  —— 见 closure.js：这段聊到这儿了，不是消失，是记下来下次怎么接
 *
 * 为什么按 target key 而不是 sessionId 记账：
 *   工具被调用时手里有的是 QQ 号/群号，sessionId 要经过路由表反查，多一层就可能查歪；
 *   target key（`group:123` / `private:456`）是它在协议层的真实身份，天然唯一。
 */
import { getConfig } from './config.js'
import { note } from './env.js'

/** target → 最后一次「有人说话」的时间戳（墙钟毫秒）。 */
const lastIncoming = new Map()
/** 被要求「这回合别转发出去」的 target → 打标记的时间。 */
const suppressed = new Map()

/**
 * 抑制标记的有效期。
 *
 * ⚠️ 为什么必须有过期：qq_pass 之后如果这一回合没走到自动转发
 *   （模型说了话但被别的分支跳过、回合没跑起来、turn/end 丢了），
 *   标记就会一直留着，把**下一次本该正常发出的回复**吃掉 ——
 *   表现成「她突然再也不说话了」，而且日志里只有一句 suppressed，很难查。
 *   所以宁可让它自愈（10 分钟后当没说过），也不要留一个永久开关。
 */
export const SUPPRESS_TTL_MS = 10 * 60 * 1000

/** 把出站目标统一成 `group:123` / `private:456`。 */
export function targetKey(target) {
  const kind = String(target?.kind ?? '').trim()
  const id = String(target?.id ?? '').trim()
  if (kind === '') return ''
  return `${kind}:${id}`
}

// ---- 三个「本回合」旁路账本 ----
// 声明提到 markIncoming 之前：markIncoming 要在新消息到达时把它们清掉，
// 而它定义在上面（函数体内引用，运行时没问题；但放前面读起来才不会以为漏了）。
/** 「这一回合她说过话 / 划走过 / 跳过了」。 */
const turnHandled = new Map()
/** 「这一回合 qq_skip 过」。 */
const skipTurns = new Map()
/** 「这一回合 qq_close 被拒过」。 */
const closeRefusedTurns = new Map()

/** 每次从 QQ 收到一条消息都打个点（决定补静默要不要续期）。 */
export function markIncoming(key, at) {
  if (key === '') return
  lastIncoming.set(key, Number(at) || Date.now())
  // ⚠️ 新消息进来 = 新回合开始，把「上一回合她处理过 / 跳过 / 收尾被拒」的账本清掉
  //   （0.16.16 审核发现）。不清的话那些标志靠 TTL 活 10 分钟，
  //   期间**下一条**消息触发的新回合也能用它们放行 —— 等于「最近 10 分钟说过话
  //   就能随便收摊」，违反 closure.js 的设计红线「对方还在问时不许收尾」。
  //   只在入站这一处清，不能在回合中途清（合批会把同回合的账踩掉）。
  turnHandled.delete(key)
  skipTurns.delete(key)
  closeRefusedTurns.delete(key)
}

/**
 * 最近一次投递的目标 —— 给「没给参数的 qq_pass / qq_close」兜底用。
 *
 * 为什么需要：多号并行时，`targetOf(args)` 留空以前一律退回 config.peerUin，
 * 于是在 B 的回合里 qq_pass 抑制的是 A —— B 照旧把话发出去、A 的下一条回复被吃掉。
 * 日志里只会看到「已抑制自动转发 key=private:A」，跟当前对话对不上，极难查。
 * 这里记住「刚投给谁」，把它当成默认值；超过 TTL 就当没有（宁可退回老行为）。
 */
let lastDelivery = null
export const DELIVERY_TTL_MS = 5 * 60 * 1000

export function rememberDelivery(target, at) {
  const key = targetKey(target)
  if (key === '') return
  lastDelivery = { target: { kind: String(target.kind), id: String(target.id) }, key, at: Number(at) || Date.now() }
}

export function recentDelivery(maxAgeMs) {
  if (lastDelivery === null) return null
  const age = Date.now() - lastDelivery.at
  if (age < 0 || age > Number(maxAgeMs || DELIVERY_TTL_MS)) return null
  return lastDelivery.target
}

/** 测试用：清掉「最近投递」（不碰抑制表）。 */
export function clearDelivery() {
  lastDelivery = null
}

/**
 * 这条正文是不是**只有动作描写**（没有一句真正的话）。
 *
 * 为什么需要：主动搭话投进去之后，模型有时会说「（尾巴摆了摆）」来表示「我在，但没话说」。
 * 转发链只认文字，于是 QQ 上真的收到一条「（尾巴摆了摆）」——
 * 用户看到的是莫名其妙的消息，看起来像功能坏了。
 * 判定故意保守：**整条去掉括号内容后什么都不剩**才算，正常聊天里的「（笑）好呀」不受影响。
 */
export function isStageOnly(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return true
  if (!/[（(]/.test(raw)) return false
  const stripped = raw
    .replace(/[（(][^（()）]{0,200}[)）]/g, '')
    .replace(/\[[^\]]{0,40}\]/g, '') // [表情:xx] 之类
    .replace(/[\s\u3000。，、…~～！？!?.．·—\-*_`'"“”‘’]/g, '')
  return stripped === ''
}

/**
 * 回复前把静默补足 —— 从**最后一条来信**开始算，不是从现在。
 *
 * 关键细节（移植自 surfcore bridge.js 的 /socialV2/wait）：
 *   等待期间如果又来了新话，`lastIncoming` 会被刷新，剩余时间**从头重算**，
 *   否则「对方连发三条」会在说完第三段之前就抢答 —— 真人不会这么做。
 *   同时给一个总预算，防止有人在群里刷屏把她永久吊住。
 *
 * @param {string} key
 * @param {number} quietMs 需要补的静默（<=0 直接返回，等于关掉这个功能）
 * @param {number} [budgetMs] 最多等多久，超时就放行（默认 60s）
 */
export function waitQuiet(key, quietMs, budgetMs = 60000) {
  const need = Number(quietMs)
  if (!Number.isFinite(need) || need <= 0) return Promise.resolve({ waitedMs: 0, skipped: true })
  if (key === '') return Promise.resolve({ waitedMs: 0, skipped: true })

  const start = Date.now()
  return new Promise((resolve) => {
    const tick = () => {
      const last = lastIncoming.get(key) ?? start
      const remaining = need - (Date.now() - last)
      if (remaining <= 0) return resolve({ waitedMs: Date.now() - start })
      const spent = Date.now() - start
      if (spent >= budgetMs) {
        note('rhythm', `补静默超预算 ${spent}ms 后放行（key=${key}，还要 ${remaining}ms）`)
        return resolve({ waitedMs: spent, budgetExceeded: true })
      }
      const step = Math.max(50, Math.min(300, remaining))
      setTimeout(tick, step)
    }
    tick()
  })
}

/**
 * 「这一回合她说过话 / 划走过」的旁路账本（0.16.15）。
 *
 * 为什么单独一本账，而不是复用 `suppressed`：
 *   `suppressed` 是一次性消费的（`consumeSuppress` 命中即删），
 *   而 `qq_close` 需要问的是「**这一回合**里她有没有已经处理过对方」——
 *   这是读，不是消费。用同一张表会有两个后果：要么把抑制标记读丢，
 *   要么得改 `consumeSuppress` 的契约（有测试钉着，不动）。
 *
 * 用途只有一个：`qq_close` 撞上 `openQuestion` 时判断
 *   「她这回合已经回应过了，那就允许关窗（但不记收尾）」。
 * 用户实测的死循环正是卡在这里。
 *
 * （`turnHandled` 声明在文件上方，markIncoming 要用它清账。）
 */
/** 这本来就是个「本回合」概念，10 分钟足够覆盖一次慢回合。 */
const TURN_HANDLED_TTL_MS = 10 * 60 * 1000

/** 记一笔：这个 key 在本回合里已经说过话 / 划走过。 */
export function noteTurnHandled(key) {
  if (key === '') return
  turnHandled.set(key, Date.now())
}

/** 本回合她有没有已经处理过这个 key（只读，不消费）。 */
export function wasTurnHandled(key) {
  if (key === '') return false
  const at = turnHandled.get(key)
  if (at === undefined) return false
  if (Date.now() - Number(at) > TURN_HANDLED_TTL_MS) {
    turnHandled.delete(key)
    return false
  }
  return true
}

/**
 * 清掉「本回合已处理」的标记。
 *
 * 生产路径用不到（TTL 会自然过期）；主要是给测试做用例隔离 ——
 * 上一个用例说过话，下一个用例的 qq_close 就会被误放行。
 * 也顺手给关窗路径用：窗口都关了，这账本就该跟着清。
 */
export function clearTurnHandled(key) {
  if (key === '') return false
  return turnHandled.delete(key)
}

/**
 * 「本回合 qq_close 被拒过」的旁路账本（0.16.15，防线二）。
 *
 * 为什么需要：`qq_close` 被拒时模型处在「判断模式」，
 * 它这一回合写出来的正文大概率是元话语（「对方还在问，我是不是该……」）——
 * 用户看到的「把该不该结束的纠结念出来」就是这么来的。
 * 所以只要这一回合 `qq_close` 返回过 ok:false，正文就一律不转发。
 *
 * ⚠️ 只拦这一种组合：**调用过 qq_close 且被拒**。
 *   不要扩大成「调过 qq_close 就拦」—— 成功收尾的回合，
 *   她要留的最后一句话照发（那是 `qq_send` 的既有语义，有测试钉着）。
 * ⚠️ 用旁路 Map 而不是复用 `suppressed`：`consumeSuppress` 是一次性消费，
 *   读一次就没了，跟「这一回合发生过什么」是两种语义。
 *
 * （`closeRefusedTurns` 声明在文件上方。）
 */

/** 记一笔：这个 key 这一回合 qq_close 被拒过。 */
export function noteCloseRefusedTurn(key) {
  if (key === '') return
  closeRefusedTurns.set(key, Date.now())
}

/** 这一回合 qq_close 被拒过吗（只读；查过之后清掉，避免影响下一回合）。 */
export function closeRefusedThisTurn(key) {
  if (key === '') return false
  const at = closeRefusedTurns.get(key)
  if (at === undefined) return false
  closeRefusedTurns.delete(key)
  if (Date.now() - Number(at) > TURN_HANDLED_TTL_MS) return false
  return true
}

/**
 * 「这条不用回」的旁路账本（0.16.16）。
 *
 * 用户实测的根本问题：她判断出「这条不需要回」时，**没有无副作用的出口**。
 *   · 纯 `qq_pass` 的说明写着「正文里写了真话照样发」—— 她不确定，于是干脆写正文；
 *   · 不调工具纯写正文 → 自动转发把思考产物发出去 → 聊天被强行续命。
 * 结果就是「她把该不该结束的判断念出来」。
 *
 * `qq_skip` 和 `qq_pass` 的语义区别（这是拆成两个工具的理由）：
 *   · `qq_pass` = 「我看了，但这次先不开口」→ 正文写了真话仍照发（既有决策，有测试钉着）；
 *   · `qq_skip` = 「这条不该有回复」→ 本回合**正文一律不发**。
 * 前者保护「她真说了话但用户没收到」，后者保护「她只是在解释自己为什么不说」。
 *
 * 一次性消费：查过就删，免得把下一回合该发的话也吞掉。
 *
 * （`skipTurns` 声明在文件上方。）
 */

/** 记一笔：这个 key 这一回合调了 qq_skip。 */
export function noteSkipTurn(key) {
  if (key === '') return
  skipTurns.set(key, Date.now())
}

/** 这一回合调过 qq_skip 吗（一次性消费）。 */
export function skipTurnRequested(key) {
  if (key === '') return false
  const at = skipTurns.get(key)
  if (at === undefined) return false
  skipTurns.delete(key)
  if (Date.now() - Number(at) > TURN_HANDLED_TTL_MS) return false
  return true
}

/** 标记：下一个回合不要自动转发（她主动选择了不说话）。 */
export function suppress(key, why = '') {
  if (key === '') return
  suppressed.set(key, Date.now())
  note('rhythm', `已抑制自动转发 key=${key}${why === '' ? '' : `（${why}）`}`)
}

/**
 * 消费一次抑制标记：命中为真并清掉。
 * ⚠️ 必须一次性消费 —— 留着会把后面本该发出的回复也吃掉。
 * ⚠️ 过期的一律当没打过标记，并清掉，避免无声失。
 */
export function consumeSuppress(key) {
  if (key === '') return false
  const at = suppressed.get(key)
  if (at === undefined) return false
  const aged = Date.now() - Number(at)
  if (Number.isFinite(aged) && aged > SUPPRESS_TTL_MS) {
    suppressed.delete(key)
    note('rhythm', `抑制标记已过期（${Math.round(aged / 1000)}s），当作没划走过`)
    return false
  }
  suppressed.delete(key)
  return true
}

/** 当前有多少 target 被抑制（设置页/排障用）：只列还没过期的。 */
export function suppressedKeys() {
  const now = Date.now()
  const alive = []
  for (const [key, at] of suppressed) {
    if (now - Number(at) <= SUPPRESS_TTL_MS) alive.push(key)
    else suppressed.delete(key)
  }
  return alive
}

/**
 * 从配置取一个限额并夹到区间里，默认 0 = 关掉。
 * 这里统一处理「配置是坏值时怎么办」：坏值一律回默认，绝不让它变成「无限」。
 */
export function clampLimit(value, def, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** 读当前该补多少静默（毫秒）。配置关掉就返回 0。 */
export function quietMsFromConfig() {
  const cfg = getConfig()
  return clampLimit(cfg?.replyQuietMs, 0, 0, 60000)
}

/**
 * 「这一回合 qq_wait 已经等了多久」的账本（2026-11-03）。
 *
 * 为什么需要：`qq_wait` 会把**一整个回合**拖长。用户实测她连打 40000ms，
 * 一个回合里 qq_wait → qq_msg_history → qq_send 交替好几轮，回合能跑几分钟。
 * 回合越长，这期间进来的消息排队窗口越大（见 deliver.js 的 pushIntoAgent 注释）——
 * 所以除了「忙的时候改用 steer」，还要给回合长度本身设一道闸。
 *
 * 记账口径：按 target key（`group:123` / `private:456`），**每次投递重置**
 * （deliver 成功投一条 = 来了新的东西要处理，理应给新的预算）。
 * 另外带 TTL 兜底：账本超过 10 分钟没用就作废，避免「昨天的等待额度」卡今天。
 *
 * capMs <= 0 表示不限（配置里关掉这道闸）。
 */
const waitSpent = new Map()
export const WAIT_LEDGER_TTL_MS = 10 * 60 * 1000

/** 新的一条消息投给她了 → 这一回合的等待额度重新算。 */
export function resetWaitBudget(key) {
  if (key === '') return
  waitSpent.delete(key)
}

/** 这一回合还能等多久（毫秒）。capMs <= 0 = 不限，返回 Infinity。 */
export function waitBudgetLeft(key, capMs) {
  const cap = Number(capMs)
  if (!Number.isFinite(cap) || cap <= 0) return Number.POSITIVE_INFINITY
  if (key === '') return cap
  const entry = waitSpent.get(key)
  if (entry === undefined) return cap
  if (Date.now() - Number(entry.at) > WAIT_LEDGER_TTL_MS) {
    waitSpent.delete(key)
    return cap
  }
  return Math.max(0, cap - Number(entry.ms || 0))
}

/** 记一笔：这一回合又等了 ms 毫秒。 */
export function chargeWaitBudget(key, ms) {
  const spent = Number(ms)
  if (key === '' || !Number.isFinite(spent) || spent <= 0) return 0
  const entry = waitSpent.get(key)
  const total = (entry === undefined ? 0 : Number(entry.ms || 0)) + spent
  waitSpent.set(key, { ms: total, at: Date.now() })
  return total
}

/** 测试用：清掉等待账本。 */
export function clearWaitBudget() {
  waitSpent.clear()
}
