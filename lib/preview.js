/**
 * preview.js —— 把「收到的图片」里的表情包**以图片的形式**交给 agent 看。
 *
 * 为什么需要（2026-10-27）：
 *   树树在教 DSH 认表情包。他从 QQ 发了 42 张商城表情过去，糖糖要收藏它们。
 *   但 QQ 发过来的图片，文件名全是 MD5 哈希（如 05C1B8CDC368297E5ECBF46422BEB110.jpg），
 *   **没有任何可读名字**。而 QQ 收藏表情的备注（desc）才是以后按名字找回它的唯一线索。
 *
 *   也就是说：光给糖糖一个文件列表，她写不出备注 —— 得**先看见图**，才能起名。
 *
 * 做法：
 *   把本地副本读出来 → attachments.saveImages() 存进 DSH 附件库（内容寻址）
 *   → 工具结果里带 image 块 → 模型的 tool result 里直接出现图片
 *
 * ⚠️ DSH 的 tool result **允许**带 image 块（宿主校验只禁止 system 角色带图，
 *   user / tool 都允许）。所以这条路是通的。
 */
import { note, serviceOf } from './env.js'
import { listImageDir, readLocalImage } from './collect.js'

/** 一次最多看几张 —— 模型的单请求图片数有上限，超了会被宿主拒绝。 */
const MAX_PREVIEW = 6

/**
 * 取要预览的图片（按目录序号）。
 *
 * @param {object} options
 * @param {number} [options.index] 单张的序号（1 = 最早收到的那张）
 * @param {number} [options.from] 起始序号
 * @param {number} [options.count] 连续几张（默认 1）
 * @returns {object} { dir, total, items:[{index,label,name,path,mediaType,bytes}] }
 */
export function pickPreviews(options = {}) {
  const listed = listImageDir(500)
  const index = Number(options?.index ?? 0)
  const from = Number(options?.from ?? 0)
  const count = Math.max(1, Math.min(MAX_PREVIEW, Number(options?.count ?? 1) || 1))

  let wanted = []
  if (index > 0) {
    const item = listed.files[index - 1]
    if (item === undefined) {
      throw new Error(`「收到的图片」目录里没有第 ${index} 张（现有 ${listed.total} 张）。先调 qq_collect_face 的 dir=true 看清单。`)
    }
    wanted = [item]
  } else if (from > 0) {
    wanted = listed.files.slice(from - 1, from - 1 + count)
    if (wanted.length === 0) {
      throw new Error(`「收到的图片」目录里没有第 ${from} 张起的图（现有 ${listed.total} 张）。`)
    }
  } else {
    // 不给参数就取最前面的几张（最早收到的）
    wanted = listed.files.slice(0, count)
    if (wanted.length === 0) {
      throw new Error(`「收到的图片」目录是空的（${listed.dir}）。`)
    }
  }

  const items = []
  for (const item of wanted) {
    const read = readLocalImage(item.path)
    items.push({
      index: item.index,
      label: item.label,
      name: item.name,
      path: item.path,
      mediaType: read.mediaType,
      bytes: read.bytes,
      data: read.data
    })
  }
  return { dir: listed.dir, total: listed.total, items }
}

/**
 * 把预览的图片存进附件库，返回可以放进 image 块的引用。
 *
 * @param {object} ctx DSH 上下文（要拿 attachments 服务）
 * @param {Array} items pickPreviews 的 items
 * @returns {Array} [{index, label, ref}] —— ref 是 {type:'image', attachment: ...} 里的 attachment
 */
export async function attachPreviews(ctx, items) {
  const attachments = serviceOf(ctx, 'attachments')
  if (attachments === undefined || attachments === null || typeof attachments.saveImages !== 'function') {
    throw new Error('DSH 附件服务不可用，看不了图 —— 先存进收藏夹再起名也一样')
  }
  const out = []
  for (const item of items) {
    // 一次存一张：saveImages 是批量的，但我们要逐张对上序号，出错时好定位。
    const refs = await attachments.saveImages([
      { data: item.data, mediaType: item.mediaType, name: `${String(item.index).padStart(3, '0')}_${item.label}` }
    ])
    const ref = Array.isArray(refs) ? refs[0] : refs
    if (ref === undefined || ref === null) throw new Error(`第 ${item.index} 张图存进附件库失败`)
    out.push({ index: item.index, label: item.label, mediaType: item.mediaType, bytes: item.bytes, ref })
  }
  note('emoji', `预览 ${out.length} 张图：${out.map((o) => `#${o.index}`).join(',')}`)
  return out
}
