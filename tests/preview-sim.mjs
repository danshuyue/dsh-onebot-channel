/**
 * 表情包预览测试：node tests/preview-sim.mjs，退出码 0 = 全过，1 = 有失败。
 *
 * 覆盖 2026-10-27 加的「看图 → 起名 → 收藏」链路：
 *   1. withExt —— 文件名扩展名按真实格式改写（QQ 给的 .jpg 常常其实是 GIF）
 *   2. readLocalImage —— 读本地图 + 嗅探真实媒体类型
 *   3. pickPreviews —— 按目录序号取图（单张 / 连续几张 / 越界报错）
 *   4. attachPreviews —— 存进 DSH 附件库，产出可放进 image 块的引用
 *
 * 不碰真 QQ、不碰真附件库（attachments 服务用假的）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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
async function throws(fn, name) {
  try {
    await fn()
    ok(false, `${name}（但没有抛错）`)
  } catch {
    ok(true, name)
  }
}

// ---- 造一个临时目录当「收到的图片」 ----

const tmp = join(tmpdir(), `dsh-preview-sim-${process.pid}`)
const imgDir = join(tmp, '收到的图片')
mkdirSync(imgDir, { recursive: true })

/** 造一张最小 GIF（GIF89a 头 + 少量像素数据）。 */
function makeGif() {
  return Buffer.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00,
    0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0x21, 0xf9, 0x04, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
    0x00, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b
  ])
}
/** 造一张最小 JPEG（SOI + APP0 头）。 */
function makeJpeg() {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9
  ])
}

// 文件名故意用 QQ 的习惯：<MD5>.jpg，但内容是 GIF —— 这正是线上的情况
writeFileSync(join(imgDir, '20261027-133426_3472302240_AAAA0000000000000000000000000000.jpg'), makeGif())
writeFileSync(join(imgDir, '20261027-175053_3472302240_BBBB0000000000000000000000000000.jpg'), makeJpeg())
writeFileSync(join(imgDir, '20261027-175054_3472302240_CCCC0000000000000000000000000000.jpg'), makeGif())

// ---- mock 配置：把「收到的图片」指到临时目录 ----

const cfgMod = await import('../lib/config.js')
const origGetConfig = cfgMod.getConfig
// config.js 的 getConfig 读的是模块内缓存，直接改它指向临时目录
const config = origGetConfig()
config.imageCopyDir = imgDir
config.workspaceCwd = tmp

// ---- 1. withExt ----

console.log('withExt：')
{
  const { withExt } = await import('../lib/images.js')
  eq(withExt('ABCDEF0123.jpg', 'gif'), 'ABCDEF0123.gif', '扩展名按真实格式改写')
  eq(withExt('ABCDEF0123.jpg', 'jpg'), 'ABCDEF0123.jpg', '格式一致时不动')
  eq(withExt('noext', 'png'), 'noext.png', '没扩展名就补上')
  eq(withExt('a.b.jpg', 'webp'), 'a.b.webp', '只改最后一个扩展名')
  eq(withExt('', 'gif'), 'image.gif', '空名兜底')
}

// ---- 2. readLocalImage ----

console.log('readLocalImage：')
{
  const { readLocalImage } = await import('../lib/collect.js')
  const gif = readLocalImage(join(imgDir, '20261027-133426_3472302240_AAAA0000000000000000000000000000.jpg'))
  eq(gif.mediaType, 'image/gif', '顶着 .jpg 名的 GIF 被认成 image/gif')
  ok(gif.bytes === makeGif().length, '字节数对得上')
  const jpg = readLocalImage(join(imgDir, '20261027-175053_3472302240_BBBB0000000000000000000000000000.jpg'))
  eq(jpg.mediaType, 'image/jpeg', 'JPEG 认成 image/jpeg')
  await throws(async () => readLocalImage(join(imgDir, '不存在.jpg')), '文件不存在时报错')
  await throws(async () => readLocalImage(''), '空路径报错')
}

// ---- 3. pickPreviews ----

console.log('pickPreviews：')
{
  const { pickPreviews } = await import('../lib/preview.js')
  const one = pickPreviews({ index: 1 })
  eq(one.total, 3, '目录里 3 张')
  eq(one.items.length, 1, 'index=1 只取 1 张')
  eq(one.items[0].index, 1, '序号是 1')
  eq(one.items[0].mediaType, 'image/gif', '第一张是 GIF')
  const many = pickPreviews({ from: 1, count: 3 })
  eq(many.items.map((i) => i.index), [1, 2, 3], 'from=1&count=3 连取 3 张')
  eq(many.items.map((i) => i.mediaType), ['image/gif', 'image/jpeg', 'image/gif'], '每张的格式都对')
  const capped = pickPreviews({ from: 1, count: 99 })
  ok(capped.items.length <= 6, `一次最多 6 张（实际 ${capped.items.length}）`)
  const def = pickPreviews({})
  eq(def.items.length, 1, '不传参数取最早的一张')
  await throws(async () => pickPreviews({ index: 99 }), '序号越界报错')
}

