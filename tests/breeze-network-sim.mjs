/** 无付费/公网请求：假 fetch 验 TTS，回环代理验 dispatcher 真正接线。 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useIsolatedHome } from './isolated-home.mjs'
const home = useIsolatedHome('breeze-network-')
const { parseWindowsProxy, proxySettings, networkFailure, breezeRoute } = await import('../lib/breeze-net.js')
const { getGlobalDispatcher } = await import('undici')
const globalDispatcher = getGlobalDispatcher()
const beforeEnv = { ...process.env }
const nativeFetch = globalThis.fetch
let count = 0
function check(value, label) { assert.ok(value, label); count++; console.log(`  ✓ ${label}`) }
const registry = '    ProxyEnable    REG_DWORD    0x1\n    ProxyServer    REG_SZ    127.0.0.1:7897\n'
check(parseWindowsProxy(registry) === 'http://127.0.0.1:7897/', '读取启用的 Windows 静态代理')
check(parseWindowsProxy(registry.replace('0x1', '0x0')) === '', '关闭系统代理时不启用')
check(parseWindowsProxy(registry.replace('127.0.0.1:7897', 'http=host:80;https=secure:81')) === 'http://secure:81/', '系统协议映射优先 HTTPS')
check(parseWindowsProxy(registry.replace('127.0.0.1:7897', 'socks5://host:90')) === '', '不将 SOCKS 误当 HTTP 代理')
check(parseWindowsProxy('AutoConfigURL REG_SZ http://pac.invalid') === '', '不执行 PAC 或猜端口')
check(proxySettings({ HTTPS_PROXY: 'http://explicit:80', NO_PROXY: '*' }, 'http://system:81').httpsProxy === 'http://explicit:80', '显式环境优先于系统代理')
check(proxySettings({ https_proxy: 'http://lower:80', HTTPS_PROXY: 'http://upper:81' }).httpsProxy === 'http://lower:80', '小写环境变量优先')
check(proxySettings({ HTTP_PROXY: 'http://only:80' }).httpsProxy === 'http://only:80', '仅 HTTP_PROXY 时 HTTPS 也可使用')
const secret = 'brz_test_SECRET_never_log'
const cause = Object.assign(new Error(secret + ' https://user:password@proxy.invalid/'), { code: 'UND_ERR_CONNECT_TIMEOUT' })
const error = new TypeError('fetch failed', { cause })
const classified = networkFailure(error)
check(classified.timeout && classified.message.includes('UND_ERR_CONNECT_TIMEOUT'), '保留嵌套连接超时错误码')
check(!JSON.stringify(classified).includes(secret) && !JSON.stringify(classified).includes('password'), '诊断白名单不泄露错误 message 中的凭据')
const aggregate = new AggregateError([Object.assign(new Error(), { code: 'ENOTFOUND' })], 'fetch failed')
aggregate.cause = aggregate
check(networkFailure(aggregate).message.includes('DNS'), 'AggregateError 分支可分类且循环 cause 不死循环')

let proxyHits = 0
const origin = createServer((req, res) => { res.writeHead(200); res.flushHeaders(); setTimeout(() => res.end('local-only'), 15) })
const proxy = createServer((req, res) => { proxyHits++; res.end('local-only') })
proxy.on('connect', (req, socket, head) => {
  proxyHits++
  const upstream = connect(origin.address().port, '127.0.0.1', () => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length) upstream.write(head)
    upstream.pipe(socket); socket.pipe(upstream)
  })
  socket.on('error', () => upstream.destroy())
  socket.on('close', () => upstream.destroy())
  upstream.on('error', () => socket.destroy())
})
await Promise.all([new Promise(r => origin.listen(0, '127.0.0.1', r)), new Promise(r => proxy.listen(0, '127.0.0.1', r))])
let dispatcher
try {
  for (const k of ['http_proxy', 'https_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) delete process.env[k]
  process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.address().port}`
  process.env.HTTP_PROXY = process.env.HTTPS_PROXY
  process.env.NO_PROXY = '127.0.0.1'
  const [route, concurrent] = await Promise.all([breezeRoute(), breezeRoute()])
  dispatcher = route.dispatcher
  check(dispatcher !== concurrent.dispatcher && !dispatcher.closed && !concurrent.dispatcher.closed, '并发请求独立拥有 Agent，不互相关闭')
  await concurrent.dispatcher.close()
  // 模拟另一回合在路由分配与 fetch 之间切换配置。
  process.env.HTTPS_PROXY += '/'
  const switched = await breezeRoute()
  check(!dispatcher.closed && !switched.dispatcher.closed, '切换配置不关闭已发放但尚未使用的路由')
  await switched.dispatcher.close()
  check(route.source === 'env-proxy' && dispatcher, '显式代理生成每请求 dispatcher')
  const proxied = await nativeFetch('http://breeze.invalid/', { dispatcher, signal: AbortSignal.timeout(3000) })
  check(await proxied.text() === 'local-only' && proxyHits === 1, '不可直连域名实际经回环代理到达（非只断言字符串）')
  const bypass = await nativeFetch(`http://127.0.0.1:${origin.address().port}/`, { dispatcher, signal: AbortSignal.timeout(3000) })
  check(await bypass.text() === 'local-only' && proxyHits === 1, 'NO_PROXY 绕过代理')
  check(getGlobalDispatcher() === globalDispatcher, '没有替换宿主全局 dispatcher')
  const streamedRoute = await breezeRoute()
  const streamed = await nativeFetch('http://breeze.invalid/', { dispatcher: streamedRoute.dispatcher, signal: AbortSignal.timeout(3000) })
  const closing = streamedRoute.dispatcher.close()
  check(await streamed.text() === 'local-only', 'graceful close 在响应头后调用仍可完整读取延迟 body')
  await closing

  const tts = await import('../lib/tts.js')
  let calls = []
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); throw error }
  const config = { voiceBreezeKey: secret, voiceBreezeVoice: 'voc_testvoice' }
  const failed = await tts.synthesizeBreeze({ text: '你好', config })
  check(!failed.ok && calls.length === 1, '合成 POST 连接失败不自动重放')
  check(calls[0].init.dispatcher && calls[0].init.dispatcher !== dispatcher, 'TTS POST 实际传入专用代理 dispatcher')
  check(failed.error.includes('UND_ERR_CONNECT_TIMEOUT'), 'TTS 返回可定位的 cause code')
  calls = []
  const query = await tts.fetchBreezeVoice(secret, 'voc_testvoice')
  check(!query.ok && query.timeout && calls.length === 1 && calls[0].init.dispatcher, '音色 GET 也走同一路由并保留嵌套超时标记：' + JSON.stringify(query))
  for (const status of [401, 402, 429]) {
    calls = []
    globalThis.fetch = async (url, init) => { calls.push({ url, init }); return { ok: false, status, text: async () => { throw Object.assign(new Error('body timeout'), { name: 'TimeoutError' }) } } }
    const rejected = await tts.fetchBreezeAccount(secret)
    check(!rejected.ok && rejected.status === status && rejected.timeout !== true && calls.length === 2, `HTTP ${status} 的 body 超时不能覆盖状态或触发重试`)
  }
  check(!dispatcher.closed, '其他请求的清理不关闭仍被调用方持有的路由')
  globalThis.fetch = async () => { throw Object.assign(new Error('network'), { code: 'TEST404' }) }
  const network404 = await tts.fetchBreezeVoice(secret, 'voc_testvoice')
  check(network404.error.includes('TEST404') && !network404.error.includes('没找到这个音色'), '错误码或请求 ID 含 404 不得伪装成 HTTP 404')
  globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => '{"code":"RESOURCE_NOT_FOUND"}' })
  check((await tts.fetchBreezeVoice(secret, 'voc_testvoice')).error.includes('没找到这个音色'), '真实 HTTP 404 仍返回音色不存在')
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => '{"code":"AUTH_INVALID"}' })
  const denied = await tts.synthesizeBreeze({ text: '你好', config })
  check(denied.error.includes('401') && !denied.error.includes('UND_ERR_CONNECT_TIMEOUT'), 'HTTP 拒绝与网络异常分开')
  globalThis.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => { throw Object.assign(new Error(secret), { code: 'ECONNRESET' }) } })
  const broken = await tts.synthesizeBreeze({ text: '你好', config })
  check(broken.error.includes('读不到 Breeze 的音频') && broken.error.includes('ECONNRESET'), '音频 body 错误单独记录')
  const log = readFileSync(join(home, '.dsh', 'qq-bridge-load.log'), 'utf8')
  check(log.includes('"stage":"request"') && log.includes('"stage":"audio-body"') && log.includes('elapsedMs') && log.includes('id='), '日志包含阶段、耗时及请求 ID')
  check(!log.includes(secret) && !log.includes('password'), '实际错误日志与返回值不含 key/代理密码')
  console.log(`\n${count} 过 / 0 败`)
} finally {
  globalThis.fetch = nativeFetch
  for (const key of Object.keys(process.env)) if (!(key in beforeEnv)) delete process.env[key]
  Object.assign(process.env, beforeEnv)
  await dispatcher?.close().catch(() => {})
  origin.closeAllConnections(); proxy.closeAllConnections()
  await Promise.all([new Promise(r => origin.close(r)), new Promise(r => proxy.close(r))])
}
