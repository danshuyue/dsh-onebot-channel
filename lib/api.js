/**
 * api.js —— 设置页 API（同源 /api/qq-bridge/*）。
 *
 * 与浏览器半侧（lib/client.js）只走同源 HTTP，不碰 RPC。
 */
import { getConfig, saveConfig } from './config.js'
import { note, serviceOf } from './env.js'
import { oneBotList, callOneBot } from './onebot.js'
import { listWorkspaceSessions } from './sessions.js'
import { discoverWsEndpoint, discoverHttpEndpoint } from './snowluma.js'
import { wsStatus } from './ws.js'
import { memorySummary, wipeMemory } from './memory.js'
import { proactiveSummary, runProactiveOnce } from './proactive.js'
import { mergePending } from './poll.js'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const API_PREFIX = '/api/qq-bridge'

/**
 * 这一份代码是哪个版本、跑在哪个进程里。
 *
 * 为什么非要有：2026-10-29 排查「改完没生效」，翻了半天日志才发现主进程是
 * 上午 11:08 起的，加载的还是旧版 —— 设置页看不到版本，人就只能靠猜。
 * 版本从自己旁边的 package.json 读：插件跑在 profile 的 node_modules 副本里，
 * import.meta.url 指向的就是**正在跑的那份**，而不是源码目录，这点很关键。
 */
const BOOT_AT = new Date().toISOString()

let cachedVersion
function pluginVersion() {
  if (cachedVersion !== undefined) return cachedVersion
  cachedVersion = ''
  try {
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')
    )
    if (typeof pkg.version === 'string') cachedVersion = pkg.version
  } catch (error) {
    note('api', `读 package.json 版本失败：${error instanceof Error ? error.message : error}`)
  }
  return cachedVersion
}

export function runtimeSummary() {
  return {
    version: pluginVersion(),
    pid: process.pid,
    bootAt: BOOT_AT
  }
}

/** 给设置页看的配置：不返回 token 明文。 */
export function publicConfig() {
  const config = getConfig()
  return {
    enabled: config.enabled === true,
    selfUin: String(config.selfUin ?? ''),
    workspaceCwd: String(config.workspaceCwd ?? ''),
    textPrefix: String(config.textPrefix ?? ''),
    groupOnlyWhenAt: config.groupOnlyWhenAt === true,
    groupContextCount: Number(config.groupContextCount) || 0,
    splitReply: config.splitReply === true,
    // 分条依据：paragraph（换行分条）/ sentence（按句末标点）
    splitMode: config.splitMode === 'sentence' ? 'sentence' : 'paragraph',
    splitMaxChars: Number(config.splitMaxChars) || 120,
    splitMaxParts: Number(config.splitMaxParts) || 8,
    splitMinChars: Number(config.splitMinChars) || 0,
    splitDelayMinMs: Number(config.splitDelayMinMs) || 200,
    splitDelayMaxMs: Number(config.splitDelayMaxMs) || 700,
    pollMs: Number(config.pollMs) || 2000,
    groupPollMs: Number(config.groupPollMs) || 3000,
    resumeColdSession: config.resumeColdSession !== false,
    autoForwardReply: config.autoForwardReply !== false,
    // 0.7.1 起：对话节奏与沉默权
    replyQuietMs: Number(config.replyQuietMs) || 0,
    waitMaxMs: Number(config.waitMaxMs) || 60000,
    closureEnabled: config.closureEnabled !== false,
    // 0.8.0 起：关系记忆
    memoryEnabled: config.memoryEnabled !== false,
    // 0.9.0 起：私聊合并窗口（标记已读的中间态）
    mergeWindowMs: Number(config.mergeWindowMs) || 0,
    mergeMaxWaitMs: Number(config.mergeMaxWaitMs) || 15000,
    mergeMaxMessages: Number(config.mergeMaxMessages) || 10,
    // 0.9.0 起：主动搭话
    proactiveEnabled: config.proactiveEnabled === true,
    proactiveIdleHours: Number(config.proactiveIdleHours) || 6,
    proactiveDailyMax: Number(config.proactiveDailyMax) || 1,
    proactiveQuietFrom: String(config.proactiveQuietFrom ?? ''),
    proactiveQuietTo: String(config.proactiveQuietTo ?? ''),
    proactiveBackoffMax: Number(config.proactiveBackoffMax) || 4,
    // 空数组 = 所有已绑私聊都可主动（跟 config 里的语义一致，别在前端再翻译一遍）
    proactiveTargets: Array.isArray(config.proactiveTargets)
      ? config.proactiveTargets.map((v) => String(v ?? '')).filter((v) => v !== '')
      : [],
    // 0.8.0 起：上线补历史
    backfillOnStart: config.backfillOnStart !== false,
    backfillMaxPages: Number(config.backfillMaxPages) || 5,
    backfillDeliver: Number(config.backfillDeliver) || 20,
    qzoneRequireConfirm: config.qzoneRequireConfirm !== false,
    imageCopyDir: String(config.imageCopyDir ?? ''),
    wsEnabled: config.wsEnabled !== false,
    wsFallbackPollMs: Number(config.wsFallbackPollMs) || 30000,
    // WS 的地址可以显示（token 不行）。wsToken 有没有配不单独暴露 ——
    // 前端只要知道「地址 + 留空保持原样」就够了，多一个字段没人用就是死的。
    wsUrl: String(config.wsUrl ?? ''),
    // 0.15.0 起：HTTP API 地址也进设置页（token 同样不回显）。
    // 此前它只在配置文件里，改端口得手改 JSON —— 用户明确要这个入口。
    onebotHttp: String(config.onebotHttp ?? '')
  }
}

