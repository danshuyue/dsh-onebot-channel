/**
 * send-throttle-sim.mjs —— 跨调用的分条间隔（0.19.4）。
 *
 * 守的是什么：**「两条之间真的隔了那么久」**。
 *
 * 背景（用户报的现场）：他说「每条消息之间的停顿好像不生效，一连串文本切成多条依旧是
 * 快速连发」。查下来不是配置没读到，也不是 partDelayMs 算错，而是停顿时机写错了地方 ——
 * 它原来在 sendToQQ 的分条循环里，条件 `if (i > 0)`，只覆盖「**一次调用**拆成 N 条」。
 * 而连发最常见的形态恰好相反：模型连着调 N 次 qq_send、每次只给一行，
 * 每次调用 markedParts.length === 1，循环一次都不进 i > 0 分支。
 * 探针实测：一次调用拆 6 条 → 间隔 473/485/513/448/453ms；三次独立调用 → gap 0ms。
 *
 * 所以这里钉死四件事：
 *   ① N 次独立调用之间也要有间隔（老 bug 的直接断言）
 *   ② 一次调用拆 N 条之间当然也要有（别为了修①把②弄丢）
 *   ③ 并发两路（同一步里多个 qq_send）不能互相踩 —— 两路会同时读到同一个
 *      lastSendAt、同时补等同样的时间、然后**同时**发出去，节流等于没做
 *   ④ 间隔为 0 时真的立刻发（`Number(x) || 800` 那个坑：0 会被 `||` 吃掉）
 *
 * 全部用假 fetch 记时间戳，不打网络、不碰真 QQ。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { useIsolatedHome } from './isolated-home.mjs'

const HOME = useIsolatedHome('send-throttle-')
const DATA = join(HOME, '.dsh')
mkdirSync(DATA, { recursive: true })

// 隔离 HOME 里自己写一份配置：间隔调大一点，好让「有没有等」一眼看得出来；
// 同时开 allowSendToAny（这几个目标号是虚构的，生产默认会被白名单拦）。
writeFileSync(join(DATA, 'qq-bridge.config.json'), JSON.stringify({
  enabled: true,
  selfUin: 3566906627,
  peerUin: 1321833118,
  ownerUin: 1321833118,
  onebotHttp: 'http://127.0.0.1:3000/',
  token: 'test-token',
  routes: { private: {}, group: {} },
  allowSendToAny: true,
  splitReply: true,
  splitMode: 'paragraph',
  splitMaxChars: 120,
  splitMinChars: 4,
  splitMaxParts: 8,
  splitDelayMode: 'fixed',
  splitDelayMs: 120,
  splitDelayPerCharMs: 120,
  // 0 = 不封顶。要紧：上限如果小于目标间隔，测出来的就是上限而不是间隔本身。
  splitDelayMaxCapMs: 0
}, null, 2), 'utf8')

/** 记下每次真发出去的时刻（fetch 被调用 = 协议端收到了请求）。 */
const sent = []
let failNext = false
globalThis.fetch = async (_url, options) => {
  const payload = JSON.parse(options?.body ?? '{}')
  if (payload.action === 'send_private_msg' || payload.action === 'send_group_msg') {
    sent.push({ at: Date.now(), payload })
  }
  if (failNext) {
    failNext = false
    return { ok: true, json: async () => ({ status: 'ok', retcode: 102, message: '假的失败' }) }
  }
  return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: sent.length } }) }
}

const { loadConfig, getConfig } = await import('../lib/config.js')
loadConfig()
const { sendToQQ, resetSendThrottle } = await import('../lib/outbound.js')

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) } else { fail += 1; console.log(`  ✗ ${label}`) }
}

/**
 * 抖动是 ±15%（partDelayMs 的 jitter 默认 0.15），所以 120ms 的目标实际落在 102~138。
 * 断言用 95 做下限：留出测量误差，又能把「完全没等」（gap≈0）明确判红。
 */
const FLOOR = 95

const gapList = () => sent.slice(1).map((item, index) => item.at - sent[index].at)
const textOf = (item) => (item.payload.params?.message ?? [])
  .filter((seg) => seg.type === 'text')
  .map((seg) => seg.data.text)
  .join('|')

const target = { kind: 'private', id: '100001' }

console.log('跨调用分条间隔')

// ---- ① 三次独立调用：这就是用户遇到的那个形态 ----
{
  resetSendThrottle()
  sent.length = 0
  await sendToQQ(target, '第一条')
  await sendToQQ(target, '第二条')
  await sendToQQ(target, '第三条')
  const gaps = gapList()
  ok(sent.length === 3, '三次独立调用发了三条')
  ok(gaps.length === 2 && gaps[0] >= FLOOR && gaps[1] >= FLOOR,
    `三次独立调用之间也有间隔（实际 ${gaps.join(' / ')}ms，下限 ${FLOOR}ms）`)
}

