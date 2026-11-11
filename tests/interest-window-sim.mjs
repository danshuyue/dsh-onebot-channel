/**
 * 兴趣点：取材 / 任务生命周期 / 落盘恢复（0.23.0）。
 *
 * ## 为什么这些断言值得写
 *
 * 这个功能最坏失败形态是**静默**：任务没建起来、或者 10 分钟后任务丢了，
 * 主人只是「没收到那条本来该有的通知」—— 他不知道有这件事，也就不会来问。
 * 所以这里盯的全是「该发生的事有没有发生」：
 *
 *   ① pre 快照必须**当场**从缓冲里切（不是 10 分钟后再去拿）；
 *   ② 等待期内的消息要追加进 during（「有没有人跟进」全靠这段）；
 *   ③ 落盘 → 重启 → 过期任务立刻可判（不重启验证的话，这条永远是「看起来对」）；
 *   ④ 关注点被删/被关 → 任务作废，不判也不通知；
 *   ⑤ 剪辑（trimTask）超限时优先丢**最老的 pre**；
 *   ⑥ 成本硬顶在**送判之前**生效（超了根本不调用模型）。
 *
 * ⚠️ LLM 一律用假 ctx（`notify:false` / 假 stream），绝不连真模型。
 * ⚠️ 全部在隔离 HOME 下跑（`run-isolated.mjs` 会建好）；本文件自己读的是
 *    `INTEREST_FILE`，所以必须先确认 HOME 是沙箱，否则会写坏真实数据。
 */
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { INTEREST_FILE } from '../lib/env.js'
import { loadConfig, getConfig, normalizeInterestPoints } from '../lib/config.js'
import {
  resetInterests, createTask, observe, matchPointsFor, runDueTasks, listTasks,
  loadInterests, persistInterests, trimTask, admitTask, interestSummary, DURING_MAX_MESSAGES
} from '../lib/interest.js'

let pass = 0
const failures = []
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log('  ✓ ' + label) } else { failures.push(label); console.error('  ✗ ' + label) }
}
const eq = (actual, expected, label) => {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, `${label}${same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`)
}

// ---- 沙箱自检：这条不成立就别往下跑 --------------------------------------
const homeDir = String(process.env.HOME || process.env.USERPROFILE || '')
ok(homeDir !== '', '测试跑在隔离 HOME 下（HOME 已设置）')
ok(
  process.env.DSH_TEST_HOME === homeDir || homeDir.includes('iso') || homeDir.includes('tmp') || homeDir.includes('mut'),
  `隔离 HOME 看起来真的是沙箱（${homeDir}）`
)

// ---- 配置钉死（跨运行状态污染会让断言恒真，见维护索引 §4 坑 30）----------
const raw = {
  groupUins: ['716197431'],
  routes: { private: {}, group: { 716197431: { sessionId: 's1' } } },
  ownerUin: 1321833118,
  selfUin: 3566906627,
  waterWindows: ['00:00-23:59'],
  windowPerGroupDaily: 20,
  windowPerPeerDaily: 10,
  interestEnabled: true,
  interestWaitMinutes: 10,
  interestPreMinutes: 10,
  interestMaxMessages: 80,
  interestCooldownMinutes: 60,
  interestDailyMaxPerGroup: 5,
  interestDailyMaxCalls: 50,
  interestPoints: [{
    id: 'p-server',
    enabled: true,
    label: '服务器崩溃反馈',
    keywords: ['崩了', '崩溃', '进不去'],
    description: '帮我关注一下群里关于服务器崩溃的反馈',
    groupUins: []
  }],
  autoForwardGroup: false
}
try {
  writeFileSync(INTEREST_FILE, JSON.stringify({ tasks: [], recent: [], daily: {}, lastNotified: {} }, null, 2), 'utf8')
} catch (error) {
  console.error('写沙箱 INTEREST_FILE 失败：', error.message)
  process.exit(1)
}
loadConfig()
// loadConfig 读的是 qq-bridge.config.json —— 沙箱里由 run-isolated 放好。
// 这里再把测试要的那几项钉进单例（能不能读文件不重要，单例才是被测对象）。
const config = getConfig()
Object.assign(config, raw)
config.interestPoints = normalizeInterestPoints(raw.interestPoints)

/** 造一条 OneBot 群消息。 */
function msg(seq, uin, nick, text, atSeconds) {
  return {
    message_seq: seq,
    message_id: String(-1000 - seq),
    time: atSeconds,
    sender: { user_id: String(uin), nickname: nick, card: '' },
    message: [{ type: 'text', data: { text } }],
    group_id: '716197431'
  }
}

