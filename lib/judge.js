/**
 * judge.js —— 兴趣点判定器（0.23.0）。
 *
 * ## 它回答的唯一问题
 *
 * 「这段群聊里，是不是真的出现了主人关心的那类事？」
 *
 * 不是「有没有提到关键词」（那是触发层的事），也不是「这段聊天值不值得知道」。
 * 判定依据只有两样：**主人自己写的那句话**（`description`）+ **群聊记录**。
 * 「帮我关注一下群里关于服务器崩溃的反馈」必须把「昨天我的程序崩溃了」
 * 判成 false —— 这是这个功能的成败所在。
 *
 * ## 为什么直连 llm，而不是起一个子代理
 *
 * 三条（都实测过）：
 *   ① **取结果**：`subagents.startActivation` 是 `delivery: 'parent'` 的**投递型** ——
 *      结论作为一条消息回到父会话，插件要拿结果得回去读会话日志（zstd 多帧解码）。
 *      多一条脆弱链路，而这条链路失败时**没有任何报错**。
 *   ② **成本**：子代理是一个完整 agent loop（可多步、可调工具），
 *      而这里要的是一次 200–400 token 的分类。差一个数量级。
 *   ③ **时序**：子代理挂在会话上，会话正忙时要排程；而兴趣点的等待窗口
 *      是按分钟算的，10 分钟的窗口不该因为群会话在跑回合而漂移。
 *
 * ## 凭据与模型
 *
 * `llm.stream({ provider, model })` 走的是**宿主已配的 provider 与凭据**：
 * 插件一个 key 都不存，也不读任何配置文件。这是本仓库一贯的立场
 * （见 deliver.js 的「只走宿主服务，绝不 import 官方包」）。
 *
 * 模型可配（`interestJudgeProvider` / `interestJudgeModel`），
 * 空串 = 继承 `agentOptions`。设置页用 `llm.listProviders()` / `llm.listModels()`
 * 做两级下拉（两个接口在 0.23.0 落地时已核实存在，见 `dsh-cost-meter` 的用法）。
 *
 * ## 失败一律 = false
 *
 * 判定失败（接口错、超时、JSON 坏、被截断）**绝不等于命中**。
 * 理由：误报会让主人收到一条「其实没关系」的通知，反复几次他就不信这个功能了；
 * 漏报只是少一条提醒。两边代价不对称，所以往「不说」那边倒。
 */
import { getConfig } from './config.js'
import { serviceOf, note } from './env.js'

/** 判定超时。群聊记录再长也不该跑过一分钟 —— 超了宁可不判。 */
export const JUDGE_TIMEOUT_MS = 60_000

/** 输出的 token 预算。JSON 契约很小，800 足够；被截断就当失败（JSON 必然不全）。 */
export const JUDGE_MAX_TOKENS = 800

/**
 * 全局并发 1。
 *
 * 为什么：一个群里可能同时有 10 个兴趣点等着判，而每次判定都是一次真实计费调用。
 * 串行化的代价是「判定慢几秒」，而它的收益是「不会一瞬间打出 10 个请求
 * （可能撞上 provider 的限流，那会导致一批判定失败 → 全部静默漏报）」。
 */
let judgeChain = Promise.resolve()

/**
 * 判定结果的形状校验。
 *
 * ⚠️ 这只保证「字段类型对」，不保证「内容对」—— 内容对不对是这个功能的语义，
 * 代码判不了。`match !== true` 一律当「不命中」：模型返回 `match: "true"`（字符串）
 * 也判 false，因为那是它没按契约输出，可信度已经没了。
 *
 * @param {unknown} raw 解析出来的对象
 * @returns {object|null} 合格结果；不合格返回 null
 */
export function validateJudgeResult(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const match = raw.match === true
  const summary = String(raw.summary ?? '').trim().slice(0, 200)
  const keyRaw = raw.keyMessage !== null && typeof raw.keyMessage === 'object' && !Array.isArray(raw.keyMessage)
    ? raw.keyMessage
    : {}
  const keyMessage = {
    time: String(keyRaw.time ?? '').trim().slice(0, 40),
    nick: String(keyRaw.nick ?? '').trim().slice(0, 40),
    uin: String(keyRaw.uin ?? '').trim().slice(0, 20),
    text: String(keyRaw.text ?? '').trim().slice(0, 400)
  }
  const related = Array.isArray(raw.related)
    ? raw.related
        .filter((row) => row !== null && typeof row === 'object')
        .slice(0, 5)
        .map((row) => ({
          nick: String(row.nick ?? '').trim().slice(0, 40),
          uin: String(row.uin ?? '').trim().slice(0, 20),
          text: String(row.text ?? '').trim().slice(0, 200)
        }))
        .filter((row) => row.text !== '')
    : []
  return {
    match,
    confidence: Number.isFinite(Number(raw.confidence)) ? Math.max(0, Math.min(1, Number(raw.confidence))) : 0,
    summary,
    keyMessage,
    related,
    reason: String(raw.reason ?? '').trim().slice(0, 200)
  }
}

