/**
 * images.js —— QQ 图片 -> DSH 附件库 -> image 块。
 *
 * 会话格式是 { type:'image', attachment: ImageAttachmentRef }（dsh 的 wire schema 里 image 是一等块类型），
 * 图片本体走 attachments.saveImages() 存内容寻址附件库，块里只放引用。
 * 模型侧 supportsImages: true，这样投进去 AI 是真能看见图的，不是只看到 [图片] 四个字。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { lookup } from 'node:dns/promises'
import { join } from 'node:path'
import { getConfig } from './config.js'
import { note, serviceOf } from './env.js'
import { DATA_DIR } from './env.js'
import { isBlockedHost } from './collect.js'

/** 按内容嗅探媒体类型 —— 别信 URL 后缀，QQ 的下载链接不带扩展名。 */
export function sniffImageMediaType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return null
}

/** 媒体类型 → 文件扩展名。 */
export function extOfMediaType(mediaType) {
  return { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }[mediaType] ?? 'jpg'
}

/**
 * 单张图片的字节上限（8 MB）—— **只用于「收藏表情」**。
 *
 * 为什么收藏要卡：收藏走 base64 内联，字节数会膨胀 4/3 挂在请求体里；
 * QQ 收藏夹本身也收不下大图。实测 1.07MB 动图稳稳通过，10.7MB 请求体往返 471ms。
 *
 * ⚠️ 别拿它卡**入站**图片（见 INBOUND_IMAGE_MAX_BYTES）—— 那是另一个场景，
 *    收紧会静默吞掉群友发的大图（实测 9MB 图会从「入库 1 张」变成「0 张」）。
 */
export const IMAGE_MAX_BYTES = 8 * 1024 * 1024

/**
 * 入站图片的字节上限（32 MB）—— 群友发什么就收什么，别擅自设卡。
 *
 * 为什么比收藏上限高得多（2026-11-02 审核发现的一次回归）：
 *   收藏表情包那次改造把 `buildImageBlocks` 也接到了 `fetchImageBytes` 上，
 *   于是 8MB 的「收藏」上限顺带压到了**入站**链路：实测 9MB 的群图
 *   从「入库 1 张、agent 能看见」变成「0 张、只看到 [图片] 占位」，而且只记一行日志。
 *   两个场景的上限本来就该分开：入站是「对方发了什么」，收藏是「我要把它塞进 QQ 夹子」。
 *
 * 32MB 是个保守的天花板（只防「一个 GB 级文件把内存拖死」），不是体验限制。
 */
export const INBOUND_IMAGE_MAX_BYTES = 32 * 1024 * 1024

/**
 * 数一下 GIF 有多少帧。
 *
 * ⚠️ 必须**走块结构**，不能裸扫 `0x21 0xF9`（2026-11-02 审核发现）：
 *   裸扫会把落在 LZW 图像数据子块里的偶然字节序列也算进去。
 *   实测那张 1.07MB 的动图：裸扫得 213，结构化解码是 **202** ——
 *   多出来的 11 个全在压缩数据里。差 5% 看着不多，但工具会把错的帧数
 *   报给模型，README 还把它当验收结论写了。
 *
 * 正确走法（GIF89a/87a 规范）：
 *   header(6) + 逻辑屏幕描述符(7) [+ 全局色表] →
 *   循环：0x21 扩展（读 label + 子块链）/ 0x2C 图像描述符（数一帧，跳局部色表 + LZW 子块链）/ 0x3B 结束
 *
 * 非 GIF 返回 0。这是结构统计，不解码像素。
 */
