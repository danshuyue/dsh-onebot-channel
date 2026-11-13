/**
 * 投递方式回归测试（0.16.19）。
 *
 * 用户实测的毛病（2026-11-03）：
 *   「会卡排队。排队的消息都是旧的，因为本次会话其实正常的推进且持续回复。」
 *   「表现为 qq_wait 和 qq_msg_history 交替工作……而 @ 触发进入了队列中进行排队。」
 *
 * 真因：deliver() 只有一条路 —— agent.followup()，而宿主里 followup 进的是
 *   **next-turn** 队列：只在回合边界被认领，**一次只认领一条**。
 *   她一个回合里 qq_wait 40 秒 + 翻历史 + 分条发好几条，这期间进来的消息全排队，
 *   回合结束后一条开一个新回合 —— 等轮到它们时早就是旧话，
 *   而且她早在当前回合里用 qq_msg_history 看过这几条了。
 *
 * 修法：忙（status === 'running'）时改用 agent.steer()（next-step：
 *   当前回合的下一个步骤边界就认领，且整队全取），闲时仍然是 followup。
 *
 * 这个测试钉三件事：
 *   A. 闲 → followup（一次都不 steer）
 *   B. 忙 → steer（一次都不 followup）
 *   C. 宿主没有 status / steer → 退回 followup，行为与改动前一致
 *
 * 隔离：跑在临时 HOME 里，不碰真的 ~/.dsh。
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SANDBOX_HOME = join(HERE, '..', '..', '.tmp-test', `deliver-mode-${process.pid}`)
const SANDBOX_DATA = join(SANDBOX_HOME, '.dsh')
mkdirSync(SANDBOX_DATA, { recursive: true })
process.env.USERPROFILE = SANDBOX_HOME
process.env.HOME = SANDBOX_HOME
process.on('exit', () => {
  try { rmSync(SANDBOX_HOME, { recursive: true, force: true }) } catch { /* 清不掉不算失败 */ }
})

const SESSION = 'session-deliver-mode-test'
writeFileSync(join(SANDBOX_DATA, 'qq-bridge.config.json'), JSON.stringify({
  enabled: true,
  selfUin: '3655191092',
  peerUin: '3472302240',
  ownerUin: '3472302240',
  onebotHttp: 'http://127.0.0.1:3000/',
  token: 'test-token',
  // 只钉「用哪个入口投递」，别让静默 / 分条 / 转发 / 记忆掺进来
  replyQuietMs: 0,
  splitReply: false,
  autoForwardPrivate: false,
  autoForwardGroup: false,
  backfillOnStart: false,
  memoryEnabled: false,
  proactiveEnabled: false,
  windowEnabled: false,
  fallbackToLiveSession: false,
  routes: { private: {}, group: {} }
}, null, 2), 'utf8')
writeFileSync(join(SANDBOX_DATA, 'qq-bridge-state.json'), JSON.stringify({
  lastId: 0, lastSeq: 0, lastTime: 0, privates: {}, groups: {}
}, null, 2), 'utf8')

const { loadConfig, getConfig } = await import('../lib/config.js')
const { deliver } = await import('../lib/deliver.js')
const { clearOutbound } = await import('../lib/outbound.js')
const { clearWaitBudget, waitBudgetLeft, chargeWaitBudget, resetWaitBudget } = await import('../lib/rhythm.js')

loadConfig()
Object.assign(getConfig(), {
  replyQuietMs: 0,
  autoForwardPrivate: false,
  autoForwardGroup: false,
  memoryEnabled: false,
  fallbackToLiveSession: false
})

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.error(`  ✗ ${name}`) }
}

/** 造一个假 agent，记录它被哪个入口推过。 */
function makeAgent(options = {}) {
  const calls = []
  const agent = {
    session: { seq: 10, snapshotEvents: () => [] },
    followup(message) {
      calls.push({ kind: 'followup', message })
      if (options.failFollowup === true) throw new Error('simulated followup failure')
    },
    steer(message) {
      calls.push({ kind: 'steer', message })
    }
  }
  if (options.status !== undefined) agent.status = options.status
  if (options.noSteer === true) delete agent.steer
  return { agent, calls }
}

function ctxFor(agent) {
  return {
    get(name) {
      if (name === 'agents') return { get: () => agent, resume: async () => ({ agent }) }
      return undefined
    },
    effect: () => {}
  }
}

const target = { kind: 'group', id: '975663147' }
const textOf = (message) => {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b?.type === 'text').map((b) => String(b.text ?? '')).join('')
}

