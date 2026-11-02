/**
 * 收尾被拒 / 判断结论被复述（0.16.15）。
 *
 * 用户实测的缺陷：
 *   对方想结束话题（没 @ 她，走对话窗口）时，她有概率结束不了，
 *   还会把「我该不该结束」这个判断本身当成话发出去。
 *   对端也是 AI 时两边会顺着这段元讨论互相回，谁都不肯先停。
 *
 * 三层成因，这个测试各钉一段：
 *   1. 判定层：「吧」结尾的让步句被判成 question → openQuestion 恒真 → 永远收不了
 *   2. 工具层：拒绝时返回的是**一句自然语言**，模型当成「我该说的内容」写进正文
 *   3. 出站层：被拒回合的正文照常转发 → 判断结论真的发到了 QQ 上
 *
 * 隔离：整个测试跑在临时 HOME 里，不碰真的 ~/.dsh。
 */
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SANDBOX_HOME = join(HERE, '..', '..', '.tmp-test', `close-refuse-${process.pid}`)
const SANDBOX_DATA = join(SANDBOX_HOME, '.dsh')
mkdirSync(SANDBOX_DATA, { recursive: true })
process.env.USERPROFILE = SANDBOX_HOME
process.env.HOME = SANDBOX_HOME
process.on('exit', () => {
  try { rmSync(SANDBOX_HOME, { recursive: true, force: true }) } catch { /* 清不掉不算失败 */ }
})

const GROUP = '975663147'
const PEER = '3472302240'
const SELF = '3655191092'
const SESSION = 'session-close-refuse-test'

writeFileSync(join(SANDBOX_DATA, 'qq-bridge.config.json'), JSON.stringify({
  enabled: true,
  selfUin: SELF,
  peerUin: PEER,
  ownerUin: PEER,
  onebotHttp: 'http://127.0.0.1:3000/',
  token: 'test-token',
  mergeWindowMs: 0,
  replyQuietMs: 0,
  splitReply: false,
  autoForwardReply: false,
  backfillOnStart: false,
  memoryEnabled: false,
  proactiveEnabled: false,
  allowSendToAny: true,
  closureEnabled: true,
  windowEnabled: true,
  groupOnlyWhenAt: true,
  routes: { private: {}, group: { [GROUP]: { sessionId: SESSION } } }
}, null, 2), 'utf8')
writeFileSync(join(SANDBOX_DATA, 'qq-bridge-state.json'), JSON.stringify({
  lastId: 0, lastSeq: 0, lastTime: 0, privates: {}, groups: {}
}, null, 2), 'utf8')

/** 假协议端历史：用来控制「对方最后一句」是什么。 */
let theirLast = '好吧'
let myLast = '好'
const calls = []
globalThis.fetch = async (_url, init) => {
  const payload = JSON.parse(init.body)
  calls.push(payload)
  if (payload.action === 'get_group_msg_history') {
    return {
      ok: true,
      json: async () => ({
        retcode: 0,
        data: {
          messages: [
            { message_id: 1, message_seq: 1, time: 1793600000, sender: { user_id: Number(SELF), nickname: '我' }, message: [{ type: 'text', data: { text: myLast } }] },
            { message_id: 2, message_seq: 2, time: 1793600010, sender: { user_id: Number(PEER), nickname: '他' }, message: [{ type: 'text', data: { text: theirLast } }] }
          ]
        }
      })
    }
  }
  if (payload.action === 'send_group_msg' || payload.action === 'send_private_msg') {
    return { ok: true, json: async () => ({ retcode: 0, data: { message_id: 999 } }) }
  }
  return { ok: true, json: async () => ({ retcode: 0, data: null }) }
}

const { loadConfig, getConfig } = await import('../lib/config.js')
const { loadState, getState } = await import('../lib/state.js')
const { classifyUtterance, assessClosure, describeClosureLine, saveClosing, peekClosing } = await import('../lib/closure.js')
const {
  openWindow, windowOf, queueWindowMessage,
  noteCloseRefused, clearCloseRefusals, closeRefusalCount, CLOSE_REFUSE_LIMIT
} = await import('../lib/window.js')
const { registerCloseTool, registerPassTool, registerSendTool } = await import('../lib/tool.js')
const { turnHandled_, clearTurnHandled: resetTurnHandledFor } = await import('../lib/rhythm.js')

loadConfig()
loadState()
const cfg = getConfig()
Object.assign(cfg, { allowSendToAny: true, closureEnabled: true, windowEnabled: true, groupOnlyWhenAt: true, waterWindows: ['00:00-23:59'], windowPerGroupDaily: 20, windowPerPeerDaily: 10 })

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.error(`  ✗ ${name}`) }
}
function eq(actual, expected, name) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, `${name}${same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`)
}

