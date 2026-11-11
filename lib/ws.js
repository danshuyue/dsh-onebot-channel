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
import { note, noteCoalesced } from './env.js'

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
  // ⚠️ 重连日志要**合并**（2026-11-09 复查发现）：
  //   协议端长期不可达时（用户挂起虚拟机、SnowLuma 没开），这里每 10~15 秒打一行，
  //   实测一轮挂起刷了 **58 行**，把日志从 1 MB 顶到 2.2 MB，淹掉真正要看的转发记录。
  //   `onclose` 那边的 1006 去重只挡「断开」那一行，挡不住这里的重连尝试。
  //   策略：第 1 次、第 10 次、之后每 50 次打一行 —— 既看得出它还在重试，
  //   又不至于把日志刷爆。恢复连接时 `onopen` 会把 reconnectLogged 清掉。
  const n = state.reconnects
  if (n === 1 || n === 10 || n % 50 === 0) {
    const suffix = n === 1 ? '' : `（累计已重连 ${n} 次，同类日志已合并）`
    note('ws', `${Math.round(delay / 1000)} 秒后重连（第 ${n} 次）${suffix}`)
  }
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

  // ⚠️ 这里**不能**再写 `let socket = null`（2026-11-06 修）。
  //    以前写了一个同名的局部变量，遮蔽了模块级那个（第 17 行）——
  //    事件回调靠闭包捕获局部变量所以功能正常，但 startWs() 返回的停止函数
  //    读的是**模块级** socket，它永远是 null → 插件停止/热重载时关不掉连接，
  //    残留一个 TCP。现在直接赋值给模块级变量。
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
      // ⚠️ 改成合并日志（2026-11-08）：原来**每一条 QQ 消息**都写一行，
      //   实测用户日志里这一种刷了 9,740 行（占整份日志 53%）—— 淹掉了真正要看的转发记录。
      //   按「群 / 私聊」分开合并：群消息量巨大、私聊很少，合在一起会让私聊的日志被群压没。
      //   合并后仍然看得出「哪个群在持续来消息」，只是不再逐条。
      const scope = String(data.message_type ?? '?') === 'group'
        ? `group:${data.group_id ?? '?'}`
        : `private:${data.user_id ?? '?'}`
      noteCoalesced('ws', `wsmsg:${scope}`, `收到消息事件 type=${data.message_type} from=${data.user_id ?? '?'}`)
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
    //
    // ⚠️ 这里的 `state.connected === false` 是**冗余但无害**的（2026-11-06 核验过）：
    //    上一行刚把它置成 false，所以这个子条件恒真，整个判断退化成 `1006 && wsDownLogged`。
    //    但去重**并没有失效** —— 真正起作用的是 wsDownLogged，而它在 onopen 里被重置。
    //    两种写法（早先的 `state.connected === false` 与「先存旧值再比」）只在
    //    「wasConnected===true 且 wsDownLogged===true」时才有分歧，而那个状态不可达：
    //    wsDownLogged 只在 onclose 的落榜路径里置 true，那里同时把 connected 置成了 false。
    //    所以这不是 bug，是个能让读者困惑的写法。留着不改（改动是零行为差异的 no-op，
    //    不值得增加评审面）；真要改就是为了可读性，不是为了修故障。
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
