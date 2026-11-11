/**
 * 兴趣点：去重 / 额度 / 下发两路（0.23.0）。
 *
 * ## 为什么这三件事要单独一个测试
 *
 * 它们是这个功能里**唯一会往外发消息**的部分，也是最容易「看起来很对」的部分：
 *   · 去重写错 → 同一个崩溃通知十遍（主人会关掉整个功能）；
 *   · 额度写错 → 账单失控（这是真金白银）；
 *   · 下发两路接反 → 「两个复选框」变成「一个复选框，另一个永远不发」。
 *
 * 而这三件事的失败**都是静默的**：没有报错，只是行为不对。
 *
 * ## 测法
 *
 * `globalThis.fetch` 打桩 —— `onebot.js` 的 `callOneBot` 是出站唯一出口，
 * 桩在那一层就等于拦住了全部真实发送（不会真往 QQ 发东西）。
 * 判定的 LLM 用假 ctx；`notify` 用 `options.notify !== false` 走真的两条路。
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { INTEREST_FILE } from '../lib/env.js'
import { loadConfig, getConfig, normalizeInterestPoints } from '../lib/config.js'
import {
  resetInterests, createTask, runDueTasks, listTasks, loadInterests, notify
} from '../lib/interest.js'
import { validateJudgeResult } from '../lib/judge.js'

let pass = 0
const failures = []
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log('  ✓ ' + label) } else { failures.push(label); console.error('  ✗ ' + label) }
}
const eq = (actual, expected, label) => {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, `${label}${same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`)
}

// ---- 沙箱自检 -------------------------------------------------------------
const homeDir = String(process.env.HOME || process.env.USERPROFILE || '')
ok(homeDir !== '', '测试跑在隔离 HOME 下')
ok(
  process.env.DSH_TEST_HOME === homeDir || homeDir.includes('iso') || homeDir.includes('tmp') || homeDir.includes('mut'),
  `隔离 HOME 是沙箱（${homeDir}）`
)

// ---- fetch 打桩：拦在 callOneBot 这一层 -----------------------------------
const sent = []
const realFetch = globalThis.fetch
globalThis.fetch = async function stubbedFetch(url, init) {
  let body = {}
  try { body = JSON.parse(String(init?.body ?? '{}')) } catch { body = {} }
  sent.push({ url: String(url ?? ''), action: String(body.action ?? ''), params: body.params ?? {} })
  // 协议端对「发消息」类调用回一个成功结果（形状与 SnowLuma 一致就够了）
  return {
    ok: true,
    status: 200,
    json: async () => ({ retcode: 0, data: { message_id: -100, message_seq: 1 } })
  }
}

// ---- 配置钉死 -------------------------------------------------------------
try {
  writeFileSync(INTEREST_FILE, JSON.stringify({ tasks: [], recent: [], daily: {}, lastNotified: {} }, null, 2), 'utf8')
} catch (error) {
  console.error('写沙箱 INTEREST_FILE 失败：', error.message)
  process.exit(1)
}
loadConfig()
const config = getConfig()
Object.assign(config, {
  groupUins: ['716197431'],
  routes: { private: { 1321833118: { sessionId: 'sess-private' } }, group: { 716197431: { sessionId: 'sess-group' } } },
  ownerUin: 1321833118,
  // ⚠️ `peerUin` 也要给：白名单在「一个号都没配」时会**放行全部**，
  //    而这里我们要验证「发给了主人」这件事本身，于是得让白名单真的生效。
  peerUin: 1321833118,
  selfUin: 3566906627,
  // ⚠️ `token` / `onebotHttp` 必须给（2026-11-11 踩到，别删）：
  //    `callOneBot` 是出站唯一出口，它读的是 `config.onebotHttp`。
  //    这两项缺了 → fetch 直接失败 → `notify` 的 catch 把错误吞掉 →
  //    `notified` 恒为 0，看起来像「去重逻辑把通知挡了」，
  //    而实际上是**根本没走到发送那一步**。这类「看起来是 A 坏了、其实是 B 没配」
  //    的误判，靠打桩是抓不出来的，只能把配置补齐。
  token: 'test-token',
  onebotHttp: 'http://127.0.0.1:3000/',
  waterWindows: ['00:00-23:59'],
  interestEnabled: true,
  interestWaitMinutes: 10,
  interestPreMinutes: 10,
  interestMaxMessages: 80,
  interestCooldownMinutes: 60,
  interestDailyMaxPerGroup: 5,
  interestDailyMaxCalls: 50,
  interestNotifySelf: true,
  interestNotifySession: false,
  interestJudgeProvider: '',
  interestJudgeModel: '',
  agentOptions: { provider: 'tp', model: 'tm' }
})
config.interestPoints = normalizeInterestPoints([{
  id: 'p-server', enabled: true, label: '服务器崩溃反馈',
  keywords: ['崩了', '崩溃'], description: '帮我关注一下群里关于服务器崩溃的反馈'
}])

const point = config.interestPoints[0]

/** 造一条已到期的任务（跳过 10 分钟等待）。 */
function dueTask(text = '服又崩了', at = Date.now() - 20 * 60_000) {
  createTask({ get: () => undefined }, point, '崩了', '716197431', {
    message_seq: 111,
    message_id: '-2001',
    time: Math.floor(at / 1000),
    sender: { user_id: '1321833118', nickname: '群友A', card: '' },
    message: [{ type: 'text', data: { text } }]
  }, { at, groupName: '测试群' })
  const task = listTasks().find((row) => row.dueAt <= Date.now())
  if (task !== undefined) task.dueAt = Date.now() - 1000
  // during 补一条「有人跟进」，让指纹有意义
  if (task !== undefined) task.during = [{ at: at + 60_000, uin: '222', nick: '群友B', text: '我也进不去' }]
  return task
}

