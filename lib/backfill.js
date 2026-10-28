/**
 * backfill.js —— 上线补历史（掉线窗口的消息不能再丢）。
 *
 * 为什么需要（2026-10-28）：
 *   轮询每轮只拉 `count: 10`（见 poll.js 的 pollOnePrivate）。这个数字对「实时」够用，
 *   对「掉线」是致命的：
 *     · DSH 关了两小时，中间攒了 60 条；
 *     · 重启后第一轮只拿到最新 10 条；
 *     · 游标（私聊 lastTime / 群 lastSeq）直接推到最新 ——
 *   中间那 50 条**永久丢失**，而且日志里没有任何痕迹（不是错误，是设计如此）。
 *
 *   补历史就是在上线时先把「游标之后」的窗口翻干净，再交给正常的投递函数。
 *
 * 三条设计原则：
 *   1. **只在上线时跑一次**，不进轮询循环 —— 它是一次性的对账，不是常规动作。
 *   2. **串行 + 页数上限**：每个对象最多翻 backfillMaxPages 页，避免启动时打爆协议端。
 *   3. **投递量有上限**：翻出来的消息可能几十条，全塞进一个回合会直接灌爆上下文。
 *      所以只投最近 backfillDeliver 条，更早的合并成一行「还有 N 条没展开」的提示 ——
 *      agent 至少知道自己错过了什么，而不是假装一切正常。
 *
 * 不做什么：不补群里的非 @ 消息（跟实时策略保持一致），不读撤回，不改游标语义。
 */
import { getConfig } from './config.js'
import { getState, saveState } from './state.js'
import { note } from './env.js'
import { callOneBot, seqOf, timeOf, isAtMe } from './onebot.js'
import { isSeen, markSeen, handlePrivateMessages, handleGroupMessage, configuredPrivates, configuredGroups } from './poll.js'

/** 单页拉多少条（协议端上限 100，这里取 50 平衡延迟）。 */
const PAGE_SIZE = 50

const clamp = (value, min, max) => {
  const num = Number(value)
  if (!Number.isFinite(num)) return min
  return Math.min(max, Math.max(min, Math.trunc(num)))
}

/** 拉一页私聊历史（原始协议端形状 —— handlePrivateMessages 要的就是这个）。 */
async function fetchPrivatePage(uin, beforeMessageId) {
  const result = await callOneBot({
    action: 'get_friend_msg_history',
    params: { user_id: Number(uin), count: PAGE_SIZE, message_id: Number(beforeMessageId) || 0 }
  })
  if (result?.retcode !== 0) throw new Error(`retcode=${result?.retcode} ${result?.message ?? ''}`)
  const list = Array.isArray(result?.data?.messages) ? result.data.messages : []
  // 只留对方发的（跟 pollOnePrivate 一致：自己发的不算新消息）
  return list.filter((item) => Number(item?.sender?.user_id) === Number(uin))
}

/** 拉一页群历史（原始形状）。 */
async function fetchGroupPage(groupId, beforeMessageId) {
  const result = await callOneBot({
    action: 'get_group_msg_history',
    params: { group_id: Number(groupId), count: PAGE_SIZE, message_id: Number(beforeMessageId) || 0 }
  })
  if (result?.retcode !== 0) throw new Error(`retcode=${result?.retcode} ${result?.message ?? ''}`)
  return Array.isArray(result?.data?.messages) ? result.data.messages : []
}

/**
 * 通用翻页：从最新往回翻，直到「最老一条落在游标之前」或翻满上限。
 *
 * @param {(beforeId:number)=>Promise<any[]>} fetchPage
 * @param {(message:any)=>boolean} isAfterCursor 这条是否在游标之后（= 还没处理过）
 * @returns {Promise<{messages:any[], pages:number, reachedCursor:boolean}>}
 *   messages 已按时间/seq 升序排好
 */
