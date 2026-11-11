/**
 * 兴趣点判定器（judge.js）验证 —— 0.23.0。
 *
 * ⚠️ 这个测试**不连真模型**：注入一个假的 `ctx`（`llm.stream` 返回预设 chunk 序列）。
 *    真实调用只放在设置页的「试跑一次」按钮里，由人点。
 *
 * 覆盖：
 *   ① JSON 三层容错（纯 JSON / ```json 块 / 前后有废话）
 *   ② 坏 JSON → ok:false 且**不命中**（这是本功能最重要的方向性断言）
 *   ③ 形状校验：match 必须是布尔 true，字符串 "true" 不算
 *   ④ finish 三种终态：error / aborted / max-tokens 都当失败
 *   ⑤ prompt 渲染：包含主人原话、包含触发那条、包含「没人跟进」的说明
 *   ⑥ 下发文本格式：`【群名】[群友]：「内容」` + 概述 + 时间 + 发起人
 */
import {
  extractJson, validateJudgeResult, judgeInterest, renderJudgeUserPrompt,
  renderInterestNotice, JUDGE_MAX_TOKENS
} from '../lib/judge.js'
import { getConfig } from '../lib/config.js'

let pass = 0
const failures = []
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log('  ✓ ' + label) } else { failures.push(label); console.error('  ✗ ' + label) }
}
const eq = (actual, expected, label) => {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, `${label}${same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`)
}

// ===========================================================================
// 1. JSON 容错

console.log('JSON 容错：')
eq(extractJson('{"match":true}'), { match: true }, '第一层：整段就是 JSON')
eq(
  extractJson('好的，我的判断是：\n```json\n{"match":false,"summary":"无"}\n```\n以上。'),
  { match: false, summary: '无' },
  '第二层：```json 代码块（前后有废话）'
)
eq(
  extractJson('我觉得：{"match":true,"summary":"服崩了"} 就这样'),
  { match: true, summary: '服崩了' },
  '第三层：第一个 { 到最后一个 }'
)
eq(extractJson('完全没有 JSON'), null, '一句废话都没有 → null')
eq(extractJson(''), null, '空串 → null')
eq(extractJson('{"broken": '), null, '半截 JSON → null（不能抛错）')
eq(extractJson('[1,2,3]'), null, '数组不算（契约是对象）')

// ===========================================================================
// 2. 形状校验

console.log('形状校验：')
{
  const result = validateJudgeResult({
    match: true,
    confidence: 0.9,
    summary: '有人报服崩',
    keyMessage: { time: '03:41:12', nick: '群友A', uin: '1321833118', text: '服又崩了' },
    related: [{ nick: '群友B', uin: '2', text: '我也进不去' }, { nick: '', uin: '', text: '' }],
    reason: '多人跟进'
  })
  eq(result.match, true, 'match:true 保留')
  eq(result.keyMessage.text, '服又崩了', 'keyMessage.text 保留')
  eq(result.related.length, 1, 'related 里的空条目被丢掉')
  eq(result.confidence, 0.9, 'confidence 保留')
}
eq(validateJudgeResult({ match: 'true' }).match, false, 'match 是字符串 "true" → 判 false（没按契约输出就不可信）')
eq(validateJudgeResult({ match: 1 }).match, false, 'match 是数字 1 → 判 false')
eq(validateJudgeResult(null), null, 'null → null')
eq(validateJudgeResult([]), null, '数组 → null')
{
  const clamped = validateJudgeResult({ match: true, confidence: 5 })
  eq(clamped.confidence, 1, 'confidence 超界被夹到 1')
  const long = validateJudgeResult({ match: true, summary: 'x'.repeat(500) })
  eq(long.summary.length, 200, 'summary 超长截到 200')
}

// ===========================================================================
// 3. 判定调用（假 llm）

console.log('判定调用：')
// 让两边都拿到确定的 provider / model
const config = getConfig()
config.agentOptions = { provider: 'test-provider', model: 'test-model' }
config.interestJudgeProvider = ''
config.interestJudgeModel = ''

/** 造一个假 ctx：llm.stream 依次吐出给定的 chunk。 */
function fakeCtx(chunks) {
  const calls = []
  return {
    calls,
    get(key) {
      if (key !== 'llm') return undefined
      return {
        stream(options) {
          calls.push(options)
          return (async function* () { for (const chunk of chunks) yield chunk })()
        }
      }
    }
  }
}

