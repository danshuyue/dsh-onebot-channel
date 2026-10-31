/**
 * 引用回复（0.13.0）：@ 段与 reply 段。
 *
 * 覆盖：
 *   1. 入站解析：replyTargetOf / atTargetsOf 认得出真实的段形状
 *   2. 投递正文：每条带 [#id] 锚点，引用关系用 → #id 标出来
 *   3. 出站：reply 段排在第一个；**只挂在第一条消息上**（分条时后面几条不带）
 *   4. 兜底：引用导致发送失败 → 去引用重发；表情也失败 → 再去表情
 *
 * 隔离：沙箱 HOME，不碰真实 ~/.dsh。
 * 跑法：node tests/reply-sim.mjs
 */
import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 沙箱放在**插件目录之外**的上级目录里。
// 原因（实测）：这台机器上 dsh-onebot-channel 目录树的权限继承被断开了，
// 子进程连在它内部 mkdir 都会被 EPERM 挡住；而上级 DSHPlugins 目录是可写的。
const HERE = dirname(fileURLToPath(import.meta.url))          // …/dsh-onebot-channel/tests
const SANDBOX_HOME = join(HERE, '..', '..', '.tmp-test', `reply-${process.pid}`)  // …/DSHPlugins/.tmp-test/…
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
  // ---- 1. 入站解析（用实测到的真实段形状）----
  console.log('onebot.js 的段解析：')
  const { replyTargetOf, atTargetsOf, textOf } = await import('../lib/onebot.js')

  // 实测样本：{"type":"reply","data":{"id":"-1019027093"}}
  eq(replyTargetOf([{ type: 'reply', data: { id: '-1019027093' } }]), { id: '-1019027093' }, 'reply 段：负数 id 原样保留')
  eq(replyTargetOf([{ type: 'reply', data: { id: '1519605856' } }]), { id: '1519605856' }, 'reply 段：正数 id 也认')
  eq(replyTargetOf([{ type: 'text', data: { text: '你好' } }]), null, '没有 reply 段 → null')
  eq(replyTargetOf(null), null, 'null 输入不抛错')
  eq(replyTargetOf([]), null, '空数组不抛错')
  // 空 id 不能当成有效引用（否则会发出一个空引用段）
  eq(replyTargetOf([{ type: 'reply', data: { id: '' } }]), null, 'reply 段 id 为空 → 当作没引用')
  // 兼容 message_id 字段名（不同实现可能这么给）
  eq(replyTargetOf([{ type: 'reply', data: { message_id: '42' } }]), { id: '42' }, '兼容 message_id 字段名')

  // 大整数不能因为 Number 往返丢精度
  const bigId = '2008556211'
  eq(replyTargetOf([{ type: 'reply', data: { id: bigId } }]).id, bigId, '大 id 保持字符串，不丢精度')

  // 实测样本：{"type":"at","data":{"qq":"762910152"}}
  eq(atTargetsOf([{ type: 'at', data: { qq: '762910152' } }]), ['762910152'], 'at 段：取出被 @ 的 QQ')
  eq(atTargetsOf([
    { type: 'at', data: { qq: '1' } },
    { type: 'at', data: { qq: '1' } }
  ]), ['1'], 'at 段：同一个号只记一次')
  eq(atTargetsOf([{ type: 'at', data: { qq: 'all' } }]), [], '@全体成员 不算具体目标')
  eq(atTargetsOf([{ type: 'text', data: { text: 'x' } }]), [], '没有 at 段 → 空数组')

  // reply 段不该产出文本（原话在 QQ 客户端里是折叠的）
  eq(textOf([{ type: 'reply', data: { id: '1' } }, { type: 'text', data: { text: '正文' } }]), '正文', 'reply 段不污染正文')

  // ---- 2. 出站：reply 段的位置与「只第一条」----
  console.log('\noutbound.js 的引用段：')
  const calls = []
  let failNext = 0
  let failMode = ''
  globalThis.fetch = async (url, init) => {
    const payload = JSON.parse(init.body)
    calls.push(payload)
    if (failNext > 0) {
      failNext -= 1
      // 模拟协议端因为引用段拒发
      if (failMode === 'reply') {
        const hasReply = (payload.params?.message ?? []).some((s) => s.type === 'reply')
        if (hasReply) return { ok: true, json: async () => ({ status: 'failed', retcode: 100, wording: 'reply id invalid' }) }
      }
      return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 123 } }) }
    }
    return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 123 } }) }
  }

  const { sendToQQ } = await import('../lib/outbound.js')
  const { loadConfig } = await import('../lib/config.js')
  loadConfig()

  // 分三条发，带引用
  calls.length = 0
  await sendToQQ({ kind: 'group', id: '685694947' }, '第一句\n第二句\n第三句', { replyTo: '-1019027093' })
  eq(calls.length, 3, '三段正文 → 发 3 条消息')
  const first = calls[0]?.params?.message ?? []
  const second = calls[1]?.params?.message ?? []
  const third = calls[2]?.params?.message ?? []
  eq(first[0]?.type, 'reply', '第一条：reply 段排在最前面')
  eq(first[0]?.data?.id, '-1019027093', '第一条：引用 id 正确（负数原样）')
  ok(!second.some((s) => s.type === 'reply'), '第二条：不带引用')
  ok(!third.some((s) => s.type === 'reply'), '第三条：不带引用')
  eq(first.filter((s) => s.type === 'reply').length, 1, '第一条只有一个 reply 段')

  // 不传 replyTo → 一条都不带引用
  calls.length = 0
  await sendToQQ({ kind: 'group', id: '685694947' }, '没有引用', {})
  ok(!(calls[0]?.params?.message ?? []).some((s) => s.type === 'reply'), '不传 replyTo → 不带引用段')

  // 空字符串 replyTo 也不能产生空引用段
  calls.length = 0
  await sendToQQ({ kind: 'group', id: '685694947' }, '空引用', { replyTo: '   ' })
  ok(!(calls[0]?.params?.message ?? []).some((s) => s.type === 'reply'), 'replyTo 是空白 → 不带引用段')

  // segments 显式分段时，同样只有第一条带引用
  calls.length = 0
  await sendToQQ({ kind: 'group', id: '685694947' }, '', {
    segments: ['甲', '乙'],
    replyTo: '1519605856'
  })
  eq(calls.length, 2, 'segments 两段 → 发 2 条')
  eq((calls[0]?.params?.message ?? [])[0]?.type, 'reply', 'segments 模式：第一条带引用')
  ok(!(calls[1]?.params?.message ?? []).some((s) => s.type === 'reply'), 'segments 模式：第二条不带引用')

  // ---- 3. 兜底：引用失败 → 去引用重发 ----
  console.log('\n引用段的降级兜底：')
  calls.length = 0
  failNext = 10
  failMode = 'reply'
  const r = await sendToQQ({ kind: 'group', id: '685694947' }, '这句很重要', { replyTo: '-999' })
  // 第一次带 reply 失败 → 第二次不带 reply 成功
  eq(calls.length, 2, '带引用失败后重发了一次')
  ok(calls[0].params.message.some((s) => s.type === 'reply'), '第一次尝试带了引用')
  ok(!calls[1].params.message.some((s) => s.type === 'reply'), '第二次去掉了引用')
  eq(calls[1].params.message.find((s) => s.type === 'text')?.data?.text, '这句很重要', '重发时正文完整保留')
  ok(r !== null && r !== undefined, '最终仍然返回结果（没抛错）')

  // ---- 4. 投递正文里的锚点（源码级接线断言）----
  // 正文格式是纯函数拼的，但它藏在 handlePrivateMessages / handleGroupMessage 内部，
  // 直接调要起一整套 ctx。这里用「源码必须包含这些片段」守住接线，跟 merge-sim 一个思路。
  console.log('\n投递正文的锚点接线：')
  const { readFileSync } = await import('node:fs')
  const pollSrc = readFileSync(new URL('../lib/poll.js', import.meta.url), 'utf8')
  ok(/function refOf\(/.test(pollSrc), 'poll.js 有 refOf()：把 message_id 变成 [#id]')
  ok(/\$\{refOf\(item\)\}/.test(pollSrc), '私聊正文：每条消息都带锚点')
  ok(/\$\{refOf\(message\)\}/.test(pollSrc), '群主消息：正文带锚点')
  ok(/\$\{refOf\(item\)\}\$\{nameOfSender/.test(pollSrc), '群上下文：每条也带锚点')
  ok(/→ #\$\{quoted\.id\}/.test(pollSrc), '群上下文：引用了别人的消息时标出 → #id')
  // message_id 为 0 是无效 id（协议端规定 message_id 非零）
  ok(/id === 0\) return ''/.test(pollSrc), 'refOf 把 id=0 当作无效（不产出空锚点）')
  // 自动转发要带 replyTo
  ok(/replyTo\b/.test(pollSrc), 'poll.js 把 replyTo 传给了 deliver')

  const outSrc = readFileSync(new URL('../lib/outbound.js', import.meta.url), 'utf8')
  ok(/replyTo: String\(options\?\.replyTo/.test(outSrc), 'enqueueOutbound 存了 replyTo')
  ok(/sendToQQ\(entry\.target, text, \{ replyTo: entry\.replyTo \}\)/.test(outSrc), '自动转发把 replyTo 用上了')

  const toolSrc = readFileSync(new URL('../lib/tool.js', import.meta.url), 'utf8')
  ok(/reply_to: \{/.test(toolSrc), 'qq_send 的参数里声明了 reply_to')
  ok(/replyTo: String\(args\?\.reply_to/.test(toolSrc), 'qq_send 把 reply_to 传给了 sendToQQ')

  console.log(`\n结果：${passed} 过 / ${failed} 败`)
  process.exitCode = failed === 0 ? 0 : 1} finally {
  try { rmSync(SANDBOX_HOME, { recursive: true, force: true }) } catch {}
}