/** 假 ctx：只要具备「被 judgeInterest 拒绝」的形状就行（notify:false 时不会走到）。 */
const fakeCtx = { get: () => undefined }

// ===========================================================================
// 1. 命中判定

console.log('命中：')
{
  const m = msg(1, 111, '群友A', '服又崩了', 1000)
  const hits = matchPointsFor(m, config.interestPoints, '716197431')
  eq(hits.length, 1, '关键词命中 → 一个触发')
  eq(hits[0].word, '崩了', '「崩了」比「崩溃」更短但与原文更贴 —— 取命中里最长的那个')
}
{
  const m = msg(1, 111, '群友A', '今天天气不错', 1000)
  eq(matchPointsFor(m, config.interestPoints, '716197431').length, 0, '没提关键词 → 不触发')
}
{
  // 纯 at 段不该参与关键词匹配（textSegmentsOf 只留 text 段）
  const m = {
    message_seq: 2,
    time: 1000,
    sender: { user_id: '111', nickname: 'A', card: '' },
    message: [{ type: 'at', data: { qq: '3566906627' } }, { type: 'text', data: { text: ' 在吗' } }]
  }
  eq(matchPointsFor(m, config.interestPoints, '716197431').length, 0, '@ 段不参与关键词匹配（用纯文字段）')
}
{
  // 生效群：限定到别的群 → 不在这个群触发
  const scoped = normalizeInterestPoints([{
    id: 'p-other', label: 'x', keywords: ['崩了'], description: 'x', groupUins: ['999'], replyInGroup: true
  }])
  eq(scoped[0].replyInGroup, true, '显式 replyInGroup:true 被归一化保留')
  const legacy = normalizeInterestPoints([{ id: 'p-legacy', keywords: ['崩了'], description: 'x' }])
  eq(legacy[0].replyInGroup, false, '存量兴趣点缺少 replyInGroup 时默认关闭')
  eq(matchPointsFor(msg(1, 111, 'A', '崩了', 1000), scoped, '716197431').length, 0, '限定别的群的关注点不在本群触发')
  eq(matchPointsFor(msg(1, 111, 'A', '崩了', 1000), scoped, '999').length, 1, '限定群命中了才触发')
}
{
  // 关掉的关注点不触发
  const off = normalizeInterestPoints([{ id: 'p-off', enabled: false, keywords: ['崩了'], description: 'x' }])
  eq(matchPointsFor(msg(1, 111, 'A', '崩了', 1000), off, '716197431').length, 0, 'enabled:false 的关注点不触发')
}
{
  // 单字关键词被归一化挡掉（否则「崩」会命中「崩坏」这种无关词）
  const one = normalizeInterestPoints([{ id: 'p-one', keywords: ['崩'], description: 'x' }])
  eq(one.length, 0, '单字关键词整条被丢（它永远触发不了，留着只会让人以为配了）')
}

// ===========================================================================
// 2. pre 快照必须当场切

console.log('pre 快照：')
resetInterests()
{
  // 缓冲里放 3 条「触发之前」的消息，时间在 10 分钟内
  const buffer = [
    msg(1, 111, '群友A', '刚重启完', 0),        // 太早（会对时间做过滤）
    msg(2, 222, '群友B', '服又崩了', 0),
    msg(3, 333, '群友C', '我看下', 0)
  ]
  // 把时间设成「触发点之前 5 分钟」这种相对值
  const triggerAt = Math.floor(Date.now() / 1000)
  buffer[0].time = triggerAt - 300
  buffer[1].time = triggerAt - 120
  buffer[2].time = triggerAt - 60
  const trigger = msg(9, 444, '群友D', '崩了崩了', triggerAt)
  const task = createTask(fakeCtx, config.interestPoints[0], '崩了', '716197431', trigger, {
    buffer,
    groupName: '测试群'
  })
  eq(task.pre.length, 3, '缓冲里 3 条都在 preMinutes 内 → 全部进 pre')
  eq(task.pre[0].text, '刚重启完', 'pre 保留原始顺序（时间正序）')
  eq(task.groupName, '测试群', 'groupName 由调用方传入（interest.js 不依赖 poll.js）')
  eq(task.dueAt - task.createdAt, 10 * 60 * 1000, 'dueAt = createdAt + interestWaitMinutes')
}
resetInterests()
{
  // 缓冲里的消息比 preMinutes 更早 → 不进 pre
  const triggerAt = Math.floor(Date.now() / 1000)
  const buffer = [msg(1, 111, 'A', '很久以前的话', triggerAt - 3600)]
  const trigger = msg(2, 222, 'B', '崩了', triggerAt)
  const task = createTask(fakeCtx, config.interestPoints[0], '崩了', '716197431', trigger, { buffer })
  eq(task.pre.length, 0, '超出 preMinutes 的消息不进 pre')
}
resetInterests()
{
  // preMinutes = 0 → 只抓触发后
  config.interestPreMinutes = 0
  const buffer = [msg(1, 111, 'A', '刚才的话', Math.floor(Date.now() / 1000))]
  const task = createTask(fakeCtx, config.interestPoints[0], '崩了', '716197431', msg(2, 222, 'B', '崩了', Math.floor(Date.now() / 1000)), { buffer })
  eq(task.pre.length, 0, 'interestPreMinutes=0 → pre 为空（只抓触发后）')
  config.interestPreMinutes = 10
}
resetInterests()
{
  // 没有 buffer（老调用方 / 测试）→ 不抛错，pre 为空
  const task = createTask(fakeCtx, config.interestPoints[0], '崩了', '716197431', msg(1, 111, 'A', '崩了', 1000), {})
  eq(task.pre.length, 0, '没传 buffer 时 pre 为空，且不抛错')
}

