/**
 * deliver.js —— 消息投递进 DSH 会话 + 路由查询。
 */
import { randomUUID } from 'node:crypto'
import { getConfig } from './config.js'
import { note, serviceOf } from './env.js'
import { enqueueOutbound, maxEventSeq } from './outbound.js'
import { ensureAgent, sessionCandidates } from './sessions.js'
import { targetKey, waitQuiet, quietMsFromConfig, rememberDelivery } from './rhythm.js'
import { peekClosing } from './closure.js'
import { describeMemory } from './memory.js'

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

  const candidates = config.fallbackToLiveSession === false ? [preferredId] : sessionCandidates(ctx, preferredId)
  for (const sessionId of candidates) {
    if (sessionId === '') continue
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
      agent.followup(makeUserMessage(blocks))
      // 记住「这一回合是投给谁的」：qq_pass / qq_close 不给号时靠它兜底（见 rhythm.js）
      rememberDelivery(target)
      if (config.autoForwardReply !== false && target !== undefined) {
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
