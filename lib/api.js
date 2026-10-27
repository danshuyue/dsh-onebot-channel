/**
 * api.js —— 设置页 API（同源 /api/qq-bridge/*）。
 *
 * 与浏览器半侧（lib/client.js）只走同源 HTTP，不碰 RPC。
 */
import { getConfig, saveConfig } from './config.js'
import { note, serviceOf } from './env.js'
import { oneBotList, callOneBot } from './onebot.js'
import { listWorkspaceSessions } from './sessions.js'
import { discoverWsEndpoint } from './snowluma.js'
import { wsStatus } from './ws.js'

export const API_PREFIX = '/api/qq-bridge'

/** 给设置页看的配置：不返回 token 明文。 */
function publicConfig() {
  const config = getConfig()
  return {
    enabled: config.enabled === true,
    selfUin: String(config.selfUin ?? ''),
    workspaceCwd: String(config.workspaceCwd ?? ''),
    groupOnlyWhenAt: config.groupOnlyWhenAt === true,
    groupContextCount: Number(config.groupContextCount) || 0,
    splitReply: config.splitReply === true,
    splitMaxChars: Number(config.splitMaxChars) || 120,
    splitDelayMinMs: Number(config.splitDelayMinMs) || 200,
    splitDelayMaxMs: Number(config.splitDelayMaxMs) || 700,
    pollMs: Number(config.pollMs) || 2000,
    groupPollMs: Number(config.groupPollMs) || 3000,
    resumeColdSession: config.resumeColdSession !== false,
    wsEnabled: config.wsEnabled !== false,
    // WS 的地址可以显示（token 不行）
    wsUrl: String(config.wsUrl ?? ''),
    wsConfigured: String(config.wsToken ?? '') !== ''
  }
}

/** 可数字段：非负有限数才接受。 */
const NUMERIC_FIELDS = ['groupContextCount', 'splitMaxChars', 'splitDelayMinMs', 'splitDelayMaxMs', 'pollMs', 'groupPollMs']
/** 布尔字段。 */
const BOOLEAN_FIELDS = ['groupOnlyWhenAt', 'splitReply', 'resumeColdSession']

/** 把设置页提交的可调参数合并进 config。返回是否有改动。 */
function applyTunables(body) {
  const config = getConfig()
  let changed = false
  if (body === null || typeof body !== 'object') return changed
  for (const key of NUMERIC_FIELDS) {
    if (body[key] === undefined) continue
    const value = Number(body[key])
    if (Number.isFinite(value) && value >= 0) {
      config[key] = value
      changed = true
    }
  }
  for (const key of BOOLEAN_FIELDS) {
    if (body[key] === undefined) continue
    config[key] = body[key] === true
    changed = true
  }
  return changed
}

/** 清洗前端传来的路由表，只留 sessionId / prefix / onlyWhenAt。 */
function normalizeRouteTable(table) {
  const out = {}
  if (table === null || typeof table !== 'object') return out
  for (const [key, value] of Object.entries(table)) {
    const id = String(key ?? '').trim()
    if (id === '' || value === null || typeof value !== 'object') continue
    const route = {}
    if (typeof value.sessionId === 'string' && value.sessionId !== '') route.sessionId = value.sessionId
    if (typeof value.prefix === 'string' && value.prefix !== '') route.prefix = value.prefix
    if (value.onlyWhenAt === false) route.onlyWhenAt = false
    out[id] = route
  }
  return out
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

function sendJson(res, code, data) {
  try {
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    })
    res.end(JSON.stringify(data))
  } catch (error) {
    note('api', `send failed ${error instanceof Error ? error.message : error}`)
  }
}