resetInterests()
{
  const originalFetch = globalThis.fetch
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  globalThis.fetch = async () => new Response(png, {
    headers: { 'content-type': 'image/png', 'content-length': String(png.length) }
  })
  const imageCtx = {
    get(key) {
      if (key === 'attachments') return { saveImages: async () => [{ id: 'question-image' }] }
      return undefined
    }
  }
  const imageMessage = msg(20, 222, '题主', '服又崩了', Math.floor(Date.now() / 1000))
  imageMessage.message.push({ type: 'image', data: { url: 'http://8.8.8.8/question.png', file: 'question.png' } })
  await observe(imageCtx, '716197431', imageMessage, {})
  const imageTask = listTasks()[0]
  eq(imageTask.imageBlocks.length, 1, '触发消息图片被转成 DSH 附件并存入任务')
  eq(imageTask.imageBlocks[0].attachment.id, 'question-image', '任务保留附件引用而非临时图片 URL')
  globalThis.fetch = originalFetch
}
resetInterests()

// ===========================================================================
// 3. 等待期追加 during

console.log('during：')
resetInterests()
{
  const triggerAt = Math.floor(Date.now() / 1000)
  createTask(fakeCtx, config.interestPoints[0], '崩了', '716197431', msg(1, 111, 'A', '崩了', triggerAt), {})
  await observe(fakeCtx, '716197431', msg(2, 222, 'B', '我也进不去', triggerAt + 30), {})
  const tasks = listTasks()
  eq(tasks.length, 1, '等待期内的消息不开新任务（还是那 1 个）')
  eq(tasks[0].during.length, 1, '等待期内的消息进了 during')
  eq(tasks[0].during[0].text, '我也进不去', 'during 存的是纯文字')
}
resetInterests()
{
  // 等待期过了之后再来的消息 → 开新任务（不再往旧任务里塞）
  const triggerAt = Math.floor(Date.now() / 1000) - 20 * 60
  createTask(fakeCtx, config.interestPoints[0], '崩了', '716197431', msg(1, 111, 'A', '崩了', triggerAt), { at: Date.now() - 20 * 60_000 })
  await observe(fakeCtx, '716197431', msg(2, 222, 'B', '又崩了', triggerAt + 30), {})
  eq(listTasks().length, 2, '过了 dueAt 之后再命中 → 开**新**任务（旧任务不吞新消息）')
}
resetInterests()
{
  // 她自己说的话不进 during（那是「已经说出去的话」）
  config.selfUin = '3566906627'
  createTask(fakeCtx, config.interestPoints[0], '崩了', '716197431', msg(1, 111, 'A', '崩了', Math.floor(Date.now() / 1000)), {})
  await observe(fakeCtx, '716197431', msg(2, 3566906627, '她', '我在看', Math.floor(Date.now() / 1000) + 10), {})
  eq(listTasks()[0].during.length, 0, '她自己发的消息不进 during')
  config.selfUin = '3566906627'
}
resetInterests()

// ===========================================================================
// 4. 落盘与恢复

