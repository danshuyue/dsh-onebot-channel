/**
 * face-resolve.js —— 经典表情名 → face 段 id 的最终解析。
 *
 * 顺序是「官方目录优先，内置表兜底」：
 *   1. 纯数字 → 直接当编号用（编号是协议端认的，写错会报错，不猜）
 *   2. 查协议端官方目录（search_sys_faces）—— QQ 自己的数据，权威，能查到新表情和官方写法
 *   3. 落内置表（lib/emoticons.js，0~348）—— 官方目录不可用时（别的协议端）靠它兜住
 *   4. 都不行 → 抛错，让调用方明确报错，不发空表情
 *
 * ⚠️ 单独成文件是为了避开循环依赖：
 *    onebot.js → emoticons.js（渲染要用）→ 若 emoticons 再 import sys-faces
 *    → sys-faces → onebot.js，就成环了。所以解析逻辑放在这一层。
 */
import { faceIdOf } from './emoticons.js'
import { lookupSysFaceId } from './sys-faces.js'

/**
 * 解析成 face 段的 id（数字）。
 * 认不出来抛错 —— 不返回 null，避免调用方忘了判空就发出去。
 */
export async function resolveFaceId(nameOrId) {
  const raw = String(nameOrId ?? '').trim()
  if (raw === '') throw new Error('表情名是空的')

  // 纯数字：编号就是 id，直接用
  if (/^\d+$/.test(raw)) {
    const id = Number(raw)
    if (Number.isSafeInteger(id) && id >= 0) return id
    throw new Error(`不是合法的表情编号：${raw}`)
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
  if (fallback !== null) return fallback

  throw new Error(
    `不认识的 QQ 表情：${raw}`
    + '（可以给中文名如「呲牙」「比心」，或直接给编号如 13）'
  )
}

/** 解析成 face 段对象。 */
export async function resolveFaceSegment(nameOrId) {
  const id = await resolveFaceId(nameOrId)
  return { type: 'face', data: { id: String(id) } }
}
