/**
 * collect.js —— 把收到的表情包存进 QQ 收藏夹。
 *
 * 为什么需要（2026-10-27）：
 *   树树在教 DSH 认表情包 —— 他从 QQ 发商城表情包给她，她学着认。
 *   但「QQ 收藏夹」是另一回事：
 *     - 协议端**没有**「收到图片自动收藏」的逻辑（查过 SnowLuma 源码，
 *       addCustomFace 只被 add_custom_face action 调用，没有任何自动触发点）
 *     - 所以她必须**显式**调 add_custom_face 才能把表情包存进去，
 *       否则 custom_emoji 那条路（发收藏表情）永远是空的。
 *
 * 协议端参数（SnowLuma 2.2.1）：
 *   add_custom_face { file } → { emoji_id }
 *   file 支持三种源（loadBinarySource）：
 *     - http(s):// —— 由**协议端**去下载
 *     - file://    —— 由**协议端**读它自己那台机器的磁盘
 *     - base64://  —— 内联字节，协议端只管解码
 *
 * ⚠️⚠️ 为什么一律走 base64://（2026-11-02，踩过一次大坑）：
 *   以前这里把本地副本路径转成 file:// 交过去，默认「协议端跟插件同机」。
 *   实测这台机器的协议端跑在 192.168.79.128（VM 网段），localhost:3003 根本没监听 ——
 *   于是协议端 stat 的是**它自己**的 D: 盘，每次都是 ENOENT：
 *   「收藏表情包」这条链路整条静默失效，跟 GIF / 静态图无关，什么图都收不进去。
 *   base64:// 把字节塞进请求体，跟两边文件系统彻底解耦，
 *   而且能保证发出去的就是**我们本地这份字节**（GIF 的每一帧都在，实测 213 帧原样保留）。
 *
 * ⚠️ 本模块是**受控入口**：不暴露裸 action，只暴露「把某张收到的图存进收藏夹」这一件事。
 */
import { callOneBot } from './onebot.js'
import { note, DATA_DIR } from './env.js'
import { getConfig } from './config.js'
import {
  recentImage,
  listRecentImages,
  sniffImageMediaType,
  fetchImageBytes,
  gifFrameCount,
  IMAGE_MAX_BYTES
} from './images.js'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 把一张图变成协议端能收的 base64:// 源。
 *
 * 为什么不给 http(s):// 直链让协议端自己下：QQ 图片直链带 rkey，有时效，
 * 而且我们本来就要嗅一遍真实格式（QQ 给的文件名永远是 .jpg，内容常是 GIF）。
 */
export function toBase64Source(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data ?? [])
  if (bytes.length === 0) throw new Error('图片来源是空的')
  if (bytes.length > IMAGE_MAX_BYTES) {
    throw new Error(
      `图片太大（${bytes.length} 字节，上限 ${IMAGE_MAX_BYTES}）。`
      + 'QQ 收藏表情本身也有体积限制，这么大的多半存不进去。'
    )
  }
  return `base64://${Buffer.from(bytes).toString('base64')}`
}

/**
 * 收藏一张表情包。
 *
 * @param {object} options
 * @param {string} [options.message_id] 从某条消息里取图（get_msg → 下载），最直接的一条路
 * @param {number} [options.image] 那条消息里的第几张图（1 = 第一张，默认 1）
 * @param {string} [options.file] 本地路径 / http(s) 直链
 * @param {number} [options.recent] 引用最近收到的第 N 张图（1 = 最近一张）
 * @param {number} [options.index] 引用「收到的图片」目录里的第 N 张（1 = 最早收到的）
 * @param {string} [options.desc] 备注（表情的名字）
 * @returns {object} { emojiId, source, origin, desc, mediaType, bytes, frames }
 */
export async function collectFace(options = {}) {
  const resolved = await resolveSource(options)
  const mediaType = sniffImageMediaType(resolved.data)
  if (mediaType === null) {
    throw new Error(
      `${resolved.origin} 不是能识别的图片格式（${resolved.data.length} 字节，头 ${headOf(resolved.data)}）。`
      + 'QQ 收藏夹只收 jpg / png / gif / webp。'
    )
  }
  const frames = gifFrameCount(resolved.data)
  const source = toBase64Source(resolved.data)

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
  // 没给 desc 时用来源兜底，这样每张收藏的表情都有个可搜的名字。
  let desc = String(options?.desc ?? '').trim()
  if (desc === '') desc = resolved.fallbackName.slice(0, 40)
  if (desc !== '' && emojiId !== '') {
    try {
      await callOneBot({ action: 'modify_custom_face', params: { emoji_id: emojiId, desc } })
    } catch (error) {
      // 备注失败不影响收藏本身 —— 图已经在收藏夹里了
      note('emoji', `收藏备注写入失败（不影响收藏）：${error instanceof Error ? error.message : error}`)
    }
  }

  const sizeNote = frames > 0 ? `，动图 ${frames} 帧` : ''
  note('emoji', `已收藏 ${resolved.origin} → ${emojiId}（${mediaType}${sizeNote}${desc !== '' ? `，备注：${desc}` : ''}）`)
  return {
    emojiId,
    source,
    origin: resolved.origin,
    desc,
    mediaType,
    bytes: resolved.data.length,
    frames
  }
}

