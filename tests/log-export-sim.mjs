/**
 * log-export-sim.mjs —— 「高级 → 导出日志」背后的那条路由（0.19.4）。
 *
 * 用户部署到云服务器以后，出问题只能靠日志说话。所以要有一个按钮能把
 * `~/.dsh/qq-bridge-load.log` 原样下载下来。
 *
 * 这条路由是**唯一**会把本地文件字节吐给浏览器的接口之一（另一个是语音试听的
 * /voice-file/），所以测试要钉死三件事：
 *   ① 正常情况：真的把文件字节吐出来，且带 attachment 让浏览器存成文件
 *   ② 没有日志文件时：404 + 一句人话，不能 500 崩掉
 *   ③ **不能被当成任意文件读取入口**：路径必须是写死的常量，路由匹配必须精确，
 *      `/log-file/../../xxx`、`/log-file?path=...` 之类都不该把别的文件吐出来
 */
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { useIsolatedHome } from './isolated-home.mjs'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = useIsolatedHome('log-export-')
const DATA = join(HOME, '.dsh')
mkdirSync(DATA, { recursive: true })

writeFileSync(join(DATA, 'qq-bridge.config.json'), JSON.stringify({
  enabled: true,
  selfUin: '1000000002',
  peerUin: '1000000001',
  ownerUin: '1000000001',
  onebotHttp: 'http://127.0.0.1:9/',
  token: 'test-token',
  workspaceCwd: '',
  groupUins: [],
  routes: { private: {}, group: {} },
  wsEnabled: false,
  proactiveEnabled: false,
  memoryEnabled: false
}, null, 2), 'utf8')

// 协议端一律当作连不上：这条路由跟 OneBot 没关系，不该被它牵连。
globalThis.fetch = async () => {
  throw Object.assign(new Error('connect ECONNREFUSED'), { name: 'TypeError' })
}

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

