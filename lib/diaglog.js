/**
 * diaglog.js —— 诊断用的「对话流水」环形记录（2026-11-09，0.21.0）。
 *
 * ## 为什么要有它（用户原话）
 *
 * 「这个诊断不太清楚。我觉得应该带上具体的聊天记录和这段时间的会话的思考过程
 *   工具调用等详细信息。这个更方便你诊断。」
 *
 * 旧诊断包（`/diag-export`）只有七节：runtime / summary / config / state /
 * outbound / log / dshLog。它能回答「插件往谁那儿发了几条」，
 * 但回答不了最关键的那问 —— **「她当时看到了什么」**。
 * 而 2026-11-09 那次「群聊不连贯」，根因恰恰就在投递正文里：
 * 上下文没有时间戳、没有她自己、接话根本没进队列。
 * 光看插件日志（`skip (no at/window) seq=7441`）永远看不出这些。
 *
 * ## 记什么、不记什么
 *
 * 记（用户勾选的四项）：
 *   1. 投给模型的**正文原文**（她实际读到的那段）
 *   2. 聊天流水（含她自己发的原始 QQ 消息）
 *   3. 工具调用：名字 + 参数摘要 + 返回摘要
 *   4. 每回合的模型输出（她的正文/思考摘要）
 *
 * 不记：token、凭据、QQ 号以外的个人信息 —— 都不进这个文件。
 *
 * ## 关键约束（都是踩过的）
 *
 * 1. **内存环形缓冲，不落盘**。诊断包是「出事了现场取证」，
 *    不是长期日志。落盘会带来：写坏数据、磁盘涨、以及「忘了脱敏就一直在盘上」。
 *    进程重启丢历史是可接受的 —— 重启本身就是一次现场重置。
 * 2. **绝不让记录失败影响主链路**。所有写入都包在 try/catch 里，
 *    任何异常一律吞掉 + 记一条 note。`deliver` 是消息投递主链路，
 *    为了诊断日志把消息投递搞挂，是本末倒置。
 * 3. **容量硬限制**。每条正文截断到 2000 字（用户要的「最近 1~2 小时」自然满足，
 *    因为环形缓冲只留最近 200 条），事件留 400 条。
 *    不截断的话，一个带 20 条上下文 + 图片的消息能到几十 KB，
 *    200 条就是几 MB —— 诊断包发给人都发不出去。
 */
// ⚠️ **不 import env.js**（2026-11-09）。
//   env.js 反过来要 import 本模块的 recordTool 来包装 tools.register，
//   两边互引会形成循环：ESM 能加载，但模块求值顺序不可靠 ——
//   `note` 可能在 diaglog 求值完成前就被调用，抛 TDZ 错误。
//   本模块只需要「记一条失败日志」，用 console 兜底足够（而且它自己就是最后一道防线，
//   写不进诊断流水时不该再依赖任何上层能力）。
//   见 docs/踩坑记录.md「循环依赖」一节。

import { randomUUID } from 'node:crypto'

/** 兜底日志：诊断记录失败时用，绝不抛。 */
function warnDiag(message) {
  try {
    // 和生产日志同样的格式前缀，方便一起 grep
    console.error(`[diag] ${message}`)
  } catch {
    /* 连 console 都不可用就算了 */
  }
}

/** 投递正文最多留多少条（环形）。 */
const MAX_BODIES = 200
/** 正文单条截断长度（字符）。 */
const MAX_BODY_CHARS = 2000
/** 工具事件最多留多少条。 */
const MAX_TOOLS = 400
/** 工具参数/返回摘要的单条截断长度。 */
const MAX_SNIPPET_CHARS = 500

/** 投给模型的正文记录。 */
const bodies = []
/** 工具调用记录。 */
const tools = []

