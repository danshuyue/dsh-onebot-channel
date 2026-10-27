/**
 * collect.js —— 把收到的表情包存进 QQ 收藏夹。
 *
 * 为什么需要（2026-10-27）：
 *   树树在教 DSH 认表情包 —— 他从 QQ 发商城表情包给她，她学着认。
 *   但「QQ 收藏夹」是另一回事：
 *     - 协议端**没有**「收到图片自动收藏」的逻辑（查过 SnowLuma 源码，
 *       addCustomFace 只被 add_custom_face action 调用，没有任何自动触发点）
 *     - 实测 fetch_custom_face_detail 返回 0 条 —— 收藏夹确实是空的
 *   所以她必须**显式**调 add_custom_face 才能把表情包存进去，
 *   否则 custom_emoji 那条路（发收藏表情）永远是空的。
 *
 * 协议端参数（SnowLuma 2.2.0）：
 *   add_custom_face { file } → { emoji_id }
 *   file 支持三种源（loadBinarySource）：
 *     - http(s):// —— 下载（QQ 图片直链带 rkey，**有时效**）
 *     - file://    —— 本地文件（协议端跟插件同机，能直接读）
 *     - base64://  —— 内联字节
 *
 * ⚠️ 本模块是**受控入口**：不暴露裸 action，只暴露「把某张收到的图存进收藏夹」这一件事。
 *   之前的 C 档封禁 add_custom_face 是为了防止「往收藏夹乱塞东西」，
 *   现在改成「只允许收藏插件自己刚收到过的图」—— 范围更窄，但够用。
 */
import { callOneBot } from './onebot.js'
import { note } from './env.js'
import { recentImage, listRecentImages } from './images.js'

/**
 * 把一条 file:// 路径规范成协议端能读的 file:// URL。
 * Windows 路径要转成 file:///D:/... 这种形式。
 */
export function toFileUrl(localPath) {
  const p = String(localPath ?? '').trim()
  if (p === '') return ''
  if (/^(?:https?|base64|file):/i.test(p)) return p
  // D:\xxx\yyy.jpg → file:///D:/xxx/yyy.jpg
  const normalized = p.replace(/\\/g, '/')
  const withSlash = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `file://${encodeURI(withSlash).replace(/#/g, '%23').replace(/\?/g, '%3F')}`
}

/**
 * 收藏一张表情包。
 *
 * @param {object} options
 * @param {string} [options.file] 图片源：本地路径 / http(s) URL / base64
 * @param {number} [options.recent] 引用最近收到的第 N 张图（1 = 最近一张）
 * @param {string} [options.desc] 备注（表情的名字）
 * @returns {object} { emojiId, source, origin }
 */
export async function collectFace(options = {}) {
  const recent = Number(options?.recent ?? 0)
  const file = String(options?.file ?? '').trim()

  let source = ''
  let origin = ''
  if (file !== '') {
    source = toFileUrl(file)
    origin = '指定文件'
  } else if (recent > 0) {
    const item = recentImage(recent)
    if (item === null) {
      throw new Error(
        `没有第 ${recent} 张最近收到的图片（可能还没收到过图片）。`
        + '可以直接给 file 参数传一个本地路径或图片直链。'
      )
    }
    // 优先用本地副本 —— QQ 直链带 rkey，过一会儿就失效了
    source = item.path !== '' ? toFileUrl(item.path) : item.url
    origin = `最近第 ${recent} 张（${item.name}）`
  } else {
    throw new Error('要给 file（图片路径或直链）或 recent（最近第几张）其中之一')
  }

  if (source === '') throw new Error('图片来源是空的')

  const result = await callOneBot({ action: 'add_custom_face', params: { file: source } })
  if (result?.retcode !== 0) {
    throw new Error(
      `收藏失败：retcode=${result?.retcode} ${result?.wording ?? result?.message ?? ''}`
      + '（QQ 收藏表情有时会限频，失败就等一会儿再试）'
    )
  }
  const emojiId = String(result?.data?.emoji_id ?? '').trim()

  // 顺手加个备注 —— 不然收藏的表情 summary/desc 全是空的，
  // agent 以后只能靠 emoji_id 里的 MD5 找，没法按名字找。
  // 没给 desc 时用文件名兜底（去掉时间戳和 QQ 号前缀，只留原名），
  // 这样每张收藏的表情都有个可搜的名字。
  let desc = String(options?.desc ?? '').trim()
  if (desc === '') desc = defaultDescOf(file, recent)
  if (desc !== '' && emojiId !== '') {
    try {
      await callOneBot({ action: 'modify_custom_face', params: { emoji_id: emojiId, desc } })
    } catch (error) {
      // 备注失败不影响收藏本身 —— 图已经在收藏夹里了
      note('emoji', `收藏备注写入失败（不影响收藏）：${error instanceof Error ? error.message : error}`)
    }
  }

  note('emoji', `已收藏 ${origin} → ${emojiId}${desc !== '' ? `（备注：${desc}）` : ''}`)
  return { emojiId, source, origin, desc }
}

/**
 * 默认备注名。
 *
 * 本地副本的文件名形如 `20261027-180031_3472302240_原名.jpg` ——
 * 前两段是时间戳和 QQ 号，去掉，只留原名。
 */
function defaultDescOf(file, recent) {
  if (file !== '') {
    const base = String(file).split(/[\\/]/).pop() ?? ''
    const cleaned = base.replace(/^\d{8}-\d{6}_\d+_/, '').replace(/\.[a-z0-9]+$/i, '')
    return cleaned.slice(0, 40)
  }
  const item = recentImage(recent)
  if (item === null) return ''
  return String(item.name ?? '').replace(/\.[a-z0-9]+$/i, '').slice(0, 40)
}

/** 列最近收到的图片，给 agent 看有哪些能收藏。 */
export function recentList(limit = 10) {
  return listRecentImages(limit).map((item, index) => ({
    index: index + 1,
    name: item.name,
    uin: item.uin,
    at: item.at,
    path: item.path
  }))
}
