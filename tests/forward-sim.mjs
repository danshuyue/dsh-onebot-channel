/**
 * 合并转发展开（聊天记录卡片）的离线模拟（0.16.7）。
 *
 * 钉住的东西：
 *   1. 开关关着时，渲染退化成旧的「[转发消息]」占位（=旧行为，不回归）
 *   2. 开关开着时，卡片里的每条消息真的进了正文（sender + 内容 + 时间）
 *   3. 截断生效，并且**明说**还漏了多少条（不能静默截）
 *   4. 嵌套：maxDepth=1 时子卡片仍是占位；调到 2 才展开
 *   5. 展开失败不抛错，只是占位（一张卡片取不到不能打断整条投递）
 *   6. 并发上限、缓存复用（同一个 id 只请求一次）
 *   7. 图片默认不取；开了以后按上限取
 *
 * 隔离：整个测试跑在临时 HOME 里，不碰真的 ~/.dsh，也不碰真协议端。
 * 协议端用假的 fetch 顶替，记录每个被请求的 action。
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SANDBOX_HOME = join(HERE, '..', '..', '.tmp-test', `forward-${process.pid}`)
const SANDBOX_DATA = join(SANDBOX_HOME, '.dsh')
mkdirSync(SANDBOX_DATA, { recursive: true })
process.env.USERPROFILE = SANDBOX_HOME
process.env.HOME = SANDBOX_HOME
process.on('exit', () => {
  try { rmSync(SANDBOX_HOME, { recursive: true, force: true }) } catch {}
})

writeFileSync(join(SANDBOX_DATA, 'qq-bridge.config.json'), JSON.stringify({
  enabled: true,
  selfUin: '3566906627',
  peerUin: '1321833118',
  ownerUin: '1321833118',
  // 假地址：所有请求都被下面的 fetch 拦掉，不会真的发出去
  onebotHttp: 'http://127.0.0.1:9/',
  token: 'test-token'
}, null, 2), 'utf8')

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.error(`  ✗ ${name}`) }
}

// ---- 假协议端 ----
const FWD_INNER = 'inner-card-id'
const FWD_OUTER = 'outer-card-id'

/** 被请求过的 action 记录（用来验并发表和缓存） */
const calls = []
/** get_forward_msg 的返回表；值是 null 表示「这条故意失败」 */
let forwardTable = {}

globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init?.body ?? '{}')
  calls.push({ action: body.action, id: body.params?.id })
  if (body.action !== 'get_forward_msg') {
    return { ok: true, json: async () => ({ retcode: 0, data: {} }) }
  }
  const id = String(body.params?.id ?? '')
  const entry = forwardTable[id]
  if (entry === undefined || entry === null) {
    return { ok: true, json: async () => ({ retcode: 100, status: 'failed', wording: 'download forward message payload is empty' }) }
  }
  return { ok: true, json: async () => ({ retcode: 0, status: 'ok', data: { messages: entry } }) }
}

// 造消息：真实形状（实测 get_forward_msg 每条都是这个结构）
const piece = (nick, text, time) => ({
  sender: { user_id: '1000', nickname: nick },
  time,
  message: [{ type: 'text', data: { text } }]
})
const imagePiece = (nick, url, time) => ({
  sender: { user_id: '1000', nickname: nick },
  time,
  message: [{ type: 'image', data: { url, file: 'x.jpg', sub_type: 7, summary: '[图]' } }]
})
const nestedPiece = (nick, text, innerId, time) => ({
  sender: { user_id: '1000', nickname: nick },
  time,
  message: [
    { type: 'text', data: { text } },
    { type: 'forward', data: { id: innerId } }
  ]
})

const TS = 1792991921
forwardTable[FWD_OUTER] = [
  piece('崩兔子', '我们主任去年给人开止痛贴', TS),
  piece('崩兔子', '26岁的男的', TS + 60),
  piece('黑鱼', '?', TS + 120),
  nestedPiece('崩兔子', '这张更早的记录：', FWD_INNER, TS + 180),
  imagePiece('崩兔子', 'https://example.invalid/a.png', TS + 240),
  ...Array.from({ length: 20 }, (_, i) => piece('刷屏的', `第${i + 5}条`, TS + 300 + i))
]
forwardTable[FWD_INNER] = [
  piece('更早的人', '内层卡片的内容', TS - 1000),
  piece('更早的人', '内层第二句', TS - 900)
]