/** 截断并按需加省略号（保留头尾 —— 报错常常在尾巴上）。 */
function clip(value, limit) {
  const text = String(value ?? '')
  if (text.length <= limit) return text
  const head = Math.floor(limit * 0.65)
  const tail = limit - head - 1
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`
}

/**
 * 记一条「投给模型的正文」。
 *
 * @param {object} entry
 * @param {string} entry.sessionId 投到哪个会话
 * @param {string} entry.kind      'group' | 'private'
 * @param {string} entry.targetId  群号 / QQ 号
 * @param {string} entry.body      正文原文（会截断）
 * @param {number} [entry.images]  附了几张图（不存图片本身）
 * @param {string} [entry.mode]    投递方式：'followup' | 'steer'
 * @param {number} [entry.at]      时刻（毫秒），缺省 now
 */
export function recordBody(entry) {
  try {
    const payload = entry ?? {}
    bodies.push({
      at: Number(payload.at) || Date.now(),
      sessionId: String(payload.sessionId ?? ''),
      kind: String(payload.kind ?? ''),
      targetId: String(payload.targetId ?? ''),
      mode: String(payload.mode ?? ''),
      images: Math.max(0, Number(payload.images) || 0),
      chars: String(payload.body ?? '').length,
      body: clip(payload.body, MAX_BODY_CHARS)
    })
    while (bodies.length > MAX_BODIES) bodies.shift()
  } catch (error) {
    // 诊断记录失败绝不能影响投递
    warnDiag(`recordBody 失败：${error instanceof Error ? error.message : error}`)
  }
}

/**
 * 记一条工具调用。
 *
 * @param {object} entry
 * @param {string} entry.tool  工具名
 * @param {any}    [entry.args] 参数（只留摘要）
 * @param {any}    [entry.result] 返回（只留摘要）
 * @param {boolean} [entry.isError] 仅表示工具抛异常，ok:false 属于业务失败
 * @param {string} [entry.callId] 每次真实调用的唯一 ID（不可按参数/时间去重）
 * @param {number} [entry.startedAt] 调用开始时刻（毫秒）
 * @param {string} [entry.sessionId] 已知的发起会话
 * @param {boolean} [entry.ok] 工具明确提供的业务结果
 * @param {number} [entry.durationMs]
 */
export function recordTool(entry) {
  try {
    const payload = entry ?? {}
    const json = (value) => {
      try {
        return typeof value === 'string' ? value : JSON.stringify(value)
      } catch {
        return String(value)
      }
    }
    const at = Number(payload.at) || Date.now()
    const durationMs = Math.max(0, Number(payload.durationMs) || 0)
    const isError = payload.isError === true
    let ok = null
    try {
      const given = payload.ok ?? payload.result?.ok
      if (typeof given === 'boolean') ok = given
    } catch { /* 业务对象的 getter 可能抛错，诊断不依赖它 */ }
    if (isError) ok = false
    tools.push({
      at,
      callId: String(payload.callId || randomUUID()),
      startedAt: Number.isFinite(payload.startedAt) ? payload.startedAt : at - durationMs,
      sessionId: String(payload.sessionId ?? ''),
      tool: String(payload.tool ?? ''),
      isError,
      ok,
      outcome: isError ? 'error' : ok === false ? 'failure' : 'success',
      durationMs,
      args: clip(json(payload.args), MAX_SNIPPET_CHARS),
      result: clip(json(payload.result), MAX_SNIPPET_CHARS)
    })
    while (tools.length > MAX_TOOLS) tools.shift()
  } catch (error) {
    warnDiag(`recordTool 失败：${error instanceof Error ? error.message : error}`)
  }
}

/**
 * 导出这一节（给 `/diag-export` 用）。
 *
 * @param {number} [windowMs] 只取最近这么久，默认 2 小时（用户选的「最近 1~2 小时」）
 * @returns {{note:string, windowMs:number, bodies:object[], tools:object[]}}
 */
export function exportDiagLog(windowMs = 2 * 60 * 60 * 1000) {
  const span = Math.max(60_000, Number(windowMs) || 2 * 60 * 60 * 1000)
  const since = Date.now() - span
  const within = (item) => Number(item?.at ?? 0) >= since
  return {
    // 口径写明：看的人要知道「没有 = 这段时间没投过 / 进程重启过」
    note: '投给模型的正文原文 + 工具调用（内存环形缓冲，进程重启即清空，最多保留最近 2 小时）',
    windowMs: span,
    bodies: bodies.filter(within),
    tools: tools.filter(within)
  }
}

/** 清空（测试用；生产不需要）。 */
export function resetDiagLog() {
  bodies.length = 0
  tools.length = 0
}
