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
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
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

/**
 * 单个主机串（已经小写、去掉方括号）是不是本机 / 内网 / 保留地址。
 * 拆出来单独一个函数，是因为「DNS 解析出 IP 之后」还要用它再判一次。
 */
function isBlockedHost(host) {
  const h = String(host ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (h === '') return true
  // ⚠️ 末尾的点必须去掉再判：`localhost.` 是完全合法的绝对域名写法，
  //    指向的仍然是 localhost。不处理就等于白名单形同虚设（实测漏过一次）。
  const bare = h.replace(/\.+$/, '')
  if (bare === '') return true
  if (bare === 'localhost' || bare.endsWith('.localhost') || bare === 'localhost.localdomain') return true

  // IPv4 私有 / 保留段
  //
  // ⚠️ 这里必须认得「省略段」和「整数/十六进制」写法，而不只是 a.b.c.d：
  //    `127.1`、`2130706433`、`0x7f.0.0.1` 在浏览器和 curl 眼里都是 127.0.0.1。
  //    以前只靠 new URL() 帮忙规范化，但 isBlockedHost 也被 DNS 解析层直接调用
  //    （那里拿到的是纯 IP 串，没有 URL 规范化），漏了就是真绕过。实测漏过。
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare)
  if (v4 !== null) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 0) return true             // 0.0.0.0/8
    if (a === 10) return true            // 10/8 私有
    if (a === 127) return true           // 环回
    if (a === 169 && b === 254) return true // 链路本地（云元数据 169.254.169.254）
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12 私有
    if (a === 192 && b === 168) return true          // 192.168/16 私有
    if (a === 100 && b >= 64 && b <= 127) return true // 100.64/10 CGNAT
    if (a >= 224) return true            // 组播 / 保留
    return false
  }
  // 省略段写法 `127.1` / `10.1`（inet_aton 的合法简写）：取第一段判
  const shortV4 = /^(\d{1,3})\.(\d{1,3})$/.exec(bare)
  if (shortV4 !== null) {
    const a = Number(shortV4[1])
    if (a === 0 || a === 10 || a === 127 || a >= 224) return true
    if (a === 169) return true // 169.254 的简写走不到，但 169.x 整段挡掉更稳
    if (a === 172 || a === 192 || a === 100) return true // 私有段的简写一律挡
    return false
  }
  // 任意一段用十六进制/八进制写（0x7f.0.0.1、0177.1）—— inet_aton 都认，一律挡。
  // 正常域名不会长成这样，正常公网 IP 也不会用这种写法写。
  if (/^[0-9a-fx.]+$/i.test(bare) && /\./.test(bare) && /(^|\.)0x/i.test(bare)) return true
  // 纯整数 / 十六进制整数形式（2130706433 / 0x7f000001）：整段挡掉。
  if (/^(0x[0-9a-f]+|\d+)$/.test(bare)) return true
  // IPv6：挡本地/内网/映射段。
  // ⚠️ WHATWG URL 会把 ::ffff:127.0.0.1 规范化成 ::ffff:7f00:1，所以不能只
  //    匹配点分写法 —— 凡是以 ::ffff: 开头的映射地址一律拒（里面可能藏私有 v4）。
  if (bare.includes(':')) {
    if (bare === '::1' || bare === '::' || bare === '0:0:0:0:0:0:0:1' || bare === '0:0:0:0:0:0:0:0') return true
    if (bare.startsWith('fe80')) return true        // 链路本地
    if (/^f[cd][0-9a-f]{0,2}:/.test(bare)) return true // fc00::/7 唯一本地
    if (bare.startsWith('::ffff:')) return true     // IPv4 映射
    if (bare.startsWith('::')) return true          // 其它 :: 前缀（含 ::(映射的简写)
    return false
  }
  return false
}

/**
 * 这个地址允许宿主去拉吗？
 *
 * 为什么必须有（2026-11-02 审核发现）：
 *   `file` 参数接受 http(s) 直链，而 agent 的参数是「别人说的话」间接影响的 ——
 *   群里一句「把 http://192.168.1.1/admin 收藏一下」就可能让她让**宿主进程**
 *   去请求内网地址。这是典型的盲 SSRF：她看不到响应，但请求真的发出去了
 *   （带我们的 User-Agent、从这台机器的网络位置），足以探测内网端口/触发副作用。
 *
 * 分两层：
 *   1. 这里 —— 纯字面判断，不联网（主机名是不是 localhost / IP 是不是私有段）
 *   2. fetchImageBytes 里 —— 真正发请求前**解析出 IP 再判一次**，
 *      挡掉 nip.io 这类「域名看着正常、解析到内网」的情况
 *
 * 仍然挡不住的：解析和请求之间的 DNS rebinding（TTL 极短来回切）。
 *   那是浏览器级防护才做得到的，自用插件不值当 —— 但说清楚边界，别以为它万能。
 */
export function isFetchableImageUrl(rawUrl) {
  const text = String(rawUrl ?? '').trim()
  if (text === '') return false
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (isBlockedHost(host)) return false
  // 剩下的必须是「像域名」的形状：带点、只含合法字符
  return /^[a-z0-9.-]+$/.test(host) && host.replace(/\.+$/, '').includes('.')
}

/** 给 fetchImageBytes 用：解析出的 IP 也不许是内网。导出给测试。 */
export { isBlockedHost }

/** 本地路径或 http(s) 直链。 */
async function sourceFromFile(file) {
  if (/^https?:\/\//i.test(file)) {
    if (!isFetchableImageUrl(file)) {
      throw new Error(
        `不给拉这个地址：${file.slice(0, 80)}`
        + '（只允许公网 http/https 图片直链 —— 本机、内网、169.254 元数据地址一律拒绝，'
        + '免得被别人的一句话指使去探内网）'
      )
    }
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

/**
 * 读本地文件（**先看大小再读**，别把整个盘读进内存）。
 *
 * 为什么要先 stat：readFileSync 是「先把文件全读进来再说」，
 * 等读到之后才发现超限，内存已经吃进去了 —— 一个几 GB 的误传文件
 * 足够把 Electron 主进程拖死。所以体积检查必须在读之前。
 */
function readBytesOfLocal(path) {
  let size = 0
  try {
    size = statSync(path).size
  } catch (error) {
    throw new Error(`读不到这个文件：${path}（${error instanceof Error ? error.message : error}）`)
  }
  if (size === 0) throw new Error(`图片是空文件：${path}`)
  if (size > IMAGE_MAX_BYTES) {
    throw new Error(`图片太大（${size} 字节，上限 ${IMAGE_MAX_BYTES}）：${path}`)
  }
  const data = new Uint8Array(readFileSync(path))
  if (data.length === 0) throw new Error(`图片是空文件：${path}`)
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