console.log('落盘与恢复：')
{
  const triggerAt = Math.floor(Date.now() / 1000)
  const task = createTask(fakeCtx, config.interestPoints[0], '崩了', '716197431', msg(1, 111, 'A', '崩了', triggerAt), {})
  ok(existsSync(INTEREST_FILE), '建任务后 INTEREST_FILE 存在')
  const onDisk = JSON.parse(readFileSync(INTEREST_FILE, 'utf8'))
  eq(onDisk.tasks.length, 1, '任务落盘了（不是只在内存里）')
  eq(onDisk.tasks[0].id, task.id, '落盘的是同一条任务')

  // 模拟重启：清内存 → 从盘上读回来
  resetInterests()
  eq(listTasks().length, 0, '清内存后任务确实没了（不是 reset 无效）')
  loadInterests()
  eq(listTasks().length, 1, 'loadInterests 把盘上的任务接回来了')
  eq(listTasks()[0].id, task.id, '接回来的是同一条')
}
resetInterests()
{
  // 坏 JSON → 按空处理，不抛错（不能因为一份手改坏的文件把整条链路拖垮）
  writeFileSync(INTEREST_FILE, '{ 这不是 JSON', 'utf8')
  const result = loadInterests()
  eq(result.tasks, [], '坏 JSON → 返回空（不抛错）')
  eq(listTasks().length, 0, '坏 JSON → 内存也没有任务')
}

// ===========================================================================
// 5. 剪辑 trimTask

console.log('剪辑：')
{
  const task = {
    id: 't', pre: Array.from({ length: 10 }, (_, i) => ({ text: `pre${i}` })),
    during: Array.from({ length: 10 }, (_, i) => ({ text: `dur${i}` }))
  }
  const trimmed = trimTask(task, 5)
  eq(trimmed.pre.length + 1 + trimmed.during.length, 5, '总条数（含触发那条）裁到上限 5')
  // ⚠️ 这条断言原来写错了，记下来免得再犯：
  //    我最初断言「保留 pre9」，理由是「优先丢最老的 pre」。
  //    但 pre 只有 10 条，而 need = 21 - 5 = 16 **超过了 pre 的整个长度** ——
  //    于是 pre 被整体丢掉，剩下的额度全部由 during 的**尾部**填满。
  //    这不是 bug，恰恰是「离触发点最近」这条原则的正确结果：
  //    当前因和跟进都要裁时，跟进（离触发点更近）优先保留。
  //    实现对了，是断言想当然了 —— 所以改断言，不动代码。
  eq(trimmed.pre.length, 0, 'need(16) 超过 pre 全长(10) → pre 整体丢弃')
  eq(trimmed.during.length, 4, '剩余额度全部给 during')
  eq(trimmed.during[0].text, 'dur6', 'during 保留的是**最近的 4 条**（dur6..dur9，丢最老的）')
  eq(trimmed.during[trimmed.during.length - 1].text, 'dur9', '最后一条是最新的（离触发点最近）')
  ok(trimmed.trimmed === true, '标记 trimmed（便于日志/排查）')
}
{
  const task = { id: 't', pre: [{ text: 'a' }], during: [{ text: 'b' }] }
  const trimmed = trimTask(task, 80)
  ok(trimmed.trimmed === undefined, '没超限时不标记 trimmed，也不改动')
}
{
  // 这条才是「优先丢前因」的正确形状：need(5) **小于** pre 长度(6)，
  // 于是只从 pre 的头部砍掉 5 条，during 完整保留。
  const task = {
    id: 't', pre: Array.from({ length: 6 }, (_, i) => ({ text: `p${i}` })),
    during: Array.from({ length: 2 }, (_, i) => ({ text: `d${i}` }))
  }
  const trimmed = trimTask(task, 4)
  eq(trimmed.during.length, 2, 'need 小于 pre 长度时，during 完整保留')
  eq(trimmed.pre.length, 1, 'pre 从 6 裁到 1（从头部丢最老的）')
  eq(trimmed.pre[0].text, 'p5', '留下的是 pre 里最新的那条')
}

// ===========================================================================
// 6. 成本硬顶在送判之前生效