const { loadConfig, getConfig } = await import('../lib/config.js')
const forward = await import('../lib/forward.js')
const cfg = loadConfig()

/** 一条「回」了张卡片的群消息 */
const cardMessage = (id = FWD_OUTER) => ({
  message_id: '900',
  message_seq: 1,
  time: TS,
  sender: { user_id: '1000', nickname: '转发的' },
  message: [{ type: 'forward', data: { id } }]
})

function setForwardConfig(overrides = {}) {
  Object.assign(cfg, {
    forwardExpandEnabled: true,
    forwardMaxDepth: 2,
    forwardMaxMessages: 50,
    forwardMaxChars: 2000,
    forwardImagesEnabled: false,
    forwardImageLimit: 6,
    forwardTimeoutMs: 4000,
    forwardConcurrency: 3,
    forwardMaxRequests: 16,
    forwardBudgetMs: 6000
  }, overrides)
  forward.clearForwardCache()
}

console.log('1. 开关关着 → 退回旧占位（旧行为不回归）：')
setForwardConfig({ forwardExpandEnabled: false })
calls.length = 0
{
  const msg = cardMessage()
  const prefetched = await forward.prefetchForwards(msg.message)
  const text = forward.renderSegments(msg.message, 0, undefined, '', prefetched)
  ok(prefetched.size === 0, '没有发出任何请求')
  ok(calls.length === 0, `零网络请求（实际 ${calls.length} 次）`)
  ok(text === '[转发消息]', `渲染成旧占位「[转发消息]」（实际「${text}」）`)
}

console.log('\n2. 开关开着 → 卡片内容真的展开：')
setForwardConfig()
calls.length = 0
let rendered = ''
{
  const msg = cardMessage()
  const prefetched = await forward.prefetchForwards(msg.message)
  rendered = forward.renderSegments(msg.message, 0, undefined, '', prefetched)
  ok(calls.some((c) => c.action === 'get_forward_msg' && c.id === FWD_OUTER), '发出了 get_forward_msg')
  ok(rendered.includes('我们主任去年给人开止痛贴'), '第一条内容在正文里')
  ok(rendered.includes('崩兔子'), '发言人昵称在正文里')
  ok(rendered.includes('26岁的男的'), '第二条内容也在')
  // ⚠️ 不能断言「不含 [转发消息」—— 展开后的标题前缀就是「[转发消息 · 共 N 条]」。
  //   要断言的是「不再只有占位」：占位形态恰好是 `[转发消息]` 且后面没有内容。
  ok(!/^\[转发消息\]$/.test(rendered.trim()), '不再是纯占位')
  ok(rendered.split('\n').length > 3, `有真正的多行内容（${rendered.split('\n').length} 行）`)
  ok(/共 \d+ 条/.test(rendered), '开头写明总条数')
}

console.log('\n3. 截断必须明说漏了多少（不能静默截）：')
setForwardConfig({ forwardMaxMessages: 3 })
{
  const msg = cardMessage()
  const prefetched = await forward.prefetchForwards(msg.message)
  const text = forward.renderSegments(msg.message, 0, undefined, '', prefetched)
  ok(text.includes('还有'), `明说了还有未展开的部分`)
  ok(/还有 \d+ 条未展开/.test(text), `给出了具体条数：${(text.match(/还有 \d+ 条未展开/) ?? ['(没匹配到)'])[0]}`)
  // 数一下实际展开的行数：开头一行 + 3 行内容
  const bodyLines = text.split('\n').slice(1).filter((l) => l.trim() !== '')
  ok(bodyLines.length === 3, `只展开 3 条（实际 ${bodyLines.length} 行）`)
}

console.log('\n4. 字数上限也生效：')
setForwardConfig({ forwardMaxChars: 40 })
{
  const msg = cardMessage()
  const prefetched = await forward.prefetchForwards(msg.message)
  const text = forward.renderSegments(msg.message, 0, undefined, '', prefetched)
  const body = text.split('\n').slice(1).join('\n')
  // 计数的口径是「行长度之和」，所以正文 = 已收的若干整行。
  // 断言：不该出现「收了 2 条以上却远超上限」——上限内最多再收一条整行。
  const lines = body.split('\n').filter((l) => l.trim() !== '')
  ok(lines.length >= 1, `至少展开了第一条（实际 ${lines.length} 条）`)
  ok(lines.length <= 2, `没有无脑全收（${lines.length} 条，上限 ${40} 字）`)
  // 单条超长时必须自己截断，而不是整行塞进去
  ok(text.includes('此条过长，已截断') || body.length <= 40 + 40, '单条超长时有截断或总体受控')
}

