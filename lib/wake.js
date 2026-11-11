/**
 * wake.js —— 群聊唤醒词（0.23.0）。
 *
 * ## 它是什么
 *
 * 群里提到某个词 = 有人叫她一声，效果等同于一次 @（但**不反向 @ 回触发者**）。
 * 词表**空 = 功能关闭**，这是默认状态。
 *
 * ## 为什么单独一个模块
 *
 * 判定逻辑全是纯函数：输入「一条消息的纯文字」+「词表」，输出「命中了哪个词」。
 * 没有 import、没有状态、没有 IO —— 于是它可以被 `tests/wake-sim.mjs` 直接测，
 * 不需要造配置、不需要隔离 HOME、不需要假装协议端在线。
 *
 * 这跟 `split.js`（分条）是同一个立场：**能做成纯函数的就别做成有状态的**。
 *
 * ## 三个容易踩的点（都是实测过的形状，别用「更正确的写法」改掉）
 *
 * ① **判据必须是纯文字段**。`textOf()` 会把 at 段渲染成 `@3566906627`，于是
 *    「@ 她 + 正文写大肥鱼」这条消息的文本里既有 at 又有唤醒词 ——
 *    计数、去重、提示词全都会错。所以本模块只接受调用方算好的**纯文字**
 *    （`commands.js` 的 `textSegmentsOf`），不自己解析段数组。
 *
 * ② **子串匹配，不做词边界**。中文没有可靠的词边界，而用户举的例子
 *    （「大肥鱼」）本身就希望被「大肥鱼好可爱」命中。代价是「肥鱼」也会命中
 *    「肥鱼腩」—— 接受：词写长一点就解决了，而这比「明明提到了却不回」便宜得多。
 *
 * ③ **单个字一律拒绝**。`鱼`、`你`、`好` 在任何群聊里都会误伤，等于把整个群
 *    变成 @ 她。护栏放在 `normalizeWakeWords` 里（保存时校验），
 *    而不是留到运行时再判 —— 用户得在点保存的那一刻就知道自己写错了。
 */

/** 词表上限。超过的按「写太多等于没写」处理 —— @ 她本来就比打字便宜。 */
export const WAKE_WORD_MAX = 20

/** 单词最短长度。1 = 几乎必然误伤，直接拒。 */
export const WAKE_WORD_MIN_LENGTH = 2

/** 节流窗口：同一群在这么长时间内最多被唤醒 `wakePerGroupHourly` 次。 */
export const WAKE_THROTTLE_WINDOW_MS = 60 * 60 * 1000

/**
 * 分隔符：中英文逗号、分号、顿号、换行。
 *
 * 为什么不加空格：英文唤醒词（`hey fish`）本身可能带空格，
 * 按空格切会把它切成两个没意义的词。中文用户习惯用逗号或顿号。
 */
const SEPARATORS = /[,，;；、\r\n]+/

/**
 * 把用户填的一坨（字符串或数组）整理成干净的词表。
 *
 * @param {string|string[]|null|undefined} input 设置页的多行文本，或已是数组
 * @returns {{ words: string[], rejected: Array<{word: string, why: string}> }}
 *   `words` 为空 = 功能关闭（不是错误）；`rejected` 非空时设置页要把原因回显给用户，
 *   **不能静默丢弃** —— 用户会以为自己保存成功了。
 */
export function normalizeWakeWords(input) {
  const words = []
  const rejected = []
  let raw = []
  if (Array.isArray(input)) {
    raw = input.map((item) => String(item ?? ''))
  } else if (typeof input === 'string') {
    raw = input.split(SEPARATORS)
  }
  for (const piece of raw) {
    const word = String(piece ?? '').trim()
    if (word === '') continue
    // 用「字符数」而不是 `length`：`'🐟'.length === 2` 会让一个 emoji 词
    // 绕过最短长度护栏。`Array.from` 按码点数，对中文和 emoji 都正确。
    const chars = Array.from(word).length
    if (chars < WAKE_WORD_MIN_LENGTH) {
      rejected.push({ word, why: `太短（${chars} 字）—— 单字唤醒词在任何群里都会误伤，至少两个字` })
      continue
    }
    if (chars > 32) {
      rejected.push({ word, why: `太长（${chars} 字）—— 唤醒词应当像「叫一声」，不要写成一句话` })
      continue
    }
    // 去重按小写比较（英文唤醒词不该区分大小写），但保留用户写的原样。
    if (words.some((existing) => existing.toLowerCase() === word.toLowerCase())) continue
    if (words.length >= WAKE_WORD_MAX) {
      rejected.push({ word, why: `超过 ${WAKE_WORD_MAX} 个上限 —— 词太多等于每个词都不生效` })
      continue
    }
    words.push(word)
  }
  return { words, rejected }
}

