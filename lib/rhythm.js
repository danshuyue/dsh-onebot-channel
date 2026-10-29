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

/** 每次从 QQ 收到一条消息都打个点（决定补静默要不要续期）。 */
export function markIncoming(key, at) {
  if (key === '') return
  lastIncoming.set(key, Number(at) || Date.now())
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