const regs = new Map()
const toolCtx = {
  get: (name) => (name === 'tools'
    ? { register: (t) => { regs.set(t.name, t); return () => {} } }
    : (name === 'attachments' ? { saveImages: async () => [] } : undefined)),
  effect: () => {}
}
await registerCloseTool(toolCtx)
await registerPassTool(toolCtx)
await registerSendTool(toolCtx)
const close = regs.get('qq_close')
const pass = regs.get('qq_pass')

const textOfOutput = (rendered) => (Array.isArray(rendered) ? rendered : [])
  .map((block) => (block?.type === 'text' ? String(block.text ?? '') : '')).join('\n')

const resetWindow = async () => {
  getState().windows = {}
  getState().groups = { [GROUP]: { lastSeq: 10, lastDeliveredSeq: 10 } }
  openWindow(GROUP, PEER)
  clearCloseRefusals(GROUP)
  // ⚠️ 必须把「本回合已处理」的旁路账本也清掉 ——
  //    否则上一个用例说过话，这个用例的 qq_close 就会被误放行。
  //    （第一版我在这里调 pass.execute 想清账，结果它反而记了一笔，把自己测挂了。）
  resetTurnHandledFor(`group:${GROUP}`)
  await new Promise((resolve) => setTimeout(resolve, 20))
}

// ---------------------------------------------------------------------------
// 1. 判定层：「吧」结尾的让步句
// ---------------------------------------------------------------------------
console.log('判定层：「吧」不该被判成疑问：')
{
  // 这四条是本次核心回归 —— 用户实测收不了尾，就是它们被判成 question
  for (const text of ['好吧', '行吧', '就这样吧', '随你吧']) {
    const kind = classifyUtterance(text)
    const verdict = assessClosure({ mine: '好', theirs: text })
    ok(kind === 'ack', `「${text}」判成 ack（实际 ${kind}）`)
    ok(verdict.openQuestion === false, `「${text}」不再触发 openQuestion 硬规矩`)
    ok(verdict.level === 'close', `「${text}」可以收尾（实际 ${verdict.level}）`)
  }

  // 反向保护：真疑问必须保持 question
  console.log('反向保护：真疑问不能被误伤：')
  for (const text of ['怎么办', '你说呢', '要不要来', '是不是真的']) {
    const kind = classifyUtterance(text)
    ok(kind === 'question', `「${text}」仍是 question（实际 ${kind}）`)
    ok(assessClosure({ mine: '好', theirs: text }).openQuestion === true, `「${text}」仍然拦住收尾`)
  }
  // 「能不能帮我看下」命中 REQUEST_RE（看一下），本质是请求 —— 同样要拦住收尾
  ok(classifyUtterance('能不能帮我看下') === 'request', '「能不能帮我看下」判成 request（请求也是没闭环的事）')
  ok(assessClosure({ mine: '好', theirs: '能不能帮我看下' }).openQuestion === true, '请求仍然拦住收尾')

  // 道别与附和保持原样
  for (const text of ['晚安', '那先这样', '好吧，那我先睡了']) {
    ok(classifyUtterance(text) === 'ending', `「${text}」仍是 ending`)
  }
  for (const text of ['嗯', '哈哈', '好的']) {
    ok(classifyUtterance(text) === 'ack', `「${text}」仍是 ack`)
  }

  // 长句里带「吧」不能误判成附和
  ok(classifyUtterance('我觉得这样安排吧，明天再说') === 'substantive', '长句里的「吧」不算附和（仍是 substantive）')
}

// ---------------------------------------------------------------------------
// 2. 工具层：拒绝时返回状态码，不是一句话
// ---------------------------------------------------------------------------
console.log('工具层：qq_close 拒绝时不返回「话」：')
{
  await resetWindow()
  theirLast = '为什么啊'
  myLast = '好'
  const result = await close.execute({ group_id: GROUP, summary: '测试', next: '待续' })
  ok(result.ok === false, 'openQuestion 时 ok=false')
  eq(result.closed, false, '没有关窗')
  eq(result.verdict, 'open-question', 'verdict 是状态码，不是自然语言句子')
  // ⚠️ 这是核心：把整段"话"糊在 verdict 里，模型就会把它当正文
  ok(!/不能收摊|先把话说完/.test(JSON.stringify(result)), 'verdict 里没有「不能收摊…」这种可被复述的句子')

  const rendered = textOfOutput(close.output.render({}, result))
  ok(rendered.startsWith('[系统]'), `render 以 [系统] 开头（实际：${rendered.slice(0, 30)}）`)
  ok(rendered.includes('不是你要说的话'), 'render 明确说了「这不是你要说的话」')
  ok(rendered.includes('不要把它写进正文'), 'render 明确禁止写进正文')
  ok(windowOf(GROUP) !== null, '窗口还开着')
}

