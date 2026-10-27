/**
 * 把一条回复切成「多条短消息」，让 QQ 那头看起来像真人一句一句打出来的。
 *
 * 纯函数、零依赖：只做切分，不做发送，方便单测（tests/split.test.mjs）。
 *
 * 切分规则
 *   1. 在句末标点后断开：。！？!?…（含连续标点、以及紧跟的引号/括号）
 *   2. 换行也断开（列表、分段）
 *   3. 太短的碎片并进前一段，避免「嗯。」单独成条
 *   4. 单段太长时优先在逗号/顿号/空格处再切
 *   5. 段数超过上限时，把最短的相邻两段合并，直到不超过上限
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

/** 按句末标点 + 换行切成原始片段（标点保留在片段末尾）。 */
function rawSegments(text) {
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
    if (HARD_END.has(ch)) {
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
 * @param {{ maxChars?: number, minChars?: number, maxParts?: number }} [options]
 * @returns {string[]} 逐条要发的消息，至少 1 条
 */
export function splitMessage(text, options = {}) {
  const source = typeof text === 'string' ? text : String(text ?? '')
  const maxChars = toPositiveInt(options.maxChars, 120)
  const minChars = toPositiveInt(options.minChars, 4)
  const maxParts = toPositiveInt(options.maxParts, 8)

  const trimmed = source.replace(/\r\n/g, '\n').trim()
  if (trimmed === '') return []

  let parts = []
  for (const segment of rawSegments(trimmed)) parts.push(...enforceLength(segment, maxChars))

  // 太短的碎片并进相邻段（优先并进前一段）
  const merged = []
  for (const part of parts) {
    if (merged.length > 0 && part.length < minChars) {
      merged[merged.length - 1] = joinText(merged[merged.length - 1], part)
    } else {
      merged.push(part)
    }
  }
  if (merged.length > 1 && merged[0].length < minChars) {
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
