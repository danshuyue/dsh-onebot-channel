/**
 * 图片占位符「编号 + 摘要」测试（0.22.0）。
 *
 * 踩过的事：正文里图片段一律渲染成写死的 `[图片]`，而 image 块是**扁平**塞在整段
 * 正文之后的（deliver.js 把 `[{text}, ...imageBlocks]` 拼起来）。于是「第 N 个
 * [图片] 行 ↔ 第 N 个 image 块」只能靠位置隐式对齐：
 *   · 一张图下载失败 → 后面的图整体前移，模型把 A 的图当成 B 的；
 *   · 跨发送者多图（实测 5/35 次投递）→ 模型只能猜，且它**从不承认自己在猜**。
 *
 * 修法：占位符带上「本次投递内的序号 + 协议端给的 summary」——
 *   `[图片2·一锅白米饭]`；summary 是通用占位（`[图片]`/`[动画表情]`）时只留 `[图片2]`；
 *   下载失败渲染 `[图片·难过（未取到）]` 且**不占号**。
 *
 * 这个测试守的是四条不变量，每条都曾经在实现过程中被踩坏过：
 *   1. 编号与 deliver 数组顺序严格一致，即使渲染顺序相反（身份钉在段对象上）；
 *   2. 同一张图在本次投递里出现两次 → 两个不同的号（不能按 url 去重）；
 *   3. 下载失败不占号，后面的图仍从 1 开始连续；
 *   4. 不传 imageLabel 的旧调用点（判空/命令解析）行为不变。
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')
const SANDBOX_HOME = join(PLUGIN, '..', '.tmp-test', `imglabel-${process.pid}`)
const SANDBOX_DATA = join(SANDBOX_HOME, '.dsh')
mkdirSync(SANDBOX_DATA, { recursive: true })
process.env.USERPROFILE = SANDBOX_HOME
process.env.HOME = SANDBOX_HOME
process.on('exit', () => {
  try { rmSync(SANDBOX_HOME, { recursive: true, force: true }) } catch {}
})

const GROUP = '975663147'
const PEER = '1321833118'
const SELF = '3566906627'
const OTHER = '2059717893'
const CTX_UIN = '2836259518'
const SESSION = 'session-image-label-test'

writeFileSync(join(SANDBOX_DATA, 'qq-bridge.config.json'), JSON.stringify({
  enabled: true,
  selfUin: SELF,
  peerUin: PEER,
  ownerUin: PEER,
  onebotHttp: 'http://127.0.0.1:9/',
  token: 'test-token',
  mergeWindowMs: 0,
  replyQuietMs: 0,
  splitReply: false,
  autoForwardPrivate: false,
  autoForwardGroup: false,
  backfillOnStart: false,
  memoryEnabled: false,
  proactiveEnabled: false,
  windowEnabled: false,
  groupOnlyWhenAt: true,
  imageCopyDir: 'off',
  forwardImagesEnabled: false,
  routes: { private: { [PEER]: { sessionId: SESSION } }, group: { [GROUP]: { sessionId: SESSION } } },
  groupUins: [GROUP]
}, null, 2), 'utf8')
writeFileSync(join(SANDBOX_DATA, 'qq-bridge-state.json'), JSON.stringify({
  lastId: 0, lastSeq: 0, lastTime: 0, privates: {}, groups: {}
}, null, 2), 'utf8')

// 一个最小的合法 PNG（1x1 透明），让 sniffImageMediaType 认得出来。
// 地址用 8.8.8.8：images.js 会先 assertPublicHost()，127.0.0.1 会被判内网直接拒掉，
// example.invalid 又会 DNS 解析失败 —— 那样测到的就不是「编号」而是「下载被拦」。
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)
const URL_OK = 'https://8.8.8.8/ok.png'
const URL_BAD = 'https://8.8.8.8/bad.png'
const URL_SAME = 'https://8.8.8.8/same.png'

globalThis.fetch = async (url) => {
  if (String(url) === URL_BAD) {
    return { ok: false, status: 400, headers: new Map(), arrayBuffer: async () => new ArrayBuffer(0), body: null }
  }
  if (String(url).startsWith('https://8.8.8.8/')) {
    return {
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'image/png'], ['content-length', String(PNG_BYTES.length)]]),
      arrayBuffer: async () => PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.byteLength),
      body: null
    }
  }
  return { ok: true, json: async () => ({ retcode: 0, data: {} }) }
}

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.error(`  ✗ ${name}`) }
}

const { loadConfig } = await import('../lib/config.js')
const { loadState } = await import('../lib/state.js')
const onebot = await import('../lib/onebot.js')
const images = await import('../lib/images.js')
const { handleGroupMessage } = await import('../lib/poll.js')

loadConfig()
loadState()

/** 假 attachments 服务：saveImages 原样返回引用 */
const fakeAttachments = {
  saveImages: async (items) => items.map((item, i) => ({ id: `att-${i}`, name: item.name ?? '' }))
}
function makeCtx(sink) {
  const agent = { followup: (m) => { sink.push(m) }, session: { snapshotEvents: () => [] } }
  return {
    get: (key) => {
      if (key === 'agents') return { get: () => agent, resume: async () => ({ agent }) }
      if (key === 'attachments') return fakeAttachments
      return undefined
    },
    effect: () => {}
  }
}

