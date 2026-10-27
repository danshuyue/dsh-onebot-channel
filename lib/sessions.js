/**
 * sessions.js —— 会话列表 + 冷启动。
 *
 * 列会话合并三个来源，任何一个挂了都不至于变成「0 个可选会话」：
 *   1. sessions 服务 —— 只有「活着」的会话，但能问到折叠后的标题；
 *   2. 落盘目录 ~/.dsh/sessions/<编码后的 cwd>/ —— 全部会话（没打开的也在）；
 *   3. 浏览器端再补一次 —— ctx.sessions.list 里有 displayTitle（见 lib/client.js）。
 */
import { getConfig } from './config.js'
import { note, serviceOf } from './env.js'
import { normCwd, scanSessionDirs } from './title.js'

/** 来源一：活着的会话。 */
export function listLiveSessions(ctx, want) {
  const out = []
  try {
    const svc = serviceOf(ctx, 'sessions')
    if (svc === null || svc === undefined || typeof svc.list !== 'function') {
      note('api', 'sessions 服务取不到 list()')
      return out
    }
    // 标题存在投影里，得问 sessionTitle 服务；它没在 inject 里，取不到会抛，必须兜住
    let titleSvc
    try {
      titleSvc = serviceOf(ctx, 'sessionTitle')
    } catch (error) {
      note('api', `sessionTitle 不可用: ${error instanceof Error ? error.message : error}`)
      titleSvc = undefined
    }
    for (const session of svc.list() ?? []) {
      const header = session?.header ?? {}
      const cwd = String(header.cwd ?? '')
      if (want !== '' && cwd !== '' && normCwd(cwd) !== normCwd(want)) continue
      const id = String(header.id ?? session?.id ?? '')
      if (id === '') continue
      let title = ''
      if (titleSvc !== undefined && titleSvc !== null && typeof titleSvc.get === 'function') {
        try {
          const folded = titleSvc.get(session)
          if (typeof folded === 'string') title = folded
        } catch (error) {
          note('api', `sessionTitle.get failed: ${error instanceof Error ? error.message : error}`)
        }
      }
      if (title === '') title = String(session?.title ?? header.title ?? '')
      out.push({ id, title, cwd, updatedAt: String(header.updatedAt ?? header.createdAt ?? '') })
    }
  } catch (error) {
    note('api', `sessions.list failed ${error instanceof Error ? error.message : error}`)
  }
  return out
}

export function listWorkspaceSessions(ctx) {
  const want = String(getConfig().workspaceCwd ?? '')
  const merged = new Map()
  const put = (item) => {
    const old = merged.get(item.id)
    if (old === undefined) {
      merged.set(item.id, item)
      return
    }
    // 标题留着有的那个；时间留新的那个
    merged.set(item.id, {
      id: item.id,
      cwd: item.cwd !== '' ? item.cwd : old.cwd,
      title: item.title !== '' ? item.title : old.title,
      updatedAt: item.updatedAt > old.updatedAt ? item.updatedAt : old.updatedAt
    })
  }
  for (const item of listLiveSessions(ctx, want)) put(item)
  for (const item of scanSessionDirs(want)) put(item)
  // 空壳会话排到最后（前缀跟 client.js 里保持一致）
  const rank = (item) => (item.title.startsWith('（空会话') ? 1 : 0)
  return [...merged.values()].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b)
    return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0
  })
}

/** 候选会话：先给配置指定的，再按「最近更新」排其它会话。 */
export function sessionCandidates(ctx, preferredId) {
  const ids = []
  if (typeof preferredId === 'string' && preferredId !== '') ids.push(preferredId)
  try {
    const sessions = serviceOf(ctx, 'sessions')
    const list = sessions !== undefined && sessions !== null && typeof sessions.list === 'function' ? sessions.list() ?? [] : []
    const sorted = [...list].sort((a, b) => {
      const sa = String(a?.header?.updatedAt ?? a?.header?.createdAt ?? '')
      const sb = String(b?.header?.updatedAt ?? b?.header?.createdAt ?? '')
      return sa < sb ? 1 : sa > sb ? -1 : 0
    })
    for (const session of sorted) {
      const id = String(session?.header?.id ?? session?.id ?? '')
      if (id !== '' && !ids.includes(id)) ids.push(id)
    }
  } catch (error) {
    note('session', `candidates failed ${error instanceof Error ? error.message : error}`)
  }
  return ids
}

/** 我们替它冷启动出来的会话 agent（会话本来没开着时）。 */
const resumedAgents = new Map()
const lastResumeAttempt = new Map()

