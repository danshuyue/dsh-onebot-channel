/**
 * ws.js —— OneBot 正向 WebSocket 事件推送（入站实时化）。
 *
 * 为什么能上：SnowLuma 的 OneBot 配置里本来就开着正向 WS 服务器
 * （config/onebot_<uin>.json → networks.wsServers[0]，独立端口 + 独立 token）。
 *
 * 鉴权：OneBot 11 规范认两种 —— HTTP 头 Authorization: Bearer，或 URL 查询参数
 * ?access_token=。这里两种都带上：Node 内置 WebSocket（undici）对 headers 选项的
 * 支持随版本浮动，带上查询参数最稳。**token 不能进日志**（note 里只打 host:port）。
 *
 * 与轮询的关系：WS 通 → 消息实时到；轮询降频成「补漏」（防 WS 漏事件）；
 * WS 断 → 轮询立刻回到全速。见 poll.js 的 intervalFor()。
 */
import { getConfig } from './config.js'
import { note } from './env.js'

let socket = null
let timer = null
let stopped = false
let retryDelay = 1000
let onEvent = null
/** 是否已经记过「连不上」——用来给 1006 断连去重，避免每轮重连刷一行。 */
let wsDownLogged = false

const state = {
  connected: false,
  connectedAt: 0,
  lastError: '',
  events: 0,
  messages: 0,
  reconnects: 0,
  url: ''
}

export function wsStatus() {
  return {
    ...state,
    connectedAt: state.connectedAt > 0 ? new Date(state.connectedAt).toISOString() : ''
  }
}

export function isWsConnected() {
  return state.connected
}

/** 日志里不能带 token，只留 host:port。 */
function safeUrl(url) {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`
  } catch {
    return 'ws://?'
  }
}

function scheduleReconnect() {
  if (stopped) return
  if (timer !== null) clearTimeout(timer)
  const delay = retryDelay
  // 退避封顶 10s（原来 30s）。
  // 实测启动时 QQ 登录完 → OneBot 的 WS 端口才 listen，中间隔了约 2 分钟；
  // 30s 封顶意味着端口开的那一刻，客户端可能还在等下一个 30s 的窗口，
  // 白白多等半个周期。10s 封顶让「端口开了就能尽快接上」，
  // 而断线期间也最多每 10 秒敲一次门，不算吵。
  retryDelay = Math.min(10000, Math.round(retryDelay * 1.8))
  state.reconnects += 1
  note('ws', `${Math.round(delay / 1000)} 秒后重连（第 ${state.reconnects} 次）`)
  timer = setTimeout(() => {
    timer = null
    connect()
  }, delay)
}

function connect() {
  const config = getConfig()
  if (config.wsEnabled === false) {
    note('ws', '已按配置禁用，退回 HTTP 轮询')
    return
  }
  const url = String(config.wsUrl ?? '').trim()
  const token = String(config.wsToken ?? '').trim()
  if (url === '' || token === '') {
    note('ws', '没配 wsUrl / wsToken，退回 HTTP 轮询')
    return
  }
  state.url = safeUrl(url)

  const target = (() => {
    try {
      const parsed = new URL(url)
      if (parsed.searchParams.get('access_token') === null) parsed.searchParams.set('access_token', token)
      return parsed.toString()
    } catch {
      return url
    }
  })()

  let socket = null
  try {
    // 第二参数带 headers 只是双保险：不同 Node 版本对 undici WebSocket 的 headers
    // 支持不一致（有的当 protocols 解析会直接抛），带上查询参数最稳。
    socket = new WebSocket(target, { headers: { Authorization: `Bearer ${token}` } })
  } catch (error) {
    // 有些 Node 版本不接受第二参数 → 退到纯 URL（鉴权靠 URL 上的 access_token）
    const message = error instanceof Error ? error.message : String(error)
    try {
      note('ws', `带 headers 建连失败（${message}），改用纯 URL 重试`)
      socket = new WebSocket(target)
    } catch (secondError) {
      state.lastError = secondError instanceof Error ? secondError.message : String(secondError)
      note('ws', `创建连接失败：${state.lastError}`)
      scheduleReconnect()
      return
    }
  }

  socket.onopen = () => {
    state.connected = true
    state.connectedAt = Date.now()
    state.lastError = ''
    retryDelay = 1000
    // 连上了就把「连不上」的状态清掉：下次再断，才能重新记一条
    wsDownLogged = false
    note('ws', `已连接 ${state.url}`)
  }

  socket.onmessage = (event) => {
    state.events += 1
    let data
    try {
      data = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
    } catch (error) {
      note('ws', `事件解析失败：${error instanceof Error ? error.message : error}`)
      return
    }
    if (data === null || typeof data !== 'object') return
    if (data.post_type === 'message') {
      state.messages += 1
      note('ws', `收到消息事件 type=${data.message_type} from=${data.user_id ?? '?'}`)
    }
    if (typeof onEvent === 'function') {
      try {
        onEvent(data)
      } catch (error) {
        note('ws', `处理事件出错：${error instanceof Error ? error.message : error}`)
      }
    }
  }

  socket.onerror = (event) => {
    // undici 的 error 事件不带详细信息，只记个类型
    state.lastError = `websocket error${event?.error?.message !== undefined ? `: ${event.error.message}` : ''}`
    // 不在这里 note：紧接着的 onclose 一定会跟一条「连接断开」，
    // 两条都记就是每轮重连刷两行。onclose 那条信息更全。
  }

  socket.onclose = (event) => {
    state.connected = false
    const code = event?.code ?? '?'
    const reason = event?.reason !== undefined && event.reason !== '' ? ` reason=${event.reason}` : ''
    // 1006 = 异常断开（对端没正常关闭）。协议端还没 listen 时连过去就是这个码，
    // 属于「等一等就好」，不逐次刷屏 —— 只在状态变化时记一条。
    if (code === 1006 && state.connected === false && wsDownLogged) {
      scheduleReconnect()
      return
    }
    wsDownLogged = true
    note('ws', `连接断开 code=${code}${reason}`)
    scheduleReconnect()
  }
}

/**
 * 启动 WS 客户端。
 * @param {(event: any) => void} handler 事件回调
 * @returns {() => void} 停止函数
 */
export function startWs(handler) {
  onEvent = handler
  stopped = false
  retryDelay = 1000
  connect()
  return () => {
    stopped = true
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    try {
      if (socket !== null) socket.close()
    } catch {
      /* 忽略 */
    }
    socket = null
    state.connected = false
  }
}
