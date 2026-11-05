/**
 * workspace-picker-sim.mjs —— 「会话来源工作区」选择器（0.18.4）的行为看守。
 *
 * ## 为什么要有这个测试（这是真事故，不是假想）
 *
 * `lib/config.js` 的 DEFAULTS 里曾把 `workspaceCwd` 写死成
 * `D:\DSH workspace\QQ对话` —— 这台机器上**根本没有这个目录**。
 * 于是 `sessions.js:56` 拿它筛会话，`client.js` 再筛一遍，设置页的
 * 「N 个可选会话」永远是 0，用户根本没法绑定。功能在代码里活着、界面上是死的，
 * 而且**没有任何报错**（读不到目录就当空数组）。
 *
 * 所以这个测试盯四件事：
 *   1. `/api/qq-bridge/workspaces` 三种读盘状态都要能返回，**坏 JSON 不能 500**
 *   2. `/save` 的 workspaceCwd 必须先校验再赋值，非法值不能落进 getConfig() 单例
 *   3. 默认值必须指向这台机器上真实存在的工作区，不能又写死一个不存在的路径
 *   4. 前端必须真的渲染出控件，且读不到注册表时降级成手填（不是白屏）
 *
 * 直接 import 被测模块：api.js / progress.js 都不碰 cordis 宿主。
 * 隔离 HOME 里自己造 workspace.json，不读真实 ~/.dsh。
 */
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { invalidateProgressCache } from '../lib/progress.js'
import { workspaceChoices } from '../lib/api.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')

let pass = 0
let fail = 0
function ok(cond, label) {
  if (cond) { pass += 1; process.stdout.write(`✓ ${label}\n`) } else { fail += 1; process.stdout.write(`✗ ${label}\n`) }
}

// ---- 守卫：绝不碰真实 ~/.dsh ------------------------------------------------
// 本测试只读 workspace.json，但「只读」这件事必须由环境本身保证，不能靠自觉
// （2026-11-06 有人直接跑 progress-sim 删掉了真实 sessions）。
const home = resolve(homedir())
const realHome = resolve(userInfo().homedir || process.env.USERPROFILE || home)
if (process.platform === 'win32'
  ? home.toLowerCase() === realHome.toLowerCase()
  : home === realHome) {
  console.error(`✗ 已拒绝执行：当前 HOME 就是真实用户目录 ${realHome}。请用 node tests/run-isolated.mjs tests/workspace-picker-sim.mjs`)
  process.exit(2)
}

const DATA = join(home, '.dsh')
const WS_FILE = join(DATA, 'storages', 'workspace.json')
mkdirSync(join(DATA, 'storages'), { recursive: true })

function writeRegistry(table) {
  writeFileSync(WS_FILE, JSON.stringify({
    unit: { version: 2 },
    tables: { workspaces: table }
  }, null, 2) + '\n', 'utf8')
  invalidateProgressCache()
}

// ---- 1. 正常：15 项，按 updatedAt 倒序 --------------------------------------
writeRegistry({
  ws1: { path: 'D:\\a\\旧', title: '旧工作区', sessionIds: ['s1'], updatedAt: '2026-10-01T00:00:00.000Z' },
  ws2: { path: 'D:\\a\\新', title: '新工作区', sessionIds: ['s2', 's3'], updatedAt: '2026-11-05T00:00:00.000Z' },
  ws3: { path: 'D:\\a\\中', title: '中工作区', sessionIds: [], updatedAt: '2026-10-20T00:00:00.000Z' }
})
let list = workspaceChoices()
ok(list.length === 3, `读到 3 个工作区（实际 ${list.length}）`)
ok(list[0].title === '新工作区', '按 updatedAt 倒序：最近用过的排第一')
ok(list[0].sessionCount === 2, 'sessionCount 数的是 sessionIds 长度')
ok(list[2].title === '旧工作区', '最久没动的排最后')
ok(typeof list[0].path === 'string' && list[0].path !== '', '每项都带 path（下拉框的 value 靠它）')
// 字段白名单：多给字段没人用 = 将来的假配置
const fields = Object.keys(list[0]).sort().join(',')
ok(fields === 'id,path,sessionCount,title,updatedAt', `只返回界面用得上的字段（实际 ${fields}）`)

