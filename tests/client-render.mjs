/**
 * 客户端真正的渲染测试：把组件树递归跑一遍，让 QqBridgeSection 的函数体真的执行。
 *
 * 之前的冒烟测试只验到「注册成功」，因为 h() 只是造对象、不调用组件函数，
 * 组件体内的错误（hooks 顺序、数据形状、未定义变量）根本测不到。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')

let definition = null
globalThis.window = { __ModuleLoader__: { load(def) { definition = def } } }
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ setAttribute() {}, appendChild() {} }),
  head: { appendChild() {} },
  body: { appendChild() {} }
}

// 极简 hooks：按调用顺序取种子值，setter 什么都不做（只验首次渲染不炸）
let seeds = []
let cursor = 0

class FakeComponent {
  constructor(props) {
    this.props = props || {}
    this.state = {}
  }
  setState(next) {
    this.state = Object.assign({}, this.state, typeof next === 'function' ? next(this.state) : next)
  }
}
FakeComponent.prototype.isReactComponent = {}

const fakeReact = {
  Component: FakeComponent,
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
  useState: (initial) => {
    const value = cursor < seeds.length ? seeds[cursor] : initial
    cursor += 1
    return [value, () => {}]
  },
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
  Fragment: 'Fragment'
}

const requireStub = (name) => {
  if (name === 'react') return fakeReact
  throw new Error('未预期的依赖: ' + name)
}

await import(pathToFileURL(join(PLUGIN, 'lib', 'client.js')).href)
if (definition === null) {
  console.error('bundle 没调用 __ModuleLoader__.load')
  process.exit(1)
}
const exports = definition.factory(requireStub)

let renderFn = null
const ctx = {
  effect(fn) { fn() },
  slots: { inject(_slot, cb) { cb() }, register(_options, render) { renderFn = render; return {} } }
}
exports.apply(ctx)
if (typeof renderFn !== 'function') {
  console.error('设置页没注册上')
  process.exit(1)
}

// 造一份「接口已经返回」的状态，直接把组件推过 data === null 那个分支
const fakeState = {
  ok: true,
  self: { uin: '3655191092', name: '洛殿下' },
  config: {
    workspaceCwd: 'D:\\DSH workspace\\QQ对话', groupContextCount: 5, groupOnlyWhenAt: true, splitReply: true,
    splitMaxChars: 120, splitDelayMinMs: 200, splitDelayMaxMs: 700, pollMs: 2000, groupPollMs: 3000,
    resumeColdSession: true,
    // 0.9.x：概览页会读这些已保存值（读编辑态会把「没保存」显示成「已生效」）
    mergeWindowMs: 2500, replyQuietMs: 5000, closureEnabled: true, memoryEnabled: true,
    proactiveEnabled: true, proactiveIdleHours: 6, proactiveDailyMax: 1,
    proactiveQuietFrom: '23:00', proactiveQuietTo: '08:00',
    // 非空 = 「只对选中的人」；概览里应该显示成「指定的 1 人」
    proactiveTargets: ['private:3472302240']
  },
  ws: { connected: true },
  // 0.10.1：概览要能回答「现在跑的到底是哪一版」
  runtime: { version: '0.10.1', pid: 19472, bootAt: '2026-10-29T03:08:11.000Z' },
  routes: { private: { '3472302240': { sessionId: 'session-96114c67-e927-4b0c-83c8-f7c3de1c65f7' } }, group: {} },
  sessions: [{ id: 'session-96114c67-e927-4b0c-83c8-f7c3de1c65f7', title: 'QQ 聊天账号转交', cwd: 'D:\\DSH workspace\\QQ对话', updatedAt: '2026-10-26T10:02:08.333Z' }],
  friends: [{ id: '3472302240', name: '求道者见月' }],
  groups: [],
  // 0.9.0：主动搭话与合并窗口 —— 有记录的分支也要真的渲染一遍（空态好走，非空才容易崩）
  proactive: {
    count: 1,
    targets: ['private:3472302240'],
    next: { key: 'private:3472302240', uin: '3472302240' },
    peers: [{ key: 'private:3472302240', uin: '3472302240', available: true, enabled: true, lastProactiveAt: Date.parse('2026-10-29T02:00:00Z'), lastIncomingAt: Date.parse('2026-10-28T20:00:00Z'), countToday: 1, unanswered: 0, reason: 'daily-quota', eligibleAt: 0 }]
  },
  merge: { settings: { windowMs: 2500, maxWaitMs: 15000, maxMessages: 10 }, pools: [{ uin: '3472302240', count: 2, waitedMs: 800 }] }
}

const bridgeCtx = {
  sessions: {
    list: {
      getSnapshot: () => ({ byId: { 'session-96114c67-e927-4b0c-83c8-f7c3de1c65f7': { id: 'session-96114c67-e927-4b0c-83c8-f7c3de1c65f7', cwd: 'D:\\DSH workspace\\QQ对话', displayTitle: 'QQ 聊天账号转交', updatedAt: '2026-10-26T10:02:08.333Z' } } }),
      subscribe: () => () => {}
    }
  }
}


function isClass(type) {
  return typeof type === 'function' && type.prototype !== undefined && type.prototype.isReactComponent !== undefined
}

let textOut = []
function render(node, depth) {
  if (node === null || node === undefined || node === false || node === true) return
  if (typeof node === 'string' || typeof node === 'number') { textOut.push(String(node)); return }
  if (Array.isArray(node)) { for (const child of node) render(child, depth); return }
  const { type, props, children } = node
  if (typeof type === 'string') { for (const child of children) render(child, depth + 1); return }
  if (isClass(type)) return
  if (typeof type === 'function') {
    const saved = cursor
    cursor = 0
    const out = type(props)
    cursor = saved
    render(out, depth + 1)
    return
  }
  for (const child of children) render(child, depth + 1)
}

// 顺序必须跟组件里 useState 的调用顺序一致：
// s1 data → sTick → s2 draft → s3 input → s4 msg → s5 busy → s6 loading → s7 tunables
// → s8 tab（0.9.1 功能分区）→ s9 targetMode（主动搭话选人模式）
seeds = [
  fakeState,
  0,
  { private: { '3472302240': { sessionId: 'session-96114c67-e927-4b0c-83c8-f7c3de1c65f7' } }, group: {} },
  { private: '', group: '' },
  '',
  false,
  false,
  {
    groupContextCount: 5, groupOnlyWhenAt: true, splitReply: true, splitMaxChars: 120,
    splitDelayMinMs: 200, splitDelayMaxMs: 700, pollMs: 2000, groupPollMs: 3000, resumeColdSession: true,
    mergeWindowMs: 2500, mergeMaxWaitMs: 15000, mergeMaxMessages: 10,
    proactiveEnabled: true, proactiveIdleHours: 6, proactiveDailyMax: 1,
    proactiveQuietFrom: '23:00', proactiveQuietTo: '08:00', proactiveBackoffMax: 4,
    proactiveTargets: [], splitMode: 'paragraph'
  },
  'overview',
  'all'
]

// 错误边界会吞掉异常，只留一句「页面渲染出错」。先把它剥掉，直接调内层组件拿真错误。
function findSection(node) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findSection(child)
      if (hit !== null) return hit
    }
    return null
  }
  if (typeof node.type === 'function' && node.props !== undefined && node.props !== null && 'bridgeCtx' in node.props) return node
  for (const child of node.children || []) {
    const hit = findSection(child)
    if (hit !== null) return hit
  }
  return null
}

const tree = renderFn({ bridgeCtx })
const section = findSection(tree)
if (section === null) {
  console.error('没找到内层设置页组件')
  process.exit(1)
}

let pass = 0
let fail = 0
function ok(cond, label) {
  if (cond) { pass += 1; process.stdout.write(`✓ ${label}\n`) } else { fail += 1; process.stdout.write(`✗ ${label}\n`) }
}

/** 指定 tab 渲染一遍（0.9.1 起一次只挂一块，得挨个走）。 */
function paint(tabId, mode, ctxLike) {
  seeds[8] = tabId
  seeds[9] = mode || 'all'
  textOut = []
  cursor = 0
  const props = Object.assign({}, section.props)
  if (ctxLike !== undefined) props.bridgeCtx = ctxLike
  const out = section.type(props)
  render(out, 0)
  return textOut.join('')
}