/**
 * 判断一条群消息的**纯文字**里有没有唤醒词。
 *
 * @param {string} text 纯文字段（`textSegmentsOf` 的结果），**不要**传 `textOf`
 * @param {string[]} words 已归一化的词表
 * @returns {string} 命中的词；没命中返回空串
 *
 * 多个词同时命中时返回**最长的那个**：提示词里要写「提到了你（「大肥鱼」）」，
 * 长词更具体，也更容易让模型理解「这是在叫她」。
 */
export function matchWakeWord(text, words) {
  const body = String(text ?? '')
  if (body === '') return ''
  const list = Array.isArray(words) ? words : []
  if (list.length === 0) return ''
  const haystack = body.toLowerCase()
  let best = ''
  for (const word of list) {
    const needle = String(word ?? '').trim().toLowerCase()
    if (needle === '') continue
    if (!haystack.includes(needle)) continue
    if (needle.length > best.length) best = String(word).trim()
  }
  return best
}

/**
 * 渲染唤醒提示（正文头部那一行）。
 *
 * 为什么写在消息正文里、而不做成 `prompt.js` 的常驻系统段落：
 * 常驻段落对**所有会话**生效、每轮都要烧 token；唤醒是一次性事件，
 * 只在被提到的那一条消息上出现才有意义。
 *
 * @param {string} template 模板，含 `{word}`；空串 = 不加这一行
 * @param {string} word 命中的唤醒词
 * @returns {string} 渲染结果；模板为空时返回空串
 */
export function renderWakeNote(template, word) {
  const tpl = String(template ?? '')
  if (tpl.trim() === '') return ''
  return tpl.replace(/\{word\}/g, String(word ?? '').trim())
}

// ---- 节流（唯一的有状态部分） ----

/**
 * groupId -> 最近一次唤醒的时间戳数组（升序，只留窗口内的）。
 *
 * ⚠️ 放内存，**不进 state**：`loadState()` 对 state 做白名单过滤，
 *   往 `state.windows` 里塞新键重启后会静默消失（见过这个坑）。
 *   重启后从 0 重新数，最坏结果是一次重启后多叫几声，不影响正确性。
 *   这与 `window.js` 的 `closeRefusals` 是同一个立场。
 */
const wakeHits = new Map()

/**
 * 判「这个群现在还能不能再被唤醒一次」，**不记账**。
 *
 * 为什么不记账就判：调用方要在确认「这条路真的会投递」（会话已绑定）之后
 * 才记账 —— 未绑定会话的群根本不该消耗额度。
 *
 * @param {string} groupId
 * @param {number} limit 一小时内上限；`0` 或负数 = 不限
 * @param {number} [now] 注入时间便于测试
 * @returns {{ allowed: boolean, used: number, limit: number }}
 */
export function wakeQuotaOf(groupId, limit, now = Date.now()) {
  const key = String(groupId ?? '').trim()
  const cap = Number(limit)
  const limitAllowed = Number.isFinite(cap) && cap > 0
  if (!limitAllowed) return { allowed: true, used: 0, limit: 0 }
  const list = (wakeHits.get(key) ?? []).filter((at) => now - at < WAKE_THROTTLE_WINDOW_MS)
  if (list.length !== (wakeHits.get(key) ?? []).length) wakeHits.set(key, list)
  return { allowed: list.length < cap, used: list.length, limit: cap }
}

/**
 * 记一次唤醒已投递（或即将投递）。
 *
 * ⚠️ **在投递前记账，失败不退**。理由与 @ 的额度退款相反：
 *   唤醒的触发源是一条真实存在的群消息，轮询/WS 已经用 seq 去过重，
 *   **不会重复处理同一条**。所以不存在「重试导致重复扣」的问题；
 *   反过来，如果投递失败就退额度，协议端短时故障期攒下的一堆唤醒
 *   会在恢复瞬间全部放行 —— 那正是节流要防的场面。
 *
 * @param {string} groupId
 * @param {number} [now]
 */
export function noteWakeUsed(groupId, now = Date.now()) {
  const key = String(groupId ?? '').trim()
  if (key === '') return
  const list = (wakeHits.get(key) ?? []).filter((at) => now - at < WAKE_THROTTLE_WINDOW_MS)
  list.push(now)
  wakeHits.set(key, list)
}

/** 测试用：清空节流记录（跨用例污染会让断言恒真，见维护索引 §4 坑 30）。 */
export function resetWakeThrottle() {
  wakeHits.clear()
}