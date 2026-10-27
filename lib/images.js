/**
 * images.js —— QQ 图片 -> DSH 附件库 -> image 块。
 *
 * 会话格式是 { type:'image', attachment: ImageAttachmentRef }（dsh 的 wire schema 里 image 是一等块类型），
 * 图片本体走 attachments.saveImages() 存内容寻址附件库，块里只放引用。
 * 模型侧 supportsImages: true，这样投进去 AI 是真能看见图的，不是只看到 [图片] 四个字。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfig } from './config.js'
import { note, serviceOf } from './env.js'
import { DATA_DIR } from './env.js'

/** 按内容嗅探媒体类型 —— 别信 URL 后缀，QQ 的下载链接不带扩展名。 */
export function sniffImageMediaType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return null
}

/** 这条消息里能下载的图片段。 */
export function imageSegmentsOf(message) {
  if (!Array.isArray(message)) return []
  const list = []
  for (const segment of message) {
    if (segment?.type !== 'image') continue
    const url = String(segment?.data?.url ?? '')
    if (url === '') continue
    list.push({ url, file: String(segment?.data?.file ?? '') })
  }
  return list
}

/** 图片副本目录：默认 <workspaceCwd>\收到的图片；配置 imageCopyDir 可改，设 "off" 关掉。 */
function imageCopyDirOf() {
  const config = getConfig()
  const configured = String(config.imageCopyDir ?? '').trim()
  if (configured.toLowerCase() === 'off') return ''
  if (configured !== '') return configured
  return join(String(config.workspaceCwd ?? '') || DATA_DIR, '收到的图片')
}

/**
 * 落一份人能看的副本（带时间戳命名），返回保存路径。
 * 跟附件库互不影响：哪边失败都不耽误另一边，更不耽误主链路。
 */
function saveImageCopy(data, mediaType, seg, uin) {
  const dir = imageCopyDirOf()
  if (dir === '') return ''
  try {
    mkdirSync(dir, { recursive: true })
    const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }[mediaType] ?? 'jpg'
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    // 原名是 QQ 的哈希名，前面加时间戳和来源 QQ 号，既不重名也能一眼看出是谁发的
    const original = String(seg?.file ?? '').replace(/[\\/:*?"<>|]/g, '_').trim()
    const base = original !== ''
      ? original
      : `${createHash('sha256').update(data).digest('hex').slice(0, 8)}.${ext}`
    const path = join(dir, `${stamp}_${uin}_${base}`)
    writeFileSync(path, data)
    note('image', `副本已存 ${path}`)
    return path
  } catch (error) {
    note('image', `副本保存失败 ${error instanceof Error ? error.message : error}`)
    return ''
  }
}

/**
 * 把消息里的图片下载下来：存进 DSH 附件库（AI 能看）+ 落一份副本（人能翻）。
 * 传进来的是一条条消息对象（{ message: [段] }），真正要扫的是里面的段数组。
 * 任何一步失败都只记日志、返回空 —— 文本里已有 [图片] 占位，主链路不受影响。
 */
export async function buildImageBlocks(ctx, messages) {
  const blocks = []
  const config = getConfig()
  let attachments = null
  try {
    attachments = serviceOf(ctx, 'attachments')
  } catch {
    attachments = null
  }
  const canAttach = attachments !== undefined && attachments !== null && typeof attachments.saveImages === 'function'
  const segmentsOf = (item) => imageSegmentsOf(Array.isArray(item) ? item : item?.message)
  if (!canAttach && messages.some((item) => segmentsOf(item).length > 0)) {
    note('image', 'attachments 服务不可用，图片只存副本，AI 侧退化成 [图片] 占位')
  }
  for (const item of messages) {
    const uin = String(item?.sender?.user_id ?? '')
    for (const seg of segmentsOf(item)) {
      try {
        // QQ 图片链接带 rkey 有时效，拿到就得立刻下载。
        // 必须带超时：这里卡住会连坐整个私聊轮询链（自调度循环等它跑完），
        // 图床挂死时表现就是「这个号从此再不收消息」。跟 callOneBot 一个口径。
        const response = await fetch(seg.url, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(Math.max(5000, Number(config.requestTimeoutMs) * 2 || 16000))
        })
        if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`)
        const data = new Uint8Array(await response.arrayBuffer())
        const mediaType = sniffImageMediaType(data)
        if (mediaType === null) throw new Error(`认不出的图片格式（${data.length} 字节）`)
        saveImageCopy(data, mediaType, seg, uin)
        if (!canAttach) continue
        const refs = await attachments.saveImages([{ data, mediaType, name: seg.file !== '' ? seg.file : undefined }])
        for (const ref of refs) blocks.push({ type: 'image', attachment: ref })
      } catch (error) {
        note('image', `图片入库失败（${seg.file || seg.url.slice(0, 60)}）：${error instanceof Error ? error.message : error}`)
      }
    }
  }
  return blocks
}