// ---- 4. attachPreviews ----

console.log('attachPreviews：')
{
  const { attachPreviews, pickPreviews } = await import('../lib/preview.js')
  const saved = []
  const fakeCtx = {
    get: (name) => (name === 'attachments'
      ? {
          // ⚠️ 真实 attachments.saveImages(inputs) 返回的是**扁平**的 refs 数组（一张图一个 ref），
          //   不是嵌套数组。mock 必须照着来，否则测的是假形状。
          saveImages: async (inputs) => inputs.map((input) => {
            saved.push(input)
            return {
              attachmentId: `sha256:${'a'.repeat(64)}`,
              mediaType: input.mediaType,
              width: 100,
              height: 100,
              bytes: input.data.byteLength,
              name: input.name
            }
          })
        }
      : undefined)
  }
  const picked = pickPreviews({ from: 1, count: 2 })
  const attached = await attachPreviews(fakeCtx, picked.items)
  eq(attached.length, 2, '产出 2 个附件引用')
  eq(saved.length, 2, '确实存了 2 张进附件库')
  eq(saved[0].mediaType, 'image/gif', 'GIF 按 image/gif 存')
  eq(saved[0].name, '001_AAAA0000000000000000000000000000', '附件名带序号，方便对号入座')
  ok(typeof attached[0].ref.attachmentId === 'string' && attached[0].ref.attachmentId.startsWith('sha256:'), '引用带 sha256 attachmentId')
  ok(attached[0].ref.width === 100, '引用带宽高')
  // 附件服务不可用时要报错，不能静默
  await throws(async () => attachPreviews({ get: () => undefined }, picked.items), '附件服务不可用时报错')
}

// ---- 5. 工具注册 + render 真的产出 image 块 ----

console.log('qq_face_preview 工具：')
{
  const { registerFacePreviewTool } = await import('../lib/tool.js')
  let registered = null
  const fakeCtx = {
    get: (name) => {
      if (name === 'tools') {
        return {
          register: (tool) => {
            registered = tool
            return () => {}
          }
        }
      }
      if (name === 'attachments') {
        return {
          saveImages: async (inputs) => inputs.map((input) => ({
            attachmentId: `sha256:${'b'.repeat(64)}`,
            mediaType: input.mediaType,
            width: 120,
            height: 120,
            bytes: input.data.byteLength,
            name: input.name
          }))
        }
      }
      return undefined
    },
    effect: () => {}
  }
  await registerFacePreviewTool(fakeCtx)
  ok(registered !== null, '工具注册成功')
  eq(registered?.name, 'qq_face_preview', '工具名是 qq_face_preview')

  // 走一遍真实 execute → render
  const value = await registered.execute({ index: 1 })
  ok(Array.isArray(value.images) && value.images.length === 1, 'execute 返回 1 个 image 引用')
  const blocks = registered.output.render({ index: 1 }, value)
  ok(Array.isArray(blocks), 'render 返回数组')
  const imageBlocks = blocks.filter((b) => b.type === 'image')
  eq(imageBlocks.length, 1, 'render 里带 1 个 image 块（模型能真的看到图）')
  ok(typeof imageBlocks[0]?.attachment?.attachmentId === 'string', 'image 块带附件引用')
  ok(blocks[0].type === 'text' && blocks[0].text.includes('#1'), '文字块在前，说明第几张')
}

// ---- 6. 端到端：看图 → 起名 → 收藏 ----

console.log('端到端（看图 → 起名 → 收藏）：')
{
  const calls = []
  globalThis.fetch = async (url, init) => {
    const payload = JSON.parse(init.body)
    calls.push(payload)
    if (payload.action === 'add_custom_face') {
      return { ok: true, json: async () => ({ retcode: 0, data: { emoji_id: '3655191092_0_0_0_ABCDEF_0_0' } }) }
    }
    return { ok: true, json: async () => ({ retcode: 0, data: null }) }
  }
  const { collectFace } = await import('../lib/collect.js')
  const { pickPreviews } = await import('../lib/preview.js')
  const picked = pickPreviews({ index: 1 })
  const seen = picked.items[0]
  eq(seen.mediaType, 'image/gif', '先看见图，知道这是 GIF')
  await collectFace({ file: seen.path, desc: '一只猫比心' })
  const modify = calls.find((c) => c.action === 'modify_custom_face')
  eq(modify?.params?.desc, '一只猫比心', '看完图起的名字写进了收藏备注')
  ok(calls[0].params.file.startsWith('file:///'), '收藏用的是本地 file:// 源')
}

rmSync(tmp, { recursive: true, force: true })

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed > 0 ? 1 : 0)
