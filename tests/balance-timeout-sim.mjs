/**
 * balance-timeout-sim.mjs —— 余额卡的「超时」不能被当成「查不到」。
 *
 * ## 守的是什么
 *
 * 设置页「高级 → 语音合成 → 余额」经常显示「查不到」。根因不是 key 错，
 * 而是 `fetchBreezeAccount` 并发打 `/v1/balance` + `/v1/entitlements`，
 * 两条各自 15s 超时；而这两个接口**首次冷请求**（DNS + TLS + 上游冷启动）
 * 实测会偶发超过 15s（正常只要 2.7s / 3.3s）。一次抖动就整块失败。
 *
 * 所以这里断言的是三件**行为**上的事：
 *   ① 超时会重试，重试成功就照常出余额（不能因为一次抖动就报错）；
 *   ② 重试只针对超时 —— 401/403 是配错了，重试只会把一次误配变成两次请求；
 *   ③ 真的两次都超时，错误对象要能被前端识别（`timeout: true` + 「刷新」的引导）。
 *
 * ⚠️ 本测试**不打网络**：fetch 被替换成可控的假实现。
 * ⚠️ 不测真实的 25s 等待 —— 那会让测试跑上半分钟。超时时长用源码断言兜底，
 *    主断言（有没有重试、重试几次、结果形状）全是行为断言。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { useIsolatedHome } from './isolated-home.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// 设置页源码：第 2 组断言要验「前端把超时翻译成什么话」（服务端那句是中性共用的）
const clientSrc = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
// 隔离 HOME：见 tests/isolated-home.mjs（本机沙箱只有工作区根下的 .tmp-test 能建目录）
useIsolatedHome('balance-timeout-')

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}${extra ? '　' + extra : ''}`) }
  else { fail += 1; console.log(`  ✗ ${label}${extra ? '　' + extra : ''}`) }
}

// ---- 假 fetch：按「计划」逐次返回/抛错，并把出站请求整个记下来 ----
const BALANCE = '{"settlement_pending":false,"settlement_interval_seconds":60,"balance":1928.0,'
  + '"balance_millicredits":1928000,"scale":1000}'
const ENTITLEMENTS = '{"plan_code":"free","status":"free","max_concurrent_generations":1,'
  + '"commercial_use_allowed":false}'

/** 造一个和 `AbortSignal.timeout()` 抛出来同款的错误。 */
function abortError() {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

const calls = []
/**
 * @param {(n:number, url:string) => 'abort'|'ok'|'401'} plan 第 n 次（从 1 起）调用该怎么响应
 */
function installFetch(plan) {
  calls.length = 0
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    const verdict = plan(calls.length, String(url))
    if (verdict === 'abort') throw abortError()
    if (verdict === '401') {
      return {
        ok: false,
        status: 401,
        headers: { get: () => 'application/json' },
        text: async () => '{"ok":false,"code":"AUTH_INVALID","detail":"invalid api key"}'
      }
    }
    const isBalance = String(url).includes('/v1/balance')
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      text: async () => (isBalance ? BALANCE : ENTITLEMENTS)
    }
  }
}

const tts = await import('../lib/tts.js')

// ==================== 1. 首轮超时 → 重试成功 ====================
console.log('\n1. 两条请求首轮都超时 → 各自重试一次 → 余额照常出来：')
{
  // 第 1、2 次是首轮的 balance + entitlements（并发，各一次），
  // 第 3、4 次是两边的重试 —— 所以计划里前两次抛 AbortError。
  installFetch((n) => (n <= 2 ? 'abort' : 'ok'))
  const result = await tts.fetchBreezeAccount('brz_testkey')
  ok(result.ok === true, '最终成功（没被一次抖动打成「查不到」）',
    result.ok === true ? `余额 ${result.balance}` : result.error)
  ok(result.balance === 1928, '余额解析正确（浮点，不是整数）', String(result.balance))
  ok(result.plan === 'free', '权益照常合并进来', result.plan)
  ok(calls.length === 4, '⚠️ 总共 4 次请求（balance / entitlements 各两次）', `实际 ${calls.length}`)
  const urls = calls.map((c) => new URL(c.url).pathname)
  ok(urls.filter((p) => p === '/v1/balance').length === 2, 'balance 打了两次')
  ok(urls.filter((p) => p === '/v1/entitlements').length === 2, 'entitlements 打了两次')
}

