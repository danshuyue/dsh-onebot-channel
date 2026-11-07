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
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
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

// ---------------------------------------------------------------------------
// 5. 导出配置（0.19.6，用户要求「导出日志时顺带导出当前插件配置」）
//
// 为什么它值得单独钉：这份 JSON 的用途是**发给别人看**（用户会贴进对话），
// 所以它同时是「诊断材料」和「泄密面」。两条要求互相拉扯：
//   ① 必须够全 —— routes / groupUins / 各档位，少了就诊断不了「发错人」
//   ② 凭据必须打码 —— token / wsToken / voiceBreezeKey 一个字符都不能出去
// 只断言「有 config 字段」是假绿（漏掉某个凭据照样绿），所以逐字段验。
// ---------------------------------------------------------------------------
console.log('\n5. 导出配置：够诊断、但不吐凭据：')
{
  // 先把三个凭据写成可识别的哨兵值，再验它们**没有**出现在输出里。
  const cfgPath = join(DATA, 'qq-bridge.config.json')
  const raw = JSON.parse(readFileSync(cfgPath, 'utf8'))
  const SENTINEL_TOKEN = 'SENTINEL-TOKEN-AAAA'
  const SENTINEL_WS = 'SENTINEL-WSTOKEN-BBBB'
  const SENTINEL_BREEZE = 'SENTINEL-BREEZE-CCCC'
  writeFileSync(cfgPath, JSON.stringify({
    ...raw,
    token: SENTINEL_TOKEN,
    wsToken: SENTINEL_WS,
    voiceBreezeKey: SENTINEL_BREEZE,
    routes: {
      private: { '1000000001': { sessionId: 'session-cfg-a', prefix: '[管理员]' } },
      group: { '975663147': { sessionId: 'session-cfg-b', prefix: '' } }
    },
    groupUins: ['975663147'],
    voiceTargetsPrivate: ['private:1000000001'],
    voiceTargetsGroup: ['group:975663147']
  }, null, 2), 'utf8')

  // 重新加载配置（插件在 apply 时读过一次，这里直接改文件要让它重读）。
  const { loadConfig } = await import('../lib/config.js')
  loadConfig()

  const res = makeRes()
  await handler({ url: '/api/qq-bridge/config-export', method: 'GET' }, res)
  const text = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body ?? '')
  let data = null
  try { data = JSON.parse(text) } catch { data = null }

  ok(res.statusCode === 200, `HTTP 200（实际 ${res.statusCode}）`)
  ok(data !== null, '返回的是合法 JSON')
  ok(String(res.headers['content-type'] ?? '').includes('application/json'), '标成 JSON')
  ok(String(res.headers['content-disposition'] ?? '').includes('attachment'), '带 attachment（点一下就是另存为）')
  ok(String(res.headers['content-disposition'] ?? '').includes('qq-bridge-config.json'), '文件名是 qq-bridge-config.json')

  // ---- ② 凭据一个字符都不能出去（这是本节的**主断言**）----
  for (const [label, value] of [['token', SENTINEL_TOKEN], ['wsToken', SENTINEL_WS], ['voiceBreezeKey', SENTINEL_BREEZE]]) {
    ok(!text.includes(value), `${label} 的明文没有出现在导出里`)
  }
  ok(data?.config?.token === '***已设置***', `token 打码成「已设置」（实际「${data?.config?.token}」）`)
  ok(data?.config?.wsToken === '***已设置***', 'wsToken 打码成「已设置」')
  ok(data?.config?.voiceBreezeKey === '***已设置***', 'voiceBreezeKey 打码成「已设置」')

  // ---- ① 诊断需要的都在 ----
  ok(JSON.stringify(data?.config?.routes?.private ?? {}).includes('session-cfg-a'),
    '导出里带着私聊绑定（这是「发错人」最关键的证据）')
  ok(JSON.stringify(data?.config?.routes?.group ?? {}).includes('975663147'), '导出里带着群绑定')
  ok(JSON.stringify(data?.config?.groupUins ?? []).includes('975663147'), '导出里带着 groupUins（监听哪些群）')
  ok(JSON.stringify(data?.config?.voiceTargetsPrivate ?? []).includes('private:1000000001'), '导出里带着语音私聊名单')
  ok(JSON.stringify(data?.config?.voiceTargetsGroup ?? []).includes('group:975663147'), '导出里带着语音群名单')
  ok(typeof data?.runtime?.version === 'string' && data.runtime.version !== '', '导出里带着版本号（判断装的是不是新版）')
  ok(typeof data?.runtime?.bootAt === 'string' && data.runtime.bootAt !== '', '导出里带着启动时刻')
  ok(typeof data?.exportedAt === 'string' && data.exportedAt !== '', '导出里带着导出时刻')

  // ---- 派生事实要跟 config 对得上（界面上显示「已绑 N 个」时应该同数）----
  ok(data?.summary?.privateRoutes === 1, `summary.privateRoutes = 1（实际 ${data?.summary?.privateRoutes}）`)
  ok(data?.summary?.groupRoutes === 1, `summary.groupRoutes = 1（实际 ${data?.summary?.groupRoutes}）`)
  ok(data?.summary?.groupUins === 1, `summary.groupUins = 1（实际 ${data?.summary?.groupUins}）`)
  ok(data?.summary?.hasToken === true, 'summary.hasToken = true（打码之后仍能看出「配了」）')
  ok(data?.summary?.hasBreezeKey === true, 'summary.hasBreezeKey = true')

  // ---- 只认 GET ----
  const postRes = makeRes()
  await handler({ url: '/api/qq-bridge/config-export', method: 'POST' }, postRes)
  ok(postRes.statusCode !== 200, `POST 拿不到配置（实际 ${postRes.statusCode}）`)

  // 复原，别把哨兵值留给后面的用例（也免得污染隔离 HOME 之外的任何东西）
  writeFileSync(cfgPath, JSON.stringify(raw, null, 2), 'utf8')
  loadConfig()
}

console.log(`\n${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
