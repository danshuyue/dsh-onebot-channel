/**
 * forward.js —— 合并转发（「群聊的聊天记录」卡片）的展开与渲染。
 *
 * 为什么单独一个模块：
 *   一张卡片展开**要发网络请求**（get_forward_msg），而 textOf() 是纯同步函数，
 *   被 poll.js 的正文拼接、群历史上下文、qq_msg_history 工具到处调用。
 *   把「取数据」塞进 textOf() 会把它变成 async，十几个调用点全得改，
 *   而且任何一处漏 await 就静默拿到 [object Promise]。
 *   所以拆成两步：
 *     · fetchForwardMessages()  同步不了的活，先做，拿到展开结果
 *     · renderForward()         纯函数，把展开结果渲染成文本
 *   调用方（poll.js / tool.js）负责用 prefetchForwards() 预取，再交给 textOf 的
 *   扩展版本渲染。没预取到的地方退化成「[转发消息 · N 条]」占位，行为与旧版一致。
 *
 * 协议事实（2026-11-02 真机实测 SnowLuma 2.2.1）：
 *
 *   群历史里，一条合并转发就是**单个 forward 段**，不带 at：
 *     [{"type":"forward","data":{"id":"JzBzMIYHiNYZDIYdDQ6lwo9..."}}]
 *
 *   get_forward_msg 的返回（retcode 0）：
 *     { data: { messages: [ ...95 条... ] } }
 *   每一条都**和普通群消息同构** —— sender.nickname / time / message 段数组齐全：
 *     { sender: { user_id, nickname, card }, time, message: [{type:'text',data:{text}}] }
 *   所以渲染逻辑可以直接复用 textOf()，图片段也带真实 url 可以走 images.js。
 *
 *   ⚠️ 展开结果里**还有可能嵌 forward 段**（实测 95 条里嵌了 8 条）。
 *   默认只展开一层，嵌套层按占位渲染 —— 递归展开会让上下文和网络请求双双失控。
 */
import { callOneBot, segmentToText } from './onebot.js'
import { getConfig } from './config.js'
import { note } from './env.js'

/** 配置里还没加这些键时的兜底（config.js 的 DEFAULTS 是真相源，这里只是防御）。 */
const FALLBACK = {
  forwardExpandEnabled: true,
  forwardMaxDepth: 2,
  forwardMaxMessages: 50,
  forwardMaxChars: 2000,
  forwardImagesEnabled: false,
  forwardImageLimit: 6,
  forwardTimeoutMs: 4000,
  forwardConcurrency: 3,
  /** 一次投递里最多发几个展开请求（防止 depth 很大时请求数失控拖停投递链）。 */
  forwardMaxRequests: 16,
  /** 一次投递里展开最多花多久（毫秒），超了就按占位收摊。 */
  forwardBudgetMs: 6000
}

function cfgOf() {
  const config = getConfig() ?? {}
  const pick = (key) => {
    const value = config[key]
    return value === undefined || value === null ? FALLBACK[key] : value
  }
  return {
    enabled: pick('forwardExpandEnabled') !== false,
    // 不设硬上限（2026-11-02 用户决定）：这是可配置项，成本由配置的人自己承担。
    // 但仍有下限保护：0 = 不展开。负数/NaN 归一成默认 2。
    // ⚠️ 递归本身有「同 id 只请求一次」的去重，所以再深的嵌套也不会指数爆炸；
    //   真正花钱的是网络请求数和展开出来的字数 —— 那两项各自有上限。
    maxDepth: Number.isFinite(Number(pick('forwardMaxDepth')))
      ? Math.max(0, Math.floor(Number(pick('forwardMaxDepth'))))
      : 2,
    maxMessages: Math.max(1, Math.min(200, Number(pick('forwardMaxMessages')) || 50)),
    // 下限只到 20：这是一个「允许用户设小」的值。
    // 之前写成 Math.max(200, …)，结果设置页填 40 会被静默抬到 200 —— 配置看起来生效了其实没有。
    maxChars: Math.max(20, Math.min(20000, Number(pick('forwardMaxChars')) || 2000)),
    images: pick('forwardImagesEnabled') === true,
    imageLimit: Math.max(0, Math.min(30, Number(pick('forwardImageLimit')) || 6)),
    timeoutMs: Math.max(1000, Math.min(15000, Number(pick('forwardTimeoutMs')) || 4000)),
    concurrency: Math.max(1, Math.min(8, Number(pick('forwardConcurrency')) || 3)),
    // 预算：0 = 不限（但默认给一个常数上界，理由见 prefetchInto 里的注释）
    maxRequestsPerMessage: Number.isFinite(Number(pick('forwardMaxRequests')))
      ? Math.max(1, Math.floor(Number(pick('forwardMaxRequests'))))
      : 16,
    budgetMs: Number.isFinite(Number(pick('forwardBudgetMs')))
      ? Math.max(1000, Math.floor(Number(pick('forwardBudgetMs'))))
      : 6000
  }
}