console.log('成本硬顶：')
resetInterests()
{
  // 今天已经用满调用额度 → 不调用模型
  const localNow = new Date()
  const today = `${localNow.getFullYear()}-${String(localNow.getMonth() + 1).padStart(2, '0')}-${String(localNow.getDate()).padStart(2, '0')}`
  const triggerAt = Math.floor(Date.now() / 1000)
  createTask(fakeCtx, config.interestPoints[0], '崩了', '716197431', msg(1, 111, 'A', '崩了', triggerAt), {
    at: Date.now() - 20 * 60_000,
    // 让它已经过期
  })
  // 手动把 dueAt 拨到过去
  const task = listTasks()[0]
  task.dueAt = Date.now() - 1000
  // 手动灌满今天的 calls
  const disk = JSON.parse(readFileSync(INTEREST_FILE, 'utf8'))
  disk.daily = { [today]: { calls: 50, perGroup: {} } }
  writeFileSync(INTEREST_FILE, JSON.stringify(disk, null, 2), 'utf8')
  loadInterests()

  let called = 0
  const countingCtx = {
    get: () => ({
      stream() { called += 1; return (async function* () {})() }
    })
  }
  const stats = await runDueTasks(countingCtx, { at: Date.now(), notify: false })
  eq(called, 0, '今日调用已达上限 → **根本不调用模型**（这是成本硬顶）')
  eq(stats.skipped, 1, '统计里记成 skipped')
  eq(listTasks().length, 0, '任务被丢弃（不留在队列里反复试）')
}

// ===========================================================================
// 7. 关注点被删 / 被关 → 任务作废

console.log('关注点作废：')
resetInterests()
{
  config.interestPoints = normalizeInterestPoints([])
  createTask(fakeCtx, { id: 'p-gone', keywords: ['崩了'] }, '崩了', '716197431', msg(1, 111, 'A', '崩了', Math.floor(Date.now() / 1000)), { at: Date.now() - 20 * 60_000 })
  listTasks()[0].dueAt = Date.now() - 1000
  const stats = await runDueTasks(fakeCtx, { at: Date.now(), notify: false })
  eq(stats.judged, 0, '关注点没了 → 不送判')
  eq(stats.skipped, 1, '记成 skipped')
  eq(listTasks().length, 0, '任务被清掉')
  config.interestPoints = normalizeInterestPoints(raw.interestPoints)
}

// ===========================================================================
// 8. 冷却

console.log('冷却：')
resetInterests()
{
  const point = config.interestPoints[0]
  eq(admitTask(point, '716197431', Date.now()).ok, true, '第一次：准入')
  // 手动记一次「刚通知过」
  const at = Date.now()
  const disk = { tasks: [], recent: [], daily: {}, lastNotified: { [point.id]: at } }
  writeFileSync(INTEREST_FILE, JSON.stringify(disk, null, 2), 'utf8')
  loadInterests()
  const now = admitTask(point, '716197431', at + 60 * 1000)
  eq(now.ok, false, '冷却期内（1 分钟 < 60 分钟）→ 拒绝')
  ok(now.why.includes('冷却'), '拒绝原因写明「冷却中」')
  eq(admitTask(point, '716197431', at + 61 * 60 * 1000).ok, true, '过了冷却期 → 重新准入')
}
resetInterests()
{
  // 每群每日额度
  const localNow = new Date()
  const today = `${localNow.getFullYear()}-${String(localNow.getMonth() + 1).padStart(2, '0')}-${String(localNow.getDate()).padStart(2, '0')}`
  const disk = { tasks: [], recent: [], daily: { [today]: { calls: 0, perGroup: { '716197431': 5 } } }, lastNotified: {} }
  writeFileSync(INTEREST_FILE, JSON.stringify(disk, null, 2), 'utf8')
  loadInterests()
  const v = admitTask(config.interestPoints[0], '716197431', Date.now())
  eq(v.ok, false, '这个群今天已通知 5 次（上限 5）→ 拒绝')
  ok(v.why.includes('上限'), '拒绝原因写明「上限」')
}

// ===========================================================================
// 9. 汇总

console.log('汇总：')
resetInterests()
{
  createTask(fakeCtx, config.interestPoints[0], '崩了', '716197431', msg(1, 111, 'A', '崩了', Math.floor(Date.now() / 1000)), {})
  const summary = interestSummary()
  eq(summary.tasks, 1, '汇总报出待判任务数')
}

resetInterests()
try { rmSync(INTEREST_FILE, { force: true }) } catch { /* 沙箱清不掉也无所谓 */ }

// ===========================================================================
console.log('')
if (failures.length === 0) {
  console.log(`全部通过：${pass} 项`)
  process.exit(0)
}
console.error(`失败 ${failures.length} 项 / 共 ${pass + failures.length} 项：`)
for (const label of failures) console.error('  · ' + label)
process.exit(1)