export function gifFrameCount(bytes) {
  if (!(bytes instanceof Uint8Array)) return 0
  if (bytes.length < 14) return 0
  // GIF87a / GIF89a
  if (!(bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)) return 0

  let i = 13 // header(6) + 逻辑屏幕描述符(7)
  const packed = bytes[10]
  if ((packed & 0x80) !== 0) {
    // 全局色表：2^(N+1) 项，每项 3 字节
    i += 3 * (1 << ((packed & 0x07) + 1))
  }
  /** 跳过一串「长度字节 + 数据」子块，直到遇到 0 长度终止符。 */
  const skipSubBlocks = () => {
    while (i < bytes.length) {
      const size = bytes[i]
      i += 1
      if (size === 0) return true
      i += size
    }
    return false // 数据提前结束（文件被截断）
  }

  let frames = 0
  while (i < bytes.length) {
    const marker = bytes[i]
    if (marker === 0x3b) break // 文件结束符
    if (marker === 0x21) {
      // 扩展块：0x21 + label(1) + 子块链
      i += 2
      if (!skipSubBlocks()) break
      continue
    }
    if (marker === 0x2c) {
      // 图像描述符：0x2C + left/top/width/height(8) + packed(1)
      if (i + 9 >= bytes.length) break
      frames += 1
      const localPacked = bytes[i + 9]
      i += 10
      if ((localPacked & 0x80) !== 0) {
        // 局部色表
        i += 3 * (1 << ((localPacked & 0x07) + 1))
      }
      i += 1 // LZW 最小码长
      if (!skipSubBlocks()) break // 跳过 LZW 压缩数据 —— 这一步是关键
      continue
    }
    // 认不出的标记：结构已经不可信，按已数到的算，别硬猜
    break
  }
  return frames
}

/**
 * 下载图片前的最后一道检查：把主机名**解析成 IP**，再判一次是不是内网。
 *
 * 为什么光有 URL 字面检查不够（2026-11-02 实测）：
 *   `http://127.0.0.1.nip.io/` 这种域名形完全合法、看着像公网，
 *   但它解析到 127.0.0.1 —— 字面白名单放行，请求其实打在本机上。
 *   所以真正发请求之前要解析一次，这是第二层。
 *
 * 用 node:dns 的 lookup（走系统解析器，和 fetch 用的是同一套）。
 * 解析失败就直接拒（宁可少拉一张图，也不要盲试一个说不清的地址）。
 */