// ---- 2. 没有 title 的项要能自己起名（否则下拉框是一片空白） ------------------
writeRegistry({
  ws1: { path: 'D:\\Yansunsky\\Desktop\\文本\\DSHQQ对话', sessionIds: [] }
})
list = workspaceChoices()
ok(list.length === 1, '只有 path 没有 title 也算一个工作区')
ok(list[0].title === 'DSHQQ对话', `title 缺失时用路径末段兜底（实际 ${list[0].title}）`)

// ---- 3. 坏 JSON：不能抛、不能 500，要空表 ------------------------------------
writeFileSync(WS_FILE, '{ 这不是 JSON ', 'utf8')
invalidateProgressCache()
let threw = false
let bad = null
try { bad = workspaceChoices() } catch { threw = true }
ok(threw === false, '注册表是坏 JSON 时不抛异常（读不到不等于接口坏了）')
ok(Array.isArray(bad) && bad.length === 0, '坏 JSON 返回空数组，前端据此降级成手填')

// ---- 4. 文件不存在：同上 ------------------------------------------------
rmSync(WS_FILE, { force: true })
invalidateProgressCache()
threw = false
let missing = null
try { missing = workspaceChoices() } catch { threw = true }
ok(threw === false, '注册表文件不存在时不抛异常')
ok(Array.isArray(missing) && missing.length === 0, '文件不存在返回空数组')

// ---- 5. 结构怪但不该炸：没有 path 的项要被丢掉 -------------------------------
writeRegistry({
  ok1: { path: 'D:\\有路徑', title: '好的一项', sessionIds: [] },
  broken1: { title: '没有 path', sessionIds: [] },
  broken2: { path: 'D:\\没sessionIds', title: '没有 sessionIds' },
  broken3: null
})
list = workspaceChoices()
ok(list.length === 2, `丢掉没有 path / 不是对象的项（实际留下 ${list.length}）`)
ok(list.some((item) => item.title === '没有 sessionIds' && item.sessionCount === 0),
  'sessionIds 缺失时 sessionCount 是 0，不是崩')

// ---- 6. DEFAULTS 不能又写死一个不存在的路径 ---------------------------------
// 这条是本次缺陷的根因，必须钉死：默认值要能在本机找到，且要能对上注册表。
const configSrc = readFileSync(join(PLUGIN, 'lib', 'config.js'), 'utf8')
const defaultsBlock = configSrc.slice(configSrc.indexOf('export const DEFAULTS'), configSrc.indexOf('let config ='))
const defaultCwd = (defaultsBlock.match(/workspaceCwd:\s*'([^']*)'/) || [])[1] || ''
ok(defaultCwd !== '', 'DEFAULTS 里 workspaceCwd 有默认值')
ok(defaultCwd.includes('DSHQQ对话'), `默认值指向真实工作区（实际 ${defaultCwd}）`)
ok(existsSync(defaultCwd), `默认值目录在本机真实存在（${defaultCwd}）`)
ok(!/D:\\\\DSH workspace\\\\QQ对话/.test(defaultsBlock), '旧的不存在路径 D:\\DSH workspace\\QQ对话 已从默认值里删掉')