/**
 * 从模型输出里抠 JSON。
 *
 * 三层容错，顺序固定：
 *   ① 整段就是 JSON（最理想，契约好的模型会这样）；
 *   ② ```json 代码块里的内容；
 *   ③ 第一个 `{` 到最后一个 `}`（模型爱加「好的，我的判断是：」这种前言）。
 *
 * ⚠️ 第三层是**最后手段**：它会把「两段 JSON 拼在一起」这种输出抠成一坨废字符串，
 *    然后解析失败 → 判 false。这正是我们要的方向（宁可漏报）。
 *
 * @param {string} text
 * @returns {object|null}
 */
export function extractJson(text) {
  const body = String(text ?? '').trim()
  if (body === '') return null
  const attempts = [body]
  const fenced = body.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced !== null && typeof fenced[1] === 'string') attempts.push(fenced[1].trim())
  const first = body.indexOf('{')
  const last = body.lastIndexOf('}')
  if (first >= 0 && last > first) attempts.push(body.slice(first, last + 1))
  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch { /* 换下一层 */ }
  }
  return null
}

/** 判定系统提示词。**这是这个功能的定义**，不是措辞偏好 —— 改之前先看 §2.4 of the 需求文档。 */
export const JUDGE_SYSTEM_PROMPT = [
  '你是用户的「关注点判定器」。给你一段群聊记录和一个关注点描述，判断这段聊天里是否真的出现了用户关心的那类情况。',
  '',
  '判定规矩（按重要性排序）：',
  '1. 严格按关注点描述的**字面意图**判断，不要放宽、不要「可能相关也算」。',
  '   例：描述是「服务器崩溃的反馈」→「XX 服又炸了、进不去」算；',
  '   「昨天我的程序崩溃了」不算（那是别人的程序，不是服务器）。',
  '2. 只有**人们真的在讨论这件事**才算。有人只是顺口提了一个词、或者话题已经翻篇，不算。',
  '3. 拿不准就判 false。少报一次远好过多报一次。',
  '4. 注意时间顺序：先报症状、后有人跟进确认，比孤零零一句话可信得多。',
  '',
  '只输出一个 JSON 对象，不要任何解释、不要代码块以外的文字。格式：',
  '{',
  '  "match": true 或 false,',
  '  "confidence": 0 到 1 的小数,',
  '  "summary": "一句话说清发生了什么（≤60 字）",',
  '  "keyMessage": { "time": "群友原话的时间", "nick": "谁说的", "uin": "QQ号", "text": "原话" },',
  '  "related": [ { "nick": "", "uin": "", "text": "" } ],',
  '  "reason": "为什么算（≤80 字）"',
  '}',
  'match 为 false 时，summary / keyMessage / related 给空值即可，reason 写一句为什么不算。'
].join('\n')

/**
 * 把任务渲染成判定用的消息内容。
 *
 * 口径与 `deliverWindowBatch` 的群批次渲染一致（`时间 昵称: 内容`、自己标「你自己」）：
 * 模型在两条路上看到同一个画面，判断才不会互相矛盾。
 *
 * @param {object} point 兴趣点（label / description / keywords）
 * @param {object} task 任务（groupId / groupName / pre[] / during[]）
 * @param {object} config
 * @returns {string}
 */