async function assertPublicHost(url) {
  let parsed
  try {
    parsed = new URL(String(url))
  } catch {
    throw new Error(`地址不合法：${String(url).slice(0, 80)}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`只允许 http / https 图片直链（收到 ${parsed.protocol}）`)
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  // 字面就是 IP（含 IPv6）的，直接判，不用解析
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    if (isBlockedHost(host)) throw new Error(`不给拉内网 / 本机地址：${host}`)
    return
  }
  let addresses = []
  try {
    const resolved = await lookup(host, { all: true })
    addresses = resolved.map((item) => String(item?.address ?? '')).filter((v) => v !== '')
  } catch (error) {
    throw new Error(`解析不了这个域名：${host}（${error instanceof Error ? error.message : error}）`)
  }
  if (addresses.length === 0) throw new Error(`解析不了这个域名：${host}`)
  for (const address of addresses) {
    if (isBlockedHost(address)) {
      throw new Error(`不给拉这个地址：${host} 解析到内网 ${address}（防被指使去探内网）`)
    }
  }
}

/** 最多跟多少次重定向。跟 fetch 默认值一致，但每一跳我们都要自己审。 */
const MAX_REDIRECTS = 5

/**
 * 下载一张图到字节。带超时 + 体积上限，失败抛错（调用方决定怎么降级）。
 *
 * ⚠️ **重定向必须自己跟**（2026-11-02 审核发现）：
 *   `fetch` 默认 `redirect: 'follow'`，但它跟随的每一跳**不会**再回到我们这里。
 *   于是「https://attacker.example/redir」→ 302 Location: http://169.254.169.254/...
 *   就绕过了全部内网检查 —— 我们只审了第一个 URL。
 *   所以改成 `redirect: 'manual'`，自己跟、每一跳都重新过 assertPublicHost。
 *
 * 仍然挡不住的：DNS rebinding（解析和连接之间换 IP）。那是解析器级别的防护，
 *   自用插件不做 —— 但重定向这条是**能挡住且必须挡**的，就不留。
 */
export async function fetchImageBytes(url, options = {}) {
  let target = String(url ?? '').trim()
  if (target === '') throw new Error('图片地址是空的')
  // 上限由调用方定：入站用 INBOUND_IMAGE_MAX_BYTES（宽松），收藏用 IMAGE_MAX_BYTES（收紧）
  const maxBytes = Number(options?.maxBytes) > 0 ? Number(options.maxBytes) : IMAGE_MAX_BYTES
  const config = getConfig()
  const timeoutMs = Number(options?.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : Math.max(5000, Number(config.requestTimeoutMs) * 2 || 16000)
  const deadline = Date.now() + timeoutMs

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    // 每一跳都重新审 —— 这是挡住「公开地址 302 到内网」的关键
    await assertPublicHost(target)
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('下载图片超时')
    const response = await fetch(target, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      // 自己跟，不交给 fetch
      redirect: 'manual',
      signal: AbortSignal.timeout(Math.max(1000, remaining))
    })
    if (response.status >= 300 && response.status < 400) {
      const location = String(response.headers?.get?.('location') ?? '').trim()
      if (location === '') throw new Error(`图片地址返回 ${response.status} 但没给 Location`)
      // 相对跳转要按当前 URL 解析成绝对地址，否则下一跳的检查会拿到半截地址
      try {
        target = new URL(location, target).toString()
      } catch {
        throw new Error(`重定向地址不合法：${location.slice(0, 80)}`)
      }
      continue
    }
    if (!response.ok) throw new Error(`下载图片失败 HTTP ${response.status}`)
    // ⚠️ 先看 Content-Length 再读（2026-11-02 审核发现）：
    //    arrayBuffer() 是「整包读进内存再说」，服务端声明的 80MB 会先吃掉 256MB RSS
    //    才轮到我们判超限。头部就在手上，先拦一道是免费的。
    const declared = Number(response.headers?.get?.('content-length') ?? 0)
    if (Number.isFinite(declared) && declared > maxBytes) {
      try { await response.body?.cancel?.() } catch { /* 关流失败不影响报错 */ }
      throw new Error(`图片太大（服务端声明 ${declared} 字节，上限 ${maxBytes}）`)
    }
    const data = await readBodyBounded(response, maxBytes)
    if (data.length === 0) throw new Error('下载到的图片是空的')
    return data
  }
  throw new Error(`重定向太多次（超过 ${MAX_REDIRECTS} 跳），放弃`)
}

/**
 * 读响应体，边读边累计，超限立即中断。
 *
 * 光看 Content-Length 不够：它可以不声明、也可以撒谎（chunked / 分块推流）。
 * 所以真正落地时还要一道「累计超限就掐断」。
 */
async function readBodyBounded(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length') ?? 0)
  // 没有流式接口（测试里的假 response）就退回整包读 —— 但先按声明值挡过一道
  if (response.body === undefined || response.body === null || typeof response.body.getReader !== 'function') {
    const buffer = new Uint8Array(await response.arrayBuffer())
    if (buffer.length > maxBytes) throw new Error(`图片太大（${buffer.length} 字节，上限 ${maxBytes}）`)
    return buffer
  }
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > maxBytes) {
        // 掐断下载：别为了报个错先把整包收下来
        try { await reader.cancel() } catch { /* 取消失败不影响报错 */ }
        throw new Error(
          `图片太大（已收 ${total} 字节，上限 ${maxBytes}`
          + `${declared > 0 ? `，服务端声明 ${declared}` : ''}）`
        )
      }
      chunks.push(value)
    }
  } finally {
    try { reader.releaseLock?.() } catch { /* 忽略 */ }
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/**
 * 改写文件名里的扩展名。
 * QQ 给的文件名永远是 <MD5>.jpg，但内容可能是 GIF / PNG —— 以真实格式为准。
 */
export function withExt(name, ext) {
  const s = String(name ?? '').trim()
  if (s === '') return `image.${ext}`
  const m = /\.[a-z0-9]+$/i.exec(s)
  if (m === null) return `${s}.${ext}`
  return `${s.slice(0, m.index)}.${ext}`
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
 *
 * @param {boolean} [remember] 要不要记进「最近收到的图片」索引（默认要）。
 *   卡片里的图必须传 false（2026-11-09 审核发现）：那些是**别人转发进来的**图，
 *   记进索引会让 qq_collect_face 的 recent/index 取到陌生人转发的图，
 *   而且索引里的时间戳是「下载时刻」不是「卡片原时间」，三天前的记录会排到最新。
 *   磁盘副本照留 —— 人还能翻，只是别让工具误把它当成「刚收到的图」。
 */
function saveImageCopy(data, mediaType, seg, uin, remember = true) {
  const dir = imageCopyDirOf()
  if (dir === '') return ''
  try {
    mkdirSync(dir, { recursive: true })
    const ext = extOfMediaType(mediaType)
    const now = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    // 原名是 QQ 的哈希名，前面加时间戳和来源 QQ 号，既不重名也能一眼看出是谁发的
    const original = String(seg?.file ?? '').replace(/[\\/:*?"<>|]/g, '_').trim()
    const base = original !== ''
      ? original
      : `${createHash('sha256').update(data).digest('hex').slice(0, 8)}.${ext}`
    // ⚠️ 扩展名**按真实格式**改写，不沿用 QQ 给的那个。
    //   QQ 发来的表情包文件名一律是 <MD5>.jpg，但内容经常是 GIF（QQ 商城表情基本都是 GIF）。
    //   之前原样保留 .jpg，导致「看到的格式」和「实际格式」对不上 ——
    //   收藏夹里存进去的 GIF 顶着 .jpg 的名字，AI 看图时也认不出是动图。
    const path = join(dir, `${stamp}_${uin}_${withExt(base, ext)}`)
    writeFileSync(path, data)
    note('image', `副本已存 ${path}`)
    // 记进「最近收到的图片」索引 —— 收藏表情包时要用它拿本地路径。
    // name 用**落盘后的真实文件名**（扩展名已按真实格式修正），别用 QQ 原始的 .jpg 名。
    // remember=false 时不记（卡片里别人转发的图不该混进「刚收到的图」）。
    if (remember) rememberImage({ path, url: String(seg?.url ?? ''), uin, name: withExt(base, ext), at: Date.now() })
    return path
  } catch (error) {
    note('image', `副本保存失败 ${error instanceof Error ? error.message : error}`)
    return ''
  }
}

/**
 * 最近收到的图片索引（内存环形缓冲，最多 60 张）。
 *
 * 干什么用：用户在教 DSH 认表情包 —— 她收到图片后要能把它**存进 QQ 收藏夹**。
 * 协议端的 add_custom_face 要的是一个「它能读到的图片源」：
 *   - http(s):// —— QQ 的图片直链，**带 rkey 有时效**，过一会儿就失效
 *   - file://    —— 本地文件（协议端跟插件同机，能直接读）
 *   - base64://  —— 内联字节
 * 所以最稳的是用本地副本路径。这个索引就是给「引用最近第 N 张图」用的。
 */
const RECENT_LIMIT = 60
const recentImages = []

/** 记一张收到的图片。 */
function rememberImage(item) {
  recentImages.push(item)
  while (recentImages.length > RECENT_LIMIT) recentImages.shift()
}

/**
 * 取最近收到的图片。
 *
 * @param {number} [index=1] 1 = 最近一张，2 = 倒数第二张，以此类推
 * @returns {object|null} { path, url, uin, name, at }
 */
export function recentImage(index = 1) {
  const n = Math.max(1, Number(index) || 1)
  const item = recentImages[recentImages.length - n]
  return item ?? null
}

/** 最近收到的图片列表（新的在前）。 */
export function listRecentImages(limit = 10) {
  const n = Math.max(1, Math.min(RECENT_LIMIT, Number(limit) || 10))
  return recentImages.slice(-n).reverse()
}

/**
 * 把消息里的图片下载下来：存进 DSH 附件库（AI 能看）+ 落一份副本（人能翻）。
 * 传进来的是一条条消息对象（{ message: [段] }），真正要扫的是里面的段数组。
 * 任何一步失败都只记日志、返回空 —— 文本里已有 [图片] 占位，主链路不受影响。
 */
export async function buildImageBlocks(ctx, messages, options = {}) {
  const blocks = []
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
        // ⚠️ 上限用入站那一档（宽松），不是收藏那一档 —— 见 INBOUND_IMAGE_MAX_BYTES 的注释。
        const data = await fetchImageBytes(seg.url, { maxBytes: INBOUND_IMAGE_MAX_BYTES })
        const mediaType = sniffImageMediaType(data)
        if (mediaType === null) throw new Error(`认不出的图片格式（${data.length} 字节）`)
        saveImageCopy(data, mediaType, seg, uin, options?.remember !== false)
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
