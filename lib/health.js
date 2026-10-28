/**
 * health.js —— OneBot 协议端探活 + 错误分级。
 *
 * 背景（2026-10-28 实测）：
 *   DSH 重启（09:45:39）早于 QQ 登录完成（09:47:38），
 *   而 SnowLuma 的 OneBot 端口（3000/3001）**是等 QQ 登录成功之后才 listen 的**。
 *   中间那两分钟，插件对着一扇还没开的门反复敲：
 *     - HTTP 轮询每 4 秒一次 × 2 个号 = 每 4 秒两条 timeout
 *     - WS 连不上，1006 断连，退避重连 6 次才接上
 *   结果就是 qq-bridge-load.log 里塞满了噪音，真出问题时反而不好找。
 *
 * 这里做两件事：
 *   1. 探活门控：启动时先确认 OneBot 能应答，再放行轮询与 WS；
 *   2. 错误分级：把「门还没开」（连接类）和「门开着但出错」（业务类）分开，
 *      前者不写 lastError、不刷日志，后者照旧报错。
 *
 * ⚠️ 门控只延后**入站**通路，不拦工具注册：
 *   qq_send 这类工具在协议端没起来时也该注册好，
 *   等端点通了立刻能用；反之则会在 QQ 还没登录的窗口里让 agent 看不到工具。
 */
import { getConfig } from './config.js'
import { note } from './env.js'
import { callOneBot } from './onebot.js'

/**
 * 判断一个错误是不是「连接类」错误 —— 也就是门还没开 / 网络断了。
 *
 * 连接类错误的含义：**不是插件的 bug，也不是业务失败**，重试就好。
 * 所以它们不该写进 state.lastError（那个字段是给设置页看的，
 * 写满了会让人以为插件坏了），也不该逐条刷日志。
 *
 * 业务类错误（retcode != 0、HTTP 非 2xx、被封禁的 action）才是真问题，照旧上报。
 */
export function isConnectionError(error) {
  if (error === null || error === undefined) return false
  const message = error instanceof Error ? error.message : String(error)
  // fetch 连不上：Node 抛 TypeError: fetch failed，cause 里带具体 errno
  const cause = error.cause
  const code = cause !== undefined && cause !== null ? String(cause.code ?? '') : ''
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE' || code === 'EHOSTUNREACH') {
    return true
  }
  if (message.includes('fetch failed')) return true
  if (message.includes('The operation was aborted due to timeout')) return true
  if (message.includes('socket hang up')) return true
  if (message.includes('network error')) return true
  return false
}

/**
 * 探一次 OneBot 活不活。
 *
 * 用 get_login_info 而不是 get_status：
 *   - get_status 在端点刚 listen 但 QQ 还没登录时也可能返回 ok，不够严格；
 *   - get_login_info 要真的进了 QQ 才会应答，才是「能干活了」的准信儿。
 *
 * @returns {Promise<{ok: boolean, reason: string}>}
 */
export async function probeOneBot() {
  const config = getConfig()
  if (String(config.onebotHttp ?? '').trim() === '') {
    return { ok: false, reason: '未配置 OneBot 地址' }
  }
  try {
    const result = await callOneBot({ action: 'get_login_info' })
    if (result?.retcode === 0) return { ok: true, reason: '' }
    return { ok: false, reason: `retcode=${result?.retcode ?? '?'} ${result?.wording ?? result?.message ?? ''}`.trim() }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 启动门控：等 OneBot 真的能应答了再放行入站通路。
 *
 * 退避节奏：1s → 1.5s → 2.2s → 3.3s → 5s → 5s……（上限 5s），
 * 总超时默认 60s —— 超过这个点还没通，就**照样放行**：
 * 与其让桥接彻底不动，不如让它在轮询里继续重试（轮询本身有错误分级，不吵）。
 *
 * @param {{timeoutMs?: number, onReady?: (info: object) => void, onGiveUp?: (info: object) => void}} options
 * @returns {Promise<boolean>} true = 已就绪；false = 超时未就绪（调用方仍应继续启动）
 */
export async function waitForOneBotReady(options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs ?? 60000))
  const started = Date.now()
  let delay = 1000
  let attempts = 0
  let lastReason = ''

  while (Date.now() - started < timeoutMs) {
    attempts += 1
    const probe = await probeOneBot()
    if (probe.ok) {
      if (attempts > 1) note('health', `OneBot 已就绪（第 ${attempts} 次探测，用时 ${Date.now() - started}ms）`)
      else note('health', 'OneBot 已就绪')
      if (typeof options.onReady === 'function') options.onReady({ attempts, elapsedMs: Date.now() - started })
      return true
    }
    lastReason = probe.reason
    // 只有第一次失败才记日志：后面每次都记的话，又变成刷屏了
    if (attempts === 1) note('health', `OneBot 未就绪（${lastReason}），等待重试`)
    await new Promise((resolve) => setTimeout(resolve, delay))
    delay = Math.min(5000, Math.round(delay * 1.5))
  }

  note('health', `OneBot ${timeoutMs}ms 内未就绪（${lastReason}），照样启动，交给轮询重试`)
  if (typeof options.onGiveUp === 'function') options.onGiveUp({ attempts, elapsedMs: Date.now() - started, reason: lastReason })
  return false
}