export function renderJudgeUserPrompt(point, task, config) {
  const selfUin = String(config?.selfUin ?? '').trim()
  const ownerUin = String(config?.ownerUin ?? config?.peerUin ?? '').trim()
  const lines = []
  lines.push('【关注点】')
  if (String(point?.label ?? '') !== '') lines.push(`名称：${point.label}`)
  lines.push(`主人的原话：${String(point?.description ?? '').trim() || '（主人没写描述，按关键词理解）'}`)
  if (Array.isArray(point?.keywords) && point.keywords.length > 0) {
    lines.push(`触发关键词：${point.keywords.join('、')}`)
  }
  lines.push('')
  lines.push('【这段群聊】')
  const gid = String(task?.groupId ?? '')
  const gname = String(task?.groupName ?? '')
  lines.push(`群：${gname === '' ? gid : `${gname}（${gid}）`}`)

  const render = (item) => {
    const at = Number(item?.at) || 0
    const time = at > 0 ? new Date(at).toLocaleTimeString('zh-CN', { hour12: false }) : ''
    const uin = String(item?.uin ?? '')
    let who = String(item?.nick ?? '') || uin || '未知'
    if (selfUin !== '' && uin === selfUin) who = '你自己'
    else if (ownerUin !== '' && uin === ownerUin) who = `${who}（用户本人）`
    else who = `${who}（群友）`
    const text = String(item?.text ?? '').trim()
    return text === '' ? '' : `${time} ${who}: ${text}`.trim()
  }

  const pre = Array.isArray(task?.pre) ? task.pre : []
  const during = Array.isArray(task?.during) ? task.during : []
  if (pre.length > 0) {
    lines.push('— 触发之前 —')
    for (const item of pre) {
      const line = render(item)
      if (line !== '') lines.push(line)
    }
  }
  lines.push(`— 触发那条（关键词「${String(task?.triggerWord ?? '').trim() || '命中'}」）—`)
  lines.push(render({ at: task?.triggerAt, uin: task?.triggerUin, nick: task?.triggerNick, text: task?.triggerText }))
  if (during.length > 0) {
    lines.push('— 之后的跟进 —')
    for (const item of during) {
      const line = render(item)
      if (line !== '') lines.push(line)
    }
  } else {
    lines.push('— 之后的跟进 —')
    lines.push('（等待期内没有人再说话）')
  }
  if (Array.isArray(task?.imageBlocks) && task.imageBlocks.length > 0) {
    lines.push(`触发消息附带 ${task.imageBlocks.length} 张图片，图片内容也属于判定材料。`)
  }
  lines.push('')
  lines.push('请判断：这段聊天里是否真的出现了主人关心的那类情况？只输出 JSON。')
  return lines.join('\n')
}

/**
 * 跑一次判定。
 *
 * @param {object} ctx 插件 context（取 `llm` 服务）
 * @param {object} point 兴趣点
 * @param {object} task 任务
 * @param {object} [options] `{ signal }`
 * @returns {Promise<{ ok: boolean, result: object|null, why: string }>}
 *   `ok: false` = 判定没做成（接口错/超时/坏 JSON），调用方**不要**当命中处理
 */
export async function judgeInterest(ctx, point, task, options = {}) {
  const config = getConfig()
  const provider = String(config?.interestJudgeProvider ?? '').trim()
    || String(config?.agentOptions?.provider ?? '').trim()
  const model = String(config?.interestJudgeModel ?? '').trim()
    || String(config?.agentOptions?.model ?? '').trim()
  if (provider === '' || model === '') {
    return { ok: false, result: null, why: '没有可用的 provider / model（agentOptions 也没配）' }
  }

  let llm = null
  try {
    llm = serviceOf(ctx, 'llm')
  } catch (error) {
    return { ok: false, result: null, why: `取 llm 服务失败：${error instanceof Error ? error.message : error}` }
  }
  if (llm === undefined || llm === null || typeof llm.stream !== 'function') {
    return { ok: false, result: null, why: '宿主没有 llm.stream（版本不匹配？）' }
  }

  const imageBlocks = Array.isArray(task?.imageBlocks)
    ? task.imageBlocks.filter((block) => block?.type === 'image' && block.attachment !== undefined)
    : []
  const messages = [
    { role: 'system', content: [{ type: 'text', text: JUDGE_SYSTEM_PROMPT }] },
    {
      role: 'user',
      content: [{ type: 'text', text: renderJudgeUserPrompt(point, task, config) }, ...imageBlocks]
    }
  ]
  const timeoutSignal = AbortSignal.timeout(JUDGE_TIMEOUT_MS)
  const signal = options.signal === undefined
    ? timeoutSignal
    : (typeof AbortSignal.any === 'function' ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal)

  // 串行化：见文件头「全局并发 1」
  const run = async () => {
    let text = ''
    let failure = ''
    for await (const chunk of llm.stream({
      provider,
      model,
      messages,
      maxTokens: JUDGE_MAX_TOKENS,
      // sessionId 只用于计费归因，不写任何会话 —— 判定不该在会话列表里留下痕迹
      sessionId: `interest:${String(task?.id ?? 'x')}`,
      signal
    })) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      if (chunk?.type === 'finish') {
        const kind = String(chunk.reason?.kind ?? '')
        if (kind === 'error') failure = String(chunk.reason?.failure?.message ?? '模型返回错误')
        else if (kind === 'aborted') failure = '判定被中断（超时或主动取消）'
        // ⚠️ max-tokens：输出被截断 → JSON 必然不全，当失败。
        //    这不是保守，是必然：800 token 都装不下的输出本身就说明它没按契约写。
        else if (kind === 'max-tokens') failure = '输出被截断（max-tokens）'
      }
    }
    if (failure !== '') return { ok: false, result: null, why: failure }
    const parsed = extractJson(text)
    if (parsed === null) {
      return { ok: false, result: null, why: `输出不是合法 JSON（前 120 字：${text.slice(0, 120)}）` }
    }
    const result = validateJudgeResult(parsed)
    if (result === null) return { ok: false, result: null, why: 'JSON 形状不对（不是对象）' }
    return { ok: true, result, why: '' }
  }

  const previous = judgeChain
  let release
  judgeChain = new Promise((resolve) => { release = resolve })
  try {
    await previous.catch(() => {})
    return await run()
  } catch (error) {
    return { ok: false, result: null, why: `判定调用抛错：${error instanceof Error ? error.message : error}` }
  } finally {
    release()
  }
}

