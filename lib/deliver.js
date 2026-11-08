/**
 * deliver.js —— 消息投递进 DSH 会话 + 路由查询。
 */
import { randomUUID } from 'node:crypto'
import { getConfig } from './config.js'
import { note, serviceOf } from './env.js'
import { enqueueOutbound, maxEventSeq } from './outbound.js'
import { ensureAgent, sessionCandidates } from './sessions.js'
import { targetKey, waitQuiet, quietMsFromConfig, rememberDelivery, resetWaitBudget } from './rhythm.js'
import { peekClosing } from './closure.js'
import { describeMemory } from './memory.js'
import { isArchived } from './archive.js'

/**
 * 查路由表：这个 QQ 号/群该投到哪个 DSH 会话。
 * 配置形如 routes.private["1000000001"] = { sessionId, prefix }。
 */
export function routeOf(cfg, kind, id) {
  const table = cfg !== null && cfg !== undefined ? cfg.routes?.[kind] : null
  if (table === null || typeof table !== 'object') return null
  const key = String(id ?? '')
  if (key === '') return null
  const route = table[key]
  return route !== null && typeof route === 'object' ? route : null
}

/**
 * 取这个 QQ 号/群对应的会话 id。
 * 没配置就返回空字符串 —— 调用方据此跳过投递（未配置的 peer 一律忽略，不再兜底到最近会话）。
 * （旧单路由字段在 config.js 的 loadConfig 里已一次性迁进 routes，这里只认 routes。）
 */
export function pickSessionId(cfg, kind, id) {
  const route = routeOf(cfg, kind, id)
  if (route !== null && typeof route.sessionId === 'string' && route.sessionId !== '') return route.sessionId
  return ''
}

/** 文本前缀：优先用路由里配的，其次按类型给默认值。 */
export function prefixOf(cfg, kind, id, fallback) {
  const route = routeOf(cfg, kind, id)
  if (route !== null && typeof route.prefix === 'string' && route.prefix !== '') return route.prefix
  return fallback
}

let lastNoAgentNote = 0

/**
 * 把一条消息送进 agent —— 忙的时候用 `steer`，闲的时候用 `followup`。
 *
 * 为什么必须分开（2026-11-03 用户实测「卡排队，排队的消息都是旧的」）：
 *   宿主的两个入口进的是**两个不同的队列**：
 *     followup → next-turn：只在**回合边界**被认领，而且一次只认领**一条**；
 *     steer    → next-step：当前回合的下一个步骤边界就认领，并且**整队全取**。
 *   她一个回合里要 qq_wait（用户实测打到 40 秒）、翻 qq_msg_history、分条发好几条，
 *   这期间进来的每条消息都 followup 进 next-turn → 回合结束后**一条开一个新回合**。
 *   表现就是「N 条排队消息，而且都是旧的」：她早在当前回合里用 qq_msg_history
 *   看过这些话了，回合结束后又被单独唤醒，对着同一段旧话再回一遍。
 *   改成 steer 之后，这些消息在她当前回合的下一步一起交上去，
 *   既不攒队列，也不各占一个回合。
 *
 * ⚠️ 闲的时候必须还是 followup：steer 进的是 next-step，空闲时没有「当前回合」，
 *   消息会一直躺在 next-step 里没人唤醒（宿主只在回合内认领它）。
 *
 * 宿主没 `status` 字段 / 没 `steer` 方法时一律退回 followup —— 行为与改动前逐字一致。
 */
function pushIntoAgent(agent, message, sessionId) {
  let status = ''
  try {
    status = String(agent?.status ?? '')
  } catch {
    /* 取不到状态就按空闲处理 */
  }
  if (status === 'running' && typeof agent.steer === 'function') {
    agent.steer(message)
    note('deliver', `agent 正在跑，改用 steer 投递（不排 next-turn）session=${sessionId}`)
    return 'steer'
  }
  agent.followup(message)
  return 'followup'
}

/** 确保消息对象带 id —— 缺 id 会被 DSH 判成 corrupt（"lacks an identified message"）。 */
function ensureId(message) {
  if (message !== null && typeof message === 'object' && typeof message.id === 'string' && message.id !== '') return message
  return { ...(message ?? {}), id: randomUUID() }
}

