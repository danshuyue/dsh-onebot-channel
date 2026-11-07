/**
 * custom-faces.js —— QQ 收藏表情（商城大表情）的列举与发送。
 *
 * 「收藏表情」是 QQ 账号自己收藏的那批表情包（收藏夹里的那些）。
 * 它们跟经典小表情（face 段）不是一回事：
 *   经典小表情 —— 编号 0~348，QQ 自带，不需要任何额外资源，face 段直接发。
 *   收藏表情   —— 表情商城的大表情，每个有一个 32 位十六进制的 emoji_id，
 *                 要靠协议端的账号态才能发出去。
 *
 * 协议端支持情况（实测 SnowLuma）：
 *   POST /fetch_custom_face_detail  → 列出收藏夹（只读，返回 emoji_id / url / summary / desc）
 *   POST /fetch_custom_face         → 只要 url 或 emoji_id 列表
 *   POST /send_custom_face          → 按 emoji_id 发出去（**单独一条消息**，不能和文本拼一段）
 *
 * ⚠️ 这些是 SnowLuma 的扩展 action，不是 OneBot 11 标准。
 * 换成别的协议端（NapCat / LLOneBot）可能没有 —— 所以每个调用都要能优雅降级：
 * 拿不到就返回空列表，发不出去就抛错，绝不能连累正常文本消息的发送。
 */
import { callOneBot } from './onebot.js'
import { note } from './env.js'

/**
 * 列收藏夹。
 * 返回 [{ emojiId, url, summary, desc }]，拿不到就是空数组。
 */
export async function listCustomFaces(limit = 100) {
  try {
    const result = await callOneBot({ action: 'fetch_custom_face_detail', params: { count: Number(limit) || 50 } })
    if (result?.retcode !== 0) {
      note('emoji', `fetch_custom_face_detail 失败：retcode=${result?.retcode} ${result?.message ?? ''}`)
      return []
    }
    const list = Array.isArray(result?.data) ? result.data : []
    return list
      .map((item) => ({
        emojiId: String(item?.emoji_id ?? item?.resId ?? '').trim(),
        url: String(item?.url ?? '').trim(),
        summary: String(item?.summary ?? item?.desc ?? '').trim(),
        desc: String(item?.desc ?? '').trim()
      }))
      .filter((item) => item.emojiId !== '')
  } catch (error) {
    // 协议端不支持这个 action 是常态（不是错误），只记一行日志
    note('emoji', `拉收藏表情失败：${error instanceof Error ? error.message : error}`)
    return []
  }
}

/**
 * 发一个收藏表情。
 *
 * ⚠️ 走独立的 send_custom_face action，**不能塞进 message 数组跟文本拼一条** ——
 * 协议端那边就是发两条独立消息。所以调用方要清楚：收藏表情必然是单独一条。
 *
 * 返回协议端的结果。
 */
export async function sendCustomFace(target, emojiId) {
  const id = String(emojiId ?? '').trim()
  if (id === '') throw new Error('收藏表情的 emoji_id 是空的')
  const groupId = String(target?.id ?? '').trim()
  const params = { emoji_id: id }
  if (target?.kind === 'group') params.group_id = Number(groupId)
  else {
    const config = await import('./config.js')
    const uin = Number(groupId) > 0 ? Number(groupId) : Number(config.getConfig().peerUin)
    params.user_id = uin
  }
  const result = await callOneBot({ action: 'send_custom_face', params })
  if (result?.retcode !== 0) {
    throw new Error(`发收藏表情失败：retcode=${result?.retcode} ${result?.message ?? ''}`)
  }
  return result
}

/** 挑表情时默认给几个候选（模型要的是「挑一个」，不是「唯一答案」）。 */
export const FACE_PICK_DEFAULT_LIMIT = 5
/** 候选上限：夹住模型的要求，别让它一次要 100 个。 */
export const FACE_PICK_MAX_LIMIT = 10
/** 不给关键词时最多列几个（够它扫一眼有什么，又不至于把上下文塞满）。 */
export const FACE_PICK_LIST_ALL_MAX = 30

