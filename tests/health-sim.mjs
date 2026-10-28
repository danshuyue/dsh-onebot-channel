/**
 * 探活门控 + 错误分级专项测试：node tests/health-sim.mjs，退出码 0 = 全过。
 *
 * 覆盖三块：
 *   1. isConnectionError —— 把「门还没开」和「门开着但出错」分对
 *   2. probeOneBot —— 探活的成功/失败判定
 *   3. waitForOneBotReady —— 退避节奏 + 超时后照样放行
 *
 * 背景（2026-10-28 实测）：
 *   SnowLuma 的 OneBot 端口是等 QQ 登录完成之后才 listen 的，
 *   DSH 重启比 QQ 登录早约 2 分钟，中间全是 timeout / 1006 噪音。
 *
 * 不连真 SnowLuma —— 用假 fetch 顶替。
 */
let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}`)
  }
}
function eq(actual, expected, name) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, `${name}${same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`)
}

// ---- 1. 错误分级 ----

console.log('isConnectionError：')
{
  const { isConnectionError } = await import('../lib/health.js')

  // 真·连接类：端口没开门
  const refused = new TypeError('fetch failed')
  refused.cause = { code: 'ECONNREFUSED' }
  ok(isConnectionError(refused) === true, 'ECONNREFUSED 算连接类')

  const reset = new TypeError('fetch failed')
  reset.cause = { code: 'ECONNRESET' }
  ok(isConnectionError(reset) === true, 'ECONNRESET 算连接类')

  // 超时（Node 的 AbortSignal.timeout 抛的就是这个）
  ok(
    isConnectionError(new Error('The operation was aborted due to timeout')) === true,
    '超时算连接类'
  )
  ok(isConnectionError(new Error('fetch failed')) === true, '裸 fetch failed 算连接类')
  ok(isConnectionError(new Error('socket hang up')) === true, 'socket hang up 算连接类')

  // 真·业务类：门开着，但协议端说不行 —— 这些必须照旧上报
  ok(isConnectionError(new Error('retcode=1401 unauthorized')) === false, 'retcode 错误不算连接类')
  ok(isConnectionError(new Error('OneBot HTTP 500')) === false, 'HTTP 5xx 不算连接类')
  ok(
    isConnectionError(new Error('已封禁的 action：get_cookies —— 会交出账号登录态')) === false,
    '被封禁的 action 不算连接类'
  )

  ok(isConnectionError(null) === false, 'null 不算连接类')
  ok(isConnectionError(undefined) === false, 'undefined 不算连接类')
}

// ---- 2 & 3. 探活 ----

console.log('\nprobeOneBot / waitForOneBotReady：')
{
  const { probeOneBot, waitForOneBotReady } = await import('../lib/health.js')
  const { getConfig } = await import('../lib/config.js')
  const config = getConfig()
  // 探活要拿到 token，否则 callOneBot 会带空 Bearer 去敲门
  const originalToken = config.token
  const originalHttp = config.onebotHttp
  config.token = 'test-token'
  config.onebotHttp = 'http://127.0.0.1:3000/'

  const realFetch = globalThis.fetch

  // 场景一：端点正常应答 get_login_info → 探活成功
  {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ status: 'ok', retcode: 0, data: { user_id: 3655191092, nickname: '洛殿下' } })
    })
    const probe = await probeOneBot()
    ok(probe.ok === true, '端点应答时探活成功')
    eq(probe.reason, '', '成功时没有原因')
  }

  // 场景二：端点答了但 retcode 不为 0 → 不算就绪
  {
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ status: 'failed', retcode: 1401, wording: 'unauthorized' })
    })
    const probe = await probeOneBot()
    ok(probe.ok === false, 'retcode 不为 0 时探活失败')
    ok(probe.reason.includes('1401'), `失败原因带上了 retcode（实际 ${probe.reason}）`)
  }

  // 场景三：端点连不上 → 抛错，探活捕获并判失败
  {
    globalThis.fetch = async () => {
      const error = new TypeError('fetch failed')
      error.cause = { code: 'ECONNREFUSED' }
      throw error
    }
    const probe = await probeOneBot()
    ok(probe.ok === false, '连不上时探活失败（而不是把异常抛出去）')
    ok(probe.reason.includes('fetch failed'), `失败原因带上了原始错误（实际 ${probe.reason}）`)
  }

  // 场景四：waitForOneBotReady —— 第 3 次探测才成功
  {
    let calls = 0
    globalThis.fetch = async () => {
      calls += 1
      if (calls < 3) {
        const error = new TypeError('fetch failed')
        error.cause = { code: 'ECONNREFUSED' }
        throw error
      }
      return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { user_id: 1 } }) }
    }
    let readyInfo = null
    const ready = await waitForOneBotReady({
      timeoutMs: 10000,
      onReady: (info) => { readyInfo = info }
    })
    ok(ready === true, '重试到成功时返回 true')
    ok(calls === 3, `探测了 3 次（实际 ${calls}）`)
    ok(readyInfo !== null && readyInfo.attempts === 3, 'onReady 带出了尝试次数')
  }

  // 场景五：一直连不上 → 超时后返回 false，但**必须放行**（不能把插件卡死）
  {
    globalThis.fetch = async () => {
      const error = new TypeError('fetch failed')
      error.cause = { code: 'ECONNREFUSED' }
      throw error
    }
    let gaveUp = null
    const started = Date.now()
    const ready = await waitForOneBotReady({
      timeoutMs: 1200,
      onGiveUp: (info) => { gaveUp = info }
    })
    const elapsed = Date.now() - started
    ok(ready === false, '一直连不上时返回 false')
    ok(gaveUp !== null, '触发了 onGiveUp 回调')
    ok(elapsed >= 1200, `等满了超时时间（实际 ${elapsed}ms）`)
    // 关键：返回 false 只是「没探到」，调用方仍要启动入站通路
    ok(typeof ready === 'boolean', '返回值是布尔，调用方可以据此决定是否照样启动')
  }

  globalThis.fetch = realFetch
  config.token = originalToken
  config.onebotHttp = originalHttp
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed > 0 ? 1 : 0)
