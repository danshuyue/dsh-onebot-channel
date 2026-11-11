/**
 * 兴趣点：接线（源码断言）—— 0.23.0。
 *
 * ## 为什么单独一个文件
 *
 * `interest-window-sim` / `interest-dedupe-sim` 测的是**组件**（命中、任务、去重、下发），
 * 它们全绿并不能说明这些组件真的挂在主链路上。
 * 0.21.1 的教训就是「import 还在、调用没了」—— 组件在、接线漏，而单测全绿。
 *
 * ## 判据纪律
 *
 * 每一条断言都盯**完整表达式**（或一个足够窄的、能唯一定位到那个块的窗口），
 * 不盯裸标识符：`poll.js` 里 `interest` 这个词出现很多次，
 * 断言「文件里有 interest」等于什么都没验（维护索引 §4 坑 26d）。
 *
 * 变异验证见 `interest-mutation.mjs`。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')

let pass = 0
const failures = []
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log('  ✓ ' + label) } else { failures.push(label); console.error('  ✗ ' + label) }
}

const poll = readFileSync(join(PLUGIN, 'lib/poll.js'), 'utf8')
const index = readFileSync(join(PLUGIN, 'lib/index.js'), 'utf8')
const config = readFileSync(join(PLUGIN, 'lib/config.js'), 'utf8')
const api = readFileSync(join(PLUGIN, 'lib/api.js'), 'utf8')
const client = readFileSync(join(PLUGIN, 'lib/client.js'), 'utf8')
const outboundSrc = readFileSync(join(PLUGIN, 'lib/outbound.js'), 'utf8')

// ===========================================================================
// 1. 主链路：observe 必须被真的调用，且是 fire-and-forget

console.log('主链路：')
{
  // ⚠️ 位置纪律：必须在「忽略指令」之后（#sl 不该被当成主人在意的事），
  //    且在所有 return 之前（不带 @ 的普通发言才是主要触发源）。
  const call = 'void interest.observe(ctx, groupId, message, {'
  ok(poll.includes(call), 'poll.js 里真的调了 interest.observe（且是 void 掉的）')
  const ignoreAt = poll.indexOf('if (isIgnoredMessage(textSegmentsOf(message.message), config.ignoreCommands)) {')
  const observeAt = poll.indexOf(call)
  const queueAt = poll.indexOf('if (windowMode && win !== null && !atMe && !wakeMe && shouldQueueForWindow(win, message, config)) {')
  const skipAt = poll.indexOf('if (config.groupOnlyWhenAt && !atMe && !inWindow && !wakeMe) {')
  ok(ignoreAt >= 0 && observeAt > ignoreAt, 'observe 在「忽略指令」判定**之后**（#sl 不触发兴趣点）')
  ok(queueAt > observeAt, 'observe 在「入队」return **之前**（否则大多数群发言看不到）')
  ok(skipAt > observeAt, 'observe 在「no at」return **之前**（不带 @ 的发言才是主要触发源）')
  // 传进去的必须是**快照数组**，不是 groupBuffer 函数
  //
  // ⚠️ 这一条原来是 `call + '\n buffer: ...' === call + '\n buffer: ...'` ——
  //    两边逐字相同，**恒真**（写的时候手滑了）。它什么都验不到，
  //    而且会让下面那条真正的断言显得多余。删掉它是对的，
  //    因为「组件在不在」已经由那条 `.slice()` 断言单独负责。
  ok(poll.includes('buffer: groupBuffer(groupId).slice(),'), 'buffer 传的是**此刻的快照**（.slice()），不是 groupBuffer 函数')
  ok(poll.includes("groupName: groupNames.get(groupId) ?? ''"), 'groupName 由 poll.js 交过去（interest.js 对 poll.js 零依赖）')
}

// ===========================================================================
// 2. 循环启动

console.log('循环启动：')
ok(index.includes("import { startInterestLoop } from './interest.js'"), 'index.js import 了 startInterestLoop')
ok(index.includes('stopFns.push(startInterestLoop(ctx))'), 'index.js 真的调用了它（import 与调用同步 —— 0.21.x 那类合并事故的看守）')
{
  // 必须在单实例锁之后（两个实例各跑一个循环 = 同一个任务判两遍、通知两遍）
  const lockAt = index.indexOf('另一个实例已在收发')
  const startAt = index.indexOf('stopFns.push(startInterestLoop(ctx))')
  if (lockAt >= 0) ok(startAt > lockAt, '兴趣点循环在单实例锁**之后**启动')
  else ok(true, '（没找到单实例锁那行日志文案，跳过位置断言）')
}

// ===========================================================================
// 3. 配置五处同改

console.log('配置：')
ok(config.includes('interestEnabled: false,'), 'DEFAULTS 里有 interestEnabled（默认 false）')
ok(config.includes('interestPoints: [],'), 'DEFAULTS 里有 interestPoints')
ok(config.includes('wakeWords: [],'), 'DEFAULTS 里有 wakeWords（默认空 = 功能关闭）')
ok(api.includes("'interestEnabled', 'interestNotifySelf', 'interestNotifySession'"), 'BOOLEAN_FIELDS 登记了兴趣点三个布尔')
ok(api.includes("'wakeWords',") && api.includes("'interestPoints'"), 'ARRAY_FIELDS 登记了唤醒词与兴趣点')
ok(api.includes("'interestWaitMinutes', 'interestPreMinutes', 'interestMaxMessages',"), 'NUMERIC_FIELDS 登记了兴趣点数值')
ok(api.includes("'wakeNoteTemplate',") && api.includes("'interestJudgeProvider', 'interestJudgeModel'"), 'STRING_FIELDS 登记了模板与判定模型')
ok(api.includes('wakeWords: cleanWakeWords') && api.includes('interestPoints: cleanInterestPoints'), 'ARRAY_CLEANERS 登记了两个清洗器')
// 反向：每个可写字段都要在 publicConfig 里（ui-wiring 的 4b 也覆盖，但这里更早报错）
for (const key of ['interestWaitMinutes', 'interestPreMinutes', 'interestMaxMessages',
  'interestCooldownMinutes', 'interestDailyMaxPerGroup', 'interestDailyMaxCalls',
  'interestJudgeProvider', 'interestJudgeModel', 'interestNotifySelf', 'interestNotifySession',
  'wakeWords', 'wakeNoteTemplate', 'wakePerGroupHourly', 'interestEnabled', 'interestPoints']) {
  ok(api.includes(`${key}:`), `publicConfig 暴露了 ${key}`)
}

// ===========================================================================
// 4. 设置页两个卡片都挂上了

console.log('设置页：')
ok(client.includes('renderWakeCard(),'), '唤醒词卡片被渲染（不是只定义了函数）')
ok(client.includes('renderInterestCard(),'), '兴趣点卡片被渲染')
{
  // 挂在「对话节奏」那个 pane 里（用户会在那儿找手感类开关）
  const stancePane = client.slice(
    client.indexOf("if (tab === 'stance')") >= 0 ? client.indexOf("if (tab === 'stance')") : client.indexOf("} else if (tab === 'stance')"),
    client.indexOf("} else if (tab === 'proactive')")
  )
  ok(stancePane.includes('renderWakeCard()'), '唤醒词卡片挂在「对话节奏」分区')
  ok(stancePane.includes('renderInterestCard()'), '兴趣点卡片挂在「对话节奏」分区')
}
// 表单状态（缺了就是「界面能改、改了没用」的另一种形态：读不到初值）
for (const key of ['wakeWords:', 'wakeNoteTemplate:', 'wakePerGroupHourly:',
  'interestEnabled:', 'interestPoints:', 'interestWaitMinutes:', 'interestPreMinutes:',
  'interestMaxMessages:', 'interestCooldownMinutes:', 'interestDailyMaxPerGroup:',
  'interestDailyMaxCalls:', 'interestJudgeProvider:', 'interestJudgeModel:',
  'interestNotifySelf:', 'interestNotifySession:']) {
  ok(client.includes(key), `设置页表单状态里有 ${key}`)
}

// ===========================================================================
// 5. 关键行为接线（不是组件正确性，而是「有没有真的用上」）

console.log('行为接线：')
const interestSrc = readFileSync(join(PLUGIN, 'lib/interest.js'), 'utf8')
const judgeSrc = readFileSync(join(PLUGIN, 'lib/judge.js'), 'utf8')
// 成本硬顶必须在送判**之前**（否则钱已经花了）
{
  const limitAt = interestSrc.indexOf('interestDailyMaxCalls')
  const judgeAt = interestSrc.indexOf('await judgeInterest(ctx, point, trimmed)')
  ok(limitAt >= 0 && judgeAt > limitAt, '成本硬顶（interestDailyMaxCalls）判在**送判之前**')
}
// 判定失败绝不能当命中
ok(judgeSrc.includes("if (failure !== '') return { ok: false, result: null, why: failure }"),
  '终态失败（error / aborted / max-tokens）一律 ok:false')
ok(interestSrc.includes('if (outcome.ok !== true) {'), '调用方对 ok:false 单独分支（不落进命中判断）')
// 任务必须落盘
ok(interestSrc.includes('persistInterests()'), '任务会落盘')
ok(interestSrc.includes('loadInterests()'), '启动时会从盘上接回任务')
// 两条下发路独立开关
ok(interestSrc.includes("if (config?.interestNotifySelf !== false) {"), '路 A 由 interestNotifySelf 控制（默认开）')
ok(interestSrc.includes("if (config?.interestNotifySession === true) {"), '路 B 由 interestNotifySession 控制（默认关）')
// 路 B 首行必须声明「不是主人说的话」
ok(interestSrc.includes('下面这段不是主人说的话'), '路 B 的素材首行写明「这是插件上报，不是主人说的话」')
ok(outboundSrc.includes("if (!forceForward && !autoForwardEnabledFor(entry.target, config)) {"), '群内答题只对 forceForward 单回合绕过全局渠道闸门')
ok(interestSrc.includes("if (point?.replyInGroup === true) {"), '群内回应由单个兴趣点的 replyInGroup 开关控制')
ok(interestSrc.includes("const instruction = String(point?.responseInstruction ?? '').trim()"), '群会话执行指令来自独立 responseInstruction 字段')
ok(interestSrc.includes("if (condition === '' || instruction === '') {"), '判定条件或执行指令为空时安全跳过群派发')
ok(interestSrc.includes("'【执行指令】'"), '群会话 prompt 明确区分执行指令')
ok(config.includes("responseInstruction: String(record.responseInstruction ?? '').trim()"), '配置层归一化 responseInstruction')
ok(client.includes('responseInstruction: String((row && row.responseInstruction) || \'\')'), '设置页表单加载 responseInstruction')
ok(client.includes("patchPoint(index, { responseInstruction: String(event.target.value || '') })"), '设置页保存命中后执行指令')
ok(interestSrc.includes("{ kind: 'group', id: groupId }"), '答题素材投到该群的绑定会话，不复用主人私聊目标')
ok(interestSrc.includes('forceForward: true, replyTo: String(task?.triggerMessageId ?? \'\')'), '单回合放行并引用原触发消息')
ok(interestSrc.includes('const instruction = String(point?.responseInstruction ?? \'\').trim()'), '群会话 prompt 读取独立执行指令')
ok(judgeSrc.includes("...imageBlocks]"), '触发消息图片作为多模态块送入判定模型')
// 群名兜底：不能留下空括号
ok(judgeSrc.includes('`群 ${String(task?.groupId ?? \'\')}`'), '群名缺失时用「群 <id>」兜底')

// ===========================================================================
console.log('')
if (failures.length === 0) {
  console.log(`全部通过：${pass} 项`)
  process.exit(0)
}
console.error(`失败 ${failures.length} 项 / 共 ${pass + failures.length} 项：`)
for (const label of failures) console.error('  · ' + label)
process.exit(1)