/** 可数字段：非负有限数才接受。 */
export const NUMERIC_FIELDS = [
  'groupContextCount', 'splitMaxChars', 'splitMaxParts', 'splitMinChars',
  'splitDelayMinMs', 'splitDelayMaxMs', 'pollMs', 'groupPollMs',
  'replyQuietMs', 'waitMaxMs', 'backfillMaxPages', 'backfillDeliver', 'wsFallbackPollMs',
  'mergeWindowMs', 'mergeMaxWaitMs', 'mergeMaxMessages',
  'proactiveIdleHours', 'proactiveDailyMax', 'proactiveBackoffMax'
]
/** 布尔字段。 */
export const BOOLEAN_FIELDS = [
  'groupOnlyWhenAt', 'splitReply', 'resumeColdSession', 'autoForwardReply',
  'closureEnabled', 'memoryEnabled', 'backfillOnStart', 'qzoneRequireConfirm', 'wsEnabled',
  'proactiveEnabled'
]
/** 可编辑的纯文本字段（空串是合法值 —— 比如清空图片目录就回到默认）。 */
export const STRING_FIELDS = ['textPrefix', 'imageCopyDir', 'proactiveQuietFrom', 'proactiveQuietTo']
/**
 * 字符串数组字段。目前只有主动搭话的白名单。
 * 提交 `[]` 是合法且有意义的（= 全放开），所以不能用「空就跳过」那套。
 */
export const ARRAY_FIELDS = ['proactiveTargets']
/**
 * 枚举字段：只接受列出的值，别的一律丢弃（防止手改配置或旧前端写进一个没人认识的值，
 * 那样 outbound 会静默退回默认分支，行为跟预期不符还查不出来）。
 */
export const ENUM_FIELDS = {
  splitMode: ['paragraph', 'sentence']
}

/** 白名单只认 `private:<数字>`：脏数据留在配置里会让功能静默失效，干脆在入口处滤掉。 */
function cleanTargetList(value) {
  if (!Array.isArray(value)) return null
  const out = []
  for (const item of value) {
    const key = String(item ?? '').trim()
    if (!/^private:\d+$/.test(key)) continue
    if (out.includes(key)) continue
    out.push(key)
    if (out.length >= 200) break
  }
  return out
}

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
  for (const key of STRING_FIELDS) {
    if (typeof body[key] !== 'string') continue
    config[key] = body[key].trim()
    changed = true
  }
  for (const key of ARRAY_FIELDS) {
    if (body[key] === undefined) continue
    const list = cleanTargetList(body[key])
    if (list === null) continue
    config[key] = list
    changed = true
  }
  for (const [key, allowed] of Object.entries(ENUM_FIELDS)) {
    if (typeof body[key] !== 'string') continue
    const value = body[key].trim()
    if (!allowed.includes(value)) continue
    config[key] = value
    changed = true
  }
  return changed
}

/**
 * 清洗前端传来的路由表，只留 sessionId / prefix。
 *
 * 只留这两个是因为**只有它们有消费方**：sessionId → deliver.pickSessionId，
 * prefix → deliver.prefixOf（私聊正文前缀）。
 *
 * ⚠️ 以前这里还留 `onlyWhenAt`，但全代码没有任何地方读它（群里「只在 @ 时响应」
 *   只有全局开关 groupOnlyWhenAt）。留着它会让前端以为这个字段生效、写进去却毫无作用，
 *   所以直接删掉 —— 存进去的假配置比不存更坏。
 */