/** 按会话记录里的 preset 组装修复 setup —— 和 UI 打开会话时做的事一致。 */
async function composeSetup(ctx, sessionId) {
  try {
    const presets = serviceOf(ctx, 'agentPresets')
    const sessions = serviceOf(ctx, 'sessions')
    const session = sessions !== undefined && sessions !== null && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
    const presetId = session?.header?.agentPreset
    if (
      presets === undefined || presets === null ||
      typeof presets.resolve !== 'function' || typeof presets.mount !== 'function' ||
      typeof presetId !== 'string' || presetId === ''
    ) {
      return () => Promise.resolve()
    }
    const resolved = await presets.resolve(presetId)
    return async (agentCtx) => {
      await presets.mount(agentCtx, resolved.id)
    }
  } catch (error) {
    note('resume', `compose setup failed: ${error instanceof Error ? error.message : error}`)
    return () => Promise.resolve()
  }
}

/**
 * 取会话活着的 agent；没有就冷启动它。
 * AgentRegistry.resume 是 DSH 给「重新打开一个旧会话」用的接口
 * （better-sidebar 复活侧边对话也走这条），所以只认一个会话也够用，不必兜底。
 */
export async function ensureAgent(ctx, sessionId) {
  const agents = serviceOf(ctx, 'agents')
  if (agents === undefined || agents === null || typeof agents.get !== 'function') return undefined

  // 注册表里的键不一定是裸 id：有的地方用 "session-<uuid>"。
  // 先按两种写法都找一遍，找到就是「会话开着」，直接用它，别再 resume。
  const ids = sessionId.startsWith('session-') ? [sessionId, sessionId.slice('session-'.length)] : [sessionId, `session-${sessionId}`]
  for (const id of ids) {
    try {
      const live = agents.get(id)
      if (live !== undefined && live !== null) {
        if (id !== sessionId) note('resume', `用 ${id} 找到了活 agent（裸 id 查不到）`)
        return live
      }
    } catch (error) {
      note('resume', `agents.get(${id}) threw: ${error instanceof Error ? error.message : error}`)
    }
  }

  // 已经替它冷启动过就直接复用，否则每 10 秒会重复 resume 出一堆 agent。
  const cached = resumedAgents.get(sessionId)
  if (cached !== undefined) return cached.agent

  if (getConfig().resumeColdSession === false) return undefined

  if (typeof agents.resume !== 'function') {
    note('resume', 'agents.resume 不可用')
    return undefined
  }

  const last = lastResumeAttempt.get(sessionId) ?? 0
  if (Date.now() - last < 10000) return undefined
  lastResumeAttempt.set(sessionId, Date.now())

  try {
    // 先把会话从持久层「摸」一下：resume 只认注册表里已知的会话，
    // 有些版本要先经过 sessions.get 才会把它载入索引。
    const sessions = serviceOf(ctx, 'sessions')
    if (sessions !== undefined && sessions !== null && typeof sessions.get === 'function') {
      try {
        const known = sessions.get(sessionId)
        note('resume', `sessions.get(${sessionId}) -> ${known === undefined || known === null ? 'undefined' : 'ok'}`)
      } catch (error) {
        note('resume', `sessions.get(${sessionId}) threw: ${error instanceof Error ? error.message : error}`)
      }
    }

    const setup = await composeSetup(ctx, sessionId)
    const agentOptions = getConfig().agentOptions
    let handle
    let usedId = sessionId
    try {
      handle = await agents.resume({ resumeSessionId: sessionId, setup, agentOptions })
    } catch (firstError) {
      // 有的版本索引用带前缀的完整 id；换一种写法再试一次。
      const alternate = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : `session-${sessionId}`
      note('resume', `${sessionId} 直接 resume 失败（${firstError instanceof Error ? firstError.message : firstError}），改用 ${alternate}`)
      handle = await agents.resume({ resumeSessionId: alternate, setup, agentOptions })
      usedId = alternate
    }

    const agent = handle?.agent
    if (agent === undefined || agent === null) {
      note('resume', `${usedId} resume 没返回 agent`)
      return undefined
    }
    resumedAgents.set(sessionId, handle)
    note('resume', `${usedId} 冷启动成功`)
    return agent
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    note('resume', `${sessionId} 冷启动失败：${message}`)
    // 「已被活跃写句柄占用」通常意味着会话其实开着、只是注册表键不同，再查一遍。
    for (const id of ids) {
      try {
        const again = agents.get(id)
        if (again !== undefined && again !== null) {
          note('resume', `占用冲突后重查 ${id} 命中`)
          return again
        }
      } catch {
        /* 忽略 */
      }
    }
    return undefined
  }
}