/** 消息里所有 forward 段的 id（去重、保序）。 */
export function forwardIdsOf(message) {
  if (!Array.isArray(message)) return []
  const out = []
  for (const segment of message) {
    if (segment?.type !== 'forward') continue
    const id = String(segment?.data?.id ?? '').trim()
    if (id !== '' && !out.includes(id)) out.push(id)
  }
  return out
}

/**
 * 一个 forward id 的展开结果缓存。
 *
 * 为什么必须缓存：同一条「聊天记录卡片」会被同一条消息的多个消费方重复要——
 * 正文、群上下文、图片收集各来一次就是三次网络请求。
 * 卡片内容是不可变的历史，缓存到进程结束没问题；用上限防止无限涨。
 */
const CACHE = new Map()
const CACHE_LIMIT = 64

function cacheGet(id) {
  const hit = CACHE.get(id)
  if (hit === undefined) return undefined
  // LRU：命中即刷新位置
  CACHE.delete(id)
  CACHE.set(id, hit)
  return hit
}

function cacheSet(id, value) {
  CACHE.set(id, value)
  while (CACHE.size > CACHE_LIMIT) {
    const oldest = CACHE.keys().next().value
    if (oldest === undefined) break
    CACHE.delete(oldest)
  }
}

/** 测试用：清缓存。 */
export function clearForwardCache() {
  CACHE.clear()
}

/**
 * 展开一个 forward id。
 *
 * @returns {Promise<{ok:true, messages:any[]} | {ok:false, error:string}>}
 *   失败**不抛**：卡片读不到是常事（过期、无权限、协议端不支持），
 *   抛出去会把整条消息的投递打断，代价远大于「这张卡片没展开」。
 */