// ==================== 2. 连续两次都超时 ====================
console.log('\n2. 两次都超时 → 失败，但要能被识别成「超时」：')
{
  installFetch(() => 'abort')
  const result = await tts.fetchBreezeAccount('brz_testkey')
  ok(result.ok === false, '确实失败')
  ok(result.timeout === true, '⚠️ timeout 标记为 true（前端据此提示重试，而不是「key 错了」）')
  ok(String(result.error).includes('超时'), '文案里有「超时」', result.error)
  // 「点刷新」这类**具体引导**由前端给（它才知道自己是余额卡还是音色搜索）：
  // 服务端这句话是余额/权益/音色搜索共用的，写死「点刷新再试」会在音色搜索结果里
  // 变成一句莫名其妙的话。所以这里验前端那份文案，而不是要求服务端说「刷新」。
  //
  // ⚠️ 用正则匹配「意图」而不是整句：0.20.0 只是把「Breeze 响应太慢」改成
  //    「Breeze **这次**响应太慢」（用户报「余额显示文字不对」时顺带润色），
  //    按整句精确匹配就会为一次无害的文案改动变红 —— 那种红会训练人去改断言，
  //    而不是去看行为。要锁住的是三件事都在：说了超时、指向刷新、没说成「查不到」。
  const timeoutLine = (clientSrc.match(/超时了[^']*/) ?? [''])[0]
  ok(timeoutLine.includes('超时') && timeoutLine.includes('刷新'),
    `前端余额卡把超时翻译成「点刷新再试」（实际：${timeoutLine || '没找到'}）`)
  ok(calls.length === 4, '仍然只重试一次，不是无限重试', `实际 ${calls.length}`)
}

// ==================== 3. 非超时错误 → 不重试 ====================
console.log('\n3. 401（配错了）→ 不重试：')
{
  installFetch(() => '401')
  const result = await tts.fetchBreezeAccount('brz_badkey')
  ok(result.ok === false, '失败')
  ok(result.timeout !== true, '⚠️ 没有 timeout 标记（不是超时）', String(result.timeout))
  ok(calls.length === 2, '⚠️ 只请求 2 次 —— 401 重试一百次也一样，白打两遍只是多一行日志',
    `实际 ${calls.length}`)
  ok(String(result.error).includes('401'), '错误里保留了 HTTP 状态', result.error)
}

// ==================== 4. 超时时长确实是放大的那个 ====================
console.log('\n4. 请求带 signal，且用的是账户专用超时（不是默认 15s）：')
{
  installFetch(() => 'ok')
  await tts.fetchBreezeAccount('brz_testkey')
  ok(calls.length === 2, '两条请求各一次（都成功，不重试）', `实际 ${calls.length}`)
  ok(calls.every((c) => c.init?.signal instanceof AbortSignal), '每次请求都带了 AbortSignal')
  ok(calls.every((c) => c.init?.signal?.aborted === false), '请求发出时 signal 还没中止')

  // 源码断言作为补充：真实的 25s 等待没法放进测试（会慢半分钟），
  // 但「是不是真的放大了、有没有误伤音色搜索」必须留一道闸。
  const source = readFileSync(join(ROOT, 'lib', 'tts.js'), 'utf8')
  ok(/const ACCOUNT_TIMEOUT_MS = 25000/.test(source), '账户超时常量是 25000ms')
  ok(/breezeGetWithTimeoutRetry\('\/v1\/balance', \{ key, timeoutMs: ACCOUNT_TIMEOUT_MS \}\)/.test(source),
    '/v1/balance 用的是 ACCOUNT_TIMEOUT_MS')
  ok(/breezeGetWithTimeoutRetry\('\/v1\/entitlements', \{ key, timeoutMs: ACCOUNT_TIMEOUT_MS \}\)/.test(source),
    '/v1/entitlements 用的是 ACCOUNT_TIMEOUT_MS')
  // ⚠️ 默认值不能被顺手改大：`/v1/voices`（音色搜索）也走 breezeGet，
  //    那里等 25 秒只会让设置页更迟钝。
  ok(/timeoutMs = 15000/.test(source), '⚠️ breezeGet 的默认超时仍是 15000（音色搜索不受影响）')
}

// ==================== 5. 原有语义不能被重试改掉 ====================
console.log('\n5. 余额失败 = 整体失败；权益失败只少两个数字：')
{
  // 余额那条永远超时（首轮 + 重试都 abort），权益正常
  installFetch((n, url) => (url.includes('/v1/balance') ? 'abort' : 'ok'))
  const noBalance = await tts.fetchBreezeAccount('brz_testkey')
  ok(noBalance.ok === false, '余额拿不到 → 整个失败（这条语义没变）')
  ok(noBalance.timeout === true, '失败仍然是「超时」那一类')

  // 反过来：余额正常，权益永远超时
  installFetch((n, url) => (url.includes('/v1/entitlements') ? 'abort' : 'ok'))
  const noEntitlements = await tts.fetchBreezeAccount('brz_testkey')
  ok(noEntitlements.ok === true, '⚠️ 权益拿不到**不**拖垮余额查询', String(noEntitlements.error))
  ok(noEntitlements.balance === 1928, '余额照常返回', String(noEntitlements.balance))
  ok(noEntitlements.plan === '（未知）', '缺权益时档位显示「（未知）」而不是 undefined', noEntitlements.plan)
  ok(noEntitlements.concurrency === 1, '并发上限退回 1', String(noEntitlements.concurrency))
}

console.log(`\n${pass} 过 / ${fail} 败`)
process.exit(fail === 0 ? 0 : 1)