export async function deliver(ctx, preferredId, text, target, imageBlocks, options) {
  const config = getConfig()
  const agents = serviceOf(ctx, 'agents')
  if (agents === undefined || agents === null || typeof agents.get !== 'function') {
    note('deliver', 'host has no agents service')
    return ''
  }

  if (preferredId !== '' && isArchived(preferredId)) {
    note('deliver', `${preferredId} 已归档，放弃投递，禁止兜底到其他会话 target=${target?.kind ?? ''}:${target?.id ?? ''}`)
    return ''
  }
  const candidates = config.fallbackToLiveSession === false ? [preferredId] : sessionCandidates(ctx, preferredId)
  for (const sessionId of candidates) {
    if (sessionId === '') continue
    // 已归档的会话不投（0.12.0）。
    // 必须放在 ensureAgent **之前** —— 别为一个注定不投的会话白拉起一个 agent
    // （冷启动要读日志、组 preset，是有成本的）。
    // 只过滤设置页下拉是不够的：「昨天绑的会话今天被归档」这种情况，
    // 下拉里早就看不见它了，但路由表里还指着它。
    if (isArchived(sessionId)) {
      note('deliver', `${sessionId} 已归档，跳过投递 target=${target?.kind ?? ''}:${target?.id ?? ''}`)
      continue
    }
    const agent = await ensureAgent(ctx, sessionId)
    if (agent === undefined || agent === null || typeof agent.followup !== 'function') continue

    // 只走宿主服务，绝不 import 官方包：插件装在 workspace 或 ~/.dsh/plugins 下时，
    // Node 从插件真实路径往上找 node_modules，碰不到 DSH 安装目录里的 @deepseek-ai/*，
    // 而 profile 的 node_modules/@deepseek-ai 里也只有 cosmokit / schemastery。
    // 不管走哪条路，最后都过一遍 ensureId：宁可多一层，也不要再写坏一条会话。
    let makeUserMessage = (blocks) => ensureId({ role: 'user', content: blocks, source: { kind: 'user' } })
    try {
      const llmService = serviceOf(ctx, 'llm')
      if (llmService !== undefined && llmService !== null && typeof llmService.createUserMessage === 'function') {
        makeUserMessage = (blocks) => ensureId(llmService.createUserMessage({ content: blocks, source: { kind: 'user' } }))
      } else {
        note('deliver', 'llm.createUserMessage 不可用，用带 id 的兜底消息')
      }
    } catch (error) {
      note('deliver', `llm 服务取不到（${error instanceof Error ? error.message : error}），用带 id 的兜底消息`)
    }

    try {
      // ---- 回复前先把静默补足 ----
      // 为什么在这里而不是在下游：只有这一处拿得到「这次投递属于哪个 QQ 号/群」。
      // 关着的时候（replyQuietMs=0）waitQuiet 立刻返回，等于完全没有开销。
      const quietKey = targetKey(target)
      const quietMs = quietMsFromConfig()
      if (quietKey !== '' && quietMs > 0) {
        const waited = await waitQuiet(quietKey, quietMs)
        if (waited.waitedMs > 0) {
          note('deliver', `补静默 ${waited.waitedMs}ms 后投递 key=${quietKey}${waited.budgetExceeded === true ? '（超预算放行）' : ''}`)
        }
      }

      // ---- 这次开口前，先告诉她上次聊到哪儿停的 ----
      // 收尾（qq_close）的意义全在这一步：记下来却不带给她，等于没记。
      // peekClosing 自带去重（一条收尾只带一次）和时效（超过 24 小时不再提），
      // 否则就重演「表情标记说明」那件事 —— 同一句凑在每轮正文里反复烧 token。
      let opener = text
      if (quietKey !== '') {
        const closing = peekClosing(quietKey)
        if (closing !== null && (closing.summary !== '' || closing.next !== '')) {
          const lines = []
          if (closing.summary !== '') lines.push(`上次聊到：${closing.summary}`)
          if (closing.next !== '') lines.push(`可以从这儿接着聊：${closing.next}`)
          opener = `（${lines.join('；')}）\n${text}`
          note('deliver', `带上上次收尾 key=${quietKey}`)
        }

        // ---- 记忆卡：她对这个人的认识，常驻 ----
        // 跟收尾提示不同，这个**每回合都带**（所以才要严格控制长度，见 memory.js）。
        // 重启后她对某个人的称呼和几条事实还在 —— 这就是「关系持久化」的全部意义。
        const memory = config.memoryEnabled === false ? '' : describeMemory(quietKey)
        if (memory !== '') opener = `${memory}\n${opener}`
      }

      const before = maxEventSeq(agent)
      // 图片作为独立的 image 块跟在文本后面（会话格式：{type:'image', attachment: ImageAttachmentRef}）
      const blocks = Array.isArray(imageBlocks) && imageBlocks.length > 0
        ? [{ type: 'text', text: opener }, ...imageBlocks]
        : [{ type: 'text', text: opener }]
      pushIntoAgent(agent, makeUserMessage(blocks), sessionId)
      // 记住「这一回合是投给谁的」：qq_pass / qq_close 不给号时靠它兜底（见 rhythm.js）
      // 按会话记（0.19.6）：A 会话的 qq_pass / qq_close 兜底只看 A 会话刚投给谁。
      // 以前是全局单例，群投递会把私聊的兜底目标顶掉 —— 见 rhythm.js 里的说明。
      rememberDelivery(target, undefined, sessionId)
      // 新消息进来了 → 这一回合的 qq_wait 额度重新算（见 rhythm.js 的 waitBudgetLeft）
      resetWaitBudget(quietKey)
      // ---- 入待转发队列（0.20.2 起：**不再**按 autoForward 开关决定入不入队）----
      //
      // 为什么开关不放在这里（改过一次，踩了坑才知道）：
      //   这个队列不只用来「转发正文」，`flushOutbound` 还靠它做**回合故障播报**
      //   （notify.js 的 [系统] 通知：出错 / 中断 / 等满 TTL 没等到 turn/end）。
      //   如果在入口就按「群里不自动转发」把条目砍掉，群里那个群**再也收不到任何故障通知**
      //   —— 那正是 0.19.5 专门加「不让人干等」要解决的问题，等于悄悄回滚了它。
      //   所以：条目照旧入队，**发不发正文**由 outbound.js 在发送那一刻按渠道判定。
      if (target !== undefined) {
        // 入待转发队列（见 outbound.js 的注释）：覆盖会丢前一回合的回复 / 发错 target
        enqueueOutbound(sessionId, agent, before, target, options)
      }
      if (sessionId !== preferredId) note('deliver', `preferred ${preferredId} 没有活 agent，改投 ${sessionId}`)
      return sessionId
    } catch (error) {
      note('deliver', `${sessionId} followup threw ${error instanceof Error ? error.message : error}`)
    }
  }

  const now = Date.now()
  if (now - lastNoAgentNote > 15000) {
    lastNoAgentNote = now
    note('deliver', `没有可用 agent，候选=[${candidates.join(', ')}]`)
  }
  return ''
}
