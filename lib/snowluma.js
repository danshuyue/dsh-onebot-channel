/**
 * snowluma.js —— 从 SnowLuma 本地配置里找 OneBot 正向 WebSocket 的地址和 token。
 *
 * 为什么要自动发现：SnowLuma 的 WS 端口/token 跟 HTTP 那套是**两套独立的**，
 * token 写在 <安装目录>\config\onebot_<uin>.json 的 wsServers[0].accessToken。
 * 让人手抄一遍太容易抄错（抄成 HTTP 的 token，握手直接被拒：非 101 状态码）。
 *
 * 找法（按可靠度排序）：
 *   1. 配置里显式写的 snowlumaConfigDir
 *   2. 常见安装位置（D:\software、各盘 Program Files、%LOCALAPPDATA% 等）
 *   3. 从**正在运行的 node 进程命令行**反推安装目录（最准，但要多起一个 PowerShell）
 *
 * 找到了就写回配置，下次启动不用再找。
 *
 * 注：本模块只认 SnowLuma 这一种协议端的配置布局。换别的协议端（比如 LLOneBot）
 * 走的是另一套配置结构，自动发现会失败 —— 那就手动填 wsUrl / wsToken，
 * 自动发现失败不影响主链路（退回 HTTP 轮询即可）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { note } from './env.js'

/** 常见安装位置（相对/绝对都行，存在即用）。 */
function candidateDirs() {
  const home = homedir()
  const list = [
    'D:\\software\\SnowLuma\\config',
    'C:\\Program Files\\SnowLuma\\config',
    'C:\\Program Files (x86)\\SnowLuma\\config',
    join(home, 'SnowLuma', 'config'),
    join(process.env.LOCALAPPDATA ?? '', 'SnowLuma', 'config'),
    join(process.env.APPDATA ?? '', 'SnowLuma', 'config')
  ]
  return list.filter((dir) => dir !== '' && existsSync(dir))
}

/** 从 SnowLuma 进程命令行里反推安装目录。 */
function dirsFromRunningProcess() {
  const out = []
  try {
    // 30 秒超时，失败就当没这招（不影响主链路）
    const output = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { $_.CommandLine }"
      ],
      { timeout: 8000, encoding: 'utf8', windowsHide: true }
    )
    for (const line of String(output).split(/\r?\n/)) {
      if (!/snowluma/i.test(line)) continue
      // 命令行形如："D:\software\SnowLuma\node.exe" index.mjs
      const match = String(line).match(/"?([A-Za-z]:\\[^"']*SnowLuma[^"']*?)\\?[^\\"']*node\.exe"?/i)
      const dir = match !== null ? match[1] : null
      if (dir === null) continue
      out.push(join(dir, 'config'))
    }
  } catch {
    /* 查不到就跳过 */
  }
  return out
}

/** 读某个 config 目录里的 onebot_*.json，取第一个 wsServers 条目。 */
function endpointFromDir(dir) {
  let files = []
  try {
    files = readdirSync(dir).filter((name) => /^onebot_.*\.json$/i.test(name))
  } catch {
    return null
  }
  for (const name of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      const servers = Array.isArray(raw?.networks?.wsServers) ? raw.networks.wsServers : []
      for (const server of servers) {
        const token = String(server?.accessToken ?? '')
        if (token === '') continue
        const host = String(server?.host ?? '127.0.0.1')
        const port = Number(server?.port ?? 0)
        const path = String(server?.path ?? '/')
        if (port <= 0) continue
        const url = `ws://${host}:${port}${path.startsWith('/') ? path : `/${path}`}`
        return { url, token, source: join(dir, name) }
      }
    } catch {
      /* 换下一个文件 */
    }
  }
  return null
}

/**
 * 从同一批 onebot_*.json 里取 HTTP API 接入点（0.15.0）。
 *
 * SnowLuma 把 HTTP 服务写在 networks.httpServers，**与 wsServers 是两套独立的
 * token**（混用会 401）。这里跟 WS 那条一样：有 host/port 才认，token 可为空
 * （有些部署给 HTTP 关掉了鉴权，此时不该整个跳过）。
 */
function httpEndpointFromDir(dir) {
  let files = []
  try {
    files = readdirSync(dir).filter((name) => /^onebot_.*\.json$/i.test(name))
  } catch {
    return null
  }
  for (const name of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      const servers = Array.isArray(raw?.networks?.httpServers) ? raw.networks.httpServers : []
      for (const server of servers) {
        const host = String(server?.host ?? '127.0.0.1')
        const port = Number(server?.port ?? 0)
        if (port <= 0) continue
        const token = String(server?.accessToken ?? '')
        return { url: `http://${host}:${port}/`, token, source: join(dir, name) }
      }
    } catch {
      /* 换下一个文件 */
    }
  }
  return null
}

/**
 * 找 WS 接入点。找不到返回 null（插件会退回纯轮询模式，不影响收发）。
 * @param {string} [configuredDir] 配置里指定的 SnowLuma 配置目录
 */
export function discoverWsEndpoint(configuredDir = '') {
  const dirs = []
  if (configuredDir !== '' && existsSync(configuredDir)) dirs.push(configuredDir)
  dirs.push(...candidateDirs())
  for (const dir of dirs) {
    const endpoint = endpointFromDir(dir)
    if (endpoint !== null) {
      note('ws', `自动发现 WS 接入点：${endpoint.url}（来自 ${endpoint.source}）`)
      return endpoint
    }
  }
  // 静态候选没命中，再从运行中的进程反推
  for (const dir of dirsFromRunningProcess()) {
    const endpoint = endpointFromDir(dir)
    if (endpoint !== null) {
      note('ws', `自动发现 WS 接入点：${endpoint.url}（来自进程反推 ${dir}）`)
      return endpoint
    }
  }
  note('ws', '没找到 SnowLuma 的 WS 接入点，退回 HTTP 轮询模式')
  return null
}

/**
 * 找 HTTP API 接入点（0.15.0）。找不到返回 null。
 * @param {string} [configuredDir] 配置里指定的 SnowLuma 配置目录
 */
export function discoverHttpEndpoint(configuredDir = '') {
  const dirs = []
  if (configuredDir !== '' && existsSync(configuredDir)) dirs.push(configuredDir)
  dirs.push(...candidateDirs())
  for (const dir of dirs) {
    const endpoint = httpEndpointFromDir(dir)
    if (endpoint !== null) {
      note('api', `自动发现 HTTP 接入点：${endpoint.url}（来自 ${endpoint.source}）`)
      return endpoint
    }
  }
  for (const dir of dirsFromRunningProcess()) {
    const endpoint = httpEndpointFromDir(dir)
    if (endpoint !== null) {
      note('api', `自动发现 HTTP 接入点：${endpoint.url}（来自进程反推 ${dir}）`)
      return endpoint
    }
  }
  note('api', '没找到 SnowLuma 的 HTTP 接入点')
  return null
}