const point = {
  id: 'p-1',
  label: '服务器崩溃反馈',
  description: '帮我关注一下群里关于服务器崩溃的反馈',
  responseInstruction: '群友求助解题时，用公式渲染工具制作图片后答复',
  keywords: ['崩了', '崩溃']
}
const task = {
  id: 't-1',
  groupId: '716197431',
  groupName: '测试群',
  triggerWord: '崩了',
  triggerAt: Date.UTC(2026, 10, 11, 3, 41, 12),
  triggerUin: '1321833118',
  triggerNick: '群友A',
  triggerText: '服又崩了',
  pre: [],
  during: []
}

ctxBlock('正常命中')
async function ctxBlock(label) { console.log(`  ${label}（异步）`) }

// ---- 正常命中 ----
{
  const ctx = fakeCtx([
    { type: 'text-delta', text: '{"match":true,' },
    { type: 'text-delta', text: '"summary":"服崩了","keyMessage":{"nick":"群友A","text":"服又崩了"}}' },
    { type: 'finish', reason: { kind: 'stop' } }
  ])
  const outcome = await judgeInterest(ctx, point, task)
  ok(outcome.ok, '调用成功（ok:true）')
  eq(outcome.result.match, true, '解析出 match:true')
  eq(ctx.calls.length, 1, '只调了一次 llm.stream')
  eq(ctx.calls[0].provider, 'test-provider', 'provider 空时继承 agentOptions')
  eq(ctx.calls[0].model, 'test-model', 'model 空时继承 agentOptions')
  eq(ctx.calls[0].maxTokens, JUDGE_MAX_TOKENS, `maxTokens 用 ${JUDGE_MAX_TOKENS}`)
  eq(ctx.calls[0].tools, undefined, '不带工具（这是一次分类，不是 agent loop）')
  ok(String(ctx.calls[0].sessionId).startsWith('interest:'), 'sessionId 带 interest: 前缀（计费归因，不写会话）')
}
{
  const image = { type: 'image', attachment: { id: 'image-ref' } }
  const ctx = fakeCtx([
    { type: 'text-delta', text: '{"match":false}' },
    { type: 'finish', reason: { kind: 'stop' } }
  ])
  await judgeInterest(ctx, point, { ...task, imageBlocks: [image] })
  const content = ctx.calls[0].messages[1].content
  eq(content.length, 2, '图片题判定请求包含文本和图片两个内容块')
  eq(content[1], image, '原题附件引用原样送给判定模型')
  ok(content[0].text.includes('附带 1 张图片'), '判定提示说明图片也是判定材料')
}

// ---- provider / model 显式配置优先 ----
{
  config.interestJudgeProvider = 'my-provider'
  config.interestJudgeModel = 'my-model'
  const ctx = fakeCtx([{ type: 'text-delta', text: '{"match":false}' }, { type: 'finish', reason: { kind: 'stop' } }])
  await judgeInterest(ctx, point, task)
  eq(ctx.calls[0].provider, 'my-provider', '显式配置的 provider 优先于 agentOptions')
  eq(ctx.calls[0].model, 'my-model', '显式配置的 model 优先于 agentOptions')
  config.interestJudgeProvider = ''
  config.interestJudgeModel = ''
}