const img = (url, summary) => ({ type: 'image', data: { url, file: `${url.split('/').pop()}`, summary } })
const text = (t) => ({ type: 'text', data: { text: t } })

console.log('A. 占位符本身：摘要怎么进，通用摘要怎么省：')
{
  ok(onebot.imageSummaryOf(img(URL_OK, '[一锅白米饭]')) === '一锅白米饭', '剥掉外层方括号')
  ok(onebot.imageSummaryOf(img(URL_OK, '[动画表情]')) === '', '通用摘要「动画表情」不当作语义')
  ok(onebot.imageSummaryOf(img(URL_OK, '[图片]')) === '', '通用摘要「图片」不当作语义')
  ok(onebot.imageSummaryOf(img(URL_OK, '')) === '', '没有 summary 返空串')
  ok(onebot.imageSummaryOf(img(URL_OK, '[  ]')) === '', '只有空白也返空串')

  ok(onebot.imagePlaceholder(img(URL_OK, '[一锅白米饭]'), { serial: 2 }) === '[图片2·一锅白米饭]', '有摘要：编号 + 摘要')
  ok(onebot.imagePlaceholder(img(URL_OK, '[动画表情]'), { serial: 2 }) === '[图片2]', '通用摘要：只留编号')
  ok(onebot.imagePlaceholder(img(URL_OK, '[难过]'), { missing: true }) === '[图片·难过（未取到）]', '失败：摘要 + 未取到')
  ok(onebot.imagePlaceholder(img(URL_OK, ''), { missing: true }) === '[图片（未取到）]', '失败且无摘要：只有未取到')
  ok(onebot.imagePlaceholder(img(URL_OK, '[一锅白米饭]')) === '[图片·一锅白米饭]', '不给编号：只有摘要')
}

console.log('\nB. 不传 label 的旧调用点行为不变（判空 / 命令解析靠它）：')
{
  const msg = [text('看图'), img(URL_OK, '[动画表情]'), img(URL_OK, '[一锅白米饭]')]
  ok(onebot.textOf(msg) === '看图[图片][图片·一锅白米饭]', 'textOf 无 label 时回落默认占位')
  // label 返回空串 = 「我这边没有号可给」，必须**回落**到摘要版占位，而不是把这一段吞掉
  // （吞掉会让 `textOf(...) === ''` 的判空逻辑误判成「这条消息没内容」）
  ok(onebot.textOf(msg, () => '') === '看图[图片][图片·一锅白米饭]', 'label 返回空串时回落默认占位（不是丢掉这段）')
}

