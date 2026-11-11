/**
 * 卡片图片的「路径覆盖」测试（0.16.9）。
 *
 * 踩过的事：卡片里的图，群聊路径接了、**私信路径漏了** ——
 * 用户在私信里转发聊天记录，卡片内图片全是 `[图片]` 占位。
 * 单测当时只测了 collectForwardImages（能捞出来），没测「各条投递路径有没有用它」，
 * 所以漏了整整一条路径。
 *
 * 这个测试的做法：不测「图片能不能下载」（那是网络），
 * 而是**静态检查每条会投递正文的路径都调用了 buildForwardImageBlocks**，
 * 外加一次真实的 handlePrivateMessages 投递，断言 image 块被传进去。
 */
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')
const SANDBOX_HOME = join(PLUGIN, '..', '.tmp-test', `imgcover-${process.pid}`)
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
const SESSION = 'session-img-cover-test'
const CARD_ID = 'card-cover-test'

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
  forwardExpandEnabled: true,
  forwardMaxDepth: 2,
  forwardMaxMessages: 50,
  forwardMaxChars: 2000,
  forwardImagesEnabled: true,
  forwardImageLimit: 6,
  forwardTimeoutMs: 4000,
  forwardConcurrency: 3,
  forwardMaxRequests: 16,
  forwardBudgetMs: 6000,
  routes: { private: { [PEER]: { sessionId: SESSION } }, group: { [GROUP]: { sessionId: SESSION } } },
  groupUins: [GROUP]
}, null, 2), 'utf8')
writeFileSync(join(SANDBOX_DATA, 'qq-bridge-state.json'), JSON.stringify({
  lastId: 0, lastSeq: 0, lastTime: 0, privates: {}, groups: {}
}, null, 2), 'utf8')