// ---- 7. 后端：/save 必须先校验再赋值（**行为验证**，不是字符串匹配） --------
//
// 为什么非要真跑一遍 handler：这次的核心缺陷形态是「非法值静默落进配置」，
// 而它靠 grep 是抓不到的 —— 代码里照样有 `nextWorkspaceCwd`、照样有 `normCwd`，
// 只是顺序写反了 / 判断写漏了。所以这里起一个假 webServer 抓 handler 真调用。
const apiSrc = readFileSync(join(PLUGIN, 'lib', 'api.js'), 'utf8')
ok(apiSrc.includes("route === '/workspaces'"), '有 /workspaces 只读路由')
ok(/route === '\/workspaces' && req\.method === 'GET'/.test(apiSrc), '/workspaces 只接受 GET')
const wsRouteSrc = apiSrc.slice(apiSrc.indexOf("route === '/workspaces'"), apiSrc.indexOf("route === '/memory-clear'"))
ok(wsRouteSrc.includes('ok: true'), '读不到注册表也返回 ok:true（读不到不等于接口坏了）')
ok(wsRouteSrc.includes('workspaceChoices()'), '/workspaces 复用 workspaceChoices()，不另写一份读盘')
ok(!wsRouteSrc.includes('saveConfig'), '/workspaces 是只读的，不写配置')

// 先把注册表恢复成「有 3 项」的正常状态
writeRegistry({
  ws1: { path: 'D:\\a\\旧', title: '旧工作区', sessionIds: ['s1'], updatedAt: '2026-10-01T00:00:00.000Z' },
  ws2: { path: 'D:\\a\\新', title: '新工作区', sessionIds: ['s2', 's3'], updatedAt: '2026-11-05T00:00:00.000Z' }
})

const { registerApi } = await import('../lib/api.js')
const { loadConfig, getConfig } = await import('../lib/config.js')
loadConfig()

/**
 * 把配置钉到一个已知状态再测 /save。
 *
 * ⚠️ 为什么必须做（变异验证时真踩到）：这个测试会被反复跑（变异脚本、run-isolated、
 *   npm test 链），而 HOME 里的 `qq-bridge.config.json` 是**持久**的 ——
 *   上一次运行保存了什么，这一次 loadConfig 就原样读回来。
 *   7d 比的是「被拒的请求有没有改 routes」；如果上一次运行已经把 routes 写成了
 *   一模一样的内容，那么前后就一定相等，**断言恒真**，把 routes 赋值挪到校验之前
 *   也照样绿。这类假绿最阴：单跑一遍永远发现不了。
 */
function resetConfigToKnownState() {
  const config = getConfig()
  config.routes = { private: {}, group: {} }
  config.groupUins = []
  config.workspaceCwd = 'D:\\a\\旧'
  return config
}

/** 抓一份 handler：假 webServer + 假 req/res，够跑通就是全绿的价值所在。 */
function makeHandler() {
  let handler = null
  const ctx = {
    effect(fn) { try { fn() } catch { /* ignore */ } },
    get(name) { return name === 'webServer' ? { register(opts) { handler = opts.handler; return () => {} } } : undefined },
    webServer: { register(opts) { handler = opts.handler; return () => {} } }
  }
  registerApi(ctx)
  if (typeof handler !== 'function') throw new Error('没抓到 api handler')
  return handler
}

/** 打一次请求，返回 { code, body }。 */
async function call(handler, method, url, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const req = {
    method,
    url,
    on(event, fn) {
      if (event === 'data') for (const chunk of chunks) fn(chunk)
      if (event === 'end') fn()
      if (event === 'error') { /* 不触发 */ }
      return req
    }
  }
  let code = 0
  let payload = ''
  const res = {
    writeHead(status) { code = status; return res },
    end(text) { payload = String(text ?? '') }
  }
  await handler(req, res)
  let parsed = null
  try { parsed = JSON.parse(payload) } catch { parsed = null }
  return { code, body: parsed, raw: payload }
}

let handler
try {
  handler = makeHandler()
} catch (error) {
  ok(false, `能抓到 api handler（${error instanceof Error ? error.message : error}）`)
  handler = null
}