// ---- 1. 顶部导航：功能都列在上面，点了才进 ----
const overview = paint('overview')
for (const label of ['概览', '绑定', '对话节奏', '主动搭话', '关系记忆', '推送', '高级']) {
  ok(overview.includes(label), `顶部列出「${label}」`)
}
ok(overview.includes('现在在跑什么'), '概览页有状态摘要')
ok(overview.includes('待合并') && overview.includes('今天主动'), '概览页有统计块（待合并 / 今天主动）')
ok(overview.includes('已连'), '概览页反映推送已连')
ok(overview.includes('指定的 1 人'), '概览页写明主动搭话只对指定的人生效')
ok(overview.includes('这版代码') && overview.includes('0.10.1') && overview.includes('19472'),
  '概览首页显示版本号与进程 pid（改了代码没生效时先看这行）')

// ---- 2. 绑定页：会话下拉、没绑定提示、前缀输入框 ----
const binding = paint('binding')
ok(binding.includes('个可选会话'), '绑定页显示可选会话数')
ok(binding.includes('QQ 聊天账号转交'), '绑定页能选到工作区里的会话')
ok(binding.includes('未绑定'), '绑定页有「未绑定（忽略）」这一项')

// ---- 3. 对话节奏：合并窗口三个字段都在 ----
const stance = paint('stance')
ok(stance.includes('合并窗口') && stance.includes('回复前静默'), '对话节奏页有合并窗口与静默')
ok(stance.includes('判断收尾') || stance.includes('允许判断收尾'), '对话节奏页有收尾开关')
ok(stance.includes('怎么分条'), '对话节奏页有「怎么分条」下拉（0.10.0）')
ok(stance.includes('按换行分'), '下拉里有「按换行分」这个选项')