console.log('F. 当前 QQ 目标的主动语音指引：')
{
  const cfg = getConfig()
  const oldVoice = { voiceMode: cfg.voiceMode, voiceTargetsGroup: cfg.voiceTargetsGroup, voiceTargetsPrivate: cfg.voiceTargetsPrivate }
  Object.assign(cfg, { voiceMode: 'active', voiceTargetsGroup: ['group:975663147'], voiceTargetsPrivate: ['private:3472302240'] })
  clearOutbound()
  const group = makeAgent({ status: 'idle' })
  await deliver(ctxFor(group.agent), SESSION, '今晚吃点什么？', target)
  const body = textOf(group.calls[0]?.message)
  ok(body.includes('【本回合 QQ 语音】'), '主动档指引进入实际投递正文')
  ok(body.includes('qq_tts') && body.includes('qq_send') && body.includes('voice: 返回的路径'), '指引说明合成成功后通过 voice 参数发送')
  ok(body.includes('group_id: "975663147"'), '群聊指引绑定本次群号')
  ok(body.includes('只在合成失败或不可用时回退文字'), '提示允许合成失败时回退文字')
  ok(body.includes('语音已成功发送后不再重复发送'), '提示禁止成功后重复发送同一内容')
  ok(body.includes('今晚吃点什么？'), '指引保留用户原消息')

  Object.assign(cfg, { voiceTargetsGroup: ['group:123456'] })
  clearOutbound()
  const denied = makeAgent({ status: 'idle' })
  await deliver(ctxFor(denied.agent), SESSION, '名单外群消息', target)
  ok(!textOf(denied.calls[0]?.message).includes('【本回合 QQ 语音】'), '名单外目标不收到主动语音指引')

  for (const mode of ['off', 'passive', 'free', 'unknown']) {
    clearOutbound()
    Object.assign(cfg, { voiceMode: mode, voiceTargetsGroup: ['group:975663147'] })
    const sample = makeAgent({ status: 'idle' })
    await deliver(ctxFor(sample.agent), SESSION, `档位 ${mode}`, target)
    ok(!textOf(sample.calls[0]?.message).includes('【本回合 QQ 语音】'), `${mode} 档不注入主动档指引`)
  }

  Object.assign(cfg, { voiceMode: 'active', voiceTargetsGroup: ['group:975663147'] })
  clearOutbound()
  const privateTarget = makeAgent({ status: 'idle' })
  await deliver(ctxFor(privateTarget.agent), SESSION, '私聊语音', { kind: 'private', id: '3472302240' })
  ok(textOf(privateTarget.calls[0]?.message).includes('user_id: "3472302240"'), '私聊指引绑定本次好友号')
  Object.assign(cfg, oldVoice)
}

// ---- A. 空闲：必须走 followup（与改动前逐字一致） ----
console.log('A. 空闲时：')
{
  clearOutbound()
  const { agent, calls } = makeAgent({ status: 'idle' })
  const used = await deliver(ctxFor(agent), SESSION, '空闲时的一条', target)
  ok(used === SESSION, `空闲时投递成功（返回 ${used || '空串'}）`)
  ok(calls.length === 1, `只推了一次（实际 ${calls.length} 次）`)
  ok(calls[0]?.kind === 'followup', `走的是 followup（实际 ${calls[0]?.kind}）`)
  ok(calls.every((c) => c.kind !== 'steer'), '一次都没调 steer')
  ok(textOf(calls[0]?.message).includes('空闲时的一条'), '正文原样交出去了')
}
{
  clearOutbound()
  const { agent, calls } = makeAgent() // 完全没有 status 字段
  await deliver(ctxFor(agent), SESSION, '没有 status 的宿主', target)
  ok(calls.length === 1 && calls[0]?.kind === 'followup', '宿主没有 status 字段 → 退回 followup')
}

// ---- B. 忙：必须走 steer（这是本次修复的核心） ----
console.log('\nB. 正在跑回合时：')
{
  clearOutbound()
  const { agent, calls } = makeAgent({ status: 'running' })
  const used = await deliver(ctxFor(agent), SESSION, '她正在想的时候进来的一条', target)
  ok(used === SESSION, `忙时投递成功（返回 ${used || '空串'}）`)
  ok(calls.length === 1, `只推了一次（实际 ${calls.length} 次）`)
  ok(calls[0]?.kind === 'steer', `走的是 steer（实际 ${calls[0]?.kind}）`)
  ok(calls.every((c) => c.kind !== 'followup'), '一次都没进 next-turn 队列 —— 这就是「不再卡排队」')
  ok(textOf(calls[0]?.message).includes('她正在想的时候进来的一条'), '正文原样交出去了')
}
{
  clearOutbound()
  const { agent, calls } = makeAgent({ status: 'running', noSteer: true })
  await deliver(ctxFor(agent), SESSION, '有 status 但没有 steer', target)
  ok(calls.length === 1 && calls[0]?.kind === 'followup', '宿主没有 steer 方法 → 退回 followup（不丢消息）')
}