export function registerApi(ctx) {
  const server = serviceOf(ctx, 'webServer')
  if (server === undefined || server === null || typeof server.register !== 'function') {
    note('api', 'webServer 不可用，跳过 API 注册')
    return
  }
  // register 返回 disposer，必须挂到 ctx.effect 上：
  // 热重载时插件被 dispose，不释放的话下次挂同一个 prefix 会抛
  // "webserver: duplicate prefix route"，接口就 404 了。
  const dispose = server.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const route = (req.url ?? '').split('?')[0].slice(API_PREFIX.length) || '/'
      try {
        if (route === '/state' && req.method === 'GET') {
          const friends = await oneBotList('get_friend_list', 'user_id', 'nickname')
          const groups = await oneBotList('get_group_list', 'group_id', 'group_name')
          // 机器人自己是谁：问一次 OneBot，拿不到就说明链路没通
          let self = null
          try {
            const info = await callOneBot({ action: 'get_login_info' })
            if (info !== null && info !== undefined && info.retcode === 0 && info.data) {
              self = {
                uin: String(info.data.user_id ?? ''),
                name: String(info.data.nickname ?? ''),
              }
            }
          } catch (error) {
            note('api', `get_login_info failed: ${error instanceof Error ? error.message : error}`)
          }
          const config = getConfig()
          return sendJson(res, 200, {
            ok: true,
            self,
            config: publicConfig(),
            ws: wsStatus(),
            routes: {
              private: config.routes?.private ?? {},
              group: config.routes?.group ?? {}
            },
            sessions: listWorkspaceSessions(ctx),
            friends,
            groups
          })
        }
        if (route === '/save' && req.method === 'POST') {
          const config = getConfig()
          const body = await readBody(req)
          if (body?.routes !== undefined && typeof body.routes === 'object') {
            config.routes = {
              private: normalizeRouteTable(body.routes.private),
              group: normalizeRouteTable(body.routes.group)
            }
            // 绑定即监听：群表里的群号自动进监听列表。
            // 之前只写 routes.group、不写 groupUins，结果设置页里绑了群却完全没轮询（踩过）。
            config.groupUins = Object.keys(config.routes.group ?? {})
          }
          if (typeof body?.workspaceCwd === 'string') config.workspaceCwd = body.workspaceCwd
          if (body?.wsEnabled !== undefined) config.wsEnabled = body.wsEnabled === true
          if (typeof body?.wsUrl === 'string' && body.wsUrl.trim() !== '') config.wsUrl = body.wsUrl.trim()
          if (typeof body?.wsToken === 'string' && body.wsToken.trim() !== '') config.wsToken = body.wsToken.trim()
          if (body?.wsFallbackPollMs !== undefined) {
            const value = Number(body.wsFallbackPollMs)
            if (Number.isFinite(value) && value >= 1000) config.wsFallbackPollMs = value
          }
          applyTunables(body)
          const ok = saveConfig()
          note('api', `saved routes private=${Object.keys(config.routes?.private ?? {}).length} group=${Object.keys(config.routes?.group ?? {}).length} ws=${config.wsEnabled === false ? 'off' : config.wsUrl}`)
          return sendJson(res, ok ? 200 : 500, { ok })
        }
        if (route === '/detect-ws' && req.method === 'POST') {
          // 自动发现 SnowLuma 的 WS 接入点（省得手动抄 token）
          const config = getConfig()
          const body = await readBody(req)
          if (typeof body?.snowlumaConfigDir === 'string' && body.snowlumaConfigDir.trim() !== '') {
            config.snowlumaConfigDir = body.snowlumaConfigDir.trim()
          }
          const endpoint = discoverWsEndpoint(String(config.snowlumaConfigDir ?? ''))
          if (endpoint === null) {
            return sendJson(res, 404, {
              ok: false,
              error: '没找到 SnowLuma 的 WS 接入点。可以手动填地址和 token（见 SnowLuma 的 config/onebot_*.json）。'
            })
          }
          config.wsUrl = endpoint.url
          config.wsToken = endpoint.token
          saveConfig()
          return sendJson(res, 200, { ok: true, url: endpoint.url, source: endpoint.source })
        }
        return sendJson(res, 404, { ok: false, error: `unknown route: ${route}` })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        note('api', `${route} threw ${message}`)
        return sendJson(res, 500, { ok: false, error: message })
      }
    }
  })
  if (typeof dispose === 'function') ctx.effect(() => dispose, 'dsh-onebot-channel: api route')
  note('api', `registered at ${API_PREFIX}`)
}