// 假协议端：get_forward_msg 返回一张带 2 张图的卡片
//
// ⚠️ 图片地址必须用**可解析的域名**（这里用 localhost 的 127.0.0.1 走 IP 字面量分支）：
//   images.js 的 fetchImageBytes 会先过 assertPublicHost()，域名要 DNS 解析、
//   解析失败直接抛「解析不了这个域名」。一开始用 example.invalid 写测试，
//   结果两条路径都是 0 张图 —— 不是代码坏了，是测试数据根本走不到下载那一步。
//   ⚠️ 但 127.0.0.1 会被 isBlockedHost 判成内网而拒掉，所以这里必须用一个
//   **看起来公开**的 IP 字面量：8.8.8.8 不会被 isBlockedHost 拦，而下面的
//   假 fetch 会在真正发请求之前就把它截住，所以不会真的连出去。
const IMG_URL_A = 'https://8.8.8.8/card-a.png'
const IMG_URL_B = 'https://8.8.8.8/card-b.png'
// 一个最小的合法 PNG（1x1 透明），让 sniffImageMediaType 认得出来
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)
let fetchCalls = 0
globalThis.fetch = async (_url, init) => {
  fetchCalls += 1
  const body = JSON.parse(init?.body ?? '{}')
  if (body.action === 'get_forward_msg') {
    // 特制卡片：12 张图，用来测预算闸
    if (String(body.params?.id ?? '') === 'many-img-card') {
      return {
        ok: true,
        json: async () => ({
          retcode: 0,
          data: {
            messages: Array.from({ length: 12 }, (_, i) => ({
              sender: { user_id: '1', nickname: '卡里的人' },
              group_id: 284840486,
              time: 1792991921 + i,
              message: [{ type: 'image', data: { url: `https://8.8.8.8/many-${i}.png`, file: `m${i}.png` } }]
            }))
          }
        })
      }
    }
    return {
      ok: true,
      json: async () => ({
        retcode: 0,
        data: {
          messages: [
            { sender: { user_id: '1', nickname: '卡里的人' }, group_id: 284840486, time: 1792991921, message: [{ type: 'text', data: { text: '看这两张图' } }] },
            { sender: { user_id: '1', nickname: '卡里的人' }, group_id: 284840486, time: 1792991922, message: [{ type: 'image', data: { url: IMG_URL_A, file: 'a.png' } }] },
            { sender: { user_id: '1', nickname: '卡里的人' }, group_id: 284840486, time: 1792991923, message: [{ type: 'image', data: { url: IMG_URL_B, file: 'b.png' } }] }
          ]
        }
      })
    }
  }
  // 图片下载：直接回一个真 PNG，不走网络
  if (String(_url).startsWith('https://8.8.8.8/')) {
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
const { handlePrivateMessages, handleGroupMessage } = await import('../lib/poll.js')

loadConfig()
loadState()

/** 假 agent：记录 followup 收到的所有块 */
function makeAgent(sink) {
  return { followup: (m) => { sink.push(m) }, session: { snapshotEvents: () => [] } }
}
/** 假 attachments 服务：saveImages 原样返回引用 */
const fakeAttachments = {
  saveImages: async (items) => items.map((item, i) => ({ id: `att-${i}-${item.mediaType}`, name: item.name ?? '' }))
}
function makeCtx(sink) {
  const agent = makeAgent(sink)
  return {
    get: (key) => {
      if (key === 'agents') return { get: () => agent, resume: async () => ({ agent }) }
      if (key === 'attachments') return fakeAttachments
      return undefined
    },
    effect: () => {}
  }
}

const cardMessage = (uin, seq) => ({
  message_id: String(800 + seq),
  message_seq: seq,
  time: 1793600000,
  sender: { user_id: String(uin), nickname: '转发的人' },
  message: [{ type: 'forward', data: { id: CARD_ID } }]
})

console.log('A. 私信路径必须把卡片图交出去（用户报的 bug）：')
{
  const sink = []
  const ctx = makeCtx(sink)
  const msg = cardMessage(PEER, 1)
  await handlePrivateMessages(ctx, PEER, [msg])
  const content = sink[0]?.content ?? []
  const imageBlocks = content.filter((b) => b?.type === 'image')
  ok(sink.length === 1, `投递发生了（followup ${sink.length} 次）`)
  ok(imageBlocks.length >= 1, `卡片图变成了 image 块（${imageBlocks.length} 个）`)
  ok(imageBlocks.every((b) => b.attachment !== undefined), '每个 image 块都带 attachment')
}

console.log('\nB. 群聊路径同样要交出卡片图（0.16.7 就有，防回归）：')
{
  const sink = []
  const ctx = makeCtx(sink)
  const msg = {
    ...cardMessage(PEER, 2),
    message: [{ type: 'at', data: { qq: SELF } }, { type: 'forward', data: { id: CARD_ID } }]
  }
  await handleGroupMessage(ctx, GROUP, msg, [])
  const content = sink[0]?.content ?? []
  const imageBlocks = content.filter((b) => b?.type === 'image')
  ok(sink.length === 1, `投递发生了（followup ${sink.length} 次）`)
  ok(imageBlocks.length >= 1, `卡片图变成了 image 块（${imageBlocks.length} 个）`)
}

console.log('\nB2. 窗口批次也要交出卡片图（0.16.9 补的第三条路）：')
{
  const { deliverWindowBatch } = await import('../lib/poll.js')
  const { getConfig } = await import('../lib/config.js')
  const cfg = getConfig()
  // 窗口批次入口第一句就是 `if (config.windowEnabled === false) return skipped`，
  // 所以这里必须先把开关打开，否则测的是「被跳过」而不是「图交没交」
  const prevWindow = cfg.windowEnabled
  cfg.windowEnabled = true
  const sink = []
  const ctx = makeCtx(sink)
  const batch = [cardMessage(PEER, 5)]
  const result = await deliverWindowBatch(ctx, GROUP, batch)
  const content = sink[0]?.content ?? []
  const imageBlocks = content.filter((b) => b?.type === 'image')
  ok(result.status === 'delivered', `窗口批次投递成功（${result.status}）`)
  ok(imageBlocks.length >= 1, `窗口批次里的卡片图变成了 image 块（${imageBlocks.length} 个）`)
  cfg.windowEnabled = prevWindow
}

console.log('\nC. 开关关掉时两条路径都不该有卡片图：')
{
  const { getConfig } = await import('../lib/config.js')
  const cfg = getConfig()
  cfg.forwardImagesEnabled = false
  const sink = []
  const ctx = makeCtx(sink)
  await handlePrivateMessages(ctx, PEER, [cardMessage(PEER, 3)])
  const imageBlocks = (sink[0]?.content ?? []).filter((b) => b?.type === 'image')
  ok(imageBlocks.length === 0, `开关关着 → 没有卡片图（${imageBlocks.length} 个）`)
  // 但正文里要有 [图片] 占位，不能静默消失
  const text = (sink[0]?.content ?? []).find((b) => b?.type === 'text')?.text ?? ''
  ok(text.includes('[图片]'), '正文里保留 [图片] 占位')
  cfg.forwardImagesEnabled = true
}

console.log('\nD. 静态检查：**每一条**投递路径都调用了 buildForwardImageBlocks：')
{
  const pollSrc = readFileSync(join(PLUGIN, 'lib', 'poll.js'), 'utf8')
  const callCount = (pollSrc.match(/await buildForwardImageBlocks\(/g) ?? []).length
  // ⚠️ 这里必须写死 3，不能写 >= 2（审核发现）：
  //   原来的 `>= 2` 在「群聊窗口批次漏了卡片图」时**照样全绿** ——
  //   断言只要能被「少一条路」满足，就等于没测覆盖。
  //   三条路径：私信 handlePrivateMessages、群聊 handleGroupMessage、窗口批次 deliverWindowBatch。
  ok(callCount === 3, `三处调用（实际 ${callCount} 处：私信 / 群聊 / 窗口批次）`)

  // 每一处的结果都必须拼进 deliver 的图片参数 —— 只调用不拼接等于白算
  ok(/\[\.\.\.imageBlocks,\s*\.\.\.forwardImages\]/.test(pollSrc), '私信路径把卡片图拼进了 deliver 参数')
  ok(/\[\.\.\.mainImages,\s*\.\.\.contextImages,\s*\.\.\.forwardImages\]/.test(pollSrc), '群聊路径把卡片图拼进了 deliver 参数')
  ok(/\[\.\.\.images,\s*\.\.\.forwardImages\]/.test(pollSrc), '窗口批次把卡片图拼进了 deliver 参数')
}

console.log('\nF. 卡片图不该进「最近收到的图片」索引（会污染 qq_collect_face）：')
{
  // 审核发现：卡片图是别人转发进来的，记进索引会让 recent/index 取到陌生人的图，
  // 而且索引时间戳是「下载时刻」不是卡片原时间。
  const imagesSrc = readFileSync(join(PLUGIN, 'lib', 'images.js'), 'utf8')
  ok(/if \(remember\) rememberImage\(/.test(imagesSrc), 'saveImageCopy 会按 remember 决定是否记索引')
  ok(/options\?\.remember !== false/.test(imagesSrc), 'buildImageBlocks 把 remember 透传给 saveImageCopy')
  const pollSrc = readFileSync(join(PLUGIN, 'lib', 'poll.js'), 'utf8')
  // 2026-11-09：这条调用还多传了 tracker（给正文里的 [图片N] 编号用），
  // 所以匹配到 `remember: false` 之后允许跟别的键，不能要求它是最后一个键。
  ok(/\{ remember: false[\s,}]/.test(pollSrc), '卡片图那条路径显式传了 remember:false')
}

console.log('\nH. 预算真的能中断下载（行为测试，不只静态检查）：')
{
  const { getConfig } = await import('../lib/config.js')
  const { buildImageBlocks } = await import('../lib/images.js')
  const cfg = getConfig()
  const prevBudget = cfg.forwardBudgetMs
  const prevLimit = cfg.forwardImageLimit
  // 预算 1 秒 + 每张图假装要 400ms → 最多下 2~3 张就该被切断
  cfg.forwardBudgetMs = 1000
  cfg.forwardImageLimit = 30

  const realFetch = globalThis.fetch
  let downloads = 0
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://8.8.8.8/')) {
      downloads += 1
      await new Promise((r) => setTimeout(r, 400))
      return {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'image/png'], ['content-length', String(PNG_BYTES.length)]]),
        arrayBuffer: async () => PNG_BYTES.buffer.slice(PNG_BYTES.byteOffset, PNG_BYTES.byteOffset + PNG_BYTES.byteLength),
        body: null
      }
    }
    return realFetch(url, init)
  }

  const sink = []
  const ctx = makeCtx(sink)
  const t0 = Date.now()
  // 一张卡片里塞 12 张图
  const manyCard = {
    ...cardMessage(PEER, 9),
    message: [{ type: 'forward', data: { id: 'many-img-card' } }]
  }
  globalThis.__manyCard = true
  await handlePrivateMessages(ctx, PEER, [manyCard])
  const elapsed = Date.now() - t0
  globalThis.fetch = realFetch
  const imageBlocks = (sink[0]?.content ?? []).filter((b) => b?.type === 'image')

  ok(downloads < 12, `没有把 12 张全下完（实际下了 ${downloads} 张）`)
  ok(imageBlocks.length < 12, `交给模型的图也被截住（${imageBlocks.length} 个块）`)
  ok(elapsed < 4000, `总耗时被预算压住（${elapsed}ms，预算 1000ms）`)
  cfg.forwardBudgetMs = prevBudget
  cfg.forwardImageLimit = prevLimit
  void buildImageBlocks
}
{
  const pollSrc = readFileSync(join(PLUGIN, 'lib', 'poll.js'), 'utf8')
  const fnStart = pollSrc.indexOf('async function buildForwardImageBlocks')
  const fnEnd = pollSrc.indexOf('\nexport async function handlePrivateMessages', fnStart)
  const fn = fnStart >= 0 && fnEnd > fnStart ? pollSrc.slice(fnStart, fnEnd) : ''
  ok(fn !== '', '找到 buildForwardImageBlocks 函数体')
  // 逐张下载：函数里必须出现「一张一次」的 buildImageBlocks 调用
  ok(/message:\s*\[\{ type: 'image', data: seg \}\]/.test(fn), '每张图单独调一次 buildImageBlocks（死线才有机会生效）')
  // 死线判断要在循环内部
  const loopIdx = fn.indexOf('for (const { seg, uin } of candidates)')
  const deadlineIdx = fn.indexOf('Date.now() > deadline')
  ok(loopIdx >= 0 && deadlineIdx > loopIdx, '死线判断在逐张循环内部')
  // limit 必须夹 30（poll 直接读 config，绕过了 forward.js 的夹取）
  ok(/Math\.min\(30,\s*Number\(config\.forwardImageLimit\)/.test(fn), 'forwardImageLimit 在 poll 侧也夹了 30')
}

console.log('\nE. attachments 服务缺失时的降级（应只记日志、不崩）：')
{
  const sink = []
  const agent = makeAgent(sink)
  const ctx = {
    get: (key) => {
      if (key === 'agents') return { get: () => agent, resume: async () => ({ agent }) }
      return undefined // 没有 attachments
    },
    effect: () => {}
  }
  let threw = null
  try {
    await handlePrivateMessages(ctx, PEER, [cardMessage(PEER, 4)])
  } catch (error) {
    threw = error
  }
  ok(threw === null, `attachments 缺失时不抛错${threw === null ? '' : `（${threw.message}）`}`)
  ok(sink.length === 1, '仍然投递了正文（图只是没有块）')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