if (handler !== null) {
  // 7a. 正常 GET /workspaces
  let res = await call(handler, 'GET', '/api/qq-bridge/workspaces')
  ok(res.code === 200 && res.body?.ok === true, 'GET /workspaces 返回 200 + ok:true')
  ok(Array.isArray(res.body?.workspaces) && res.body.workspaces.length === 2,
    `GET /workspaces 带出 2 项（实际 ${res.body?.workspaces?.length}）`)
  ok(res.body?.workspaces?.[0]?.title === '新工作区', 'GET /workspaces 按最近使用倒序')

  // 7b. 合法路径：接受，并落成注册表里的原始大小写
  res = await call(handler, 'POST', '/api/qq-bridge/save', { workspaceCwd: 'd:/a/新/' })
  ok(res.code === 200, `大小写/斜杠不同的合法路径能保存（实际 ${res.code}）`)
  ok(getConfig().workspaceCwd === 'D:\\a\\新',
    `落盘用注册表里的原始大小写，不是用户传的（实际 ${getConfig().workspaceCwd}）`)

  // 7c. 非法路径：400，而且**绝不能**污染已生效的配置
  const before = getConfig().workspaceCwd
  res = await call(handler, 'POST', '/api/qq-bridge/save', { workspaceCwd: 'D:\\根本不存在\\瞎写' })
  ok(res.code === 400, `注册表里没有的路径返回 400（实际 ${res.code}）`)
  ok(String(res.body?.error ?? '').includes('不在工作区注册表里'),
    '错误文案说清「不在工作区注册表里」')
  ok(getConfig().workspaceCwd === before,
    `被拒的值没有落进 config 单例（仍是 ${getConfig().workspaceCwd}）`)

  // 7d. 非法路径 + 别的字段一起提交：整单拒绝，别的字段也不能部分生效
  //     （老坑：先赋值后校验，save 报错了但内存里的 routes 已经变了）
  //     ⚠️ 先钉成已知状态，否则上一次运行写进去的 routes 会让「前后相等」恒成立（假绿）
  resetConfigToKnownState()
  const routesBefore = JSON.stringify(getConfig().routes)
  res = await call(handler, 'POST', '/api/qq-bridge/save', {
    workspaceCwd: 'D:\\根本不存在\\瞎写',
    routes: { private: { '999999': { sessionId: 'session-should-not-stick' } }, group: {} }
  })
  ok(res.code === 400, '工作区非法时整单 400')
  ok(getConfig().routes?.private?.['999999'] === undefined,
    '越权写入的绑定没有落进 config（校验必须在所有赋值之前）')
  ok(JSON.stringify(getConfig().routes) === routesBefore,
    '被拒的请求没有顺手把 routes 也改了（校验必须在所有赋值之前）')

  // 7e. 空串是合法值（= 不筛工作区）
  res = await call(handler, 'POST', '/api/qq-bridge/save', { workspaceCwd: '' })
  ok(res.code === 200, `空串能保存（= 不筛工作区，实际 ${res.code}）`)
  ok(getConfig().workspaceCwd === '', '空串真的写进去了')

  // 7f. 非字符串：400，而且要说清是「类型不对」，不是「路径不在注册表里」——
  //     两者混在一句里的话，用户会去 DSH 里新建一个叫「12345」的工作区，白折腾。
  res = await call(handler, 'POST', '/api/qq-bridge/save', { workspaceCwd: 12345 })
  ok(res.code === 400, `数字类型的 workspaceCwd 被拒（实际 ${res.code}）`)
  ok(String(res.body?.error ?? '').includes('字符串'),
    '类型错误的文案说的是「要字符串」，不是「不在注册表里」')

  // 7g. 注册表读不到时：手填框不能变成死路。
  //     退路 = 只校验「目录在不在」，存在就收。这是降级路径能用的前提。
  rmSync(WS_FILE, { force: true })
  invalidateProgressCache()
  res = await call(handler, 'POST', '/api/qq-bridge/save', { workspaceCwd: DATA })
  ok(res.code === 200, `注册表读不到 + 目录存在 → 仍然能存（否则手填框永远存不进去，实际 ${res.code}）`)
  res = await call(handler, 'POST', '/api/qq-bridge/save', { workspaceCwd: join(DATA, '不存在的子目录') })
  ok(res.code === 400, '注册表读不到 + 目录不存在 → 仍然拒绝（防手滑把图片目录搬走）')
}

