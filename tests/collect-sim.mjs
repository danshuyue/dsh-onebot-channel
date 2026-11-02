/**
 * 收藏表情测试：node tests/collect-sim.mjs，退出码 0 = 全过，1 = 有失败。
 *
 * 覆盖「收到表情包 → 存进 QQ 收藏夹」这条链路：
 *   1. 图片来源一律走 base64://（协议端可能在另一台机器上，file:// 读不到我们本地盘）
 *   2. collectFace —— 调用 add_custom_face + modify_custom_face
 *   3. 备注（desc）—— 没给时用来源兜底
 *   4. add_custom_face 已从 C 档封禁清单里放开
 *   5. message_id → get_msg → 下载 → 收藏（不用等图落进目录）
 *   6. GIF 帧数统计与体积上限
 */
import { BLOCKED_ACTIONS, isBlocked } from '../lib/blocked.js'
import { toBase64Source } from '../lib/collect.js'
import { findCustomFace } from '../lib/custom-faces.js'
import { gifFrameCount, IMAGE_MAX_BYTES, INBOUND_IMAGE_MAX_BYTES } from '../lib/images.js'

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}`)
  }
}
function eq(actual, expected, name) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, `${name}${same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`)
}
function throwsSync(fn, name) {
  try {
    fn()
    ok(false, `${name}（但没有抛错）`)
  } catch {
    ok(true, name)
  }
}

// 测试用的本地图：自己在临时目录里造一张（不依赖仓库外的任何文件）
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
const tempDir = mkdtempSync(joinPath(tmpdir(), 'collect-sim-'))
const samplePath = joinPath(tempDir, '20261027-180031_3472302240_原名为动图.gif')
writeFileSync(samplePath, Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
))

// ---- mock OneBot ----
let calls = []
let customFaceResult = { emoji_id: '3655191092_0_0_0_ABCDEF0123456789ABCDEF0123456789_0_0' }
let customFaceList = []
// 1x1 GIF（GIF89a，两帧 GCE）
const GIF_BYTES = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
)
let messageResult = null
let imageDownload = null
globalThis.fetch = async (url, init) => {
  // 下载 QQ 图片直链：没有 body 的那种 GET
  const isDownload = init?.body === undefined
  if (isDownload) {
    if (imageDownload === null) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => imageDownload.buffer.slice(imageDownload.byteOffset, imageDownload.byteOffset + imageDownload.byteLength)
    }
  }
  const payload = JSON.parse(init.body)
  calls.push(payload)
  if (payload.action === 'add_custom_face') {
    return { ok: true, json: async () => ({ retcode: 0, data: customFaceResult }) }
  }
  if (payload.action === 'get_msg') {
    if (messageResult === null) return { ok: true, json: async () => ({ retcode: 100, wording: 'message not found' }) }
    return { ok: true, json: async () => ({ retcode: 0, data: messageResult }) }
  }
  if (payload.action === 'modify_custom_face') {
    const id = payload.params.emoji_id
    const desc = payload.params.desc
    customFaceList = customFaceList.map((item) => (item.emojiId === id ? { ...item, desc, summary: desc } : item))
    if (customFaceList.length === 0) customFaceList.push({ emojiId: id, url: '', summary: desc, desc })
    return { ok: true, json: async () => ({ retcode: 0, data: null }) }
  }
  if (payload.action === 'fetch_custom_face_detail') {
    // ⚠️ 协议端真实字段名是 emoji_id / url / summary / desc（不是 emojiId）
    return {
      ok: true,
      json: async () => ({
        retcode: 0,
        data: customFaceList.map((item) => ({
          emoji_id: item.emojiId,
          url: item.url ?? '',
          summary: item.summary ?? '',
          desc: item.desc ?? ''
        }))
      })
    }
  }
  return { ok: true, json: async () => ({ retcode: 0, data: null }) }
}

// ---- 1. 封禁清单 ----

console.log('blocked.js：')
{
  ok(!isBlocked('add_custom_face'), 'add_custom_face 已从封禁清单放开（收藏表情包需要它）')
  ok(BLOCKED_ACTIONS.size === 13, `封禁清单剩 13 项（实际 ${BLOCKED_ACTIONS.size}）`)
  ok(isBlocked('get_cookies'), '凭据类仍然封禁')
  ok(isBlocked('delete_qzone_msg'), '删说说仍然封禁')
}

// ---- 2. toBase64Source ----

console.log('toBase64Source：')
{
  const src = toBase64Source(GIF_BYTES)
  ok(src.startsWith('base64://'), '本地图一律转 base64://（协议端可能在另一台机器）')
  const back = Buffer.from(src.slice('base64://'.length), 'base64')
  ok(back.equals(GIF_BYTES), 'base64 编解码无损（GIF 每一帧都在）')
}
{
  throwsSync(() => toBase64Source(new Uint8Array(0)), '空字节报错')
  throwsSync(() => toBase64Source(new Uint8Array(IMAGE_MAX_BYTES + 1)), '超过体积上限报错')
}
{
  // GIF 帧数：**精确值**，不能只断言 >=1（审核指出：只断 >=1 会让错误实现通过）
  const twoFrames = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'base64'
  )
  // 内置的 GIF_BYTES 是单帧
  eq(gifFrameCount(GIF_BYTES), 1, '单帧 GIF 精确数出 1 帧')
  // ⚠️ 两帧要「在同一张合法的 GIF 里」，不能把两个完整文件头拼起来 ——
  //    那样第二个文件头会被当成非法标记，结构化解码只认第一帧（其实是对的）。
  //    构造方式：把单帧 GIF 的第一个图像描述符（0x2C 起）整段再复制一遍，
  //    放在 trailer(0x3B) 之前。
  const single = Buffer.from(GIF_BYTES)
  const trailerAt = single.lastIndexOf(0x3b)
  const imageDescAt = single.indexOf(0x2c)
  ok(imageDescAt > 0 && trailerAt > imageDescAt, '样本里能找到图像描述符和 trailer（构造前提）')
  const twoFrameGif = Buffer.concat([single.slice(0, trailerAt), single.slice(imageDescAt, trailerAt), Buffer.from([0x3b])])
  eq(gifFrameCount(twoFrameGif), 2, '真正的两帧 GIF 精确数出 2 帧')
  eq(gifFrameCount(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 0, 'JPEG 不算 GIF 帧')
  eq(gifFrameCount(new Uint8Array(0)), 0, '空数据返回 0')
  // ⚠️ 反例：LZW 数据里含 0x21 0xF9 的单帧 GIF，裸扫会数成 2
  const tricky = Buffer.from(GIF_BYTES)
  // 在图像数据里插一个 21 F9（不破坏结构：插在子块长度之前会被 skipSubBlocks 跳过）
  const withFakeGce = Buffer.concat([tricky, Buffer.from([0x21, 0xf9]), tricky.slice(13)])
  // 这条不要求特定值，只要求「不是裸扫出来的那个数」
  ok(gifFrameCount(withFakeGce) !== (() => {
    let n = 0
    for (let i = 0; i < withFakeGce.length - 1; i += 1) if (withFakeGce[i] === 0x21 && withFakeGce[i + 1] === 0xf9) n += 1
    return n
  })(), '结构化解码 ≠ 裸扫字节（LZW 里的假 GCE 不会被算成帧）')
}

// ---- 3. collectFace ----

console.log('collectFace：')
{
  const { collectFace } = await import('../lib/collect.js')
  calls = []
  customFaceList = []
  const r = await collectFace({ file: samplePath, desc: '测试表情' })
  eq(calls[0].action, 'add_custom_face', '先调 add_custom_face')
  eq(calls[0].params.file.startsWith('base64://'), true, 'file 参数是 base64://（不再是 file://）')
  eq(r.emojiId, customFaceResult.emoji_id, '返回 emoji_id')
  eq(r.mediaType, 'image/gif', '嗅出真实格式（不受文件名 .jpg 影响）')
  ok(r.frames > 0, `动图帧数有值（${r.frames} 帧）`)
  eq(calls[1].action, 'modify_custom_face', '接着调 modify_custom_face 写备注')
  eq(calls[1].params.desc, '测试表情', '备注内容对')
}
{
  const { collectFace } = await import('../lib/collect.js')
  calls = []
  customFaceList = []
  // 没给 desc 时用文件名兜底
  await collectFace({ file: samplePath })
  const desc = calls.find((c) => c.action === 'modify_custom_face')?.params?.desc
  eq(desc, '原名为动图', '没给 desc 时用文件名兜底（去掉时间戳、QQ 号和扩展名）')
}
{
  const { collectFace } = await import('../lib/collect.js')
  calls = []
  customFaceList = []
  await throws(async () => {
    await collectFace({})
  }, '既没 file 也没 message_id/recent 时报错')
  ok(calls.length === 0, '参数缺失时没发请求')
}

// ---- 4. message_id 路径 ----

console.log('message_id：')
{
  const { collectFace } = await import('../lib/collect.js')
  calls = []
  customFaceList = []
  imageDownload = GIF_BYTES
  messageResult = {
    message_id: -313561868,
    message: [{ type: 'image', data: { url: 'https://multimedia.nt.qq.com.cn/download?x=1', file: 'ABC.jpg', summary: '[动画表情]' } }]
  }
  const r = await collectFace({ message_id: '-313561868', desc: '群友的动图' })
  eq(calls[0].action, 'get_msg', '先 get_msg 取那条消息')
  eq(calls[0].params.message_id, '-313561868', 'message_id 原样传（负数不丢）')
  const add = calls.find((c) => c.action === 'add_custom_face')
  ok(add !== undefined && add.params.file.startsWith('base64://'), '下载后再 base64 送进收藏夹')
  eq(r.mediaType, 'image/gif', '从消息里取到的动图格式对')
  ok(r.frames > 0, '帧数保留')
}
{
  const { collectFace } = await import('../lib/collect.js')
  calls = []
  messageResult = { message: [{ type: 'text', data: { text: '纯文字' } }] }
  imageDownload = GIF_BYTES
  await throws(async () => {
    await collectFace({ message_id: '123' })
  }, '消息里没有图就报错（并说清段类型）')
}
{
  const { collectFace } = await import('../lib/collect.js')
  calls = []
  messageResult = null
  await throws(async () => {
    await collectFace({ message_id: '999' })
  }, 'get_msg 失败就报错')
}
imageDownload = null
messageResult = null

// ---- 5. SSRF 防御 ----

console.log('直链白名单（防被指使去探内网）：')
{
  const { isFetchableImageUrl } = await import('../lib/collect.js')
  // 公网图片直链：放行
  ok(isFetchableImageUrl('https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=x'), 'QQ 图片直链放行')
  ok(isFetchableImageUrl('https://p.qpic.cn/qq_expression/1/2/0'), 'qpic 表情直链放行')
  ok(isFetchableImageUrl('http://example.com/a.gif'), '普通公网 http 放行')
  // 内网 / 本机 / 元数据：一律拒
  ok(!isFetchableImageUrl('http://127.0.0.1:3000/'), '环回 127.0.0.1 拒绝')
  ok(!isFetchableImageUrl('http://localhost:58434/api'), 'localhost 拒绝')
  ok(!isFetchableImageUrl('http://192.168.79.128:3003/'), '内网 192.168 拒绝')
  ok(!isFetchableImageUrl('http://10.0.0.1/x'), '私有 10/8 拒绝')
  ok(!isFetchableImageUrl('http://172.16.0.1/x'), '私有 172.16/12 拒绝')
  ok(!isFetchableImageUrl('http://169.254.169.254/latest/meta-data/'), '云元数据 169.254 拒绝')
  ok(!isFetchableImageUrl('http://[::1]/x'), 'IPv6 环回拒绝')
  ok(!isFetchableImageUrl('http://[fe80::1]/x'), 'IPv6 链路本地拒绝')
  ok(!isFetchableImageUrl('file:///C:/Windows/win.ini'), 'file:// 拒绝（这不是直链）')
  ok(!isFetchableImageUrl('ftp://example.com/a.gif'), 'ftp 拒绝')
  ok(!isFetchableImageUrl(''), '空串拒绝')
  ok(!isFetchableImageUrl('不是网址'), '垃圾串拒绝')
}
{
  // 端到端：给了内网直链，collectFace 必须直接拒绝、且**不发任何请求**
  const { collectFace } = await import('../lib/collect.js')
  calls = []
  imageDownload = null
  let fetchCount = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async (...args) => { fetchCount += 1; return realFetch(...args) }
  await throws(async () => {
    await collectFace({ file: 'http://169.254.169.254/latest/meta-data/', desc: 'x' })
  }, '内网直链被拒（元数据地址）')
  eq(fetchCount, 0, '拒绝时不发任何 HTTP 请求（不是「先请求了再判」）')
  globalThis.fetch = realFetch
}

// ---- 6. 第二层：DNS 解析后仍判内网 ----

console.log('DNS 解析层（挡 nip.io 这类看着正常、解析到内网的域名）：')
{
  const { fetchImageBytes } = await import('../lib/images.js')
  // ⚠️ 这几条不能只断言「抛错了」—— DNS 挂掉/断网时 lookup 也会抛错，
  //    那样测试会因为**错误的原因**变绿（假保护）。必须断言错误原因。
  const reasonOf = async (fn) => {
    try {
      await fn()
      return ''
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
  const nipMsg = await reasonOf(() => fetchImageBytes('http://127.0.0.1.nip.io/x'))
  ok(/解析到内网|不给拉内网|解析不了|超时|下载图片失败/.test(nipMsg), `nip.io 被拒且原因是安全检查（实际：${nipMsg.slice(0, 60)}）`)
  // 上面这条允许「解析不了」是因为离线环境下 nip.io 确实解不出来 ——
  // 但下面的**字面**检查是确定性的，不依赖网络：
  const metaMsg = await reasonOf(() => fetchImageBytes('http://169.254.169.254/latest/meta-data/'))
  ok(/不给拉内网/.test(metaMsg), `字面元数据地址被安全检查拦下、不是网络错误（实际：${metaMsg.slice(0, 60)}）`)
  const fileMsg = await reasonOf(() => fetchImageBytes('file:///C:/Windows/win.ini'))
  ok(/只允许 http|地址不合法/.test(fileMsg), `file:// 被协议检查拦下（实际：${fileMsg.slice(0, 60)}）`)
}

