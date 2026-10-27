/**
 * face-resolve.js —— 经典表情名 → face 段 id 的最终解析。
 *
 * 顺序是「官方目录优先，内置表兜底」：
 *   1. 纯数字 → 当编号用，但要**过有效性校验**
 *   2. 查协议端官方目录（search_sys_faces）—— QQ 自己的数据，权威，能查到新表情和官方写法
 *   3. 落内置表（lib/emoticons.js，0~348）—— 官方目录不可用时（别的协议端）靠它兜住
 *   4. 都不行 → 抛错，让调用方明确报错，不发空表情
 *
 * ⚠️ 单独成文件是为了避开循环依赖：
 *    onebot.js → emoticons.js（渲染要用）→ 若 emoticons 再 import sys-faces
 *    → sys-faces → onebot.js，就成环了。所以解析逻辑放在这一层。
 *
 * ⚠️⚠️ 为什么必须有有效性校验（2026-10-27 踩的坑）：
 *    协议端 makeFaceElem 会**无条件**先跑 SysFaceStore.resolve(faceId)，
 *    而 resolve 在本地目录里查不到这个 id 时，会去 OIDB 0x9155 单查 ——
 *    查不到就抛 "id N sysemojis cfg not found"，**整条消息发不出去**（不是丢个表情）。
 *
 *    而内置表有 109 个「幽灵 id」（官方目录里根本没有）：比如内置表说「晕」=17，
 *    官方目录里「晕」其实是 34，17 那个位置压根不存在。
 *    拿幽灵 id 去发，整条回复直接炸 —— 实测把她两条回复整条吞了。
 *
 *    所以：**发送前必须确认 id 在官方目录里存在**，宁可丢掉这个表情，也不能让整条消息失败。
 */
import { faceIdOf } from './emoticons.js'
import { lookupSysFaceId, isKnownSysFaceId } from './sys-faces.js'

/**
 * 解析成 face 段的 id。
 * 认不出来抛错 —— 不返回 null，避免调用方忘了判空就发出去。
 *
 * @param {string|number} nameOrId 表情名或编号
 * @param {object} [options]
 * @param {boolean} [options.requireKnown=true] 是否要求 id 在官方目录里存在。
 *   默认 true —— 这是防炸的关键。官方目录不可用时（别的协议端）自动放行。
 */
export async function resolveFaceId(nameOrId, options = {}) {
  const raw = String(nameOrId ?? '').trim()
  if (raw === '') throw new Error('表情名是空的')
  const requireKnown = options.requireKnown !== false

  // 纯数字：编号就是 id，但要先验有效性
  if (/^\d+$/.test(raw)) {
    const id = Number(raw)
    if (!Number.isSafeInteger(id) || id < 0) throw new Error(`不是合法的表情编号：${raw}`)
    if (requireKnown && !(await isKnownSysFaceId(id))) {
      throw new Error(
        `表情编号 ${id} 在 QQ 官方表情目录里不存在（内置表情表可能记错了）。`
        + '换用中文名，或先用 qq_emoji_search 查一下正确的编号。'
      )
    }
    return id
  }

  // 官方目录优先
  try {
    const hit = await lookupSysFaceId(raw)
    if (hit !== null) return Number(hit.id)
  } catch {
    /* 官方目录不可用，往下走内置表 */
  }

  // 内置表兜底
  const fallback = faceIdOf(raw)
  if (fallback !== null) {
    if (requireKnown && !(await isKnownSysFaceId(fallback))) {
      throw new Error(
        `内置表情表里的「${raw}」(编号 ${fallback}) 在 QQ 官方目录里不存在，发出去会导致整条消息失败。`
        + '换用中文名，或先用 qq_emoji_search 查一下正确的编号。'
      )
    }
    return fallback
  }

  throw new Error(
    `不认识的 QQ 表情：${raw}`
    + '（可以给中文名如「呲牙」「比心」，或直接给编号如 13）'
  )
}

/**
 * 安全解析：解析不出来返回 null，**不抛错**。
 *
 * 供「发表情失败不能连累整条消息」的场景用 —— 发不出去就不发表情，
 * 文字照发。宁可少个表情，也不能让整条回复凭空消失。
 */
export async function resolveFaceIdSafe(nameOrId) {
  try {
    return await resolveFaceId(nameOrId)
  } catch {
    return null
  }
}

/** 解析成 face 段对象。 */
export async function resolveFaceSegment(nameOrId, options = {}) {
  const id = await resolveFaceId(nameOrId, options)
  return { type: 'face', data: { id: String(id) } }
}