// ---- 4. 主动搭话：能选人（0.9.1 新） ----
const proactive = paint('proactive')
ok(proactive.includes('对谁开口'), '主动搭话页有「对谁开口」')
ok(proactive.includes('所有已绑私聊') && proactive.includes('只对勾选的人'), '两种模式都能选')
ok(proactive.includes('3472302240'), '名单里列出了已绑会话的人')
ok(proactive.includes('对TA试一次'), '每个人都能单独试一次')
ok(proactive.includes('下一个轮到'), '「现在试一次」会写明这次轮到谁（0.9.2）')
ok(proactive.includes('静默开始'), '闸门参数还在')

// 名单行里勾选状态：全员模式 → 全勾
const allModeTree = section.type(Object.assign({}, section.props))
ok(allModeTree !== null, '全员模式渲染不炸')

// ---- 5. 记忆 / 配置 / 高级：三块都能单独打开 ----
ok(paint('memory').includes('关系记忆'), '记忆页能打开')
ok(paint('ws').includes('WebSocket') || paint('ws').includes('推送地址'), '配置页能打开')
ok(paint('advanced').includes('高级设置'), '高级页能打开')

// ---- 5b. 「配置」分区：HTTP API 与 WS 两条链路都在（0.15.0） ----
const configPane = paint('ws')
ok(configPane.includes('HTTP API'), '配置页有 HTTP API 区块')
ok(configPane.includes('HTTP 地址'), '配置页能改 HTTP 地址')
ok(configPane.includes('HTTP token'), '配置页能改 HTTP token')
ok(configPane.includes('httpServers'), '提示里说明 token 在 httpServers 里（与 WS 那套区分）')
ok(configPane.includes('WebSocket 推送'), '同一页里还有 WS 推送区块')
ok(configPane.includes('WS 地址') && configPane.includes('WS token'), 'WS 地址与 token 也都还在')
ok(configPane.includes('自动发现'), 'HTTP 也有自动发现按钮')

// ---- 6. 模拟 cordis 的门禁：读 ctx.sessions 直接抛 ----
// "cannot get property sessions without inject"。组件必须照样渲染（降级成宿主端那份列表）。
const hostileCtx = {
  get sessions() {
    throw new Error('cannot get property sessions without inject')
  }
}
let survived = true
try {
  const joined2 = paint('binding', 'all', hostileCtx)
  survived = joined2.includes('个可选会话') && joined2.includes('QQ 聊天账号转交')
} catch (error) {
  console.error('读取 ctx.sessions 抛错时组件挂了：', error && error.message ? error.message : error)
  survived = false
}
ok(survived, 'ctx.sessions 抛错时正常降级，面板还在')

console.log(`\n${pass} 过 ${fail} 败`)
process.exit(fail === 0 ? 0 : 1)