/** 假 ctx：返回一个命中 true 的判定。 */
function matchCtx(resultPatch = {}) {
  const payload = JSON.stringify({
    match: true,
    confidence: 0.9,
    summary: '有人报服崩，两名群友跟进',
    keyMessage: { time: '2026-11-11 03:41:12', nick: '群友A', uin: '1321833118', text: '服又崩了' },
    related: [{ nick: '群友B', uin: '222', text: '我也进不去' }],
    reason: '多人确认',
    ...resultPatch
  })
  return {
    get(key) {
      if (key !== 'llm') return undefined
      return {
        stream() {
          return (async function* () {
            yield { type: 'text-delta', text: payload }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        }
      }
    }
  }
}

// ===========================================================================
// 1. 内容指纹去重

console.log('内容指纹：')
resetInterests()
sent.length = 0
{
  dueTask('服又崩了')
  const first = await runDueTasks(matchCtx(), { at: Date.now(), notify: true })
  eq(first.notified, 1, '第一次命中 → 通知 1 条路（只有 self 开）')
  // ⚠️ 这里**不能**断言 `sent.length === 1`：`sendToQQ` 会按配置分条，
  //    一条通知被拆成好几条（探针实测 6 条）。断言「发了 1 条 HTTP」等于
  //    把分条配置写进这个测试，它跟去重毫无关系（第一版就是在这里假红的）。
  //    要看的是「至少发出去了一次」，以及后面的「再也不会多发」。
  ok(sent.length >= 1, `真的发出去了（走 callOneBot，共 ${sent.length} 条分条消息）`)
  eq(sent[0].action, 'send_private_msg', '发的是私聊消息')
  eq(String(sent[0].params.user_id), '1321833118', '发给了主人（ownerUin）')
  ok(JSON.stringify(sent).includes('【测试群】'), '正文带【群名】前缀（用户逐字要求的格式）')

  const messagesAfterFirst = sent.length

  // 同一件事再来一次（同样的话）
  dueTask('服又崩了')
  const second = await runDueTasks(matchCtx(), { at: Date.now(), notify: true })
  eq(second.notified, 0, '同一件事第二次 → **不再通知**')
  eq(sent.length, messagesAfterFirst, '没有多发任何一条')

  const second2 = await runDueTasks(matchCtx(), { at: Date.now(), notify: true })
  eq(sent.length, messagesAfterFirst, '第三次也没有（指纹账本生效）')
}

// ===========================================================================
// 1b. 内容指纹（**必须单独测，冷却会掩盖它**）
//
// ⚠️ 这一节存在的理由，是变异验证逼出来的（2026-11-11）：
//    上面第 1 节那两条指纹断言，在「去掉指纹判定」的变异下**照样绿** ——
//    因为第一次通知把 `lastNotified` 写上了，第二次被**冷却**挡住，
//    根本走不到指纹那一步。两个因素（冷却、指纹）同时满足，
//    断言就分不清是谁挡的（维护索引 §4 坑 27 的教科书形态）。
//    所以这里把冷却显式设成 0（只留指纹这一道闸），才能单独验它。
console.log('内容指纹（冷却关闭，单独验）：')
resetInterests()
sent.length = 0
{
  config.interestCooldownMinutes = 0
  config.interestDailyMaxPerGroup = 0

  dueTask('服又崩了')
  const first = await runDueTasks(matchCtx({
    keyMessage: { time: '', nick: '群友A', uin: '111', text: '服又崩了' },
    related: [{ nick: '群友B', uin: '222', text: '我也进不去' }]
  }), { at: Date.now(), notify: true })
  eq(first.notified, 1, '冷却关掉后，第一次照常通知（说明闸门确实只剩指纹）')
  const afterFirst = sent.length

  // **同样的话**再来一次：指纹相同 → 挡住
  dueTask('服又崩了')
  const same = await runDueTasks(matchCtx({
    keyMessage: { time: '', nick: '群友A', uin: '111', text: '服又崩了' },
    related: [{ nick: '群友B', uin: '222', text: '我也进不去' }]
  }), { at: Date.now(), notify: true })
  eq(same.notified, 0, '同一件事（指纹相同）→ 不再通知')
  eq(same.skipped, 1, '统计里记成 skipped')
  eq(sent.length, afterFirst, '没有多发')

  // **不同的话**：指纹不同 → 应当照常通知
  //    （这条同时证明「指纹不是把整个群静音」—— 它只合并复述，不屏蔽新事件）
  dueTask('开服公告出来了，能进了')
  const different = await runDueTasks(matchCtx({
    keyMessage: { time: '', nick: '群友C', uin: '333', text: '开服公告出来了，能进了' },
    related: []
  }), { at: Date.now(), notify: true })
  eq(different.notified, 1, '不同的事（指纹不同）→ 照常通知（指纹只合并复述，不屏蔽新事件）')

  config.interestCooldownMinutes = 60
  config.interestDailyMaxPerGroup = 5
}

// ===========================================================================
// 2. 冷却（同关注点）

console.log('冷却：')
resetInterests()
sent.length = 0
{
  // ⚠️ 必须先真的跑一次，把 `lastNotified` 建起来 ——
  //    「冷却」是被上一次通知写下的时间戳挡住的，没有第一轮就没有冷却那回事。
  //    （第一版这段直接断言「冷却期内不发」，结果自然红：那时账本还是空的。）
  dueTask('第一次命中，建立冷却')
  const baseline = await runDueTasks(matchCtx({
    keyMessage: { time: '', nick: '群友Z', uin: '999', text: '第一次命中，建立冷却' },
    related: []
  }), { at: Date.now(), notify: true })
  eq(baseline.notified, 1, '先建立一次通知（冷却的参照点）')
  const afterBaseline = sent.length

  // 换一个完全不同的 keyMessage → 指纹不同，但**冷却仍然挡**
  dueTask('崩了崩了，全是报错')
  const outcome = await runDueTasks(matchCtx({
    keyMessage: { time: '', nick: '群友C', uin: '333', text: '崩了崩了，全是报错' },
    related: []
  }), { at: Date.now(), notify: true })
  eq(outcome.notified, 0, '冷却期内 → 不通知（即使内容不同）')
  eq(outcome.skipped, 1, '统计里记成 skipped')
  eq(sent.length, afterBaseline, '没有多发任何一条')
}

// ===========================================================================
// 3. 每群每日额度

console.log('每日额度：')
resetInterests()
sent.length = 0
{
  const localNow = new Date()
  const today = `${localNow.getFullYear()}-${String(localNow.getMonth() + 1).padStart(2, '0')}-${String(localNow.getDate()).padStart(2, '0')}`
  const disk = { tasks: [], recent: [], daily: { [today]: { calls: 0, perGroup: { '716197431': 5 } } }, lastNotified: {} }
  writeFileSync(INTEREST_FILE, JSON.stringify(disk, null, 2), 'utf8')
  loadInterests()
  dueTask('崩了，开服公告呢')
  const outcome = await runDueTasks(matchCtx({
    keyMessage: { time: '', nick: '群友D', uin: '444', text: '崩了，开服公告呢' },
    related: []
  }), { at: Date.now(), notify: true })
  eq(outcome.notified, 0, '这个群今天已通知 5 次 → 不再通知')
  eq(outcome.skipped, 1, '记成 skipped')
  eq(sent.length, 0, '没有发出去')
}

// ===========================================================================
// 4. 调用上限（成本硬顶）

console.log('调用上限：')
resetInterests()
sent.length = 0
{
  const localNow = new Date()
  const today = `${localNow.getFullYear()}-${String(localNow.getMonth() + 1).padStart(2, '0')}-${String(localNow.getDate()).padStart(2, '0')}`
  // calls 已经到 50（上限），但 perGroup 还没到 —— 要验证的是**送判前**就拦住
  const disk = { tasks: [], recent: [], daily: { [today]: { calls: 50, perGroup: {} } }, lastNotified: {} }
  writeFileSync(INTEREST_FILE, JSON.stringify(disk, null, 2), 'utf8')
  loadInterests()
  dueTask('崩了崩了')
  let streamCalls = 0
  const counting = {
    get(key) {
      if (key !== 'llm') return undefined
      return {
        stream() {
          streamCalls += 1
          return (async function* () {
            yield { type: 'text-delta', text: '{"match":true}' }
            yield { type: 'finish', reason: { kind: 'stop' } }
          })()
        }
      }
    }
  }
  await runDueTasks(counting, { at: Date.now(), notify: true })
  eq(streamCalls, 0, '调用额度用尽 → **一次模型调用都没发生**（省的是钱）')
  eq(sent.length, 0, '自然也没有通知')
}

// ===========================================================================
// 5. 下发两条路（独立开关）

console.log('下发两路：')
resetInterests()
sent.length = 0
{
  // 只开 self
  config.interestNotifySelf = true
  config.interestNotifySession = false
  dueTask('服又崩了 A')
  const a = await runDueTasks(matchCtx({ keyMessage: { time: '', nick: 'A', uin: '1', text: '服又崩了 A' } }), { at: Date.now(), notify: true })
  eq(a.notified, 1, '只开 self → 1 条路')

  // 只开 session
  resetInterests()
  sent.length = 0
  config.interestNotifySelf = false
  config.interestNotifySession = true
  dueTask('服又崩了 B')
  const b = await runDueTasks(matchCtx({ keyMessage: { time: '', nick: 'B', uin: '2', text: '服又崩了 B' } }), { at: Date.now(), notify: true })
  // 路 B 要投进主人会话 —— 假 ctx 没有 agents 服务，所以这里应该是 0 条路
  // （deliver 会在拿不到 agents 时返回 ''，而且不抛错）。
  eq(b.notified, 0, '只开 session 但宿主没有 agents → 0 条路（不抛错）')
  eq(sent.length, 0, '路 B 不会直接发 QQ（它是投会话，不是发消息）')

  // 两个都开：宿主没有 agents，所以仍然只有 self 那一条
  resetInterests()
  sent.length = 0
  config.interestNotifySelf = true
  config.interestNotifySession = true
  dueTask('服又崩了 C')
  const c = await runDueTasks(matchCtx({ keyMessage: { time: '', nick: 'C', uin: '3', text: '服又崩了 C' } }), { at: Date.now(), notify: true })
  eq(c.notified, 1, '两个都开 + 没有 agents → 只有 self 那条成功（路 B 失败被吞）')
  eq(sent.length, 6, 'self 那条照发（分条后合计 6 条 HTTP —— 这里钉死条数，'
    + '是因为它同时验证「路 B 失败没有连累路 A」：如果发送被吞掉，这个数会变成 0）')
}

// ===========================================================================
// 6. notify 本身：路 B 的第一行必须是「这不是主人说的话」

console.log('路 B 素材：')
resetInterests()
{
  const result = validateJudgeResult({
    match: true, summary: 'x', keyMessage: { nick: '甲', uin: '1', text: 'y' }, related: []
  })
  const task = { id: 't', groupId: '1', groupName: 'G', triggerAt: Date.now(), triggerUin: '1', triggerNick: '甲', triggerText: 'y' }
  let deliveredText = ''
  const ctxWithAgents = {
    get(key) {
      if (key === 'agents') {
        return {
          get: () => ({
            followup(message) { deliveredText = JSON.stringify(message); return Promise.resolve() }
          })
        }
      }
      return undefined
    }
  }
  config.interestNotifySelf = false
  config.interestNotifySession = true
  const delivered = await notify(ctxWithAgents, point, task, result, {})
  ok(deliveredText !== '', '路 B 真的调了 followup（投进主人会话）')
  ok(
    deliveredText.includes('插件上报') && deliveredText.includes('不是主人说的话'),
    '路 B 的首行写明「这是插件上报，不是主人说的话」（否则主会话会以为主人在跟它聊）'
  )
  eq(delivered, 1, '路 B 计入 1 条路')
}

// ===========================================================================
// 7. 兴趣点群内回应：精准路由到该群会话，且单回合放行群转发

console.log('群内自动回应：')
resetInterests()
{
  const { outbound, clearOutbound } = await import('../lib/outbound.js')
  clearOutbound()
  sent.length = 0
  point.replyInGroup = true
  point.responseInstruction = '解题时将公式用可用渲染工具制作成图片再发到群里。'
  config.interestNotifySelf = false
  config.interestNotifySession = false
  let received = null
  const groupAgent = {
    session: { seq: 10, events: [] },
    status: 'idle',
    followup(message) { received = message; return Promise.resolve() }
  }
  const ctxWithGroupAgent = {
    get(key) {
      if (key === 'agents') return { get: (id) => id === 'sess-group' ? groupAgent : undefined }
      if (key === 'llm') return { createUserMessage: (message) => ({ id: 'group-interest-user', ...message }) }
      return undefined
    }
  }
  const result = validateJudgeResult({
    match: true,
    summary: '群友发来数学题求助',
    keyMessage: { nick: '题主', uin: '222', text: '这道高数题怎么解？' },
    related: [{ nick: '群友B', uin: '333', text: '求详细步骤' }]
  })
  const task = {
    id: 't-group', pointId: point.id, groupId: '716197431', groupName: '测试群',
    triggerMessageId: '-98765', triggerText: '这道高数题怎么解？', triggerAt: Date.now(),
    triggerUin: '222', triggerNick: '题主', imageBlocks: []
  }
  const delivered = await notify(ctxWithGroupAgent, point, task, result, {})
  ok(received !== null, '命中结果确实投进绑定的群 agent')
  ok(JSON.stringify(received).includes('解题时将公式用可用渲染工具制作成图片再发到群里'), '真实群会话收到独立配置的命中后执行指令')
  ok(JSON.stringify(received).includes('执行指令'), '群会话提示明确标出执行指令区段')
  eq(delivered, 1, '群内答题投递计为一个成功下发渠道')
  const entry = outbound.get('sess-group')?.[0]
  eq(entry?.target, { kind: 'group', id: '716197431' }, '出站目标固定为该群路由')
  eq(entry?.forceForward, true, '仅这个群答题回合获得临时转发许可')
  eq(entry?.replyTo, '-98765', '答题回合引用触发消息')
  clearOutbound()

  const savedRoutes = config.routes
  config.routes = { private: savedRoutes.private, group: {} }
  let fallbackFollowup = false
  const noRouteCtx = {
    get(key) {
      if (key === 'agents') return { get: () => ({
        session: { seq: 0, events: [] },
        followup() { fallbackFollowup = true }
      }) }
      return undefined
    }
  }
  const skipped = await notify(noRouteCtx, point, task, result, {})
  eq(skipped, 0, '没有绑定该群会话时不计为成功下发')
  eq(fallbackFollowup, false, '群未绑定时不兜底到其他会话')
  config.routes = savedRoutes

  received = null
  point.description = ''
  const noCondition = await notify(ctxWithGroupAgent, point, task, result, {})
  eq(noCondition, 0, '判定条件为空时不派发群内工作')
  eq(received, null, '空判定条件不会触发群会话')
  point.description = '帮我关注群友发来的题目求助'

  received = null
  point.responseInstruction = ''
  const noInstruction = await notify(ctxWithGroupAgent, point, task, result, {})
  eq(noInstruction, 0, '执行指令为空时不派发群内工作')
  eq(received, null, '空执行指令不会触发群会话')
  point.responseInstruction = '解题时将公式用可用渲染工具制作成图片再发到群里。'
  point.replyInGroup = false
}

// ---- 收尾 -----------------------------------------------------------------
config.interestNotifySelf = true
config.interestNotifySession = false
resetInterests()
globalThis.fetch = realFetch
try { rmSync(INTEREST_FILE, { force: true }) } catch { /* 沙箱清不掉也无所谓 */ }

console.log('')
if (failures.length === 0) {
  console.log(`全部通过：${pass} 项`)
  process.exit(0)
}
console.error(`失败 ${failures.length} 项 / 共 ${pass + failures.length} 项：`)
for (const label of failures) console.error('  · ' + label)
process.exit(1)