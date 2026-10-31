/**
 * @ 人（0.14.0）：群里回话时点名叫人。
 *
 * 覆盖：
 *   1. 段顺序：reply → at → text（实测 SnowLuma 就是按这个顺序保留的）
 *   2. **只挂在第一条**：分条发送时后面几条不带 @，避免连点同一个人
 *   3. 私聊忽略 @（没有这个概念）、不 @ 自己、垃圾号当没填
 *   4. 降级链：@ 失败 → 去 @ → 去引用 → 去表情
 *
 * 隔离：沙箱 HOME 放在插件目录**之外**（这台机器插件目录树的权限继承是断的，
 * 在里面 mkdir 会 EPERM）。不碰真实 ~/.dsh。
 * 跑法：node tests/at-sim.mjs
 */
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SANDBOX_HOME = join(HERE, '..', '..', '.tmp-test', `at-${process.pid}`)
mkdirSync(join(SANDBOX_HOME, '.dsh'), { recursive: true })
process.env.USERPROFILE = SANDBOX_HOME
process.env.HOME = SANDBOX_HOME

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

try {
  const calls = []
  /** 让接下来 N 次发送按指定规则失败，用来验证降级链 */
  let failSegments = null
  globalThis.fetch = async (url, init) => {
    const payload = JSON.parse(init.body)
    calls.push(payload)
    const segs = payload.params?.message ?? []
    if (failSegments !== null && segs.some((s) => failSegments.includes(s.type))) {
      return { ok: true, json: async () => ({ status: 'failed', retcode: 100, wording: `segment ${failSegments.join('/')} rejected` }) }
    }
    return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 456 } }) }
  }

  const { loadConfig, getConfig } = await import('../lib/config.js')
  loadConfig()
  const cfg = getConfig()
  const { sendToQQ } = await import('../lib/outbound.js')
  const GROUP = { kind: 'group', id: '975663147' }
  const PRIVATE = { kind: 'private', id: '1321833118' }

  // ---- 1. 段顺序与「只第一条」----
  console.log('段顺序与「只第一条」：')
  calls.length = 0
  await sendToQQ(GROUP, '第一句\n第二句\n第三句', { atUin: '5810550' })
  eq(calls.length, 3, '三段 → 发 3 条')
  const seg1 = calls[0]?.params?.message ?? []
  const seg2 = calls[1]?.params?.message ?? []
  const seg3 = calls[2]?.params?.message ?? []
  eq(seg1.map((s) => s.type), ['at', 'text'], '第一条：at 在 text 之前')
  eq(seg1[0]?.data?.qq, '5810550', '第一条：@ 的 QQ 号正确')
  ok(!seg2.some((s) => s.type === 'at'), '第二条：不带 @')
  ok(!seg3.some((s) => s.type === 'at'), '第三条：不带 @')
  eq(seg1.filter((s) => s.type === 'at').length, 1, '第一条只有一个 at 段')

  // ---- 2. at + reply 共存时的顺序 ----
  console.log('\n@ 与引用的共存：')
  calls.length = 0
  await sendToQQ(GROUP, '我看看', { atUin: '5810550', replyTo: '-535052793' })
  const both = calls[0]?.params?.message ?? []
  eq(both.map((s) => s.type), ['reply', 'at', 'text'], '段顺序 reply → at → text（实测协议端按此保留）')
  eq(both[0]?.data?.id, '-535052793', '引用 id 正确')
  eq(both[1]?.data?.qq, '5810550', '@ 的号正确')

  // 分条时 reply 和 at 都只在第一条
  calls.length = 0
  await sendToQQ(GROUP, '甲\n乙', { atUin: '5810550', replyTo: '-1' })
  const t1 = calls[0]?.params?.message ?? []
  const t2 = calls[1]?.params?.message ?? []
  eq(t1.map((s) => s.type), ['reply', 'at', 'text'], '第一条：reply+at+text')
  eq(t2.map((s) => s.type), ['text'], '第二条：只有 text（引用和 @ 都不跟过来）')

  // ---- 3. 边界：私聊 / 自己 / 垃圾值 ----
  console.log('\n边界：')
  calls.length = 0
  await sendToQQ(PRIVATE, '私聊不该有 @', { atUin: '5810550' })
  ok(!(calls[0]?.params?.message ?? []).some((s) => s.type === 'at'), '私聊：@ 参数被忽略（没有这个概念）')

  calls.length = 0
  await sendToQQ(GROUP, '不 @ 自己', { atUin: String(cfg.selfUin) })
  ok(!(calls[0]?.params?.message ?? []).some((s) => s.type === 'at'), '不 @ 机器人自己')

  for (const bad of ['', '   ', 'abc', '0', '-1']) {
    calls.length = 0
    await sendToQQ(GROUP, `垃圾值 ${JSON.stringify(bad)}`, { atUin: bad })
    ok(!(calls[0]?.params?.message ?? []).some((s) => s.type === 'at'), `垃圾 @ 值 ${JSON.stringify(bad)} → 不带 at 段`)
  }

  // 不传 atUin
  calls.length = 0
  await sendToQQ(GROUP, '没 @', {})
  ok(!(calls[0]?.params?.message ?? []).some((s) => s.type === 'at'), '不传 atUin → 不带 at 段')

  // 号里的空格要能归一（' 5810550 '）
  calls.length = 0
  await sendToQQ(GROUP, '归一化测试', { atUin: ' 5810550 ' })
  eq((calls[0]?.params?.message ?? []).find((s) => s.type === 'at')?.data?.qq, '5810550', '号码前后的空格被归一掉')

  // ---- 4. 降级链 ----
  console.log('\n@ 的降级链：')
  // @ 被拒 → 去 @ 后成功
  calls.length = 0
  failSegments = ['at']
  const r1 = await sendToQQ(GROUP, '这句很重要', { atUin: '5810550' })
  eq(calls.length, 2, '@ 失败后重发一次')
  ok(calls[0].params.message.some((s) => s.type === 'at'), '第一次带了 @')
  ok(!calls[1].params.message.some((s) => s.type === 'at'), '第二次去掉了 @')
  eq(calls[1].params.message.find((s) => s.type === 'text')?.data?.text, '这句很重要', '重发时正文完整')
  ok(r1 !== null && r1 !== undefined, '最终返回结果，没抛错')

  // @ 和 reply 都被拒 → 两级降级
  calls.length = 0
  failSegments = ['at', 'reply']
  await sendToQQ(GROUP, '两级降级', { atUin: '5810550', replyTo: '-1' })
  eq(calls.length, 3, '@+引用都失败 → 共尝试 3 次')
  eq(calls[0].params.message.map((s) => s.type), ['reply', 'at', 'text'], '第 1 次：reply+at+text')
  eq(calls[1].params.message.map((s) => s.type), ['reply', 'text'], '第 2 次：去掉 @')
  eq(calls[2].params.message.map((s) => s.type), ['text'], '第 3 次：去掉引用')
  failSegments = null

  // ---- 5. 接线断言 ----
  console.log('\n接线：')
  const { readFileSync } = await import('node:fs')
  const pollSrc = readFileSync(new URL('../lib/poll.js', import.meta.url), 'utf8')
  ok(/const atUin = isAtMe\(message\.message, config\.selfUin\)/.test(pollSrc), '群投递：被 @ 时自动 @ 回触发人')
  ok(/\{ replyTo, atUin \}/.test(pollSrc), '群投递把 atUin 传给了 deliver')

  const outSrc = readFileSync(new URL('../lib/outbound.js', import.meta.url), 'utf8')
  ok(/atUin: String\(options\?\.atUin/.test(outSrc), 'enqueueOutbound 存了 atUin')
  ok(/atUin: entry\.atUin/.test(outSrc), '自动转发把 atUin 用上了')

  const toolSrc = readFileSync(new URL('../lib/tool.js', import.meta.url), 'utf8')
  ok(/at: \{/.test(toolSrc), 'qq_send 声明了 at 参数')
  ok(/atUin: String\(args\?\.at/.test(toolSrc), 'qq_send 把 at 传给了 sendToQQ')

  console.log(`\n结果：${passed} 过 / ${failed} 败`)
  process.exitCode = failed === 0 ? 0 : 1
} finally {
  try { rmSync(SANDBOX_HOME, { recursive: true, force: true }) } catch {}
}