/**
 * 把判定结果渲染成发给主人的那段文本。
 *
 * 格式来自用户原话：`【群昵称】[群友]：「内容」` + 概述 + 时间 + 发起人。
 *
 * ⚠️ 这段文本**不冒充她说的话**，也不该带着「她」的口气 ——
 *    它是插件替主人盯着群的**系统汇报**。所以开头就是群名，没有寒暄。
 *
 * @param {object} point
 * @param {object} task
 * @param {object} result validateJudgeResult 的产物
 * @returns {string}
 */
export function renderInterestNotice(point, task, result) {
  const gname = String(task?.groupName ?? '').trim() || `群 ${String(task?.groupId ?? '')}`
  const keyUin = String(result?.keyMessage?.uin ?? '') || String(task?.triggerUin ?? '')
  const keyNick = String(result?.keyMessage?.nick ?? '').trim() || String(task?.triggerNick ?? '').trim() || '群友'
  // 触发者自己的 QQ 号不往外贴（主人也未必想知道），只在格式化里用昵称。
  // keyUin 不为空且没昵称时才有意义，这里仅用于「谁发起的」那一行。
  const keyText = String(result?.keyMessage?.text ?? '').trim() || String(task?.triggerText ?? '').trim()
  const at = Number(result?.keyMessage?.time ? Date.parse(result.keyMessage.time) : NaN)
  const when = Number.isFinite(at)
    ? new Date(at).toLocaleString('zh-CN', { hour12: false })
    : new Date(Number(task?.triggerAt) || Date.now()).toLocaleString('zh-CN', { hour12: false })

  const lines = []
  lines.push(`【${gname}】[${keyNick}]：「${keyText}」`)
  lines.push(`概述：${String(result?.summary ?? '').trim() || '（模型没给概述）'}`)
  lines.push(`时间：${when}（群 ${String(task?.groupId ?? '')}）`)
  lines.push(`关注点：${String(point?.label ?? '').trim() || String(point?.description ?? '').trim() || '（未命名）'}`)
  lines.push(`发起人：${keyNick}${keyUin === '' ? '' : `（${keyUin}）`}`)
  const related = Array.isArray(result?.related) ? result.related.filter((row) => String(row?.text ?? '').trim() !== '') : []
  if (related.length > 0) {
    lines.push(`其他人也在说：${related.slice(0, 3).map((row) => `${String(row.nick || '群友').trim()}：${String(row.text ?? '').trim()}`).join(' / ')}`)
  }
  return lines.join('\n')
}

/** 测试用：清空串行链（跨用例污染会让断言恒真）。 */
export function resetJudgeChain() {
  judgeChain = Promise.resolve()
}

export function reportJudgeFailure(point, task, why) {
  note('interest', `判定失败，按「不命中」处理 point=${String(point?.id ?? '')} group=${String(task?.groupId ?? '')}：${why}`)
}