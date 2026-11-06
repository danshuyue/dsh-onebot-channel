/**
 * 把一条回复切成「多条消息」，让 QQ 那头看起来像真人在打字。
 *
 * 纯函数、零依赖：只做切分，不做发送，方便单测（tests/assert.mjs）。
 *
 * 两种模式（0.10.0 起 `splitMode`）：
 *
 *   paragraph（默认）—— **换行才是一条的分界**，句号不算。
 *     为什么改：模型写的是「一段完整回复」，句号只是句子内部的标点；
 *     按句号切会把一段连贯的话剁成五六条弹出来，像刷屏，也不是她的本意。
 *     现在她说几条由她自己决定：写三行就是三条，写一整段就是一条。
 *
 *   sentence —— 老行为：每个句末标点后断开（。！？!?…），像真人一句一句打出来。
 *     想回老手感就在设置页切回去。
 *
 * 两种模式共用的保护：
 *   · 换行断条（两种模式都认）
 *   · 单段太长时在逗号/顿号/空格处再切（`maxChars`）
 *   · 段数超过上限时把最短的相邻两段合并（`maxParts`）
 */

const HARD_END = new Set(['。', '！', '？', '!', '?', '…'])
const SOFT_END = new Set(['，', '、', ',', '；', ';', '：', ':'])
const TRAILERS = new Set(['"', '”', '’', '）', ')', '」', '』', '】', '》', ']', '～', '~'])