// ---- 8. 前端：真的有控件，且降级不是白屏 -----------------------------------
const clientSrc = readFileSync(join(PLUGIN, 'lib', 'client.js'), 'utf8')
ok(clientSrc.includes('/workspaces'), '前端会去拉 /workspaces')
ok(clientSrc.includes('renderWorkspacePicker'), '绑定页有工作区选择器')
ok(/tab === 'binding'[\s\S]{0,400}renderWorkspacePicker\(\)/.test(clientSrc),
  '选择器挂在「绑定」页里（不是又开了一个新栏）')
ok(clientSrc.includes('pickWorkspace'), '选中有对应处理')
ok(/apiPost\('\/save', \{ workspaceCwd: raw \}\)/.test(clientSrc),
  '选中后只提交 workspaceCwd 一个字段（不顺手提交未保存的绑定改动）')
ok(clientSrc.includes("degraded || wsList.length === 0"), '注册表读不到时降级成手填输入框')
ok(clientSrc.includes('不在工作区注册表里'), '下拉框给「当前值不在注册表」留了占位项')
// option 的 value 必须是 path：改成 title 的话提交上去的是名字，后端按注册表比必然 400。
// 这个错写起来很自然（显示的是 title、顺手就把 value 也设成 title），所以单独钉一条。
ok(/value: item\.path,/.test(clientSrc) && !/value: item\.title/.test(clientSrc),
  '下拉框的 value 是路径而不是标题')
// 底部灰字改成显示标题（路径长得像日志，没人读）
// ⚠️ 断言「那一行是由 currentWorkspaceLabel() 拼出来的」，而不是「不包含某个坏字符串」——
//   后者写成 `!includes(...)` 太脆：换一种坏写法（比如 `'…' + wantCwd`）照样能通过。
const cwdLine = clientSrc.slice(clientSrc.indexOf("className: 'qqb-note', key: 'cwd'"))
ok(cwdLine.slice(0, 240).includes('currentWorkspaceLabel()'),
  '底部那行确实由 currentWorkspaceLabel() 拼出来（显示标题，不是路径）')
ok(!/key: 'cwd'[\s\S]{0,200}\+ wantCwd/.test(clientSrc), '底部没有退回去直接拼路径')
// 副作用提示必须**真的挂在选择器那张卡片上**，不能只是文件里出现过「收到的图片」这几个字
// ——「高级 → 图片副本目录」那个输入框的 placeholder 里也有这四个字，
// 只查 includes 的话把整段提示删掉照样绿（变异验证时真踩到过一次）。
const pickerSrc = clientSrc.slice(
  clientSrc.indexOf('function renderWorkspacePicker'),
  clientSrc.indexOf('function renderTable')
)
ok(pickerSrc !== '', '能定位到 renderWorkspacePicker 的函数体')
// ⚠️ 断言要盯「那句会消失的话」，不能盯「别处也有的词」：
//    「旧目录里的图不会跟着搬」是这条提示的**后半句**，前半句被删掉它还在，
//    于是「只删前半句」这种变异照样绿（变异验证时真踩到过）。
ok(pickerSrc.includes('收到的图片副本存在') && pickerSrc.includes('旧目录里的图不会跟着搬'),
  '选择器卡片里写明换工作区会搬图片目录、旧图不会跟着搬')
// 普通「保存」不许把 workspaceCwd 一起提交（否则历史上那个非法值会卡住一切保存）
ok(/if \(key === 'workspaceCwd'\) continue/.test(clientSrc),
  '普通保存跳过 workspaceCwd（它只由选择器那条路提交）')