async function pageBack(fetchPage, isAfterCursor, maxPages) {
  const collected = []
  let beforeId = 0
  let pages = 0
  let reachedCursor = false

  while (pages < maxPages) {
    const page = await fetchPage(beforeId)
    pages += 1
    if (page.length === 0) { reachedCursor = true; break }

    // 页内**最老**一条：翻页锚点用它。
    // ⚠️ message_id 可能是负数（SnowLuma 的真实行为），
    //   所以「最老」不能靠数值大小比，靠时间戳；拿不到时间才退回绝对值比 id。
    const oldest = page.reduce((acc, item) => {
      if (acc === null) return item
      const ti = timeOf(item)
      const ta = timeOf(acc)
      if (ti > 0 && ta > 0) return ti < ta ? item : acc
      return Math.abs(Number(item?.message_id) || 0) < Math.abs(Number(acc?.message_id) || 0) ? item : acc
    }, null)

    collected.push(...page)

    // 这一页里已经出现了游标之前的消息 → 窗口补齐了，不用再翻
    if (page.some((item) => !isAfterCursor(item))) { reachedCursor = true; break }
    // 这一页不够整页 → 已经到头了
    if (page.length < PAGE_SIZE) { reachedCursor = true; break }

    const anchor = Number(oldest?.message_id) || 0
    if (anchor === 0) { reachedCursor = true; break }
    // 锚点没前进（协议端不认这个 id）→ 别死循环
    if (anchor === beforeId) { reachedCursor = true; break }
    beforeId = anchor
  }

  // 去重（翻页边界可能重复）+ 排序
  const seen = new Set()
  const unique = []
  for (const item of collected) {
    const id = Number(item?.message_id)
    const key = Number.isFinite(id) ? `id:${id}` : `t:${timeOf(item)}|${String(item?.raw_message ?? '')}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(item)
  }
  unique.sort((a, b) => {
    const ta = timeOf(a)
    const tb = timeOf(b)
    if (ta > 0 && tb > 0 && ta !== tb) return ta - tb
    const sa = seqOf(a) ?? 0
    const sb = seqOf(b) ?? 0
    return sa - sb
  })
  return { messages: unique, pages, reachedCursor }
}

/**
 * 补一个私聊对象的掉线窗口。
 * @returns {Promise<{uin:string, missed:number, delivered:number, skipped:number, pages:number} | null>}
 */
async function backfillPrivate(ctx, uin, maxPages, deliverMax) {
  const config = getConfig()
  const state = getState()
  const cursor = state.privates[uin] ?? {}
  const lastTime = Number(cursor.lastTime ?? 0)
  // 没有时间游标 = 还没播种过，交给轮询的 seedOnFirstRun 处理，这里不掺和
  if (lastTime <= 0) return null

  // 游标之后 = 时间不早于游标（同秒的靠 isSeen 的 message_id 精确去重）
  const isAfterCursor = (message) => {
    const time = timeOf(message)
    if (time > 0) return time >= lastTime
    return true
  }

  const { messages, pages, reachedCursor } = await pageBack(
    (beforeId) => fetchPrivatePage(uin, beforeId),
    isAfterCursor,
    maxPages
  )

  // 只留真正没处理过的（seenIds 命中 / 早于游标的都剔掉）
  const fresh = messages.filter((message) => isAfterCursor(message) && !isSeen(state.privates[uin], message))
  if (fresh.length === 0) {
    return { uin, missed: 0, delivered: 0, skipped: 0, pages, complete: reachedCursor }
  }

  // 投递量截断：只投最近 deliverMax 条，更早的只报数
  const skipped = Math.max(0, fresh.length - deliverMax)
  const toDeliver = skipped > 0 ? fresh.slice(-deliverMax) : fresh
  const note_ = skipped > 0
    ? `（离线期间还有 ${skipped} 条更早的消息没展开，这里只补最近 ${toDeliver.length} 条）`
    : ''

  const used = await handlePrivateMessages(ctx, uin, toDeliver, { leadingNote: note_ })
  note('backfill', `private ${uin}：翻 ${pages} 页，漏 ${fresh.length} 条，投 ${toDeliver.length} 条${skipped > 0 ? `，跳 ${skipped} 条` : ''}${reachedCursor ? '' : '（页数用尽，窗口未补完）'}`)
  return { uin, missed: fresh.length, delivered: used === '' ? 0 : toDeliver.length, skipped, pages, complete: reachedCursor }
}

/**
 * 补一个群的掉线窗口。
 *
 * ⚠️ 群只补「@ 到自己」的那几条（跟实时策略一致），
 *   但**整段窗口的游标照样要推进** —— 不推进的话，下一次轮询会把这段
 *   本来就不该投递的消息再捞一遍（而且每次重启都捞）。
 */
async function backfillGroup(ctx, groupId, maxPages, deliverMax) {
  const config = getConfig()
  const state = getState()
  const cursor = state.groups?.[groupId] ?? {}
  const lastSeq = Number(cursor.lastSeq ?? 0)
  if (lastSeq <= 0) return null

  const isAfterCursor = (message) => {
    const seq = seqOf(message)
    if (seq === null) return true
    return seq > lastSeq
  }

  const { messages, pages, reachedCursor } = await pageBack(
    (beforeId) => fetchGroupPage(groupId, beforeId),
    isAfterCursor,
    maxPages
  )

  const fresh = messages.filter((message) => isAfterCursor(message) && !isSeen(state.groups[groupId], message, true))
  const atMe = fresh.filter((message) => isAtMe(message.message, config.selfUin))
  const toDeliver = atMe.length > deliverMax ? atMe.slice(-deliverMax) : atMe

  let delivered = 0
  for (const message of toDeliver) {
    try {
      const result = await handleGroupMessage(ctx, groupId, message)
      if (result?.status === 'delivered') delivered += 1
    } catch (error) {
      note('backfill', `group ${groupId} 投递失败：${error instanceof Error ? error.message : error}`)
    }
  }

  // 游标推进到窗口里最新的那条 —— 不管有没有 @ 我。
  // 不推进的话这段窗口会被反复重扫（每次重启都扫一遍）。
  const newestSeq = fresh.reduce((max, item) => Math.max(max, seqOf(item) ?? 0), 0)
  if (fresh.length > 0) {
    for (const item of fresh) markSeen(state.groups[groupId] ?? (state.groups[groupId] = {}), item)
    state.groups[groupId] = {
      ...(state.groups[groupId] ?? {}),
      lastSeq: Math.max(lastSeq, newestSeq)
    }
    saveState({ groups: state.groups })
  }

  note('backfill', `group ${groupId}：翻 ${pages} 页，漏 ${fresh.length} 条，其中 @ 我 ${atMe.length} 条，投 ${delivered} 条${reachedCursor ? '' : '（页数用尽，窗口未补完）'}`)
  return { groupId, missed: fresh.length, atMe: atMe.length, delivered, pages, complete: reachedCursor }
}

/**
 * 上线补历史总入口。在探活通过之后、启动轮询之前调用一次。
 *
 * @param {object} ctx 插件上下文
 * @param {object} [options]
 * @param {number} [options.maxPages] 每个对象最多翻几页
 * @param {number} [options.deliverMax] 每个对象最多投递几条
 * @returns {Promise<{privates:any[], groups:any[]}>}
 */
export async function runBackfill(ctx, options = {}) {
  const config = getConfig()
  if (config.backfillOnStart === false) {
    note('backfill', '已关闭（backfillOnStart=false）')
    return { privates: [], groups: [] }
  }
  const maxPages = clamp(options.maxPages ?? config.backfillMaxPages ?? 5, 1, 20)
  const deliverMax = clamp(options.deliverMax ?? config.backfillDeliver ?? 20, 1, 100)

  const result = { privates: [], groups: [] }
  const startedAt = Date.now()

  for (const uin of configuredPrivates()) {
    try {
      const one = await backfillPrivate(ctx, uin, maxPages, deliverMax)
      if (one !== null) result.privates.push(one)
    } catch (error) {
      note('backfill', `private ${uin} 失败：${error instanceof Error ? error.message : error}`)
    }
  }
  for (const groupId of configuredGroups()) {
    try {
      const one = await backfillGroup(ctx, groupId, maxPages, deliverMax)
      if (one !== null) result.groups.push(one)
    } catch (error) {
      note('backfill', `group ${groupId} 失败：${error instanceof Error ? error.message : error}`)
    }
  }

  const totalMissed = result.privates.reduce((sum, item) => sum + item.missed, 0)
    + result.groups.reduce((sum, item) => sum + item.missed, 0)
  note(
    'backfill',
    `完成：私聊 ${result.privates.length} 个 / 群 ${result.groups.length} 个，共补 ${totalMissed} 条，耗时 ${Date.now() - startedAt}ms`
  )
  return result
}