console.log('\nC. 编号与 deliver 顺序一致，哪怕渲染顺序相反：')
{
  // 群 @ 路径实际就是「先渲染 context、后渲染 mainText」，而 deliver 数组是 main 在前。
  // 如果按渲染顺序取号，主消息和上下文用了同一张图时两个号会对调。
  const segMain = img(URL_SAME, '[一锅白米饭]')
  const segCtx = img(URL_SAME, '[一锅白米饭]')
  const tracker = images.createImageTracker()
  tracker.resolved.add(URL_SAME)
  images.assignImageSerials(tracker, [{ message: [segMain] }, { message: [segCtx] }])
  const label = images.imageLabelOf(tracker)
  ok(label(segCtx) === '[图片2·一锅白米饭]', '后渲染的上下文拿的是 2 号')
  ok(label(segMain) === '[图片1·一锅白米饭]', '先渲染的主消息拿的是 1 号')
  ok(label(segMain) === '[图片1·一锅白米饭]', '同一段重复渲染仍是同一个号（身份钉在段对象上）')
}

console.log('\nD. 同一张图在同一次投递里出现两次 → 两个号（不能按 url 去重）：')
{
  const a1 = img(URL_SAME, '')
  const a2 = img(URL_SAME, '')
  const b = img(URL_OK, '')
  const tracker = images.createImageTracker()
  tracker.resolved.add(URL_SAME)
  tracker.resolved.add(URL_OK)
  images.assignImageSerials(tracker, [{ message: [a1] }, { message: [a2] }, { message: [b] }])
  const label = images.imageLabelOf(tracker)
  ok(label(a1) === '[图片1]', '第一张')
  ok(label(a2) === '[图片2]', '重复的那张也占一个号')
  ok(label(b) === '[图片3]', '后面的图不会因为去重而提前')
}

console.log('\nE. 下载失败不占号，后面的图仍从 1 连续：')
{
  const bad = img(URL_BAD, '[难过]')
  const good = img(URL_OK, '[饭来]')
  const tracker = images.createImageTracker()
  tracker.failed.add(URL_BAD)
  tracker.resolved.add(URL_OK)
  images.assignImageSerials(tracker, [{ message: [bad] }, { message: [good] }])
  const label = images.imageLabelOf(tracker)
  ok(label(bad) === '[图片·难过（未取到）]', '失败的图明说「未取到」')
  ok(label(good) === '[图片1·饭来]', '后面的图仍是 1 号（失败图没吃号）')
}

console.log('\nF. 端到端：群里两个人各发一张图，正文行能看出谁是谁：')
{
  // 主消息（@ 我）来自 OTHER 带一张图；上下文里 CTX_UIN 也发了一张。
  // 修好之后，正文里应该出现两个**不同形态**的占位，且各自落在自己那一行上。
  // ⚠️ 上下文发送者不能用 PEER（它同时是 ownerUin），否则渲染的是「用户本人」
  //    而不是「群友「…」」，断言就测不到昵称那一路了。
  const main = {
    message_id: '900',
    message_seq: 9001,
    time: 1793600000,
    sender: { user_id: OTHER, nickname: '小鲸鱼' },
    message: [text('看这个'), img(URL_OK, '[一锅白米饭]')],
    message_scene: { ext: [] }
  }
  const ctxMsg = {
    message_id: '901',
    message_seq: 9000,
    time: 1793599990,
    sender: { user_id: CTX_UIN, nickname: '羊羊乐的小憨包' },
    message: [img(URL_BAD, '[难过]')]
  }
  const ated = {
    ...main,
    message: [{ type: 'at', data: { qq: SELF } }, ...main.message]
  }
  const sink = []
  const ctx = makeCtx(sink)
  const result = await handleGroupMessage(ctx, GROUP, ated, [ctxMsg])
  const content = sink[0]?.content ?? []
  const body = content.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('')
  const imageBlocks = content.filter((b) => b?.type === 'image')
  ok(result?.status === 'delivered', `投递成功（${result?.status}）`)
  ok(imageBlocks.length === 1, `成功下载的图只有 1 个块（实际 ${imageBlocks.length}）`)
  ok(body.includes('[图片1·一锅白米饭]'), '主消息那张：1 号 + 摘要')
  ok(body.includes('[图片·难过（未取到）]'), '上下文那张下载失败：说清未取到')
  ok(!body.includes('[图片2'), '失败图没占号，所以不该出现 2 号')
  ok(body.includes('小鲸鱼') && body.includes('羊羊乐的小憨包'), '两个发送者都在正文里（图与人对得上）')
}

console.log(`\n${passed} 过 / ${failed} 败`)
if (failed > 0) process.exitCode = 1
