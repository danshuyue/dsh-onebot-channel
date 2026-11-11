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

// ---------------------------------------------------------------------------
// 6. 诊断包（0.19.7，用户问「导出日志是不是该搭配导出 DSH 的日志」）
//
// 它比前两份都危险：内容多、来源杂（配置 + 活状态 + 两个日志文件），
// 所以同时是「最强的诊断材料」和「最大的泄密面」。要钉的四件事：
//   ① 凭据一个字符都不能出去（三处哨兵逐字段验，不能只验一个）
//   ② 该有的节都在（少一节就复盘不了，而「少了也绿」是最常见的假绿）
//   ③ **不许夹带别的会话** —— DSH 日志是全站共用的，不过滤就把用户别的项目带走
//   ④ 任何一节坏掉都要降级返回 200，不能 500（这功能就是在坏事发生时才用）
// ---------------------------------------------------------------------------
console.log('\n6. 诊断包：够复盘、不泄密、不夹带别的会话、坏掉也降级：')
{
  const cfgPath = join(DATA, 'qq-bridge.config.json')
  const raw = JSON.parse(readFileSync(cfgPath, 'utf8'))
  const SENTINEL_TOKEN = 'SENTINEL-TOKEN-AAAA'
  const SENTINEL_WS = 'SENTINEL-WSTOKEN-BBBB'
  const SENTINEL_BREEZE = 'SENTINEL-BREEZE-CCCC'
  // ⚠️ loadConfig 必须在**本节内**重新 import：第 5 节那个是它自己的块级变量，
  //    这里直接用会 ReferenceError（上一次就是这么炸的）。
  const { loadConfig } = await import('../lib/config.js')
  writeFileSync(cfgPath, JSON.stringify({
    ...raw,
    token: SENTINEL_TOKEN,
    wsToken: SENTINEL_WS,
    voiceBreezeKey: SENTINEL_BREEZE,
    routes: {
      private: { '1000000001': { sessionId: 'session-cfg-a', prefix: '[管理员]' } },
      group: { '975663147': { sessionId: 'session-cfg-b', prefix: '' } }
    },
    groupUins: ['975663147']
  }, null, 2), 'utf8')
  loadConfig()

  // ---- 造一份 DSH 日志：本会话的 tool/result（要留）+ 别的会话的（必须走掉）----
  // ⚠️ 这条是本节的关键：只用「有 events」证明不了过滤生效 ——
  //    必须**同时**放一条属于别处的诱饵，然后断言它没出现。
  {
    const logsDir = join(DATA, 'logs')
    mkdirSync(logsDir, { recursive: true })
    const day = new Date().toISOString().slice(0, 10)
    const file = join(logsDir, `desktop-next-${day}.0.jsonl`)
    const lines = [
      // 属于绑定会话 → 要留
      {
        time: '2026-11-08T00:00:01.000Z', event: 'tool/result', level: 'info', fields: {
          sessionId: 'session-cfg-a', sessionEventType: 'tool/result', isError: false, durationMs: 12
        }
      },
      // 失败的那种 → 要留，且 isError 必须是 true
      {
        time: '2026-11-08T00:00:02.000Z', event: 'execute.failed', level: 'error', fields: {
          sessionId: 'session-cfg-a', tool: 'qq_send', isError: false, durationMs: 38
        }, error: { name: 'Error', message: 'SENTINEL-TOOL-FAIL 发不出去' }
      },
      // 别的会话 → **必须被过滤掉**（否则就是把用户别的项目带走）
      {
        time: '2026-11-08T00:00:03.000Z', event: 'tool/result', level: 'warning', fields: {
          sessionId: 'session-SOMEONE-ELSE', sessionEventType: 'tool/result', isError: true, durationMs: 99
        }
      },
      // 与本插件无关的事件类型 → 不该收（它们对收发没有诊断价值，只会撑大包）
      {
        time: '2026-11-08T00:00:04.000Z', event: 'log', level: 'info', fields: {
          sessionId: 'session-cfg-a', message: 'SENTINEL-IRRELEVANT-EVENT'
        }
      }
    ]
    writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8')
  }

  // ---- 造游标数据（否则「seenIds 只给条数」这条断言是在验 undefined，等于假绿）----
  // ⚠️ 必须**先真的写进 state**，再打接口：直接断言一个空对象里的字段，
  //    实现里就算把整个 seenIds 数组吐出来，断言也会因为「字段不存在」而失败或通过得莫名其妙。
  {
    const { saveState } = await import('../lib/state.js')
    saveState({
      privates: {
        '1000000001': {
          lastSeq: 12345,
          lastTime: 1762000000,
          lastId: 678,
          // 60 个真实形状的 message_id：如果实现原样吐数组，体积会明显变大
          seenIds: Array.from({ length: 60 }, (_, i) => String(-1000 - i))
        }
      },
      groups: {
        '975663147': { lastSeq: 999, lastTime: 1762000001, lastDeliveredSeq: 990, seenIds: ['-1', '-2'] }
      }
    })
  }

  const res = makeRes()
  await handler({ url: '/api/qq-bridge/diag-export', method: 'GET' }, res)
  const text = Buffer.isBuffer(res.body) ? res.body.toString('utf8') : String(res.body ?? '')
  let data = null
  try { data = JSON.parse(text) } catch { data = null }

  ok(res.statusCode === 200, `HTTP 200（实际 ${res.statusCode}）`)
  ok(data !== null, '返回的是合法 JSON')
  ok(String(res.headers['content-type'] ?? '').includes('application/json'), '标成 JSON')
  ok(String(res.headers['content-disposition'] ?? '').includes('attachment'), '带 attachment（点一下就是另存为）')
  ok(String(res.headers['content-disposition'] ?? '').includes('.json'), '下载名是 .json')
  ok(data?.schema === 'dsh-onebot-channel/diag-export', '有 schema 标记（与 config-export 区分开）')

  // ---- ② 该有的节都在 ----
  for (const section of ['runtime', 'config', 'summary', 'state', 'outbound', 'log', 'dshLog']) {
    ok(data !== null && data[section] !== undefined && data[section] !== null,
      `有 ${section} 这一节（少了它这次复盘就残缺）`)
  }
  ok(typeof data?.exportedAt === 'string' && data.exportedAt !== '', '有导出时刻')

  // ---- ① 凭据一个字符都不能出去 ----
  for (const [label, value] of [['token', SENTINEL_TOKEN], ['wsToken', SENTINEL_WS], ['voiceBreezeKey', SENTINEL_BREEZE]]) {
    ok(!text.includes(value), `${label} 的明文没有出现在诊断包里`)
  }
  ok(data?.config?.token === '***已设置***', `token 打码成「已设置」（实际「${data?.config?.token}」）`)
  ok(data?.config?.voiceBreezeKey === '***已设置***', 'voiceBreezeKey 打码成「已设置」')

  // ---- 诊断需要的活状态都在 ----
  ok(data?.state?.privates !== undefined && data?.state?.groups !== undefined, 'state 里有私聊/群游标两节')
  // ⚠️ 只给条数，不给整个数组 —— 数组里是一堆消息编号，既没用又撑包体
  const privCursor = data?.state?.privates?.['1000000001']
  ok(privCursor !== undefined && privCursor.lastSeq === 12345 && privCursor.lastTime === 1762000000,
    `游标的 lastSeq / lastTime 原样带出来（实际 ${JSON.stringify(privCursor)}）`)
  ok(privCursor !== undefined && privCursor.seenIds === 60,
    `游标的 seenIds 只给条数 60（实际 ${JSON.stringify(privCursor?.seenIds)}）`)
  // 主断言：整个 seenIds 数组**没有**被吐出来。上面那条可能被「实现返回 60 这个数字」
  // 碰巧满足，所以再验「具体那些 id 一个都没出现」—— 两条一起才钉得住。
  ok(!text.includes('-1000') && !text.includes('-1059'),
    'seenIds 里那些 message_id 一个都没进诊断包（只给条数，不给内容）')
  ok(data?.outbound?.queues !== undefined && typeof data.outbound.queues === 'object', 'outbound 里给了每会话队列深度')
  ok(Array.isArray(data?.outbound?.suppressed), 'outbound 里给了抑制表（解释「她突然不说话」）')
  ok(data?.log?.file === 'qq-bridge-load.log' && Array.isArray(data.log.lines), 'log 里有日志文件名和行数组')
  ok(Array.isArray(data?.log?.lines) && data.log.lines.length <= 300, '日志尾巴最多 300 行（不把整份 8MB 塞进来）')

  // ---- ③ DSH 日志：该留的留、该走的走 ----
  const events = data?.dshLog?.events
  ok(Array.isArray(events), 'dshLog.events 是数组')
  ok(Array.isArray(events) && events.length >= 2, `绑定会话的工具事件被收进来了（实际 ${events?.length} 条）`)
  ok(!text.includes('session-SOMEONE-ELSE'),
    '⚠️ 别的会话的事**一条都没进来**（DSH 日志全站共用，不过滤就是把用户别的项目带走）')
  // ⚠️ 这条原来写的是「输出里没有 SENTINEL-IRRELEVANT-EVENT」，它是**恒真**的：
  //    那个哨兵放在 fields.message 里，而实现只输出 error.message ——
  //    就算把 log 事件整个收进来，哨兵也不会出现。变异验证当场抓出来了（改坏实现照样绿）。
  //    改成验**事件类型的白名单**：实现一旦放进来 log，这里立刻红。
  const eventTypes = new Set((Array.isArray(events) ? events : []).map((item) => String(item?.event ?? '')))
  for (const type of eventTypes) {
    ok(type === 'tool/result' || type === 'execute.failed',
      `收到的事件类型只在白名单里（实际多出「${type}」）`)
  }
  ok(eventTypes.size > 0, '确实收到了事件（空集合会让上面那条恒真）')
  ok(!text.includes('"event": "log"'), '与本插件无关的事件类型没有收（只认 tool/result 与 execute.failed）')
  ok(text.includes('SENTINEL-TOOL-FAIL'), '失败原文进来了（「工具不存在」这类报错没有它就查不出原因）')
  const failed = Array.isArray(events) ? events.find((item) => item?.event === 'execute.failed') : null
  ok(failed !== null && failed !== undefined && failed.tool === 'qq_send',
    `execute.failed 里带着工具名（实际「${failed?.tool}」）`)
  ok(typeof data?.dshLog?.routeSessions !== 'undefined' && Array.isArray(data.dshLog.routeSessions),
    'dshLog 里写明了「只取这几个会话」—— 口径要摆出来，不是靠读的人猜')
  ok(String(data?.dshLog?.note ?? '').includes('只含'), 'dshLog 有口径说明（免得被误读成「没调用过工具」）')

  // ---- 只认 GET + 不吃 query ----
  const postRes = makeRes()
  await handler({ url: '/api/qq-bridge/diag-export', method: 'POST' }, postRes)
  ok(postRes.statusCode !== 200, `POST 拿不到诊断包（实际 ${postRes.statusCode}）`)

  // ⚠️ query 参数必须被忽略：`?path=` 之类一旦生效就是任意文件读取入口
  const probeRes = makeRes()
  await handler({ url: '/api/qq-bridge/diag-export?path=' + encodeURIComponent(join(DATA, 'secret.txt')), method: 'GET' }, probeRes)
  const probeText = Buffer.isBuffer(probeRes.body) ? probeRes.body.toString('utf8') : String(probeRes.body ?? '')
  ok(!probeText.includes('TOP-SECRET-SHOULD-NOT-LEAK') && !probeText.includes(SENTINEL_TOKEN),
    'query 参数被忽略（拿到的还是诊断包，不是任意文件、也不是凭据明文）')

  // ---- ④ 坏产物时降级，不许 500：日志/配置都读不到也要给一个能下载的文件 ----
  {
    const { resetCoalesce } = await import('../lib/env.js')
    try { resetCoalesce() } catch {}
    rmSync(join(DATA, 'qq-bridge-load.log'), { force: true })
    const degraded = makeRes()
    await handler({ url: '/api/qq-bridge/diag-export', method: 'GET' }, degraded)
    const degradedText = Buffer.isBuffer(degraded.body) ? degraded.body.toString('utf8') : String(degraded.body ?? '')
    let degradedData = null
    try { degradedData = JSON.parse(degradedText) } catch { degradedData = null }
    ok(degraded.statusCode === 200, `没有日志文件时仍然 200（实际 ${degraded.statusCode}）`)
    ok(degradedData !== null, '没有日志文件时仍然返回合法 JSON')
    ok(degradedData?.log?.exists === false, '没有日志文件时 log.exists = false（明说「没有」而不是假装空）')
    ok(degradedData?.runtime?.version !== '', '降级时其它节（版本）照旧在')
  }

  writeFileSync(cfgPath, JSON.stringify(raw, null, 2), 'utf8')
  loadConfig()
}

console.log(`\n${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
