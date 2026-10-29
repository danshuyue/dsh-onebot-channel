/**
 * merge.js —— 私聊「先记账，攒一会儿再回」（标记已读的中间态）。
 *
 * 为什么需要它：
 *   现在 WS 通路是「来一条投一条」，对方连发三句会开三个回合、被连问三遍；
 *   而 replyQuietMs 只是把每一回合**各等一遍**，三条消息还是三个回合。
 *   真人的做法是：看到消息（等于已读）→ 等他把这一波说完 → 一起回。
 *
 * 这个模块只负责「攒」和「什么时候放行」，不碰投递、不碰游标：
 *   入池时机由 poll.js 决定（那里已经 markSeen，所以等于「已读已记账，只是还没回」）；
 *   放行之后仍然走原来的 handlePrivateMessages —— 游标推进、去重、失败回滚一条都不变。
 *
 * 三条硬约束：
 *   1. 窗口不能无限等：maxWaitMs 兜底，否则对方一直发就永远不回。
 *   2. 攒得太多就别攒了：maxMessages 到了立刻放行（一口气十条已经不是「还没说完」）。
 *   3. 同一对象同时只跑一次投递：投递期间的 incoming 留到下一池，不并发打同一个会话。
 *
 * 配置：mergeWindowMs（0 = 关，完全回到「来一条投一条」）、mergeMaxWaitMs、mergeMaxMessages。
 */
import { getConfig } from './config.js'
import { note } from './env.js'

function clampInt(value, def, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** 当前窗口配置（每次都从配置读，设置页改完下一批就生效）。 */
export function mergeSettings() {
  const cfg = getConfig()
  return {
    windowMs: clampInt(cfg?.mergeWindowMs, 2500, 0, 60000),
    maxWaitMs: clampInt(cfg?.mergeMaxWaitMs, 15000, 0, 300000),
    maxMessages: clampInt(cfg?.mergeMaxMessages, 10, 1, 50)
  }
}

/**
 * 建一个合并队列。
 *
 * @param {(uin: string, messages: any[], ctx: any) => Promise<string>} flush 一批放行时的投递函数
 * @param {() => {windowMs:number, maxWaitMs:number, maxMessages:number}} [settings] 注入配置（测试用）
 * @returns {{push: Function, flushAll: () => void, pending: () => {uin:string,count:number,waitedMs:number}[], size: () => number}}
 */
export function createMergeQueue(flush, settings = mergeSettings) {
  /** uin -> { messages, timer, firstAt, ctx } */
  const pools = new Map()
  /** 正在投递的对象：防止同一会话被两个批次并发打进去。 */
  const inFlight = new Set()

  function clearTimer(entry) {
    if (entry.timer !== null) {
      clearTimeout(entry.timer)
      entry.timer = null
    }
  }

  async function fire(uin) {
    const entry = pools.get(uin)
    if (entry === undefined) return
    // 上一批还没投完：让新池子稍后再试，不排队也不并发
    if (inFlight.has(uin)) {
      clearTimer(entry)
      entry.timer = setTimeout(() => {
        entry.timer = null
        void fire(uin)
      }, 300)
      return
    }
    pools.delete(uin)
    clearTimer(entry)
    inFlight.add(uin)
    try {
      await flush(uin, entry.messages, entry.ctx)
    } catch (error) {
      // 投递抛错不能把定时器带崩，否则整个入站链就此静默
      note('merge', `${uin} 投递抛错：${error instanceof Error ? error.message : error}`)
    } finally {
      inFlight.delete(uin)
    }
  }

  /**
   * 收一条消息。
   * @returns {{queued: boolean, done?: Promise<string>}}
   *   queued=true  → 已入池，稍后放行（调用方不要等）
   *   queued=false → 窗口关着，已经直接投递，done 是那一批的结果
   */
  function push(ctx, uin, message) {
    const s = settings()
    const key = String(uin)
    if (s.windowMs <= 0) {
      return {
        queued: false,
        done: (async () => {
          try {
            return await flush(key, [message], ctx)
          } catch (error) {
            note('merge', `${key} 直接投递抛错：${error instanceof Error ? error.message : error}`)
            return ''
          }
        })()
      }
    }

    const now = Date.now()
    let entry = pools.get(key)
    if (entry === undefined) {
      entry = { messages: [], timer: null, firstAt: now, ctx }
      pools.set(key, entry)
    }
    entry.messages.push(message)
    entry.ctx = ctx

    if (entry.messages.length >= s.maxMessages) {
      void fire(key)
      return { queued: true }
    }

    // 每次来新话都重置窗口（「等他说完」），但总时长被 maxWaitMs 卡住
    clearTimer(entry)
    const hardLeft = s.maxWaitMs > 0 ? Math.max(0, s.maxWaitMs - (now - entry.firstAt)) : Number.POSITIVE_INFINITY
    const delay = Math.max(0, Math.min(s.windowMs, hardLeft))
    entry.timer = setTimeout(() => {
      const alive = pools.get(key)
      if (alive !== undefined) alive.timer = null
      void fire(key)
    }, delay)
    return { queued: true }
  }

  /** 立刻放行全部（插件卸载时用，别把攒着的消息一起带走）。 */
  function flushAll() {
    for (const key of [...pools.keys()]) void fire(key)
  }

  /** 池子里现有什么（设置页 / 排障用）。 */
  function pending() {
    const now = Date.now()
    return [...pools.entries()].map(([uin, entry]) => ({
      uin,
      count: entry.messages.length,
      waitedMs: now - entry.firstAt
    }))
  }

  function size() {
    let total = 0
    for (const entry of pools.values()) total += entry.messages.length
    return total
  }

  /** 丢掉池子里所有东西（插件卸载时用：ctx 正在卸载，不能再投递了）。 */
  function discard() {
    const dropped = pending()
    for (const entry of pools.values()) clearTimer(entry)
    pools.clear()
    return dropped
  }

  return { push, flushAll, pending, size, discard }
}