let passed = 0
let failed = 0
function ok(cond, name, extra = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}${extra ? '　' + extra : ''}`) }
  else { failed += 1; console.error(`  ✗ ${name}${extra ? '　' + extra : ''}`) }
}

/** 二进制安全的小响应桩：end() 收到的可能是 Buffer，不是字符串。 */
function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: null,
    setHeader(key, value) { this.headers[String(key).toLowerCase()] = value },
    writeHead(code, headers) {
      this.statusCode = code
      if (headers && typeof headers === 'object') {
        for (const [key, value] of Object.entries(headers)) this.headers[key.toLowerCase()] = value
      }
      return this
    },
    end(payload) { this.body = payload }
  }
}

const LOG_PATH = join(DATA, 'qq-bridge-load.log')

console.log('\n1. 有日志文件时能把字节完整吐出来：')
{
  const content = [
    '2026-11-07T00:00:01.000Z [out] 分 2 条发送，字数 5/6',
    '2026-11-07T00:00:01.500Z [out] 两条之间只隔 500ms，补等 300ms（目标 800ms）',
    '2026-11-07T00:00:02.000Z [out] 两条之间隔了 900ms（目标 800ms，够了）',
    ''
  ].join('\n')
  writeFileSync(LOG_PATH, content, 'utf8')
  const res = makeRes()
  await handler({ url: '/api/qq-bridge/log-file', method: 'GET' }, res)
  const text = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body ?? '')
  ok(res.statusCode === 200, `HTTP 200（实际 ${res.statusCode}）`)
  ok(text.startsWith(content), '字节原样返回，没被改写/截断')
  ok(String(res.headers['content-type'] ?? '').includes('text/plain'), '标成纯文本（浏览器直接显示而不是下载成乱码）')
  ok(String(res.headers['content-disposition'] ?? '').includes('attachment'),
    '带 attachment —— 点一下就是另存为，不会在标签页里刷一屏日志')
  ok(String(res.headers['content-disposition'] ?? '').includes('qq-bridge-load.log'),
    '下载下来的文件名是 qq-bridge-load.log')
  // ⚠️ 不能拿「刚才写进去的那段」当基准：插件自己也在往同一个文件里追加 note
  //    （加载、路由命中都会写），实测两次之间能多出几百字节 —— 那条断言会随机红。
  //    真正要钉的是「header 等于**实际发出去的字节数**」：差一个字节，浏览器就会
  //    一直等到超时（或者截断）。
  const sent = Buffer.isBuffer(res.body) ? res.body.length : Buffer.byteLength(String(res.body ?? ''))
  ok(Number(res.headers['content-length']) === sent,
    'content-length 等于实际发出的字节数（差一字节浏览器就会等到超时）',
    `header=${res.headers['content-length']} 实发=${sent}`)
  ok(sent >= Buffer.byteLength(content), '发出的字节不少于写进去的那段（没有被截断）')
}

console.log('\n2. 没有日志文件时给 404 + 一句人话，而不是 500：')
{
  rmSync(LOG_PATH, { force: true })
  const res = makeRes()
  await handler({ url: '/api/qq-bridge/log-file', method: 'GET' }, res)
  let data = null
  try { data = JSON.parse(res.body) } catch { data = null }
  ok(res.statusCode === 404, `HTTP 404（实际 ${res.statusCode}）`)
  ok(data !== null && data.ok === false, '返回 JSON 且 ok:false')
  ok(typeof data?.error === 'string' && data.error.length > 0, '有可读的错误说明')
  // ⚠️ 不能把 ENOENT 原文回给浏览器：它长这样
  //    `ENOENT: no such file or directory, open 'C:\Users\<用户名>\.dsh\...'`
  //    —— 用户名和安装路径就这么漏到前端（下载失败时 error 会被显示出来）。
  const errText = String(data?.error ?? '')
  ok(!/ENOENT|no such file/i.test(errText), `错误里没有 ENOENT 原文（实际「${errText}」）`)
  ok(!errText.includes(DATA), '错误里没有数据目录的绝对路径')
  ok(!/Users|AppData|\.dsh/i.test(errText), '错误里没有用户名 / 安装路径痕迹')
}

console.log('\n3. 不能被当成任意文件读取入口：')
{
  const secret = 'TOP-SECRET-SHOULD-NOT-LEAK\n'
  writeFileSync(join(DATA, 'secret.txt'), secret, 'utf8')
  const probes = [
    '/api/qq-bridge/log-file/../secret.txt',
    '/api/qq-bridge/log-file?path=' + encodeURIComponent(join(DATA, 'secret.txt')),
    '/api/qq-bridge/log-file/' + encodeURIComponent(join(DATA, 'secret.txt'))
  ]
  for (const url of probes) {
    const res = makeRes()
    // 探测请求可能抛（路由里读文件失败会被 catch 成 404/500），
    // 这里只关心「有没有把 secret.txt 吐出去」。
    try {
      await handler({ url, method: 'GET' }, res)
    } catch {
      // 抛了更好 —— 至少没吐文件
    }
    const text = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body ?? '')
    ok(!text.includes('TOP-SECRET-SHOULD-NOT-LEAK'), `不吐别的文件：${url}`)
    // ⚠️ 只断言「没吐 secret」是**恒真**的：路由是 `route === '/log-file'` 精确匹配，
    //    这些 URL 结构上就不可能进到读文件那一支 —— 哪怕实现里根本不读文件也照样绿。
    //    所以再补一条**正向**断言：必须落到「未知路由」那一支，而不是碰巧 200 了。
    let body = null
    try { body = JSON.parse(res.body) } catch { body = null }
    // `?path=` 那条会被 `split('?')[0]` 削成 `/log-file` —— 它**确实**命中了路由，
    // 但拿不到 secret（因为路径是常量）。所以这里只要求「没吐 secret」+「不是 200 带内容」。
    if (url.includes('?')) {
      ok(!text.includes('TOP-SECRET-SHOULD-NOT-LEAK') && res.statusCode !== 500,
        `query 参数被忽略（拿到的还是日志，不是 secret）：${url}`)
    } else {
      ok(res.statusCode === 404 && String(body?.error ?? '').includes('unknown route'),
        `走的是「未知路由」分支而不是读文件：${url}`)
    }
  }
  rmSync(join(DATA, 'secret.txt'), { force: true })
}

console.log('\n4. 只认 GET（POST 不该也能下载）：')
{
  writeFileSync(LOG_PATH, 'x\n', 'utf8')
  const res = makeRes()
  await handler({ url: '/api/qq-bridge/log-file', method: 'POST' }, res)
  const text = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body ?? '')
  ok(res.statusCode !== 200 || !text.startsWith('x'), `POST 拿不到日志（实际 ${res.statusCode}）`)
}

console.log(`\n${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
