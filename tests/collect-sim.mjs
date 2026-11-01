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

// ---- 5. findCustomFace 大小写 ----

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