// ---- 四种失败形态都必须 ok:false 且 result 为 null ----
{
  const ctx = fakeCtx([
    { type: 'text-delta', text: '这不是 JSON' },
    { type: 'finish', reason: { kind: 'stop' } }
  ])
  const outcome = await judgeInterest(ctx, point, task)
  eq(outcome.ok, false, '坏 JSON → ok:false')
  eq(outcome.result, null, '坏 JSON → result 为 null（**绝不能当命中**）')
}
{
  const ctx = fakeCtx([
    { type: 'text-delta', text: '{"match":true}' },
    { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited' } } }
  ])
  const outcome = await judgeInterest(ctx, point, task)
  eq(outcome.ok, false, 'finish.kind=error → ok:false（哪怕文本看起来是 JSON）')
}
{
  const ctx = fakeCtx([
    { type: 'text-delta', text: '{"match":true}' },
    { type: 'finish', reason: { kind: 'aborted' } }
  ])
  const outcome = await judgeInterest(ctx, point, task)
  eq(outcome.ok, false, 'finish.kind=aborted → ok:false')
}
{
  const ctx = fakeCtx([
    { type: 'text-delta', text: '{"match":tr' },
    { type: 'finish', reason: { kind: 'max-tokens' } }
  ])
  const outcome = await judgeInterest(ctx, point, task)
  eq(outcome.ok, false, 'finish.kind=max-tokens → ok:false（截断的 JSON 必然不全）')
  ok(outcome.why.includes('截断'), '失败原因写明「截断」')
}
{
  // 没有 llm 服务
  const outcome = await judgeInterest({ get: () => undefined }, point, task)
  eq(outcome.ok, false, '取不到 llm 服务 → ok:false，不抛错')
}
{
  // stream 抛错
  const ctx = {
    get: () => ({
      stream() {
        return (async function* () { throw new Error('network down') })()
      }
    })
  }
  const outcome = await judgeInterest(ctx, point, task)
  eq(outcome.ok, false, 'stream 抛错 → ok:false，不把异常冒出去')
  ok(outcome.why.includes('network down'), '失败原因带上了原始错误')
}

// ===========================================================================
// 4. prompt 渲染

console.log('prompt：')
{
  const fullTask = {
    ...task,
    pre: [{ at: Date.UTC(2026, 10, 11, 3, 30, 0), uin: '111', nick: '群友C', text: '刚重启完' }],
    during: [{ at: Date.UTC(2026, 10, 11, 3, 45, 0), uin: '222', nick: '群友B', text: '我也进不去' }]
  }
  const prompt = renderJudgeUserPrompt(point, fullTask, config)
  ok(prompt.includes('帮我关注一下群里关于服务器崩溃的反馈'), '判定 prompt 包含命中条件')
  ok(!prompt.includes(point.responseInstruction), '执行指令不混入内部判定模型 prompt')
  ok(prompt.includes('服务器崩溃反馈'), 'prompt 里带关注点名称')
  ok(prompt.includes('崩了、崩溃'), 'prompt 里带关键词')
  ok(prompt.includes('刚重启完'), 'prompt 里带触发**之前**的消息')
  ok(prompt.includes('服又崩了'), 'prompt 里带触发那条')
  ok(prompt.includes('我也进不去'), 'prompt 里带触发**之后**的跟进')
  ok(prompt.includes('— 触发那条'), '三段有明确分隔（模型要能看出时间顺序）')
}
{
  const emptyTask = { ...task, pre: [], during: [] }
  const prompt = renderJudgeUserPrompt(point, emptyTask, config)
  ok(prompt.includes('等待期内没有人再说话'), '没有跟进时**明说**没有 —— 不能留白让模型自己猜')
}
{
  // 她自己说过的话标「你自己」（与窗口批次的渲染口径一致）
  config.selfUin = '999'
  const selfTask = { ...task, during: [{ at: 0, uin: '999', nick: '她', text: '我在' }] }
  const prompt = renderJudgeUserPrompt(point, selfTask, config)
  ok(prompt.includes('你自己'), '她自己说过的话标成「你自己」')
  config.selfUin = ''
}

// ===========================================================================
// 5. 下发文本格式（用户原话：`【群昵称】[群友]：「内容」`）

console.log('下发文本：')
{
  const result = validateJudgeResult({
    match: true,
    summary: '有人报服崩，两名群友跟进确认',
    keyMessage: { time: '', nick: '群友A', uin: '1321833118', text: '服又崩了' },
    related: [{ nick: '群友B', uin: '222', text: '我也进不去' }],
    reason: '多人确认'
  })
  const text = renderInterestNotice(point, task, result)
  ok(text.startsWith('【测试群】[群友A]：「服又崩了」'), '首行就是 `【群名】[群友]：「内容」`（用户逐字要求）')
  ok(text.includes('概述：有人报服崩'), '带概述')
  ok(text.includes('时间：'), '带时间')
  ok(text.includes('关注点：服务器崩溃反馈'), '带关注点名称')
  ok(text.includes('发起人：群友A'), '带发起人')
  ok(text.includes('我也进不去'), '带其他人的佐证')
}
{
  // 群名拿不到时退回群号 —— 不能出现「【】」
  const noName = { ...task, groupName: '' }
  const text = renderInterestNotice(point, noName, validateJudgeResult({ match: true, summary: 'x', keyMessage: { nick: '甲', text: 'y' } }))
  ok(text.startsWith('【群 716197431】'), '群名缺失时用群号兜底，不留下空括号')
}
{
  // 模型没给概述时不能留下空白（用户看到「概述：」会以为坏了）
  const text = renderInterestNotice(point, task, validateJudgeResult({ match: true, keyMessage: { nick: '甲', text: 'y' } }))
  ok(text.includes('（模型没给概述）'), '概述缺失时有明确的占位，不是空行')
}

// ===========================================================================
// 结论

console.log('')
if (failures.length === 0) {
  console.log(`全部通过：${pass} 项`)
  process.exit(0)
}
console.error(`失败 ${failures.length} 项 / 共 ${pass + failures.length} 项：`)
for (const label of failures) console.error('  · ' + label)
process.exit(1)