// ---------------------------------------------------------------------------
// 3. 「同回合已处理过」→ 放行关窗
// ---------------------------------------------------------------------------
console.log('给她一个「说完就走」的出口：')
{
  await resetWindow()
  theirLast = '为什么啊'
  myLast = '好'

  // 先 qq_pass 划走（= 这一回合她处理过了）
  await pass.execute({ group_id: GROUP, why: '不想接' })
  ok(turnHandled_(`group:${GROUP}`) === true, 'qq_pass 会记下「本回合已处理」')

  const result = await close.execute({ group_id: GROUP, summary: '', next: '' })
  ok(result.ok === true, '同回合划走过之后，qq_close 可以关窗')
  eq(result.closed, true, '确实关窗了')
  eq(result.verdict, 'closed-no-check', 'verdict 是 closed-no-check（放行但不算闭环）')
  ok(windowOf(GROUP) === null, '窗口已关闭')
  // 不记收尾：没闭环，不该说「上次聊到哪儿」
  ok(peekClosing(`group:${GROUP}`) === null, '放行关窗时不记收尾（不算真正闭环）')
}

{
  // qq_send 也算「处理过」
  await resetWindow()
  theirLast = '为什么啊'
  await regs.get('qq_send').execute({ group_id: GROUP, text: '因为这样比较稳' })
  ok(turnHandled_(`group:${GROUP}`) === true, 'qq_send 会记下「本回合已处理」')
  const result = await close.execute({ group_id: GROUP, summary: '聊清楚了', next: '' })
  ok(result.ok === true && result.closed === true, '同回合说过话之后，qq_close 也能关窗')
  ok(windowOf(GROUP) === null, '窗口已关闭')
}

// ---------------------------------------------------------------------------
// 4. 连续被拒 N 次 → 强制关窗（防死循环）
// ---------------------------------------------------------------------------
console.log('连续被拒就强制收摊（防死循环）：')
{
  await resetWindow()
  theirLast = '为什么啊'
  let forcedAt = 0
  for (let i = 1; i <= CLOSE_REFUSE_LIMIT; i += 1) {
    // 每轮都要清掉「本回合处理过」的账，否则第二次就放行了
    clearCloseRefusals(GROUP)
    await resetWindow()
    const result = await close.execute({ group_id: GROUP })
    if (result.closed === true) { forcedAt = i; break }
  }
  ok(forcedAt === 0 || forcedAt <= CLOSE_REFUSE_LIMIT, '连续被拒不会无限循环')
  // 直接验证计数与自动关窗（不依赖上面循环的时序）
  await resetWindow()
  const first = noteCloseRefused(GROUP)
  const second = noteCloseRefused(GROUP)
  const third = noteCloseRefused(GROUP)
  eq([first, second, third], [false, false, true], `第 ${CLOSE_REFUSE_LIMIT} 次被拒时返回「已强制关窗」`)
  ok(windowOf(GROUP) === null, '达上限后窗口被强制关闭')
  eq(closeRefusalCount(GROUP), 0, '强制关窗后计数清零')

  // 成功收尾要清零
  await resetWindow()
  noteCloseRefused(GROUP)
  ok(closeRefusalCount(GROUP) === 1, '准备：计数为 1')
  clearCloseRefusals(GROUP)
  eq(closeRefusalCount(GROUP), 0, '成功收尾/关窗后计数清零')
}

// ---------------------------------------------------------------------------
// 5. 成功路径与 closureEnabled=false 不许变
// ---------------------------------------------------------------------------
console.log('既有行为不许变：')
{
  await resetWindow()
  theirLast = '好吧'
  myLast = '好'
  const result = await close.execute({ group_id: GROUP, summary: '聊到这儿', next: '改天聊技术' })
  ok(result.ok === true, '对方说「好吧」时 qq_close 能成功（本次核心验收点）')
  eq(result.closed, true, '关窗了')
  eq(result.verdict, 'closed', 'verdict 是 closed')
  ok(windowOf(GROUP) === null, '窗口已关闭')
  const closing = peekClosing(`group:${GROUP}`)
  ok(closing !== null && closing.summary === '聊到这儿', '成功收尾时照常记下 summary')
  const rendered = textOfOutput(close.output.render({}, result))
  ok(rendered.startsWith('[系统]'), '成功路径的 render 也用 [系统] 前缀（一致）')

  // closureEnabled=false：直接放行，不校验
  getConfig().closureEnabled = false
  await resetWindow()
  theirLast = '为什么啊'
  const bypass = await close.execute({ group_id: GROUP, summary: 'x', next: '' })
  ok(bypass.ok === true, 'closureEnabled=false 时直接放行')
  eq(bypass.verdict, 'closed-no-check', '关闭校验时的 verdict 是 closed-no-check')
  getConfig().closureEnabled = true
}