console.log('\n4b. 单条超长 → 截断并说明：')
setForwardConfig({ forwardMaxChars: 20 })
{
  const msg = cardMessage()
  const prefetched = await forward.prefetchForwards(msg.message)
  const text = forward.renderSegments(msg.message, 0, undefined, '', prefetched)
  ok(text.includes('此条过长，已截断'), '单条超长时明确写了「已截断」')
}

console.log('\n5. 嵌套卡片：depth=1 时子卡片仍是占位：')
setForwardConfig({ forwardMaxDepth: 1 })
calls.length = 0
{
  const msg = cardMessage()
  const prefetched = await forward.prefetchForwards(msg.message)
  const text = forward.renderSegments(msg.message, 0, undefined, '', prefetched)
  ok(!calls.some((c) => c.id === FWD_INNER), 'depth=1 时没有请求内层卡片')
  ok(!text.includes('内层卡片的内容'), '内层内容没被展开（符合预期）')
  ok(text.includes('[转发消息'), '内层保留占位')
}

console.log('\n6. 嵌套卡片：depth=2 时才展开内层：')
setForwardConfig({ forwardMaxDepth: 2 })
calls.length = 0
{
  const msg = cardMessage()
  // depth=2 时预取应当**递归**把内层也取回来（不需要调用方手工补）
  const prefetched = await forward.prefetchForwards(msg.message)
  ok(calls.some((c) => c.id === FWD_INNER), '递归预取请求了内层卡片')
  ok(prefetched.has(FWD_INNER), '内层结果进了同一个 Map')
  const text = forward.renderSegments(msg.message, 0, undefined, '', prefetched)
  ok(text.includes('内层卡片的内容'), 'depth=2 时内层内容被展开')
}

console.log('\n6b. depth=1 时不应递归请求内层：')
setForwardConfig({ forwardMaxDepth: 1 })
calls.length = 0
{
  const prefetched = await forward.prefetchForwards(cardMessage().message)
  ok(!calls.some((c) => c.id === FWD_INNER), 'depth=1 没有请求内层')
  ok(!prefetched.has(FWD_INNER), '内层不在结果里')
}

console.log('\n7. 展开失败不抛错，只降级成占位：')
setForwardConfig()
{
  const msg = cardMessage('不存在的-id')
  let threw = null
  let text = ''
  try {
    const prefetched = await forward.prefetchForwards(msg.message)
    text = forward.renderSegments(msg.message, 0, undefined, '', prefetched)
  } catch (error) {
    threw = error
  }
  ok(threw === null, `没有抛错${threw === null ? '' : `（实际抛了 ${threw.message}）`}`)
  ok(text.includes('[转发消息'), '降级成占位')
  ok(text.includes('download forward message payload is empty') || text.includes('（'), '占位里带上失败原因，便于排障')
}

console.log('\n7b. 「占位态」不能被当成内容渲染（ok 不为 true 一律走占位）：')
setForwardConfig()
{
  // 手工构造一个「ok:false 且带 messages」的记录 —— 递归预取会先写 pending 占位，
  // 如果把 `hit.ok !== true` 的守卫改松，它会被当成有效内容渲染出一段空卡片。
  const forged = new Map([['forged-id', { ok: false, error: 'pending', messages: [piece('不该出现的人', '不该出现的内容', TS)] }]])
  const msg = { message: [{ type: 'forward', data: { id: 'forged-id' } }] }
  const text = forward.renderSegments(msg.message, 0, undefined, '', forged)
  ok(!text.includes('不该出现的内容'), 'ok:false 的卡片内容没有被渲染出来')
  ok(text.includes('[转发消息'), '仍然是占位')
}

console.log('\n8. 缓存：同一个 id 只请求一次：')
setForwardConfig()
calls.length = 0
{
  const msg = cardMessage()
  await forward.prefetchForwards(msg.message)
  const first = calls.filter((c) => c.id === FWD_OUTER).length
  await forward.prefetchForwards(msg.message)
  const second = calls.filter((c) => c.id === FWD_OUTER).length
  ok(first === 1, `第一次请求 1 次（实际 ${first}）`)
  ok(second === 1, `第二次命中缓存，没有再请求（累计 ${second}）`)
}