// ---- ② 一次调用拆三条：老行为不能退化 ----
{
  resetSendThrottle()
  sent.length = 0
  await sendToQQ(target, '甲\n乙\n丙')
  const gaps = gapList()
  ok(sent.length === 3, '一次调用拆成三条')
  ok(gaps.length === 2 && gaps[0] >= FLOOR && gaps[1] >= FLOOR,
    `同一次调用内部也有间隔（实际 ${gaps.join(' / ')}ms）`)
}

// ---- ③ 并发两路：会同时读到同一个 lastSendAt，只有串行化才压得住 ----
{
  resetSendThrottle()
  sent.length = 0
  await Promise.all([
    sendToQQ(target, '并发甲'),
    sendToQQ(target, '并发乙')
  ])
  const gaps = gapList()
  ok(sent.length === 2, '并发两路各发一条')
  ok(gaps.length === 1 && gaps[0] >= FLOOR,
    `并发两路之间也有间隔（实际 ${gaps.join(' / ')}ms —— 没有串行化的话这里是 0ms）`)
}

// ---- ④ 不同目标不互相拖：私聊两个人同时聊，不该排队 ----
{
  resetSendThrottle()
  sent.length = 0
  await Promise.all([
    sendToQQ({ kind: 'private', id: '100002' }, '给甲'),
    sendToQQ({ kind: 'private', id: '100003' }, '给乙')
  ])
  const gaps = gapList()
  ok(sent.length === 2 && gaps[0] < 60,
    `不同目标不互相拖（实际 ${gaps.join(' / ')}ms —— 前面几组都是同目标，这里应该是立刻发）`)
}

// ---- ⑤ 间隔 0 = 立刻发（防 `Number(x) || 800`）----
{
  const cfg = getConfig()
  cfg.splitDelayMs = 0
  resetSendThrottle()
  sent.length = 0
  await sendToQQ(target, '零间隔甲')
  await sendToQQ(target, '零间隔乙')
  const gaps = gapList()
  ok(gaps.length === 1 && gaps[0] < 60,
    `splitDelayMs=0 时立刻发（实际 ${gaps.join(' / ')}ms —— 写成 || 800 这里会是 800ms）`)
  cfg.splitDelayMs = 120
}

// ---- ⑥ 按字数模式：跨调用这边拿的是段数组，字数是 textLengthOf 算出来的 ----
{
  const cfg = getConfig()
  cfg.splitDelayMode = 'perChar'
  cfg.splitDelayPerCharMs = 10   // 20 字 → 目标 200ms
  resetSendThrottle()
  sent.length = 0
  await sendToQQ(target, '零')
  await sendToQQ(target, '一二三四五六七八九十一二三四五六七八九十')
  const gaps = gapList()
  ok(gaps.length === 1 && gaps[0] >= 170,
    `按字数模式按「即将发的那条」的字数算（20 字 × 10ms，实际 ${gaps.join(' / ')}ms）`)
  cfg.splitDelayMode = 'fixed'
  cfg.splitDelayPerCharMs = 120
}

// ---- ⑦ resetSendThrottle 真的清空（测试之间不串味）----
{
  resetSendThrottle()
  sent.length = 0
  const startedAt = Date.now()
  await sendToQQ(target, '重置后第一条')
  const elapsed = Date.now() - startedAt
  ok(sent.length === 1 && elapsed < 60,
    `reset 之后第一条不等（实际 ${elapsed}ms —— 不等说明 lastSendAt 被清掉了）`)
}

// ---- ⑧ 发失败的那次不该把下一条往后推 ----
{
  resetSendThrottle()
  sent.length = 0
  failNext = true
  let threw = false
  try {
    await sendToQQ(target, '会失败的一条')
  } catch {
    threw = true
  }
  ok(threw, 'retcode 非 0 时抛错（不吞）')
  const startedAt = Date.now()
  await sendToQQ(target, '失败之后的一条')
  const elapsed = Date.now() - startedAt
  ok(elapsed < 60,
    `失败的那次不记时刻，下一条不补等（实际 ${elapsed}ms 就发了）`)
}

// ---- ⑨ 日志里必须留下证据 ----
// 用户把日志导出来是为了回答「间隔到底生效没有」。如果这里不写，导出的日志里
// 一条间隔数据都没有 —— 那个「导出日志」按钮就白加了。
{
  let log = ''
  try {
    log = readFileSync(join(DATA, 'qq-bridge-load.log'), 'utf8')
  } catch {
    log = ''
  }
  const lines = log.split('\n').filter((line) => line.includes('两条之间'))
  ok(lines.length > 0, `日志里记了每两条之间的真实毫秒数（${lines.length} 行）`)
  ok(lines.some((line) => line.includes('补等')), '补等时明确写了补多少')
}

console.log(`\n${pass} 过 / ${fail} 败`)
process.exit(fail === 0 ? 0 : 1)
