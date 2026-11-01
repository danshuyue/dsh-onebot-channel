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
import { gifFrameCount, IMAGE_MAX_BYTES } from '../lib/images.js'

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
import { mkdtempSync, writeFileSync } from 'node:fs'
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
  // GIF 帧数：AQAB 单图 + 2 个 GCE 的样本
  const twoFrames = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'base64'
  )
  ok(gifFrameCount(GIF_BYTES) >= 1, `GIF 帧数能数出来（实际 ${gifFrameCount(GIF_BYTES)}）`)
  ok(gifFrameCount(twoFrames) > gifFrameCount(GIF_BYTES), '两段 GIF 拼起来的帧数更多')
  eq(gifFrameCount(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 0, 'JPEG 不算 GIF 帧')
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
  // 字面检查放行、解析后必须拒（真解析一次，不 mock —— 这就是它的价值）
  await throws(async () => {
    await fetchImageBytes('http://127.0.0.1.nip.io/x')
  }, 'nip.io 解析到 127.0.0.1 → 拒')
  await throws(async () => {
    await fetchImageBytes('http://169.254.169.254/latest/meta-data/')
  }, '字面元数据地址 → 拒（不发请求）')
  await throws(async () => {
    await fetchImageBytes('file:///C:/Windows/win.ini')
  }, 'file:// 不是 http → 拒')
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
  customFaceList = []
  eq(await findCustomFace('不存在的表情'), null, '找不到返回 null')
}

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