// 当前工作区优先取表单状态（reload 回填 + 切换成功后同步），首屏 tunables 为 null 时
// 退回 /state。写成「只读 data.config」的话，切换成功后不刷新页面下拉框就停在旧值上，
// 用户会以为没切成功、再点一次。
//
// ⚠️ 这里必须匹配**完整表达式**，不能只查 `tunables.workspaceCwd` 这个子串。
//    （2026-11-06 test-delivery 报的假绿，Lead 已实测复现）：
//    该词在 client.js 里出现 3 次，其中一次是**注释**（上面那段解释的正文），
//    所以哪怕把 wantCwd 整个改成只读 data.config（功能真回退），旧断言照样绿。
//    实测：变异后「66 过 0 败」，那条断言仍是 ✓ —— 完全没长眼睛。
const wantCwdExpr = clientSrc.slice(
  clientSrc.indexOf('var wantCwd = String('),
  clientSrc.indexOf('var wantCwd = String(') + 400
)
ok(/typeof tunables\.workspaceCwd === 'string'\s*\n?\s*\?\s*tunables\.workspaceCwd/.test(wantCwdExpr),
  '当前工作区优先读表单状态 tunables.workspaceCwd（完整表达式，不是注释里那个词）')
ok(/:\s*\(data\.config && data\.config\.workspaceCwd/.test(wantCwdExpr),
  '表单状态还没有时（首屏 tunables 为 null）退回 /state 里那份')
ok(/setTunables\(function \(old\) \{[\s\S]{0,120}workspaceCwd: next/.test(clientSrc),
  '切换成功后把新值同步回表单状态（否则下拉框停在旧值）')

// ---- 10. 会话筛选用的就是这个值（回归根因） ---------------------------------
const sessionsSrc = readFileSync(join(PLUGIN, 'lib', 'sessions.js'), 'utf8')
ok(/workspaceCwd/.test(sessionsSrc), 'sessions.js 仍按 workspaceCwd 筛会话（换工作区才会真的换列表）')

// ---- 11. 存量配置自愈：配了注册表里没有的路径 → 改回默认工作区 -------------
//
// 为什么必须测：只改 DEFAULTS 救不了**已经存在的**配置文件 ——
// `{...DEFAULTS, ...raw}` 里 raw 的旧值优先，而那个值正是 `D:\DSH workspace\QQ对话`。
// 不做这一步的话，用户升级完打开设置页，还是 0 个可选会话（缺陷原样）。
{
  const CFG_FILE = join(home, '.dsh', 'qq-bridge.config.json')
  /** 造一份「配置里有死路径」的状态，然后 loadConfig()，看它有没有被修好。 */
  async function loadWithConfig(extra) {
    writeFileSync(CFG_FILE, JSON.stringify({ enabled: true, ...extra }, null, 2), 'utf8')
    const mod = await import(`../lib/config.js?t=${Math.random()}`)
    return mod.loadConfig()
  }

  writeRegistry({
    a1: { path: 'D:\\w\\小', title: '小工作区', sessionIds: ['s1'], updatedAt: '2026-10-01T00:00:00.000Z' },
    a2: { path: 'D:\\Yansunsky\\Desktop\\文本\\DSHQQ对话', title: '默认工作区', sessionIds: [], updatedAt: '2026-10-05T00:00:00.000Z' },
    a3: { path: 'D:\\w\\大', title: '大工作区', sessionIds: ['s2', 's3', 's4', 's5'], updatedAt: '2026-10-02T00:00:00.000Z' }
  })
  invalidateProgressCache()

  // 11a. 死路径 → 改回 DEFAULTS 指的那个工作区（**不是**会话最多的那个）
  //      ⚠️ 这条是本功能最危险的判断：改错了会连带把「收到的图片」目录搬走。
  //      实测过「挑会话最多」的写法在本机会选到 CreateCMPOR（一个 MC 模组工作区）。
  let cfg = await loadWithConfig({ workspaceCwd: 'D:\\DSH workspace\\QQ对话' })
  ok(cfg.workspaceCwd === 'D:\\Yansunsky\\Desktop\\文本\\DSHQQ对话',
    `失效路径被改回默认工作区（实际 ${cfg.workspaceCwd}）`)
  ok(cfg.workspaceCwd !== 'D:\\w\\大',
    '没有挑「会话最多」的那个（那会挑到跟 QQ 无关的工作区）')

  // 11b. 合法路径 → 一个字节都不许动（自愈不能变成「每次都重置」）
  cfg = await loadWithConfig({ workspaceCwd: 'd:/w/小/' })
  ok(cfg.workspaceCwd === 'd:/w/小/',
    `合法路径原样保留，不改大小写也不补斜杠（实际 ${cfg.workspaceCwd}）`)

  // 11c. 空串 → 不碰（空串是「不筛工作区」的有效选择，不是「没配」）
  cfg = await loadWithConfig({ workspaceCwd: '' })
  ok(cfg.workspaceCwd === '', `空串不被自愈覆盖（实际 "${cfg.workspaceCwd}"）`)

  // 11d. 注册表读不到 → 原样保留（读不到 ≠ 配错了）
  rmSync(WS_FILE, { force: true })
  invalidateProgressCache()
  cfg = await loadWithConfig({ workspaceCwd: 'D:\\某个暂时读不到的\\工作区' })
  ok(cfg.workspaceCwd === 'D:\\某个暂时读不到的\\工作区',
    '注册表读不到时不动用户配置（绝不能凭猜测改工作区）')

  // 11e. 坏 JSON → 同上，不炸也不改
  writeFileSync(WS_FILE, '{ 坏掉的 ', 'utf8')
  invalidateProgressCache()
  let threw = false
  try {
    cfg = await loadWithConfig({ workspaceCwd: 'D:\\还有个\\工作区' })
  } catch { threw = true }
  ok(threw === false, '注册表是坏 JSON 时 loadConfig 不抛')
  ok(cfg?.workspaceCwd === 'D:\\还有个\\工作区', '坏 JSON 时也不动用户配置')

  // 11f. 默认工作区也不在注册表里 → 不改，留着让选择器挑明
  //      「宁可不改，也不能改错」：改错会连带搬走图片目录，比不改难查得多。
  writeRegistry({
    a1: { path: 'D:\\w\\甲', title: '甲', sessionIds: [], updatedAt: '2026-10-01T00:00:00.000Z' }
  })
  invalidateProgressCache()
  cfg = await loadWithConfig({ workspaceCwd: 'D:\\不存在\\死路径' })
  ok(cfg.workspaceCwd === 'D:\\不存在\\死路径',
    `默认工作区不在注册表里时不乱改（实际 ${cfg.workspaceCwd}）`)
  // 也别改成注册表里**随便哪一个**——那才是最坏的形态：悄悄换成一个无关工作区。
  ok(!String(cfg.workspaceCwd).includes('\\w\\甲'),
    '也没有掉进注册表里的第一个工作区（不该乱改到无关工作区）')

  // 11g. 自愈要落盘，不能只在内存里改（否则重启又变回去）
  writeRegistry({
    a1: { path: 'D:\\w\\小', title: '小', sessionIds: [], updatedAt: '2026-10-01T00:00:00.000Z' },
    a2: { path: 'D:\\Yansunsky\\Desktop\\文本\\DSHQQ对话', title: '默认', sessionIds: [], updatedAt: '2026-10-02T00:00:00.000Z' }
  })
  invalidateProgressCache()
  await loadWithConfig({ workspaceCwd: 'D:\\不存在\\死路径' })
  const onDisk = JSON.parse(readFileSync(CFG_FILE, 'utf8'))
  ok(onDisk.workspaceCwd === 'D:\\Yansunsky\\Desktop\\文本\\DSHQQ对话',
    `自愈结果写回了配置文件（磁盘上是 ${onDisk.workspaceCwd}）`)
}

console.log(`\n${pass} 过 ${fail} 败`)
process.exit(fail === 0 ? 0 : 1)
