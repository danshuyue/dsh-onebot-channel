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
export async function listCustomFaces(limit = 50) {
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

/**
 * 按关键词在收藏夹里找表情。
 * 匹配 summary / desc / emojiId 的包含关系；找不到返回 null。
 *
 * ⚠️ emojiId 的大小写：QQ 返回的是**大写 MD5** 段
 *   （形如 <uin>_0_0_0_<32位大写MD5>_0_0），
 *   而 agent 手上的文件名 / hash 常是小写 —— 不做大小写无关匹配就找不到。
 */
export async function findCustomFace(keyword, limit = 50) {
  const key = String(keyword ?? '').trim()
  if (key === '') return null
  const list = await listCustomFaces(limit)
  if (list.length === 0) return null
  const lower = key.toLowerCase()
  // 先精确匹配 summary，再包含匹配
  const exact = list.find((item) => item.summary.toLowerCase() === lower || item.desc.toLowerCase() === lower)
  if (exact !== undefined) return exact
  const partial = list.find(
    (item) =>
      item.summary.toLowerCase().includes(lower) ||
      item.desc.toLowerCase().includes(lower) ||
      item.emojiId.toLowerCase() === lower ||
      item.emojiId.toLowerCase().includes(lower)
  )
  return partial ?? null
}