/** 头几个字节的十六进制，报错时用来判断「这到底是不是图」。 */
function headOf(data) {
  return Array.from(data.slice(0, 4)).map((b) => Number(b).toString(16).padStart(2, '0')).join(' ')
}

/**
 * 把用户给的「来源」解析成字节 + 人话描述。
 *
 * 优先级：message_id → file → index → recent。
 * 全都没有就报错，别猜。
 */
async function resolveSource(options) {
  const messageId = String(options?.message_id ?? '').trim()
  if (messageId !== '') return await sourceFromMessage(messageId, Number(options?.image ?? 0))

  const file = String(options?.file ?? '').trim()
  if (file !== '') return await sourceFromFile(file)

  const index = Number(options?.index ?? 0)
  if (index > 0) {
    // 按目录序号 —— 这是「批量收藏历史表情包」的主路径
    const listed = listImageDir(500)
    const item = listed.files[index - 1]
    if (item === undefined) {
      throw new Error(
        `「收到的图片」目录里没有第 ${index} 张（现有 ${listed.total} 张）。`
        + '先调 dir=true 看看有哪些。'
      )
    }
    return {
      data: readBytesOfLocal(item.path),
      origin: `第 ${index} 张（${item.label}）`,
      fallbackName: String(item.label ?? '')
    }
  }

  const recent = Number(options?.recent ?? 0)
  if (recent > 0) {
    const item = recentImage(recent)
    if (item === null) {
      throw new Error(
        `没有第 ${recent} 张最近收到的图片（可能还没收到过图片，或者 DSH 重启过 —— 那个索引在内存里）。`
        + '可以直接给 message_id（某条消息里的图）、index（目录序号）或 file（本地路径）。'
      )
    }
    // 优先用本地副本 —— QQ 直链带 rkey，过一会儿就失效了
    const data = item.path !== '' && existsSync(item.path)
      ? readBytesOfLocal(item.path)
      : await fetchImageBytes(item.url)
    return {
      data,
      origin: `最近第 ${recent} 张（${item.name}）`,
      fallbackName: String(item.name ?? '').replace(/\.[a-z0-9]+$/i, '')
    }
  }

  throw new Error(
    '要给 message_id（某条消息里的表情包）、index（目录序号）、recent（最近第几张）'
    + '或 file（本地路径 / 图片直链）其中之一'
  )
}

/**
 * 从一条消息里取图。
 *
 * 为什么要这条路（2026-11-02）：群友刚发一张表情包时它还没落进「收到的图片」目录
 * （那条链只在投递时顺带下载），agent 手上只有正文里的 [#消息编号]。
 * 有了 message_id 就能「看到哪条、收哪条」，不用等缓存。
 *
 * ⚠️ 段类型两种都可能：QQ 商城表情在 SnowLuma 里是 image（sub_type 1，summary=[动画表情]），
 *   有的实现给 mface（带 url）。两种都认。
 */
async function sourceFromMessage(messageId, pick) {
  const result = await callOneBot({ action: 'get_msg', params: { message_id: messageId } })
  if (result?.retcode !== 0) {
    throw new Error(
      `取不到消息 ${messageId}：retcode=${result?.retcode} ${result?.wording ?? result?.message ?? ''}`
      + '（编号写错了，或者那条消息已经被撤回）'
    )
  }
  const segments = Array.isArray(result?.data?.message) ? result.data.message : []
  const images = []
  for (const segment of segments) {
    if (segment?.type !== 'image' && segment?.type !== 'mface') continue
    const url = String(segment?.data?.url ?? '').trim()
    if (url === '') continue
    images.push({
      url,
      name: String(segment?.data?.file ?? ''),
      summary: String(segment?.data?.summary ?? '')
    })
  }
  if (images.length === 0) {
    throw new Error(`消息 ${messageId} 里没有图片或表情包（段类型：${segments.map((s) => s?.type).join(',') || '空'}）`)
  }
  const nth = Number.isFinite(pick) && pick > 0 ? Math.trunc(pick) : 1
  const target = images[nth - 1]
  if (target === undefined) {
    throw new Error(`消息 ${messageId} 里只有 ${images.length} 张图，没有第 ${nth} 张`)
  }
  const data = await fetchImageBytes(target.url)
  return {
    data,
    origin: `消息 ${messageId} 的第 ${nth} 张${target.summary !== '' ? `（${target.summary}）` : ''}`,
    fallbackName: String(target.name ?? '').replace(/\.[a-z0-9]+$/i, '')
  }
}

