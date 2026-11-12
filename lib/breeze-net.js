/** Breeze 专用代理路由，不改宿主 global dispatcher，不在失败后重放合成 POST。 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'

const exec = promisify(execFile)
let windowsCache
let windowsAt = 0

/** 仅支持已启用的静态 HTTP(S) 系统代理；PAC 不猜、不执行。 */
export function parseWindowsProxy(text) {
  if (!/^\s*ProxyEnable\s+REG_DWORD\s+0x1\s*$/mi.test(text)) return ''
  const server = /^\s*ProxyServer\s+REG_SZ\s+(.+)$/mi.exec(text)?.[1]?.trim() ?? ''
  const entries = server.split(';').map(s => s.trim()).filter(Boolean)
  const perProtocol = entries.find(s => /^https=/i.test(s)) ?? entries.find(s => /^http=/i.test(s))
  const raw = perProtocol ? perProtocol.replace(/^https?=/i, '') : entries.find(s => !s.includes('=')) ?? ''
  if (!raw) return ''
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`)
    // 系统代理解析错误时不向不明协议发送凭据。
    return ['http:', 'https:'].includes(url.protocol) ? url.href : ''
  } catch { return '' }
}

async function windowsProxy() {
  if (process.platform !== 'win32') return ''
  if (Date.now() - windowsAt < 30000 && windowsCache !== undefined) return windowsCache
  // 使用系统 reg.exe，避免 PATH 内同名程序；异步 + 2s 上限，不阻塞消息处理。
  windowsCache = (async () => {
    try {
      const { stdout } = await exec(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe'),
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
        { windowsHide: true, timeout: 2000, maxBuffer: 65536 })
      return parseWindowsProxy(stdout)
    } catch { return '' }
  })()
  windowsAt = Date.now()
  return windowsCache
}

/** 环境代理优先（小写优先）；NO_PROXY 始终有效。未配置时保留宿主默认网络。 */
export function proxySettings(env, systemProxy = '') {
  const httpProxy = String(env.http_proxy ?? env.HTTP_PROXY ?? '').trim()
  const httpsProxy = String(env.https_proxy ?? env.HTTPS_PROXY ?? httpProxy).trim()
  return {
    httpProxy: httpProxy || (httpsProxy ? '' : systemProxy),
    httpsProxy: httpsProxy || (httpProxy ? httpProxy : systemProxy),
    noProxy: String(env.no_proxy ?? env.NO_PROXY ?? ''),
    source: httpProxy || httpsProxy ? 'env-proxy' : systemProxy ? 'windows-proxy' : 'host-default'
  }
}

export async function breezeRoute() {
  const settings = proxySettings(process.env)
  if (settings.source === 'host-default') Object.assign(settings, proxySettings(process.env, await windowsProxy()))
  if (settings.source === 'host-default') return { source: settings.source }
  // ponytail: Breeze 请求低频，每次拥有独立 Agent，避免配置切换时关闭其他调用的路由。
  // 调用方在 fetch 结算后 graceful close；已派发响应的 body 可继续读取。
  const { EnvHttpProxyAgent } = await import('undici')
  return { source: settings.source, dispatcher: new EnvHttpProxyAgent(settings) }
}

/** 只保留诊断字段，不输出 URL/headers/body/stack/原始 message，避免带出 key 或代理密码。 */
export function networkFailure(error, { stage = 'request', elapsedMs = 0, route = 'host-default' } = {}) {
  const errors = []
  const seen = new Set()
  function walk(value, depth = 0) {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 3 || errors.length >= 8) return
    seen.add(value)
    const safe = s => typeof s === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(s) ? s : ''
    errors.push({ name: safe(value.name), code: safe(value.code) })
    walk(value.cause, depth + 1)
    if (Array.isArray(value.errors)) for (const child of value.errors.slice(0, 4)) walk(child, depth + 1)
  }
  walk(error)
  const codes = errors.map(e => e.code || e.name).filter(Boolean)
  const timeout = codes.some(c => /TIMEOUT|TIMEDOUT|TimeoutError|AbortError|ABORT_ERR/.test(c))
  let hint = timeout ? '连接或请求超时，检查代理与网络' : '网络请求失败，检查 DNS、TLS 与代理'
  if (codes.some(c => /ENOTFOUND|EAI_AGAIN/.test(c))) hint = 'DNS 解析失败，检查 DNS 与代理'
  if (codes.some(c => /CERT|TLS|SSL/.test(c))) hint = 'TLS/证书验证失败，检查证书与代理（不要关闭证书验证）'
  return { stage, elapsedMs, route, errors, timeout, message: `${hint}（${codes.join(' → ') || 'unknown'}）` }
}
