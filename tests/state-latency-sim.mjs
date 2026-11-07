/**
 * state-latency-sim.mjs —— /state 在协议端挂死时不能拖住设置页（2026-11-06）
 *
 * 用户报：「似乎没连上 SnowLuma 会导致卡加载中…很久」。
 *
 * 根因：/state 开头三次**串行** await 问 OneBot（好友 / 群 / 登录信息），
 * 各带 8 秒超时 → 最坏 24 秒。而前端 reload() 在那之前一直停在「加载中…」。
 * 关键荒唐之处：/state 其余 90% 的内容全是本地数据，却为了三个装饰性字段
 * （昵称 / 群名 / 机器人自己是谁）被拖住。
 *
 * 这个测试真的**跑一遍 /state handler**，用挂死的 fetch 计时。
 * 不测源码字符串 —— 那抓不住「把 Promise.all 改回串行」这种回退。
 *
 * ⚠️ 只在隔离 HOME 下跑：node tests/run-isolated.mjs tests/state-latency-sim.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-state-latency-'))
const DATA = join(HOME, '.dsh')
mkdirSync(DATA, { recursive: true })
process.env.USERPROFILE = HOME
process.env.HOME = HOME
process.on('exit', () => { try { rmSync(HOME, { recursive: true, force: true }) } catch {} })
writeFileSync(join(DATA, 'qq-bridge.config.json'), JSON.stringify({
  enabled: true, selfUin: '1000000002', peerUin: '1000000001', ownerUin: '1000000001',
  onebotHttp: 'http://127.0.0.1:9/', token: 'test-token',
  workspaceCwd: '', groupUins: [], routes: { private: {}, group: {} },
  wsEnabled: false, proactiveEnabled: false, memoryEnabled: false
}, null, 2), 'utf8')

const PLUGIN = join(import.meta.dirname, '..')

let passed = 0
let failed = 0
function ok(cond, name) {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.error(`  ✗ ${name}`) }
}

/**
 * 挂死的 fetch：直到 AbortSignal 触发才 reject。
 * 记录每次调用收到的 signal 里有没有 timeout，以及调用时机。
 */
const calls = []
globalThis.fetch = (url, opts) => new Promise((_resolve, reject) => {
  const started = Date.now()
  calls.push({ url, started, signal: opts?.signal })
  const signal = opts?.signal
  if (signal) {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })))
  }
  // 不给 resolve —— 模拟 SnowLuma 端口没 listen / 挂死
})

let handler = null
const ctx = {
  get(key) {
    if (key === 'webServer') return { register: (def) => { handler = def.handler } }
    if (key === 'agents') return { get: () => undefined, resume: async () => undefined }
    if (key === 'tools') return { register: () => {} }
    if (key === 'sessions') return { list: () => [] }
    if (key === 'sessionTitle') return { get: () => '' }
    return undefined
  },
  effect() {},
  on() {}
}

const mod = await import(`${pathToFileURL(join(PLUGIN, 'lib', 'index.js')).href}?t=${Date.now()}`)
mod.apply(ctx)

if (handler === null) {
  console.error('API 没注册上')
  process.exit(1)
}

const res = {
  statusCode: 0,
  setHeader() {},
  writeHead(code) { this.statusCode = code },
  end(text) { this.body = text }
}

console.log('\n1. 协议端完全挂死时 /state 仍然能返回（不能把设置页拖死）：')
// apply() 启动时探活/自动发现也可能发请求（不算在 /state 里）。
// 只统计**这次 handler 调用期间**的，别把启动那几次混进来。
calls.length = 0
const t0 = Date.now()
await handler({ url: '/api/qq-bridge/state', method: 'GET' }, res)
const elapsed = Date.now() - t0
console.log(`  耗时 ${elapsed}ms，期间 ${calls.length} 次协议调用`)

ok(res.statusCode === 200, `HTTP 200（实际 ${res.statusCode}）`)
let data = null
try { data = JSON.parse(res.body) } catch (e) { console.log('  解析失败:', e.message) }
ok(data !== null && data.ok === true, '返回 ok:true')
ok(elapsed < 6000, `耗时远小于串行的 24 秒（实际 ${elapsed}ms，上限 6000ms）`)

console.log('\n2. 三次协议调用是并发的，不是一个等一个：')
ok(calls.length === 3, `正好 3 次调用（实际 ${calls.length}）`)
if (calls.length === 3) {
  const spread = Math.max(...calls.map(c => c.started)) - Math.min(...calls.map(c => c.started))
  console.log(`  三次起始时间差 ${spread}ms`)
  ok(spread < 500, `三次几乎同时发出（差 ${spread}ms，串行会是 1500ms+）`)
}

console.log('\n3. 每次都带短超时（不是全局 8 秒）：')
// 从挂死到全部放弃的总耗时 ≈ 单次超时，说明是 1.5 秒而不是 8 秒
ok(elapsed < 4000, `总耗时接近单次短超时而非 8 秒（实际 ${elapsed}ms）`)
ok(calls.every(c => c.signal !== undefined), '每次调用都带了 AbortSignal')

console.log('\n4. 拿不到协议端数据时，本地那部分照样完整（这是 /state 的主体）：')
ok(data !== null && Array.isArray(data.sessions), 'sessions 字段在（本地扫盘）')
ok(data !== null && data.config !== undefined, 'config 字段在')
ok(data !== null && data.routes !== undefined, 'routes 字段在')
ok(data !== null && data.runtime !== undefined, 'runtime 字段在（版本/pid）')
ok(data !== null && data.toolSizes !== undefined, 'toolSizes 字段在')
ok(data !== null && Array.isArray(data.friends) && data.friends.length === 0, 'friends 降级成空数组')
ok(data !== null && Array.isArray(data.groups) && data.groups.length === 0, 'groups 降级成空数组')
ok(data !== null && (data.self === null || data.self === undefined), 'self 降级成 null')

console.log('\n5. 前端有「加载慢」的提示（不是干等一个「加载中…」）：')
{
  const { readFileSync } = await import('node:fs')
  const clientSrc = readFileSync(join(PLUGIN, 'lib', 'client.js'), 'utf8')
  ok(/setTimeout\(function \(\) \{[\s\S]{0,600}?没连上 SnowLuma/.test(clientSrc), '超过 2 秒会显示「可能没连上 SnowLuma」')
  ok(clientSrc.includes('clearSlowTimer'), '成功/失败/卸载时都会清掉计时器')
  ok(/return clearSlowTimer/.test(clientSrc), '组件卸载时清计时器')
  ok(/msg === '' \? null/.test(clientSrc), 'loading 分支会显示那句提示')
}

console.log(`\n${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