console.log('重定向（挡「公网地址 302 到内网」的绕过）：')
{
  // 起一个本地小服务 302 到内网地址。注意：本地服务本身是 127.0.0.1，
  // 所以第一跳就会因为「字面是内网」被拦 —— 那也是一种正确结果。
  // 真正要验的是「跟随后每一跳都重新审」这个逻辑，所以直接测相对跳转解析 + 拦截。
  const { fetchImageBytes } = await import('../lib/images.js')
  const msg = await (async () => {
    try {
      await fetchImageBytes('http://127.0.0.1:1/redir')
      return ''
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  })()
  ok(/不给拉内网/.test(msg), `指向内网的第一跳就被拦（实际：${msg.slice(0, 50)}）`)
  // fetchImageBytes 里显式用了 redirect:'manual'，自己跟每一跳 ——
  // 这条断言从源码层面钉住那个决定，防止有人把它改回默认跟随。
  const src = (await import('node:fs')).readFileSync(new URL('../lib/images.js', import.meta.url), 'utf8')
  ok(/redirect:\s*'manual'/.test(src), '下载走 redirect: manual（不交给 fetch 跟随）')
  ok(/for \(let hop = 0; hop <= MAX_REDIRECTS/.test(src), '自己逐跳跟重定向，每跳重新审地址')
}

// ---- 7. isBlockedHost 的绕过写法 ----

console.log('isBlockedHost（主机串的各种写法）：')
{
  const { isBlockedHost } = await import('../lib/collect.js')
  ok(isBlockedHost('localhost.'), '末尾带点的 localhost.（绝对域名写法，实测漏过一次）')
  ok(isBlockedHost('127.1'), '省略段写法 127.1')
  ok(isBlockedHost('10.1'), '省略段写法 10.1（私有段）')
  ok(isBlockedHost('0x7f.0.0.1'), '十六进制写法')
  ok(isBlockedHost('2130706433'), '纯整数形式（=127.0.0.1）')
  ok(isBlockedHost('0x7f000001'), '十六进制整数形式')
  ok(isBlockedHost('169.254.169.254'), '云元数据地址')
  ok(isBlockedHost('::ffff:7f00:1'), 'URL 规范化后的 IPv4 映射（不是点分写法）')
  ok(isBlockedHost('0:0:0:0:0:0:0:1'), 'IPv6 环回长写法')
  ok(isBlockedHost('fe80::1'), 'IPv6 链路本地')
  ok(isBlockedHost('fc00::1'), 'IPv6 唯一本地')
  ok(!isBlockedHost('multimedia.nt.qq.com.cn'), '正常公网域名放行')
  ok(!isBlockedHost('8.8.8.8'), '公网 IP 放行')
}

// ---- 8. findCustomFace 大小写 ----

console.log('findCustomFace：')
{
  customFaceList = [
    {
      emojiId: '3655191092_0_0_0_5F7484A8D8B68F2715712492C65166BA_0_0',
      url: '', summary: '测试表情A', desc: '测试表情A'
    }
  ]
  const hit = await findCustomFace('测试表情A')
  ok(hit !== null, '按备注名能找到')
}
{
  customFaceList = [
    {
      emojiId: '3655191092_0_0_0_5F7484A8D8B68F2715712492C65166BA_0_0',
      url: '', summary: '', desc: ''
    }
  ]
  // 小写 hash（agent 手上的文件名是小写，QQ 返回的是大写）
  const hit = await findCustomFace('5f7484a8d8b68f2715712492c65166ba')
  ok(hit !== null, '按小写 hash 也能找到（大小写无关匹配）')
}
{
  customFaceList = [
    { emojiId: 'face-weak', url: '', summary: '委屈小猫', desc: '委屈小猫 | 委屈' },
    { emojiId: 'face-strong', url: '', summary: '柴犬哭哭', desc: '委屈柴犬 | 委屈 难过 求安慰' },
    { emojiId: 'face-other', url: '', summary: '开心小猫', desc: '开心小猫 | 开心 撒娇' }
  ]
  calls = []
  const hit = await findCustomFace('委屈，求安慰')
  eq(hit?.emojiId, 'face-strong', '多个关键词按命中数排序，挑中标签更匹配的收藏表情')
  eq(calls.find((c) => c.action === 'fetch_custom_face_detail')?.params.count, 100, '搜索默认读取前 100 项（与收藏夹列表一致）')
}
{
  customFaceList = [{ emojiId: 'face-tagged', url: '', summary: '兔子', desc: '委屈兔 | 撒娇 求抱抱' }]
  const hit = await findCustomFace('求抱抱')
  eq(hit?.emojiId, 'face-tagged', '可直接按单个分类关键词检索')
  eq(await findCustomFace('，/'), null, '只有分隔符的搜索词不误选表情')
}
{
  customFaceList = []
  eq(await findCustomFace('不存在的表情'), null, '找不到返回 null')
}

// ---- 9. modify_custom_face 的 retcode 必须被检查 ----

console.log('备注假成功（协议端返回 HTTP200 + retcode 100）：')
{
  const { collectFace } = await import('../lib/collect.js')
  calls = []
  customFaceList = []
  imageDownload = null
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (init?.body === undefined) return realFetch(url, init)
    const payload = JSON.parse(init.body)
    calls.push(payload)
    if (payload.action === 'add_custom_face') {
      return { ok: true, json: async () => ({ retcode: 0, data: customFaceResult }) }
    }
    if (payload.action === 'modify_custom_face') {
      // 实测协议端对非法 emoji_id 就是这样回的：HTTP 200 但 retcode 100
      return { ok: true, json: async () => ({ status: 'failed', retcode: 100, wording: 'invalid emoji_id' }) }
    }
    return { ok: true, json: async () => ({ retcode: 0, data: null }) }
  }
  const r = await collectFace({ file: samplePath, desc: '猫' })
  // ⚠️ 关键：备注没写进去时，返回值里**不能**报一个其实没生效的备注
  eq(r.desc, '', '备注失败时返回值不谎报 desc（以前会报「已收藏…（备注：猫）」）')
  eq(r.emojiId, customFaceResult.emoji_id, '备注失败不影响收藏本身')
  globalThis.fetch = realFetch
}

// ---- 10. 入站图片上限与收藏上限是分开的 ----

console.log('入站 / 收藏上限分离（防 9MB 群图被静默吞掉）：')
{
  const { IMAGE_MAX_BYTES, INBOUND_IMAGE_MAX_BYTES } = await import('../lib/images.js')
  ok(INBOUND_IMAGE_MAX_BYTES > IMAGE_MAX_BYTES, `入站上限(${INBOUND_IMAGE_MAX_BYTES}) 高于收藏上限(${IMAGE_MAX_BYTES})`)
  // buildImageBlocks 必须用入站那一档：从源码层面钉住（这是审核发现的真实回归）
  const src = (await import('node:fs')).readFileSync(new URL('../lib/images.js', import.meta.url), 'utf8')
  ok(/maxBytes:\s*INBOUND_IMAGE_MAX_BYTES/.test(src), 'buildImageBlocks 传的是入站上限（不是收藏上限）')
}

// ---- 11. image=N 按段序编号，缺 url 要报错而不是静默跳过 ----

console.log('image=N 选图：')
{
  const { collectFace } = await import('../lib/collect.js')
  calls = []
  imageDownload = Buffer.from(GIF_BYTES)
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (init?.body === undefined) {
      return {
        ok: true, status: 200,
        arrayBuffer: async () => imageDownload.buffer.slice(imageDownload.byteOffset, imageDownload.byteOffset + imageDownload.byteLength)
      }
    }
    const payload = JSON.parse(init.body)
    calls.push(payload)
    if (payload.action === 'get_msg') {
      // 段序：[图1有url, 图2缺url, 图3有url]
      return {
        ok: true,
        json: async () => ({
          retcode: 0,
          data: {
            message: [
              { type: 'image', data: { url: 'https://multimedia.nt.qq.com.cn/1.jpg', file: 'A.jpg' } },
              { type: 'image', data: { file: 'B.jpg' } },
              { type: 'image', data: { url: 'https://multimedia.nt.qq.com.cn/3.jpg', file: 'C.jpg' } }
            ]
          }
        })
      }
    }
    if (payload.action === 'add_custom_face') return { ok: true, json: async () => ({ retcode: 0, data: customFaceResult }) }
    return { ok: true, json: async () => ({ retcode: 0, data: null }) }
  }
  // image=2 指向的是第 2 段（缺 url）—— 必须明确报错，不能静默取第 3 张
  await throws(async () => {
    await collectFace({ message_id: '1', image: 2 })
  }, 'image=2 指向缺 url 的那张 → 明确报错（不静默取图3）')
  // image=3 是第 3 段，有 url，应该成功
  const r = await collectFace({ message_id: '1', image: 3 })
  ok(r.emojiId !== '', 'image=3 → 取到第 3 段并收藏成功')
  ok(r.origin.includes('第 3 张'), `origin 说的是第 3 张（实际：${r.origin}）`)
  globalThis.fetch = realFetch
  imageDownload = null
}

const toolSource = (await import('node:fs')).readFileSync(new URL('../lib/tool.js', import.meta.url), 'utf8')
ok(toolSource.includes('先用 custom_emoji 从收藏夹找语义合适的表情包'), '发送指引把收藏表情列为视觉反应的首选')
ok(toolSource.includes('普通图片只有在你清楚看出它是可复用的梗图/反应图时才收藏'), '收藏指引限制普通图片必须是明确可复用的表情包')
ok(toolSource.includes('简短名称 | 2-4 个关键词'), '收藏指引要求备注包含可搜索关键词')

rmSync(tempDir, { recursive: true, force: true })

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed > 0 ? 1 : 0)

async function throws(fn, name) {
  try {
    await fn()
    ok(false, `${name}（但没有抛错）`)
  } catch {
    ok(true, name)
  }
}
