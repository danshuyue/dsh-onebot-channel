/**
 * sys-faces.js —— QQ 官方系统表情目录的搜索与反查。
 *
 * 为什么需要它：
 *   lib/emoticons.js 的内置表是手工整理的（0~348，275 个中文名），
 *   会过时 —— QQ 隔一阵就加新表情，也加新别名。
 *   协议端接了官方目录（fetch_sys_faces / search_sys_faces），
 *   那是 QQ 自己的数据，权威且能查到「比心」这种带空格/斜杠的官方写法。
 *
 * 所以策略是：**先查协议端官方目录，查不到再落内置表**。
 *
 * 实测返回结构（SnowLuma 2.2.0）：
 *   search_sys_faces {query:'比心'}
 *     → { retcode:0, data:{ faces:[ { q_sid:'319', q_des:'/比心', em_code:'10319',
 *                                     is_super:true, url:'...' } ] } }
 *   fetch_sys_faces {}
 *     → { retcode:0, data:{ packs:[ { pack_name:'超级表情', emojis:[ ...同上 ] } ] } }
 *
 * ⚠️ 参数名是 `query`，不是 `keyword` —— 传 keyword 会报 "query: is required"。
 * ⚠️ 这两个是 SnowLuma 的扩展 action，不是 OneBot 11 标准。
 *    别的协议端没有 → 每次调用都要能降级（查不到就返回空，交给内置表兜底）。
 */
import { callOneBot } from './onebot.js'
import { note } from './env.js'

/** 协议端返回的一条表情，规整成插件内部统一形状。 */
function normFace(item) {
  // q_des 形如 '/比心'，前面的斜杠是 QQ 目录本身的写法，去掉更好读
  const raw = String(item?.q_des ?? '').trim()
  const name = raw.replace(/^\/+/, '').trim()
  const id = String(item?.q_sid ?? '').trim()
  if (id === '') return null
  return {
    id,
    name,
    isSuper: item?.is_super === true,
    code: String(item?.em_code ?? '').trim()
  }
}

/**
 * 搜索官方系统表情。
 * 返回 [{ id, name, isSuper, code }]，协议端不支持或出错时返回空数组。
 */
export async function searchSysFaces(query, limit = 20) {
  const q = String(query ?? '').trim()
  if (q === '') return []
  try {
    const result = await callOneBot({ action: 'search_sys_faces', params: { query: q } })
    if (result?.retcode !== 0) {
      note('emoji', `search_sys_faces 失败：retcode=${result?.retcode} ${result?.message ?? ''}`)
      return []
    }
    const list = Array.isArray(result?.data?.faces) ? result.data.faces : []
    return list.map(normFace).filter((item) => item !== null).slice(0, Math.max(1, Number(limit) || 20))
  } catch (error) {
    // 协议端不支持这个 action 是常态，不是错误 —— 静默降级到内置表
    note('emoji', `search_sys_faces 不可用：${error instanceof Error ? error.message : error}`)
    return []
  }
}

/**
 * 拉完整的官方表情目录（按表情包分组）。
 * 返回 [{ packName, faces:[{id,name,...}] }]，拿不到返回空数组。
 *
 * 数据量不小（约 400+ 条），只在用户明确要「列出全部表情」时才调，
 * 平时一律用 search_sys_faces。
 */
export async function fetchSysFacePacks() {
  try {
    const result = await callOneBot({ action: 'fetch_sys_faces', params: {} })
    if (result?.retcode !== 0) {
      note('emoji', `fetch_sys_faces 失败：retcode=${result?.retcode} ${result?.message ?? ''}`)
      return []
    }
    const packs = Array.isArray(result?.data?.packs) ? result.data.packs : []
    return packs
      .map((pack) => ({
        packName: String(pack?.pack_name ?? '').trim(),
        faces: (Array.isArray(pack?.emojis) ? pack.emojis : []).map(normFace).filter((item) => item !== null)
      }))
      .filter((pack) => pack.faces.length > 0)
  } catch (error) {
    note('emoji', `fetch_sys_faces 不可用：${error instanceof Error ? error.message : error}`)
    return []
  }
}

/**
 * 按名字反查官方表情 id —— 用于出站发经典表情。
 *
 * 精确优先：先找名字完全相等的，再找包含关系的。
 * 找不到返回 null —— 调用方要报错，不许发空表情。
 */
export async function lookupSysFaceId(name) {
  const q = String(name ?? '').trim()
  if (q === '') return null
  const list = await searchSysFaces(q, 30)
  if (list.length === 0) return null
  const exact = list.find((item) => item.name === q)
  if (exact !== undefined) return exact
  const partial = list.find((item) => item.name.includes(q) || q.includes(item.name))
  return partial ?? null
}