/** 本地路径或 http(s) 直链。 */
async function sourceFromFile(file) {
  if (/^https?:\/\//i.test(file)) {
    const data = await fetchImageBytes(file)
    return { data, origin: `直链 ${file.slice(0, 80)}`, fallbackName: nameFromUrl(file) }
  }
  if (/^base64:/i.test(file)) {
    const stripped = file.replace(/^base64:\/\//i, '')
    const data = new Uint8Array(Buffer.from(stripped, 'base64'))
    return { data, origin: 'base64 内联字节', fallbackName: '' }
  }
  if (!existsSync(file)) {
    throw new Error(
      `本地文件不存在：${file}`
      + '（要给 QQ 图片直链就用 http(s):// 开头，要给某条消息里的图就用 message_id）'
    )
  }
  return {
    data: readBytesOfLocal(file),
    origin: `本地文件 ${file.split(/[\\/]/).pop() ?? file}`,
    fallbackName: defaultDescOf(file)
  }
}

/** 读本地文件（带上限，别把整个盘读进内存）。 */
function readBytesOfLocal(path) {
  const data = new Uint8Array(readFileSync(path))
  if (data.length === 0) throw new Error(`图片是空文件：${path}`)
  if (data.length > IMAGE_MAX_BYTES) {
    throw new Error(`图片太大（${data.length} 字节，上限 ${IMAGE_MAX_BYTES}）：${path}`)
  }
  return data
}

/** 从直链里猜个名字（给备注兜底用）。 */
function nameFromUrl(url) {
  try {
    const base = String(new URL(url).pathname.split('/').pop() ?? '')
    return base.replace(/\.[a-z0-9]+$/i, '').slice(0, 40)
  } catch {
    return ''
  }
}

/**
 * 默认备注名。
 *
 * 本地副本的文件名形如 `20261027-180031_3472302240_原名.jpg` ——
 * 前两段是时间戳和 QQ 号，去掉，只留原名。
 */
function defaultDescOf(file) {
  const base = String(file).split(/[\\/]/).pop() ?? ''
  return base.replace(/^\d{8}-\d{6}_\d+_/, '').replace(/\.[a-z0-9]+$/i, '').slice(0, 40)
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

/**
 * 列「收到的图片」目录里的文件（按时间升序）。
 *
 * 为什么需要这个（2026-10-27）：
 *   糖糖要收藏那 42 张表情包，但她**没有列目录的工具** ——
 *   插件的「最近收到的图片」索引是**内存**的，DSH 一重启就空了。
 *   目录里的文件却是持久的（43 张都在），所以要能从目录直接列出来。
 *
 * 文件名格式：`<时间戳>_<QQ号>_<原名>.<真实扩展名>`，时间戳本身就是接收顺序，
 * 排序后天然就是「先收到的在前」。
 *
 * ⚠️ 扩展名是**按真实格式**写的（QQ 给的名字永远是 .jpg，但内容常是 GIF）。
 */
export function listImageDir(limit = 100) {
  const config = getConfig()
  const configured = String(config.imageCopyDir ?? '').trim()
  const dir = configured !== '' && configured.toLowerCase() !== 'off'
    ? configured
    : join(String(config.workspaceCwd ?? '') || DATA_DIR, '收到的图片')
  if (!existsSync(dir)) return { dir, files: [] }
  let names = []
  try {
    names = readdirSync(dir).filter((name) => /\.(jpg|jpeg|png|gif|webp)$/i.test(name))
  } catch {
    return { dir, files: [] }
  }
  // 文件名以时间戳开头 → 字典序就是时间序
  names.sort()
  const n = Math.max(1, Math.min(500, Number(limit) || 100))
  const picked = names.slice(0, n)
  return {
    dir,
    total: names.length,
    files: picked.map((name, index) => ({
      index: index + 1,
      name,
      // 原名（去掉时间戳和 QQ 号前缀）—— 用它当备注名
      label: name.replace(/^\d{8}-\d{6}_\d+_/, '').replace(/\.[a-z0-9]+$/i, ''),
      path: join(dir, name)
    }))
  }
}

/**
 * 读一张「收到的图片」，返回字节和真实媒体类型。
 *
 * 用途：给 agent 看图（预览），以及确认文件是不是真的是图片。
 */
export function readLocalImage(path) {
  const p = String(path ?? '').trim()
  if (p === '') throw new Error('图片路径是空的')
  if (!existsSync(p)) throw new Error(`图片不存在：${p}`)
  const data = readBytesOfLocal(p)
  const mediaType = sniffImageMediaType(data)
  if (mediaType === null) throw new Error(`不是能识别的图片格式：${p}`)
  return { data, mediaType, bytes: data.length, frames: gifFrameCount(data), path: p }
}

/**
 * 删除收藏夹里的一个表情。
 *
 * 协议端有 delete_custom_face（糖糖之前说「不能删」——其实有，是她没看到）。
 * ⚠️ 这是**不可逆**的：删了就没了，得重新收藏才能恢复。
 */
export async function deleteCustomFace(emojiId) {
  const id = String(emojiId ?? '').trim()
  if (id === '') throw new Error('emoji_id 是空的')
  const result = await callOneBot({ action: 'delete_custom_face', params: { emoji_id: id } })
  if (result?.retcode !== 0) {
    throw new Error(`删除收藏表情失败：retcode=${result?.retcode} ${result?.wording ?? result?.message ?? ''}`)
  }
  note('emoji', `已删除收藏表情 ${id}`)
  return { emojiId: id }
}