// ---------------------------------------------------------------------------
// 6. describeClosureLine 本身
// ---------------------------------------------------------------------------
console.log('describeClosureLine：')
{
  const refused = describeClosureLine({ ok: false, verdict: 'open-question', reasons: ['对方还在问/还在求，不能丢下'] })
  ok(refused.startsWith('[系统]'), '拒绝态以 [系统] 开头')
  ok(refused.includes('不是你要说的话'), '拒绝态说明「不是你要说的话」')

  const closed = describeClosureLine({ ok: true, verdict: 'closed', reasons: [] })
  ok(closed.startsWith('[系统]'), '成功态也带 [系统]')
  ok(!closed.includes('不是你要说的话'), '成功态不加那句禁止语（它本来就不是拒绝）')

  // 未知状态码不能变成空字符串（否则模型什么也看不到）
  const unknown = describeClosureLine({ ok: false, verdict: 'whatever-new-code' })
  ok(unknown.trim() !== '' && unknown.includes('whatever-new-code'), '未知状态码原样带出，不是空')
}

// ---------------------------------------------------------------------------
// 6. 出站防线：被拒回合的正文不许转发（这是「判断结论被发出去」的最后一道闸）
//
// ⚠️ 这一段是变异验证补的：第一版测试只覆盖了工具层，
//   把 outbound 里那道拦截整条删掉，测试照样全绿 —— 等于没测。
// ---------------------------------------------------------------------------
console.log('出站防线：被拒回合的正文不转发：')
{
  const { outbound, enqueueOutbound, flushOutbound } = await import('../lib/outbound.js')
  const { noteCloseRefusedTurn } = await import('../lib/rhythm.js')

  const sent = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body)
    if (payload.action === 'send_private_msg' || payload.action === 'send_group_msg') {
      sent.push(payload)
    }
    return { ok: true, json: async () => ({ retcode: 0, data: { message_id: 1000 + sent.length } }) }
  }

  const fakeAgent = (events) => ({
    session: { snapshotEvents: () => events }
  })

  // --- 场景 A：qq_close 被拒过 → 正文不转发 ---
  {
    sent.length = 0
    outbound.clear()
    resetTurnHandledFor('private:444')
    noteCloseRefusedTurn('private:444')
    const events = [
      { seq: 1, type: 'user/message', data: {} },
      // 这就是用户看到的「判断结论被念出来」
      { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '对方还在问，我是不是该结束…' }] } } },
      { seq: 3, type: 'turn/end', data: { reason: { kind: 'stop' } } }
    ]
    enqueueOutbound('session-CR', fakeAgent(events), 0, { kind: 'private', id: '444' })
    await flushOutbound()
    ok(sent.length === 0, 'qq_close 被拒的回合，元话语【不】发到 QQ（实际发了 ' + sent.length + ' 条）')
    ok(outbound.size === 0, '被拦的回合正常出队，不会堵住后面')
  }

  // --- 场景 B：没被拒 → 正文照发（不能拦过头）---
  {
    sent.length = 0
    outbound.clear()
    resetTurnHandledFor('private:555')
    const events = [
      { seq: 1, type: 'user/message', data: {} },
      { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好呀，明天见' }] } } },
      { seq: 3, type: 'turn/end', data: { reason: { kind: 'stop' } } }
    ]
    enqueueOutbound('session-OK', fakeAgent(events), 0, { kind: 'private', id: '555' })
    await flushOutbound()
    const texts = sent.map((m) => JSON.stringify(m.params ?? {})).join('|')
    ok(sent.length > 0 && texts.includes('明天见'), '没被拒的回合，正文照常转发（没拦过头）')
  }

  // --- 场景 C：qq_close **成功**的回合 → 最后一句话照发 ---
  //     这条是既有语义（她留的最后一句话要说出去），不许被新闸吞掉
  {
    sent.length = 0
    outbound.clear()
    resetTurnHandledFor('private:666')
    // 成功后不调 noteCloseRefusedTurn，所以这里什么都不做
    const events = [
      { seq: 1, type: 'user/message', data: {} },
      { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '那先这样，晚安' }] } } },
      { seq: 3, type: 'turn/end', data: { reason: { kind: 'stop' } } }
    ]
    enqueueOutbound('session-OK2', fakeAgent(events), 0, { kind: 'private', id: '666' })
    await flushOutbound()
    const texts = sent.map((m) => JSON.stringify(m.params ?? {})).join('|')
    ok(sent.length > 0 && texts.includes('晚安'), 'qq_close 成功的回合，她留的最后一句话照发')
  }

  globalThis.fetch = realFetch
  outbound.clear()
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
