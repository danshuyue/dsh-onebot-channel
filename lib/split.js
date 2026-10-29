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

  return parts.filter((s) => s !== '')
}

/** 每条之间的停顿：按字数给一点差异，避免机械等间隔。 */
export function partDelayMs(part, options = {}) {
  const min = toPositiveInt(options.minDelayMs, 200)
  const max = toPositiveInt(options.maxDelayMs, 700)
  const perChar = Number(options.perCharMs ?? 12)
  const base = min + Math.min(max - min, part.length * perChar)
  const jitter = Math.random() * Math.max(0, max - base)
  return Math.round(Math.min(max, base + jitter * 0.6))
}