// ---- C. steer 抛错仍然走原来那条 catch（失败要能看见） ----
console.log('\nC. 边界：')
{
  clearOutbound()
  const { agent } = makeAgent({ status: 'running' })
  agent.steer = () => { throw new Error('simulated steer failure') }
  const used = await deliver(ctxFor(agent), SESSION, 'steer 会抛', target)
  ok(used === '', 'steer 抛错 → deliver 返回空串（调用方能判失败、回滚游标）')
}

// ---- D. 单回合等待额度（rhythm.js）----
console.log('\nD. 单回合 qq_wait 额度：')
{
  clearWaitBudget()
  const key = 'group:975663147'
  ok(waitBudgetLeft(key, 60000) === 60000, '没用过 → 全额 60000')
  chargeWaitBudget(key, 25000)
  ok(waitBudgetLeft(key, 60000) === 35000, '等过 25 秒 → 还剩 35000')
  chargeWaitBudget(key, 35000)
  ok(waitBudgetLeft(key, 60000) === 0, '用满 60 秒 → 还剩 0（不能再干等）')
  chargeWaitBudget(key, 10000)
  ok(waitBudgetLeft(key, 60000) === 0, '再等也不出现负数')
  resetWaitBudget(key)
  ok(waitBudgetLeft(key, 60000) === 60000, '新消息投给她 → 额度重置回全额')
  ok(waitBudgetLeft(key, 0) === Number.POSITIVE_INFINITY, '上限设 0 = 不限（不再记账）')
  clearWaitBudget()
  ok(waitBudgetLeft('', 60000) === 60000, '空 key → 全额（不崩）')
  chargeWaitBudget('', 5000)
  ok(waitBudgetLeft('', 60000) === 60000, '空 key 不记账')
}

// ---- E. qq_wait 真的会按额度截断（走注册出来的那个工具对象）----
// ⚠️ 必须走 registerWaitTool 拿到的真对象：额度逻辑写在新加的字段里，
//   只在 rhythm.js 里单测 waitBudgetLeft 是不够的 —— 那证明不了它真被接上。
console.log('\nE. qq_wait 接上了额度：')
{
  clearWaitBudget()
  const { registerWaitTool } = await import('../lib/tool.js')
  const registered = new Map()
  const fakeTools = {
    register(tool) {
      registered.set(tool.name, tool)
      return () => {}
    }
  }
  const toolCtx = {
    get(name) {
      if (name === 'tools') return fakeTools
      return undefined
    },
    effect: () => {}
  }
  const controller = new AbortController()
  await registerWaitTool(toolCtx, controller.signal)
  const waitTool = registered.get('qq_wait')
  ok(waitTool !== undefined, 'qq_wait 注册出来了')

  // 用假 getHistory 挡掉真网络：工具内部 import 的 history.js 走 fetch
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ retcode: 0, data: { messages: [] } })
  })

  const key = 'group:975663147'
  const cap = Number(getConfig().waitTurnMaxMs) || 60000
  // 先把额度耗到只剩 1 秒，再让它请求 40 秒 —— 必须只等 1 秒左右
  chargeWaitBudget(key, cap - 1000)
  const startedAt = Date.now()
  const value = await waitTool.execute({ group_id: '975663147', ms: 40000 })
  const elapsed = Date.now() - startedAt
  ok(elapsed < 5000, `额度只剩 1 秒时请求等 40 秒 → 实际只等了 ${elapsed}ms（没有干等 40 秒）`)
  ok(value?.newCount === 0, '没人说话时 newCount 是 0')
  ok(Number(value?.waitBudgetLeft) === 0, `返回值里带额度剩余（实际 ${value?.waitBudgetLeft}）`)
  ok(String(value?.hint ?? '').includes('额度'), '提示里说明额度用完了，指向「现在开口 / 收掉这一轮」')
  const rendered = String(waitTool.output?.render?.({}, value)?.[0]?.text ?? '')
  ok(rendered.includes('等待额度'), 'render 里也写了还剩多少 —— 模型看得到')

  // 再来一次：额度已经是 0，必须立刻返回（不再等）
  const againStart = Date.now()
  const again = await waitTool.execute({ group_id: '975663147', ms: 40000 })
  const againElapsed = Date.now() - againStart
  ok(againElapsed < 2000, `额度为 0 时再 qq_wait 立刻返回（实际 ${againElapsed}ms）`)
  ok(Number(again?.waitedMs) === 0, `额度为 0 时 waitedMs 是 0（实际 ${again?.waitedMs}）`)

  // 新消息投给她 → 额度重置
  clearWaitBudget()
  const { agent } = makeAgent({ status: 'idle' })
  await deliver(ctxFor(agent), SESSION, '新的一条', target)
  ok(waitBudgetLeft(key, cap) === cap, '有新消息投递后额度重置回全额')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)