/**
 * 收藏夹打分排序（唯一一处打分实现，findCustomFace / rankCustomFaces 共用）。
 *
 * 为什么抽出来：`findCustomFace` 原来把打分写在函数体内，只能返回**第一名**；
 * 而模型挑表情需要看到候选列表。两处各写一份打分必然慢慢走样，
 * 所以这里只留一处，两个导出的函数都调它。
 *
 * 打分规则（保持原样，不动权重）：
 *   · summary/desc 与关键词**完全相等** → 10000 分，稳居第一；
 *   · 整段关键词被包含 / emojiId 命中 → 1000 + 词数；
 *   · 否则按词累加：desc +3 / summary +2 / emojiId +1；
 *   · 所有词都命中再 +50。
 *
 * @returns {Array<{item, index, score}>} 已按分数降序；关键词里没有有效词时返回 []
 */
function scoreFaces(list, key) {
  const lower = key.toLowerCase()
  const terms = [...new Set(lower.split(/[\s,，、|/]+/).filter(Boolean))]
  if (terms.length === 0) return []
  const ranked = list.map((item, index) => {
    const summary = item.summary.toLowerCase()
    const desc = item.desc.toLowerCase()
    const emojiId = item.emojiId.toLowerCase()
    if (summary === lower || desc === lower) return { item, index, score: 10000 }
    if (summary.includes(lower) || desc.includes(lower) || emojiId === lower || emojiId.includes(lower)) {
      return { item, index, score: 1000 + terms.length }
    }
    const matched = terms.reduce((score, term) => {
      if (desc.includes(term)) return score + 3
      if (summary.includes(term)) return score + 2
      if (emojiId.includes(term)) return score + 1
      return score
    }, 0)
    const matchedTerms = terms.filter((term) => desc.includes(term) || summary.includes(term) || emojiId.includes(term)).length
    return { item, index, score: matchedTerms === terms.length ? matched + 50 : matched }
  })
  ranked.sort((a, b) => b.score - a.score || a.index - b.index)
  return ranked
}

/**
 * 按关键词在收藏夹里找表情。
 * 匹配 summary / desc / emojiId 的包含关系；找不到返回 null。
 *
 * ⚠️ emojiId 的大小写：QQ 返回的是**大写 MD5** 段
 *   （形如 <uin>_0_0_0_<32位大写MD5>_0_0），
 *   而 agent 手上的文件名 / hash 常是小写 —— 不做大小写无关匹配就找不到。
 */
export async function findCustomFace(keyword, limit = 100) {
  const key = String(keyword ?? '').trim()
  if (key === '') return null
  const list = await listCustomFaces(limit)
  if (list.length === 0) return null
  const ranked = scoreFaces(list, key)
  return ranked[0]?.score > 0 ? ranked[0].item : null
}

/**
 * 按关键词给收藏夹排序，返回前 N 个候选（不是只返回第一个）。
 *
 * 给 `qq_face_pick` 用：模型拿着情绪词来问「有哪些能用的」，
 * 而不是赌一个词、赌不中就整句发不出去。
 *
 * @param {string} keyword 情绪/场景关键词，空格分隔；留空则列出全部收藏
 * @param {number} [limit] 最多返回几个，缺省 5，夹在 [1, FACE_PICK_MAX_LIMIT]
 * @returns {Promise<Array<{item: {emojiId, url, summary, desc}, score: number}>>}
 *          收藏夹为空或没有匹配时返回 []
 */
export async function rankCustomFaces(keyword, limit = FACE_PICK_DEFAULT_LIMIT) {
  const key = String(keyword ?? '').trim()
  const wanted = Number(limit)
  // ⚠️ 下界也要夹（0.16.16 审核发现）：原来只判 `wanted > 0` 就 floor，
  //   于是 limit=0.5 算出 max=0、返回空数组，
  //   上层把空数组解释成「收藏夹里没有匹配的表情」—— 把参数错误误报成「没这张表情」。
  const max = Number.isFinite(wanted) && wanted > 0
    ? Math.min(Math.max(1, Math.floor(wanted)), FACE_PICK_MAX_LIMIT)
    : FACE_PICK_DEFAULT_LIMIT
  const list = await listCustomFaces(100)
  if (list.length === 0) return []
  // 不给关键词：把收藏夹摊开给模型看（分数统一 0，收藏夹顺序即 QQ 里的顺序）
  if (key === '') return list.slice(0, FACE_PICK_LIST_ALL_MAX).map((item) => ({ item, score: 0 }))
  // ⚠️ 必须滤掉 score 0：那表示一个词都没命中。
  //   不滤的话模型会收到一批「毫不相关」的候选，还以为是自己要的那类。
  return scoreFaces(list, key)
    .filter((entry) => entry.score > 0)
    .slice(0, max)
}