function normalizeRouteTable(table) {
  const out = {}
  if (table === null || typeof table !== 'object') return out
  for (const [key, value] of Object.entries(table)) {
    const id = String(key ?? '').trim()
    if (id === '' || value === null || typeof value !== 'object') continue
    const route = {}
    if (typeof value.sessionId === 'string' && value.sessionId !== '') route.sessionId = value.sessionId
    if (typeof value.prefix === 'string' && value.prefix !== '') route.prefix = value.prefix
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
            runtime: runtimeSummary(),
            config: publicConfig(),
            ws: wsStatus(),
            memory: memorySummary(),
            proactive: proactiveSummary(),
            merge: mergePending(),
            routes: {
              private: config.routes?.private ?? {},
              group: config.routes?.group ?? {}
            },
            sessions: listWorkspaceSessions(ctx),
            friends,
            groups
          })
        }
        if (route === '/memory-clear' && req.method === 'POST') {
          // 「她把我忘了」的后悔药：清空整张关系卡表（不可撤销，前端必须二次确认）
          const ok = wipeMemory()
          note('api', `memory cleared ok=${ok}`)
          return sendJson(res, ok ? 200 : 500, { ok, memory: memorySummary() })
        }
        if (route === '/proactive-now' && req.method === 'POST') {
          // 设置页的「现在试一次」：忽略开关/配额/空闲/静默，立刻投一次。
          // 为什么允许在开关关着时也能试：不试一下谁也不知道手感对不对。
          // body.only 指定对象（`private:123`）；不传就按名单里第一个。
          const body = await readBody(req)
          const only = typeof body?.only === 'string' ? body.only : ''
          const result = await runProactiveOnce(ctx, { force: true, only })
          note('api', `proactive-now sent=${result.sent} skipped=${result.skipped.map((s) => `${s.key}:${s.reason}`).join(',') || '-'}`)
          return sendJson(res, 200, { ok: true, ...result, proactive: proactiveSummary() })
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
          // wsEnabled 由 applyTunables 统一处理（BOOLEAN_FIELDS），这里不再重复赋值
          if (typeof body?.wsUrl === 'string' && body.wsUrl.trim() !== '') config.wsUrl = body.wsUrl.trim()
          if (typeof body?.wsToken === 'string' && body.wsToken.trim() !== '') config.wsToken = body.wsToken.trim()
          // 0.15.0：HTTP API 地址 / token（与 WS 同一套「留空 = 保持原样」语义，
          // 这样前端不回显凭据也不会误清空）。地址非法直接拒，别写进去让主链路连不上。
          if (typeof body?.onebotHttp === 'string' && body.onebotHttp.trim() !== '') {
            const next = body.onebotHttp.trim()
            if (!/^https?:\/\//i.test(next)) {
              return sendJson(res, 400, { ok: false, error: 'HTTP API 地址要以 http:// 或 https:// 开头' })
            }
            config.onebotHttp = next
          }
          if (typeof body?.token === 'string' && body.token.trim() !== '') config.token = body.token.trim()
          // wsFallbackPollMs 也归 applyTunables（NUMERIC_FIELDS），不再单独判一遍
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
        if (route === '/detect-http' && req.method === 'POST') {
          // 0.15.0：自动发现 SnowLuma 的 HTTP API 接入点（与 WS 那套 token 不是一回事）
          const config = getConfig()
          const body = await readBody(req)
          if (typeof body?.snowlumaConfigDir === 'string' && body.snowlumaConfigDir.trim() !== '') {
            config.snowlumaConfigDir = body.snowlumaConfigDir.trim()
          }
          const endpoint = discoverHttpEndpoint(String(config.snowlumaConfigDir ?? ''))
          if (endpoint === null) {
            return sendJson(res, 404, {
              ok: false,
              error: '没找到 SnowLuma 的 HTTP 接入点。可以手动填地址和 token（见 SnowLuma 的 config/onebot_*.json 的 httpServers）。'
            })
          }
          config.onebotHttp = endpoint.url
          if (endpoint.token !== '') config.token = endpoint.token
          saveConfig()
          return sendJson(res, 200, { ok: true, url: endpoint.url, source: endpoint.source, hasToken: endpoint.token !== '' })
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