export async function fetchForward(id, config = cfgOf()) {
  const key = String(id ?? '').trim()
  if (key === '') return { ok: false, error: 'empty-id' }
  const cached = cacheGet(key)
  if (cached !== undefined) return cached

  let result
  try {
    const response = await callOneBot({
      action: 'get_forward_msg',
      params: { id: key },
      // 单张卡片不能拖着整条投递链一起卡：入站投递是串行的。
      timeoutMs: config.timeoutMs
    })
    if (response?.retcode !== 0) {
      result = { ok: false, error: `retcode=${response?.retcode ?? '?'} ${response?.wording ?? response?.message ?? ''}`.trim() }
    } else {
      const data = response?.data
      // 实测是 { messages: [...] }；别的实现可能直接给数组，两种都认。
      const list = Array.isArray(data) ? data : (Array.isArray(data?.messages) ? data.messages : null)
      result = list === null
        ? { ok: false, error: '展开结果里没有 messages 数组' }
        : { ok: true, messages: list }
    }
  } catch (error) {
    result = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  // 失败也缓存？不。失败可能是临时的（协议端刚重启），下次也许能拿到；
  // 而且失败缓存会让「重试」变得不可能。只在成功时缓存。
  if (result.ok) cacheSet(key, result)
  return result
}

/**
 * 预取一条消息里所有 forward 段的展开结果（含嵌套层）。
 *
 * 返回 Map<id, 展开结果>，交给 renderForward 用。
 * 开关关着、或消息里根本没有卡片时**立刻返回空 Map**，零开销。
 *
 * ⚠️ 必须递归：depth=2 时，内层卡片的 id 只有**展开外层之后**才知道，
 *   不在这里继续钻，渲染时就查不到内层缓存，嵌套永远是占位。
 *   深度受 forwardMaxDepth 约束，且每层 id 去重之后才请求 —— 不会无限膨胀。
 *
 * @param {any} message OneBot 段数组
 * @param {{depth?:number}} [options]
 * @returns {Promise<Map<string, {ok:boolean, messages?:any[], error?:string}>>}
 */
export async function prefetchForwards(message, options = {}) {
  const config = cfgOf()
  const out = new Map()
  if (!config.enabled) return out
  const startDepth = Math.max(0, Number(options.depth) || 0)
  // ⚠️ 整段包 try/catch：这里是「装饰性」动作（把卡片读成文字），
  //   绝不能因为它把一条**已经进来的 @ 消息**弄丢。
  //   踩过的路径：prefetchForwards 抛错 → 冒到 handleGroupMessage 之外
  //   → 被 pollGroup 的 catch 吞掉，而游标在那之前**已经前进并落盘**
  //   → 这条消息既没投递、也不会再被捞回来，永久丢失。
  //   畸形数据能触发（实测：展开结果里 message 是 getter 抛错）。
  //   所以失败一律降级成「这张卡片没展开」，不向上抛。
  const budget = {
    left: Math.max(0, Number(config.maxRequestsPerMessage) || 0),
    deadline: Date.now() + Math.max(0, Number(config.budgetMs) || 0)
  }
  if (budget.left === 0 && budget.deadline <= Date.now()) return out
  try {
    await prefetchInto(out, message, startDepth, config, budget)
  } catch (error) {
    note('forward', `展开中断（已取到 ${out.size} 张，其余按占位）：${error instanceof Error ? error.message : error}`)
  }
  return out
}

/**
 * 递归预取的实现。已经放进 out 的 id 不再请求（跨层去重）。
 * @param {Map} out 累积结果
 * @param {any} message 段数组
 * @param {number} depth 当前层（0 = 最外层消息本身）
 * @param {object} config 生效配置
 */
async function prefetchInto(out, message, depth, config, budget) {
  if (depth >= config.maxDepth) return
  const ids = forwardIdsOf(message).filter((id) => !out.has(id))
  if (ids.length === 0) return

  // 并发上限（不是总数上限）—— 2026-11-02 审核发现并修正。
  // 旧写法 `ids.slice(0, concurrency)` 把「并发数」当成了「最多展开几张卡片」：
  //   一条消息里 5 张卡片、concurrency=3 时，第 4、5 张**永远不会被展开**，
  //   而且只在正文里留个占位，用户完全不知道为什么。
  // 现在按 concurrency 分批：每批同时发 N 个请求，批与批之间串行，所有卡片都会取到。
  for (let i = 0; i < ids.length; i += config.concurrency) {
    // ---- 预算闸（2026-11-02 审核后加）----
    // 为什么必须有：抓取**完全不受** forwardMaxChars / forwardMaxMessages 约束
    // （那两个只截渲染）。depth 又不设上限（用户要求，成本自己承担）。
    // 于是 maxDepth 填很大时，一张卡片嵌 N 条、N 条各嵌 N 条……请求数成倍增长，
    // 每条最坏 forwardTimeoutMs，而这段跑在**串行投递链**上（poll.js 逐条 await）。
    // 结果不是「慢一点」，是整条投递停摆、群轮询间隔被拉长到看不见。
    // 预算把「一次投递的总花费」变成常数上界，同时**保留**用户调大 depth 的自由。
    //
    // ⚠️ 判的是「这一批会不会超出剩余预算」，批内再按剩余额度切一次 ——
    //   否则一批 concurrency=2、只剩 1 次额度时会发出 2 个请求，上限形同虚设。
    const left = Math.max(0, Math.floor(budget.left))
    const overBudget = left === 0 || Date.now() > budget.deadline
    if (overBudget) {
      // 明说而不是静默：剩下的卡片渲染时是占位，日志里得能查到原因
      if (out.size > 0 && !budget.noted) {
        budget.noted = true
        note('forward', `展开预算用尽（已取 ${out.size} 张），其余卡片按占位渲染`)
      }
      return
    }
    const batch = ids.slice(i, i + Math.min(config.concurrency, left))
    budget.left -= batch.length

    // 先占位，防止同一 id 在递归里被重复请求（A→B→A 这种环）
    for (const id of batch) out.set(id, { ok: false, error: 'pending' })
    const results = await Promise.all(batch.map((id) => fetchForward(id, config)))
    for (let j = 0; j < batch.length; j += 1) out.set(batch[j], results[j])

    // 继续往里钻：只对**取成功**的卡片递归，失败的没有内容可钻
    for (let j = 0; j < batch.length; j += 1) {
      const result = results[j]
      if (result?.ok !== true) continue
      for (const item of result.messages) {
        if (!hasForward(item?.message)) continue
        await prefetchInto(out, item.message, depth + 1, config, budget)
      }
    }
  }
}

/** 渲染一行「谁说了什么」—— 和 poll.js 里群上下文的写法保持一致，模型好读。 */
function lineOf(item, depth, config, indent, forwards) {
  const sender = String(item?.sender?.nickname ?? item?.sender?.card ?? item?.sender?.user_id ?? '').trim()
  const who = sender === '' ? '某人' : sender
  const seconds = Number(item?.time) || 0
  let stamp = ''
  if (seconds > 0) {
    const at = new Date(seconds * 1000)
    const pad = (n) => String(n).padStart(2, '0')
    stamp = `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())} `
  }
  // ⚠️ item.message 可能不是普通属性（畸形数据可以拿 getter 抛错，实测过）。
  //   渲染是**纯装饰**动作，绝不能因为一条坏数据让整条投递炸掉 ——
  //   吞掉之后这一行退化成「（内容读取失败）」，其余照常。
  let body = ''
  try {
    body = renderSegments(item?.message, depth + 1, config, indent, forwards)
  } catch (error) {
    body = `（内容读取失败：${error instanceof Error ? error.message : error}）`
  }
  return `${indent}${stamp}${who}: ${body}`
}

/**
 * 段数组 → 文本。**纯函数**，不发请求。
 *
 * 和 onebot.js 的 textOf 的唯一区别：forward 段不再一律写成「[转发消息]」，
 * 而是去 forwards 里找预取结果；找到就展开，没找到就带条数占位。
 *
 * ⚠️ 其余段一律交给 onebot.js 的 segmentToText —— **不要在这里再复制一套 switch**。
 *   踩过：这里原本自己写了一遍，漏了 face/mface，于是「一批消息里有任意一张卡片」
 *   就会让整批消息的「[表情:呲牙]」退化成「[表情]」。共用同一个函数才能保证
 *   「有卡片」和「没卡片」两条路径的渲染结果逐字一致。
 */
export function renderSegments(message, depth, config, indent, forwards) {
  if (typeof message === 'string') return message
  if (!Array.isArray(message)) return ''
  const c = config ?? cfgOf()
  const ind = indent ?? ''
  return message
    .map((segment) => {
      // forward 是唯一需要特殊处理的段（要展开）；别的一律走公共渲染
      if (segment?.type !== 'forward') return segmentToText(segment)
      const id = String(segment?.data?.id ?? '').trim()
      const hit = forwards?.get(id)
      if (hit === undefined || hit.ok !== true) {
        // 没预取 / 没开 / 取失败：保留占位，别让模型以为这里什么都没有
        const why = hit !== undefined && hit.ok !== true && hit.error !== undefined ? `（${hit.error}）` : ''
        return `[转发消息${why}]`
      }
      // ⚠️ 这里传 **depth**，不是 depth+1：renderForward 内部会把它当作
      //   「这张卡片所在的层」来判「还能不能往里钻」。
      //   传 depth+1 会让深度被算两次 —— maxDepth=2 时内层实际算到 3 层，
      //   于是永远超限、嵌套永远展不开（实测踩过）。
      return renderForward(hit.messages, depth, c, ind, forwards)
    })
    .join('')
    .trim()
}

/** 段类型 → 中文标签（跟 onebot.js 的 SEGMENT_LABELS 同口径，这里只留会出现在卡片里的）。 */
const LABELS = {
  record: '[语音]',
  video: '[视频]',
  file: '[文件]',
  location: '[位置]',
  json: '[卡片消息]',
  xml: '[卡片消息]',
  share: '[分享链接]',
  contact: '[名片]',
  music: '[音乐]',
  face: '[表情]',
  mface: '[表情]',
  reply: '',
  poke: '[戳一戳]',
  gift: '[礼物]',
  markdown: '',
  node: '',
  grayTip: ''
}

function segmentLabel(type) {
  const key = String(type ?? '')
  if (key === '') return '[未知段]'
  if (key in LABELS) return LABELS[key]
  return `[${key}]`
}

/**
 * 把一次展开结果渲染成「一小段聊天记录」。
 *
 * 三层截断，任何一层都可能先到：
 *   · 条数上限   forwardMaxMessages
 *   · 字数上限   forwardMaxChars
 *   · 嵌套深度   forwardMaxDepth（超过就仍是占位）
 * 截断必须**明说还漏了多少**，不能静默截 —— 模型会以为它看到了全部。
 */
export function renderForward(messages, depth, config, indent, forwards) {
  const c = config ?? cfgOf()
  const ind = indent ?? ''
  const list = Array.isArray(messages) ? messages : []
  if (list.length === 0) return '[转发消息（空）]'
  if (depth > c.maxDepth) return `[转发消息 · ${list.length} 条（嵌套层数已达上限，未展开）]`

  const lines = []
  let chars = 0
  let used = 0
  for (const item of list) {
    if (used >= c.maxMessages) break
    const line = lineOf(item, depth, c, ind, forwards)
    if (line.trim() === '') continue
    // 第一条无论多长都收 —— 否则一条超长的消息会让整张卡片变成空的。
    // 但「只收第一条」不等于可以无视字数上限：单条超长时必须自己截断，
    // 否则 forwardMaxChars 在小值下形同虚设（测试实测：上限 40 时正文 188 字）。
    if (chars === 0 && line.length > c.maxChars) {
      lines.push(`${line.slice(0, c.maxChars)}…（此条过长，已截断 ${line.length - c.maxChars} 字）`)
      chars += c.maxChars
      used += 1
      break
    }
    if (chars > 0 && chars + line.length > c.maxChars) break
    lines.push(line)
    chars += line.length
    used += 1
  }

  const droppedCount = list.length - used
  const droppedChars = droppedCount > 0
    ? `，还有 ${droppedCount} 条未展开`
    : ''
  const head = `[转发消息 · 共 ${list.length} 条${droppedChars}]\n`
  return `${head}${lines.join('\n')}`
}

/**
 * 收集一条消息（含其展开的卡片）里所有的图片段，供 images.js 下载。
 *
 * 为什么要在这里做：卡片里的图片藏在展开结果里，buildImageBlocks 只看
 * 消息本身的段数组，根本看不到它们。不把它们捞出来，模型只能看到 [图片]。
 *
 * @returns {Array<{url:string, file:string, sub_type:any, summary:string}>}
 */
export function collectForwardImages(message, forwards, config) {
  const c = config ?? cfgOf()
  if (!c.images) return []
  const out = []
  const seen = new Set()
  const push = (seg) => {
    if (out.length >= c.imageLimit) return
    const url = String(seg?.data?.url ?? '').trim()
    if (url === '' || seen.has(url)) return
    seen.add(url)
    out.push({
      url,
      file: String(seg?.data?.file ?? ''),
      sub_type: seg?.data?.sub_type,
      summary: String(seg?.data?.summary ?? '')
    })
  }
  const walk = (segments, depth) => {
    if (!Array.isArray(segments) || depth > c.maxDepth) return
    for (const segment of segments) {
      if (out.length >= c.imageLimit) return
      if (segment?.type === 'image') push(segment)
      if (segment?.type === 'forward') {
        const hit = forwards?.get(String(segment?.data?.id ?? '').trim())
        if (hit?.ok === true) for (const item of hit.messages) walk(item?.message, depth + 1)
      }
    }
  }
  walk(message, 0)
  return out
}

/** 这条消息里有没有卡片（供调用方决定要不要走预取，省掉一次无谓的 async）。 */
export function hasForward(message) {
  return forwardIdsOf(message).length > 0
}

/** 排障用：把一次展开结果压成一行摘要。 */
export function describeForward(id, result) {
  if (result?.ok !== true) return `forward ${String(id).slice(0, 12)}… 展开失败：${result?.error ?? '未知'}`
  return `forward ${String(id).slice(0, 12)}… 展开 ${result.messages.length} 条`
}

/** 预取失败时记一条日志（不刷屏：同一 id 只记一次）。 */
const notedFailures = new Set()
export function noteForwardFailure(id, error) {
  const key = String(id ?? '')
  if (key === '' || notedFailures.has(key)) return
  notedFailures.add(key)
  note('forward', `卡片展开失败 id=${key.slice(0, 16)}… ：${String(error ?? '未知')}`)
}