console.log('\n9. 图片：默认不取，开了按上限取：')
setForwardConfig({ forwardImagesEnabled: false })
{
  const msg = cardMessage()
  const prefetched = await forward.prefetchForwards(msg.message)
  const images = forward.collectForwardImages(msg.message, prefetched)
  ok(images.length === 0, '默认不收集卡片里的图片')
  ok(forward.renderSegments(msg.message, 0, undefined, '', prefetched).includes('[图片]'), '正文里是 [图片] 占位')
}
setForwardConfig({ forwardImagesEnabled: true, forwardImageLimit: 1 })
{
  const msg = cardMessage()
  const prefetched = await forward.prefetchForwards(msg.message)
  const images = forward.collectForwardImages(msg.message, prefetched)
  ok(images.length === 1, `按上限只取 1 张（实际 ${images.length}）`)
  ok(images[0].url.startsWith('https://'), '拿到的是真实图片 url')
}

console.log('\n10. 没有卡片的消息 = 零开销：')
setForwardConfig()
calls.length = 0
{
  const plain = { message: [{ type: 'text', data: { text: '就一句话' } }] }
  const prefetched = await forward.prefetchForwards(plain.message)
  ok(prefetched.size === 0, '没有预取内容')
  ok(calls.length === 0, `没有网络请求（实际 ${calls.length}）`)
  ok(forward.hasForward(plain.message) === false, 'hasForward 判为没有卡片')
  ok(forward.hasForward(cardMessage().message) === true, 'hasForward 判为有卡片')
}

console.log('\n11. 段类型：卡片里的图片/语音不会变成乱码：')
setForwardConfig()
{
  forwardTable[FWD_OUTER] = [
    piece('甲', '正常一句', TS),
    { sender: { user_id: '1', nickname: '甲' }, time: TS, message: [{ type: 'record', data: {} }] },
    { sender: { user_id: '1', nickname: '甲' }, time: TS, message: [{ type: 'file', data: { name: 'a.pdf' } }] }
  ]
  forward.clearForwardCache()
  const msg = cardMessage()
  const prefetched = await forward.prefetchForwards(msg.message)
  const text = forward.renderSegments(msg.message, 0, undefined, '', prefetched)
  ok(text.includes('[语音]'), '语音渲染成中文标签')
  ok(text.includes('[文件]'), '文件渲染成中文标签')
}

console.log('\n12. 「有卡片」和「没卡片」两条路径必须逐字一致（审核发现的退化）：')
setForwardConfig()
{
  // 踩过：renderSegments 原本自己复制了一套段渲染 switch，漏了 face/mface，
  // 于是「一批消息里有任意一张卡片」就会让整批的「[表情:呲牙]」退化成「[表情]」。
  // 现在两边共用 onebot.js 的 segmentToText，这条断言钉住它们不再漂移。
  const { textOf } = await import('../lib/onebot.js')
  const cases = [
    { name: '经典表情', message: [{ type: 'face', data: { id: '13' } }] },
    { name: '文字+表情', message: [{ type: 'text', data: { text: '好的' } }, { type: 'face', data: { id: '13' } }] },
    { name: '@ 某人', message: [{ type: 'at', data: { qq: '12345' } }, { type: 'text', data: { text: '在吗' } }] },
    { name: '@ 全体', message: [{ type: 'at', data: { qq: 'all' } }] },
    { name: '图片', message: [{ type: 'image', data: { url: 'x' } }] },
    { name: '引用', message: [{ type: 'reply', data: { id: '1' } }, { type: 'text', data: { text: '接着说' } }] },
    { name: '语音', message: [{ type: 'record', data: {} }] },
    { name: '未知段', message: [{ type: 'weird_thing', data: {} }] }
  ]
  for (const c of cases) {
    const viaText = textOf(c.message)
    const viaRender = forward.renderSegments(c.message, 0, undefined, '', new Map())
    ok(viaText === viaRender, `${c.name} 两条路径一致（textOf「${viaText}」/ render「${viaRender}」）`)
  }
}