/** 拼接两段：中文直接接，英文之间补一个空格。 */
function joinText(left, right) {
  const a = left.trimEnd()
  const b = right.trimStart()
  if (a === '') return b
  if (b === '') return a
  const needSpace = /[A-Za-z0-9!?.:;,'"]$/.test(a) && /^[A-Za-z0-9]/.test(b)
  return needSpace ? `${a} ${b}` : `${a}${b}`
}

/**
 * 非负整数容错（**允许 0**）。
 *
 * ⚠️ 为什么不能用 `toPositiveInt`：那个函数把 0 当成「没填」并回落到默认值 ——
 *    于是 `fixedMs: 0` 会变成 800ms，而设置页明明写着「填 0 = 立刻发」。
 *    这类「界面上承诺了、实现里做不到」的偏差最难发现，因为它不报错。
 *    这里用 `undefined` / `null` / 空串 / 非数字 才算「没填」。
 */
function toNonNegativeInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const n = Math.trunc(Number(value))
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function toPositiveInt(value, fallback) {
  const n = Math.trunc(Number(value))
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** 按句末标点 + 换行切成原始片段（标点保留在片段末尾）。paragraph 模式下只认换行。 */
function rawSegments(text, mode) {
  const splitBySentence = mode !== 'paragraph'
  const segments = []
  let buffer = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    buffer += ch
    if (ch === '\n') {
      segments.push(buffer)
      buffer = ''
      continue
    }
    if (splitBySentence && HARD_END.has(ch)) {
      // 吃掉连续标点（"？！" "……"）和收尾引号
      while (i + 1 < text.length && (HARD_END.has(text[i + 1]) || SOFT_END.has(text[i + 1]))) {
        i += 1
        buffer += text[i]
      }
      while (i + 1 < text.length && TRAILERS.has(text[i + 1]) && text[i + 1] !== ' ') {
        i += 1
        buffer += text[i]
      }
      segments.push(buffer)
      buffer = ''
    }
  }
  if (buffer !== '') segments.push(buffer)
  return segments.map((s) => s.trim()).filter((s) => s !== '')
}

/** 整段只有标点/空白（比如单独一行的「。」）—— 这种碎片不该单独成条。 */
function isPunctOnly(text) {
  return /^[\s。，、！？!?…~～·.,;:：；\-—_*"'“”‘’]+$/.test(text)
}

/** 超过上限的一段，尽量在逗号/空格处再切。 */
function enforceLength(segment, maxChars) {
  if (segment.length <= maxChars) return [segment]
  const out = []
  let rest = segment
  while (rest.length > maxChars) {
    let cut = -1
    for (let i = Math.min(rest.length - 1, maxChars); i >= Math.max(1, Math.floor(maxChars * 0.5)); i -= 1) {
      if (SOFT_END.has(rest[i]) || rest[i] === ' ' || rest[i] === '\n') {
        cut = i + 1
        break
      }
    }
    if (cut === -1) cut = maxChars
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest !== '') out.push(rest)
  return out.filter((s) => s !== '')
}

/**
 * @param {string} text 完整回复
 * @param {{ mode?: 'paragraph'|'sentence', maxChars?: number, minChars?: number, maxParts?: number }} [options]
 * @returns {string[]} 逐条要发的消息，至少 1 条
 */
export function splitMessage(text, options = {}) {
  const source = typeof text === 'string' ? text : String(text ?? '')
  const mode = options.mode === 'sentence' ? 'sentence' : 'paragraph'
  const maxChars = toPositiveInt(options.maxChars, 120)
  const minChars = toPositiveInt(options.minChars, 4)
  const maxParts = toPositiveInt(options.maxParts, 8)

  const trimmed = source.replace(/\r\n/g, '\n').trim()
  if (trimmed === '') return []

  let parts = []
  for (const segment of rawSegments(trimmed, mode)) parts.push(...enforceLength(segment, maxChars))

  // 太短的碎片并进相邻段（优先并进前一段）。
  // paragraph 模式不按字数合并 —— 换行是她自己划的分条线，「嗯」单独一行就是想单独发；
  // 只把「纯标点」这种明显的手滑碎片并进去。
  const merged = []
  for (const part of parts) {
    const tooShort = mode === 'paragraph' ? isPunctOnly(part) : part.length < minChars
    if (merged.length > 0 && tooShort) {
      merged[merged.length - 1] = joinText(merged[merged.length - 1], part)
    } else {
      merged.push(part)
    }
  }
  if (merged.length > 1 && (mode === 'paragraph' ? isPunctOnly(merged[0]) : merged[0].length < minChars)) {
    merged[1] = joinText(merged[0], merged[1])
    merged.shift()
  }
  parts = merged.length > 0 ? merged : [trimmed]

  // 段数超上限：反复合并「最短的相邻两段」，尽量保持长度均衡
  while (parts.length > maxParts) {
    let bestIndex = 0
    let bestCost = Infinity
    for (let i = 0; i < parts.length - 1; i += 1) {
      const cost = parts[i].length + parts[i + 1].length
      if (cost < bestCost) {
        bestCost = cost
        bestIndex = i
      }
    }
    parts.splice(bestIndex, 2, joinText(parts[bestIndex], parts[bestIndex + 1]))
  }

  // maxParts === 1 = 「强制只发一条」。上面的 while 循环理论上能收敛到 1，
  // 但那是「反复合并最短相邻两段」的副作用，不是一条明确承诺 ——
  // 一旦以后有人改合并策略（比如加个「太长的段不再合并」的保护），
  // 「填 1 就只发一条」会静默失效，而用户是从设置页上读到这个承诺的。
  // 所以这里用 `trimmed`（已归一化换行并 trim 的原串）直接短路，不依赖循环收敛。
  // 不用 parts.join()：那会把段落之间的换行吃成空串，丢掉原文的换行。
  if (maxParts === 1) return [trimmed]

  return parts.filter((s) => s !== '')
}

/**
 * 每条消息之间的停顿。
 *
 * ## 两种模式（2026-11-07 用户要求「固定间隔 / 按字数乘积」二选一）
 *
 *   `fixed`    固定间隔：每条之间等这么久（加 ±jitter 的抖动，免得像机器）
 *   `perChar`  按字数算：`字数 × perCharMs`，长段落等得久、短句立刻跟上
 *
 * ## 为什么不是三个独立旋钮
 *
 * 原来只有一个函数，把 `min`、`max`、`perChar` 三样混在一起算：
 *
 *     base = min + min(max - min, 字数 × 12)
 *
 * 后果是**两种模式都表达不清楚**：
 *   · 想「固定 1500ms」的人只能同时改 min 和 max，还得知道 min 不能超过 max；
 *   · `max` 会把按字数的增长**截断** —— 实测 40 字就封顶在 700ms，
 *     再长的段落也不会等更久，于是「按字数」这个意图在长回复上直接失效。
 *
 * 所以拆成一个模式 + 一个数值。默认仍是 `fixed 800ms`：
 * 用户反馈的真实问题是「连着发、太急」，而 800ms 是对这个症状最直接的解；
 * 按字数模式留给他想「长段落慢一点」时再切。
 *
 * @param {string} part 这一条的内容（`perChar` 模式要用它算字数）
 * @param {{mode?:'fixed'|'perChar', fixedMs?:number, perCharMs?:number, jitter?:number, maxMs?:number}} options
 *   `maxMs` 是**调用方**给的上限（0 / 不传 = 不封顶）。它和旧的 `maxDelayMs` 不同：
 *   旧的 max 参与计量（把按字数的增长截断），这个只是最终取值的天花板。
 * @returns {number} 毫秒
 */
export function partDelayMs(part, options = {}) {
  const mode = options.mode === 'perChar' ? 'perChar' : 'fixed'
  const jitter = clampNumber(options.jitter, 0, 0.5, 0.15)

  let base
  if (mode === 'perChar') {
    const perChar = toPositiveInt(options.perCharMs, 120)
    // ⚠️ 这里**不封顶**：上限交由调用方给（见 maxMs）。
    //    自己封顶会把「按字数」变成「按字数、但超过 N 字就不算数」——
    //    旧实现就是这么把 40 字以后的增长吃掉、并在用户眼里变成「连发」的。
    base = String(part ?? '').length * perChar
  } else {
    // ⚠️ 用 toNonNegativeInt 而不是 toPositiveInt：设置页写着「填 0 = 立刻发」，
    //    而 toPositiveInt 会把 0 当没填、回落成默认 800 —— 承诺就成了空话。
    base = toNonNegativeInt(options.fixedMs, 800)
  }

  // 抖动：±jitter 比例的随机偏移。固定间隔不加抖动的话，
  // 一串等间隔的消息看起来比连发还像机器人。
  const spread = base * jitter
  const value = base + (Math.random() * 2 - 1) * spread

  // 上限：0 / 负数 / 非数字 = 不封顶。
  //
  // ⚠️ 这里**不能**先 clamp 再判 0 —— `clampNumber(0, 1, MAX, 0)` 会先把 0 抬到 1，
  //    于是「0 = 不封顶」变成「上限 1ms」，间隔直接归零。
  //    实测踩到：端到端验证时间隔只有 14ms，而配置写的是 perChar 100ms/字。
  //    所以先判断「有没有填一个正数」，再决定要不要压。
  const rawCap = Number(options.maxMs)
  const hasCap = Number.isFinite(rawCap) && rawCap > 0
  return Math.max(0, Math.round(hasCap ? Math.min(rawCap, value) : value))
}

/** 数值容错：认不出来 / 越界就用默认值（配置可能被手改坏）。 */
function clampNumber(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