console.log('\n13. forwardConcurrency 是并发数，不是「最多展开几张」：')
setForwardConfig({ forwardConcurrency: 2 })
calls.length = 0
{
  // 踩过：旧实现 `ids.slice(0, concurrency)` 会把第 3 张以后的卡片**永久丢掉**，
  // 只在正文里留占位，用户不知道为什么不展开。
  const ids = ['m1', 'm2', 'm3', 'm4', 'm5']
  for (const id of ids) forwardTable[id] = [piece('人' + id, '内容' + id, TS)]
  const msg = { message: ids.map((id) => ({ type: 'forward', data: { id } })) }
  const prefetched = await forward.prefetchForwards(msg.message)
  const missing = ids.filter((id) => !prefetched.has(id))
  ok(missing.length === 0, `5 张卡片全部取到（缺：${missing.join(',') || '无'}，并发上限 2）`)
  const text = forward.renderSegments(msg.message, 0, undefined, '', prefetched)
  for (const id of ids) ok(text.includes('内容' + id), `${id} 的内容进了正文`)
}

console.log('\n14. 极端配置不会崩：')
setForwardConfig({ forwardMaxDepth: 1000, forwardMaxMessages: 1, forwardMaxChars: 20, forwardConcurrency: 999 })
{
  let threw = null
  let text = ''
  try {
    const msg = cardMessage()
    const prefetched = await forward.prefetchForwards(msg.message)
    text = forward.renderSegments(msg.message, 0, undefined, '', prefetched)
  } catch (error) {
    threw = error
  }
  ok(threw === null, `超大配置下不抛错${threw === null ? '' : `（${threw.message}）`}`)
  ok(typeof text === 'string' && text.length > 0, '仍然产出内容')
}

console.log('\n15. 畸形数据不能穿透（否则会丢整条 @ 消息）：')
setForwardConfig()
{
  // 审核指出：prefetchForwards 抛错会冒到 handleGroupMessage 之外，
  // 被 pollGroup 的 catch 吞掉，而游标在那之前已前进并落盘 → 这条消息永久丢。
  // 实测畸形数据能触发：展开结果里 message 是 getter 抛错。
  const realFetch = globalThis.fetch
  globalThis.fetch = async (_u, init) => {
    const b = JSON.parse(init?.body ?? '{}')
    if (b.action !== 'get_forward_msg') return { ok: true, json: async () => ({ retcode: 0, data: {} }) }
    const bad = { sender: {}, time: TS }
    Object.defineProperty(bad, 'message', { get() { throw new Error('恶意/畸形段数组') } })
    return { ok: true, json: async () => ({ retcode: 0, data: { messages: [bad] } }) }
  }
  let threw = null
  let prefetched = null
  try {
    prefetched = await forward.prefetchForwards(cardMessage().message)
  } catch (error) {
    threw = error
  }
  globalThis.fetch = realFetch
  ok(threw === null, `畸形展开数据不会抛出来${threw === null ? '' : `（抛了 ${threw.message}）`}`)
  ok(prefetched !== null, '仍然返回一个 Map（调用方可以照常渲染）')
  const text = forward.renderSegments(cardMessage().message, 0, undefined, '', prefetched ?? new Map())
  ok(typeof text === 'string', '渲染不崩')
}

console.log('\n16. 请求预算：depth 再大也有常数上界：')
setForwardConfig({ forwardMaxDepth: 1000, forwardMaxRequests: 5, forwardConcurrency: 2 })
calls.length = 0
{
  // 造 20 张卡片，预算只有 5 次 → 只该发 5 个请求，剩下的按占位
  const ids = Array.from({ length: 20 }, (_, i) => 'bud' + i)
  for (const id of ids) forwardTable[id] = [piece('人', '内容' + id, TS)]
  const msg = { message: ids.map((id) => ({ type: 'forward', data: { id } })) }
  const prefetched = await forward.prefetchForwards(msg.message)
  const requests = calls.filter((c) => c.action === 'get_forward_msg').length
  ok(requests <= 5, `请求数被预算限住（${requests} 次 ≤ 5）`)
  ok(prefetched.size >= 1, `至少取到一张（实际 ${prefetched.size}）`)
  const text = forward.renderSegments(msg.message, 0, undefined, '', prefetched)
  ok(text.includes('[转发消息'), '没取到的卡片仍然有占位（不静默消失）')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
