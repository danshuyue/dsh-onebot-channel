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
    splitMaxChars: 120, splitDelayMode: 'fixed', splitDelayMs: 800, pollMs: 2000, groupPollMs: 3000,
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
    splitDelayMode: 'fixed', splitDelayMs: 800, pollMs: 2000, groupPollMs: 3000, resumeColdSession: true,
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

// 列序（0.19.4）：用户要求「昵称在前，QQ 号在后」。
// 这里靠渲染顺序断言 —— 文本是按节点顺序拼起来的，所以昵称必须**先**出现。
// 只查「两个都在」是抓不住换位的（老代码也两个都在，只是顺序反了）。
{
  const nameAt = binding.indexOf('求道者见月')
  const uinAt = binding.indexOf('3472302240')
  ok(nameAt >= 0 && uinAt >= 0 && nameAt < uinAt,
    `绑定表里昵称排在 QQ 号前面（昵称 @${nameAt}，QQ 号 @${uinAt}）`)

  // 悬浮显示完整信息：昵称列和 QQ 号列的 title 都应该是「昵称（QQ xxx）」，
  // 否则窄屏被省略号截掉以后就没法确认这行到底是谁。
  let rowNode = null
  const walk = (node) => {
    if (rowNode !== null || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const child of node) walk(child); return }
    if (node.props && node.props.className === 'qqb-row') { rowNode = node; return }
    for (const child of node.children || []) walk(child)
  }
  seeds[8] = 'binding'
  seeds[9] = 'all'
  cursor = 0
  const tree = section.type(Object.assign({}, section.props))
  walk(tree)
  const spans = (rowNode?.children ?? []).filter((child) => child && typeof child === 'object')
  const nameSpan = spans.find((child) => child.props?.className === 'qqb-name')
  const uinSpan = spans.find((child) => child.props?.className === 'qqb-uin')
  ok(nameSpan?.props?.title === '求道者见月（QQ 3472302240）',
    `昵称列悬浮显示完整信息（实际 ${JSON.stringify(nameSpan?.props?.title)}）`)
  ok(uinSpan?.props?.title === '求道者见月（QQ 3472302240）',
    `QQ 号列悬浮显示完整信息（实际 ${JSON.stringify(uinSpan?.props?.title)}）`)
}

// ---- 3. 对话节奏：合并窗口三个字段都在 ----
const stance = paint('stance')
ok(stance.includes('合并窗口') && stance.includes('回复前静默'), '对话节奏页有合并窗口与静默')
ok(stance.includes('判断收尾') || stance.includes('允许判断收尾'), '对话节奏页有收尾开关')
ok(stance.includes('怎么分条'), '对话节奏页有「怎么分条」下拉（0.10.0）')
ok(stance.includes('按换行分'), '下拉里有「按换行分」这个选项')
// 分条间隔（2026-11-07）：从「高级」挪进「对话节奏」，并改成模式 + 数值。
// 用户报「连着发消息太急」—— 参数本来就有，但人在「对话节奏」找不到，等于没有。
ok(stance.includes('分条间隔'), '对话节奏页有「分条间隔」卡片（原来藏在「高级」里）')
ok(stance.includes('固定间隔') && stance.includes('按字数'), '两种模式都列出来了')
ok(stance.includes('条与条之间等多久'), '卡片说明了它是干什么的')

// ---- 4. 主动搭话：能选人（0.9.1 新） ----
const proactive = paint('proactive')
ok(proactive.includes('对谁开口'), '主动搭话页有「对谁开口」')
ok(proactive.includes('所有已绑私聊') && proactive.includes('只对勾选的人'), '两种模式都能选')
ok(proactive.includes('3472302240'), '名单里列出了已绑会话的人')
ok(proactive.includes('对TA试一次'), '每个人都能单独试一次')
ok(proactive.includes('下一个轮到'), '「现在试一次」会写明这次轮到谁（0.9.2）')
ok(proactive.includes('静默开始'), '闸门参数还在')

// 主动搭话「对谁开口」那张表也要昵称在前（0.19.5 审核指出两处风格不一致）。
// ⚠️ 只查「两个都在」抓不住换位 —— 这里同样按渲染顺序断言。
{
  const pName = proactive.indexOf('求道者见月')
  const pUin = proactive.indexOf('3472302240')
  ok(pName >= 0 && pUin >= 0 && pName < pUin,
    `主动搭话表里昵称也排在 QQ 号前面（昵称 @${pName}，QQ 号 @${pUin}）`)
}

// 名单行里勾选状态：全员模式 → 全勾
const allModeTree = section.type(Object.assign({}, section.props))
ok(allModeTree !== null, '全员模式渲染不炸')

// ---- 5. 记忆 / 配置 / 高级：三块都能单独打开 ----
ok(paint('memory').includes('关系记忆'), '记忆页能打开')
ok(paint('ws').includes('WebSocket') || paint('ws').includes('推送地址'), '配置页能打开')
ok(paint('advanced').includes('高级设置'), '高级页能打开')

// ---- 5c. 语音四档与合成引擎（0.19.0）----
// 这一节守的是**真的渲染出来了**，不是「代码里有这个词」——
// 和 ui-wiring 的分工：那边查文本，这边让 QqBridgeSection 的函数体真的跑一遍。
{
  const stanceVoice = paint('stance')
  ok(stanceVoice.includes('语音模式'), '对话节奏页有「语音模式」卡片')
  // 四档的定义必须**整句**渲染出来（用户要求「详细举例介绍」，不是只给个名字）
  ok(stanceVoice.includes('这个模式下ai无语音工具调用权限，无法发语音'), '四档渲染出「禁用」的完整定义')
  ok(stanceVoice.includes('这个模式下除非你要求，否则ai不会发语音'), '四档渲染出「被动」的完整定义')
  ok(stanceVoice.includes('实际效果可能和被动模式类似'), '四档渲染出「自由」的完整定义')
  ok(stanceVoice.includes('除非你要求用文字或者不适合用语音'), '四档渲染出「主动」的完整定义')
  ok(stanceVoice.includes('重启 DSH'), '四档卡片写明了要重启')

  const adv = paint('advanced')
  ok(adv.includes('语音合成'), '高级页有「语音合成」卡片')
  ok(adv.includes('本机 GPT-SoVITS'), '两个引擎都列出来了（本机）')
  ok(adv.includes('Breeze'), '两个引擎都列出来了（Breeze）')
  ok(adv.includes('只是「默认引擎」') || adv.includes('默认引擎'), '写明了这只是默认引擎、不拦 MCP')

  // 导出日志（0.19.4）：用户要把日志拿去云服务器上排查「间隔到底生效没有」。
  // 这里除了「有这张卡」，还要确认链接真的指向 /log-file 且带 download ——
  // 少了 download 浏览器会把这坨纯文本刷在标签页里，用户拿不到文件。
  ok(adv.includes('导出日志'), '高级页有「导出日志」卡片')
  {
    let anchor = null
    let cfgAnchor = null
    let diagAnchor = null
    const walk = (node) => {
      if (node === null || typeof node !== 'object') return
      if (Array.isArray(node)) { for (const child of node) walk(child); return }
      const href = String(node.props?.href ?? '')
      if (node.type === 'a' && anchor === null && href.includes('/log-file')) { anchor = node }
      if (node.type === 'a' && cfgAnchor === null && href.includes('/config-export')) { cfgAnchor = node }
      // ⚠️ 用 includes('/diag-export') 而不是 includes('diag')：后者会被 /config-export
      //    之类的近名字带绿（而且顺序上 config 先命中就永远拿不到 diag）
      if (node.type === 'a' && diagAnchor === null && href.includes('/diag-export')) { diagAnchor = node }
      for (const child of node.children || []) walk(child)
    }
    seeds[8] = 'advanced'
    seeds[9] = 'all'
    cursor = 0
    walk(section.type(Object.assign({}, section.props)))
    ok(anchor !== null, '导出日志卡片里有指向 /log-file 的下载链接')
    ok(String(anchor?.props?.download ?? '') !== '', '链接带 download —— 点一下是另存为，不是把日志刷在标签页里')
    ok(adv.includes('QQ 号') && (adv.includes('没有 key') || adv.includes('不含 key')),
      '写明了日志里有什么（有 QQ 号、没有 key）—— 用户要把它发出来，得先知道这一点')
    // 导出配置（0.19.6，用户要求「导出日志时顺带导出配置」）：
    // 少了配置那一半，排查「发错群」时只看得到「发给了谁」、看不到「当时配的是谁」。
    ok(cfgAnchor !== null, '导出卡片里也有指向 /config-export 的下载链接')
    ok(String(cfgAnchor?.props?.download ?? '').includes('.json'),
      '配置下载下来是 .json（不是把 JSON 刷在标签页里）')
    ok(adv.includes('打码') || adv.includes('已设置'), '写明了凭据会打码 —— 用户才敢把它发出来')
    // 诊断包（0.19.7，用户问「导出日志是不是该搭配导出 DSH 的日志」）：
    // 第三个按钮。⚠️ 断言要点是「href 指向 /diag-export」「带 download」「下载名是 .json」，
    // 光断言文案里有「诊断包」抓不住「按钮指向了错的地址」。
    ok(diagAnchor !== null, '导出卡片里有指向 /diag-export 的第三个下载链接')
    ok(String(diagAnchor?.props?.download ?? '').includes('.json'),
      `诊断包下载下来是 .json（实际「${String(diagAnchor?.props?.download ?? '')}」）`)
    ok(adv.includes('工具调用'), '写明了诊断包会带上工具调用记录 —— 这正是它比前两份多出来的东西')
    ok(adv.includes('队列'), '写明了诊断包里含出站队列状态（「消息卡住」要看的就是它')
  }

  const proactVoice = paint('proactive')
  ok(proactVoice.includes('能使用语音的对象'), '主动搭话页有语音对象名单')
  // ⚠️ 种子里 voiceMode 是 'off'（默认），这时名单卡**故意**只显示「现在是禁用档」的说明，
  //    不渲染两张表 —— 因为 off 档下谁都不能用语音，摆一张能勾的表只会误导。
  //    所以要验「两张表真的在」必须把档位切成非 off，否则测的是另一个分支。
  ok(proactVoice.includes('现在是「禁用」档'), 'off 档下名单卡写明「谁都不能用」')

  // 切成「自由」档再渲染一次：这时两张表必须都在。
  // ⚠️ 档位在 **tunables（seeds[7]）** 里，不是 s12 —— s12 是音色搜索/余额那些临时态。
  //    seeds 数组只预置到索引 9，s10 之后都取各自初始值。
  const savedTunables = seeds[7]
  seeds[7] = Object.assign({}, seeds[7], { voiceMode: 'free' })
  const proactFree = paint('proactive')
  ok(proactFree.includes('私聊') && proactFree.includes('群聊'), '自由档下名单分成私聊 / 群聊两张表')
  // 语义在 2026-11-07 反转了：空名单从「全放开」改成「谁都不能用」（用户要求，更符合直觉，
  // 而且语音会花钱 —— 默认放行所有人是危险的那一侧）。
  ok(proactFree.includes('一个都没勾 = 谁都不能用'), '自由档下写明了空名单 = 谁都不能用')
  ok(proactFree.includes('只对勾选的'), '自由档下能看出「名单非空 = 只对勾选的人」')
  seeds[7] = savedTunables
}

// ---- 5d. 0.19.5 的四项界面改动 ----
{
  // ① 语音卡：改完即存的状态提示必须在（用户明确要求这张卡不用点顶部保存）
  const adv2 = paint('advanced')
  ok(adv2.includes('改动自动保存') || adv2.includes('已保存'),
    '语音卡头部显示了「改动自动保存」的状态（用户要求这张卡不用点顶部保存）')

  // ② 注册入口（需求 3）
  ok(adv2.includes('还没有 Breeze 账号？'), '语音卡里有 Breeze 的注册入口那一句')
  ok(adv2.includes('点这里注册'), '注册入口的链接文字还在')
  // 0.20.2：按用户要求**撤掉「注册链接」输入框**（「选填框用不到，没有实用意义」），
  // 那一行只留「还没有 Breeze 账号？点这里注册」，链接本身就是他的邀请链接。
  //
  // ⚠️ 断言的是**渲染出来的树**，不是源码文本 —— 这里唯一能拿到的是 adv2
  //    （渲染后的字符串）和下面 walk 出来的节点。
  //    「没有输入框」这件事用「原来那格的 label 不再出现」来验：那一格的标签就叫
  //    「注册链接」，而入口那句用的是「点这里注册」/「还没有 Breeze 账号？」，
  //    字面量不同，不会互相误伤。
  ok(!adv2.includes('注册链接'), '0.20.2 撤掉了「注册链接」输入框（用户说没有实用意义）')
  {
    let signup = null
    const walk = (node) => {
      if (signup !== null || node === null || typeof node !== 'object') return
      if (Array.isArray(node)) { for (const child of node) walk(child); return }
      if (node.type === 'a' && String(node.props?.href ?? '').includes('breezeblue.ai')) { signup = node; return }
      for (const child of node.children || []) walk(child)
    }
    seeds[8] = 'advanced'
    seeds[9] = 'all'
    cursor = 0
    walk(section.type(Object.assign({}, section.props)))
    ok(signup !== null, '注册链接指向 breezeblue.ai')
    ok(String(signup?.props?.target ?? '') === '_blank', '注册链接在新标签打开（别把设置页顶掉）')
    ok(String(signup?.props?.rel ?? '').includes('noopener'), '外链带 rel=noopener')
  }

  // ---- 0.20.0：余额那一行的渲染（用户报的 bug 就在这里）----
  //
  // 现场：顶部绿条写着「余额 1916.0 credits」，卡片那一行却写「查不到」。
  // 根因是渲染判的是 `vs.account.ok === true`，而成功路径塞进去的是
  // 后端的 account 子对象（**没有 ok 字段**）—— 恒假，于是永远走「查不到」。
  //
  // 这里用「归并后的形状」（accountStateOf 的产出：ok 在 account 里）渲染一遍。
  // ⚠️ 光断言「数字出现了」不够：查不到分支也会打印别的字，得同时断言
  //    「没有出现『查不到』」—— 那才是用户看到的那句错话。
  {
    const savedVoiceState = seeds[12]
    const savedTunablesForBalance = seeds[7]
    // ⚠️ 余额那一行在 **breezeBlock 里**：整块只在「默认引擎 = Breeze」时渲染。
    //    不切引擎的话这段根本不会出现在树上 —— 而那就变成一个恒绿的断言。
    seeds[7] = Object.assign({}, seeds[7], { voiceEngine: 'breeze' })
    seeds[8] = 'advanced'
    seeds[9] = 'all'

    /**
     * 取「余额那一行」里的**值那个子节点**（`key: 'v'`）的文本。
     *
     * ⚠️ 为什么不能取整行（变异验证逼出来的，两个变异都是同一个根因）：
     *    ① 「超时那行要包含『刷新』」—— 整行里本来就有一个「刷新」按钮，
     *       于是把文案砍成一句光秃秃「超时了」，断言照样绿。同一个事实被两个
     *       因素满足 = 假绿，判不出是哪一边在起作用。
     *    ② 「今日已用」如果只断言整行文本，把那个 span 设成 display:none 也绿
     *       —— 文字仍留在树里，测的是「字符串出现过」，不是「它渲染了」。
     *    所以：值节点单独取，断言只落在它身上。
     */
    function balanceValueText() {
      // ⚠️ 两步走：先定位「余额那一行」（key='bal'），再在**它的子树里**找 key='v'。
      //    直接全树找 key='v' 会撞到提示词卡片里的变量说明（那里也有 key='v'），
      //    实测拿到的是「私聊可用变量：{prefix}…」—— 断言全红，但那是定位错了、
      //    不是实现坏了。定位必须收在被测区域内。
      let row = null
      const findRow = (node) => {
        if (row !== null || node === null || typeof node !== 'object') return
        if (Array.isArray(node)) { for (const child of node) findRow(child); return }
        if (node.props && node.props.key === 'bal' && Array.isArray(node.children)) { row = node; return }
        for (const child of node.children || []) findRow(child)
      }
      findRow(section.type(Object.assign({}, section.props)))
      if (row === null) return null
      let valueNode = null
      const findValue = (node) => {
        if (valueNode !== null || node === null || typeof node !== 'object') return
        if (Array.isArray(node)) { for (const child of node) findValue(child); return }
        if (node.props && node.props.key === 'v' && Array.isArray(node.children)) { valueNode = node; return }
        for (const child of node.children || []) findValue(child)
      }
      findValue(row)
      if (valueNode === null) return null
      const parts = []
      const collect = (n) => {
        if (n === null || n === undefined || n === true || n === false) return
        if (typeof n === 'string' || typeof n === 'number') { parts.push(String(n)); return }
        if (Array.isArray(n)) { for (const c of n) collect(c); return }
        for (const c of n.children || []) collect(c)
      }
      collect(valueNode.children)
      return parts.join('')
    }

    seeds[12] = {
      voices: [], voiceKeyword: '', total: 0, test: null, hasKey: true,
      account: {
        ok: true, timeout: false, error: '',
        balance: 1916.0, pending: false, plan: 'free', concurrency: 1, commercial: false,
      },
      quota: { used: 0, limit: 1000, remaining: 1000, unlimited: false },
    }
    cursor = 0
    const balVal = balanceValueText()
    ok(balVal !== null, '余额那一行的值节点真的渲染出来了（拿不到它就等于下面几条全是恒真的）')
    const balText = String(balVal ?? '')
    ok(balText.includes('1916.0'), `查得到余额时显示 1916.0（实际：${balText.slice(0, 120)}）`)
    ok(!balText.includes('查不到'), '查得到余额时不出现「查不到」')
    ok(balText.includes('free') && balText.includes('并发 1'),
      '余额旁边带上套餐与并发（用户要求说清楚）')
    ok(balText.includes('今天已用 0 / 1000'),
      `今日额度在值节点里（实际：${balText.slice(0, 160)}）`)

    // 查不到的那一侧：仍然是「超时」与「配错了」分开说，不许混成一句
    seeds[12] = Object.assign({}, seeds[12], {
      account: { ok: false, timeout: true, error: '' }, quota: null,
    })
    cursor = 0
    const timeoutText = String(balanceValueText() ?? '')
    ok(timeoutText.includes('超时') && timeoutText.includes('刷新'),
      `超时文案自己就写了「刷新」（不能靠同一行的刷新按钮凑数，实际：${timeoutText.slice(0, 120)}）`)
    ok(!timeoutText.includes('今天已用'), '查不到时不显示额度（否则像是「账户是好的，只是没显示钱」）')

    seeds[12] = Object.assign({}, seeds[12], {
      account: { ok: false, timeout: false, error: 'key 不对' }, quota: null,
    })
    cursor = 0
    ok(String(balanceValueText() ?? '').includes('key 不对'),
      '真的配错时把后端那句原话转出来（不吞成「查不到」）')

    seeds[12] = savedVoiceState
    seeds[7] = savedTunablesForBalance
  }

  // ---- 0.20.1：忽略指令的控件（用户要求「可配置」）----
  //
  // 断言重点不是「文案里有『忽略指令』」，而是**输入框的 value 是逗号拼起来的表**：
  // 那才证明 listField 真的把数组接上了。只查文案的话，把 value 写成空串也绿 ——
  // 而用户会看到自己的 #sl 不见了、保存一次就把配置清空。
  {
    const savedT = seeds[7]
    seeds[7] = Object.assign({}, seeds[7], { ignoreCommands: ['#sl', '/status'] })
    seeds[8] = 'stance'
    seeds[9] = 'all'
    cursor = 0
    let inputNode = null
    const walk = (node) => {
      if (inputNode !== null || node === null || typeof node !== 'object') return
      if (Array.isArray(node)) { for (const child of node) walk(child); return }
      if (node.props && node.props.key === 'ignoreCommands' && Array.isArray(node.children)) {
        const findInput = (n) => {
          if (inputNode !== null || n === null || typeof n !== 'object') return
          if (Array.isArray(n)) { for (const c of n) findInput(c); return }
          if (n.type === 'input') { inputNode = n; return }
          for (const c of n.children || []) findInput(c)
        }
        findInput(node)
        return
      }
      for (const child of node.children || []) walk(child)
    }
    walk(section.type(Object.assign({}, section.props)))
    ok(inputNode !== null, '「忽略指令」那一格真的渲染出了输入框')
    ok(String(inputNode?.props?.value ?? '') === '#sl, /status',
      `输入框里是逗号拼起来的表（实际「${String(inputNode?.props?.value ?? '')}」）—— 空串就说明数组没接上`)
    seeds[7] = savedT
  }

  // ③ 提示词变量说明 + 导入导出（需求 7）
  ok(adv2.includes('全部可用变量'), '提示词卡片列出了全部可用变量')
  for (const name of ['prefixTrimmed', 'ownerUin', 'senderLabel', 'senderUin', 'groupName']) {
    ok(adv2.includes('{' + name + '}'), `变量说明里有 {${name}}`)
  }
  ok(adv2.includes('导出') && adv2.includes('导入'), '提示词卡片有导入 / 导出按钮')

  // ④ 语音对象名单：私聊区即使一个会话都没绑也要列出好友（需求 5）
  //    原来 boundPrivateKeys() 只收有 sessionId 的，用户那条私聊没选会话 →
  //    整块变成「还没有绑好会话的私聊」，看起来像「私聊不见了」。
  const savedT = seeds[7]
  const savedDraft = seeds[2]
  const savedState = seeds[0]
  seeds[7] = Object.assign({}, seeds[7], { voiceMode: 'free' })
  // draft 里那唯一一条**没有** sessionId —— 正是用户截图里的现场
  seeds[2] = { private: { '1321833118': { sessionId: '', prefix: '[管理员]' } }, group: {} }
  // 再塞一个「协议端认识、但既不在绑定表也不在 routes 里」的好友（1437212904 最后的红薯）：
  // 这条是专门为了抓「候选来源漏了 data.friends」这个变异 —— 只靠 draft/routes 也凑得出
  // 一个名字的话，把 friends 那一行删掉测试照样绿，那就等于没测到。
  seeds[0] = Object.assign({}, seeds[0], {
    friends: (seeds[0].friends || []).concat([{ id: '1437212904', name: '最后的红薯' }])
  })
  const proactUnbound = paint('proactive')
  seeds[7] = savedT
  seeds[2] = savedDraft
  seeds[0] = savedState
  // ⚠️ 这里只能查语音卡那句原文（「再回来决定谁**能收语音**」）。
  //    「主动搭话 → 对谁开口」那张表**仍然**只收已绑会话的私聊，那是另一回事
  //    （对没绑会话的人搭话没有意义，消息投不出去），不要顺手把它也放宽了。
  ok(!proactUnbound.includes('再回来决定谁能收语音'),
    '没绑会话时不再把整块语音名单藏起来（原来会替换成一句「还没有绑好会话的私聊」）')
  ok(proactUnbound.includes('学海难行') || proactUnbound.includes('1321833118'),
    '没绑会话的好友仍然列在语音名单里')
  ok(proactUnbound.includes('最后的红薯'),
    '候选里包含「只在协议端好友列表里、没绑会话也没进绑定表」的人（来源不能只剩 draft/routes）')
  ok(proactUnbound.includes('未绑会话'), '没绑会话的好友标出了「未绑会话」')

  // ⑤ 顶栏 + 分区条固定，内容区自己滚（需求 6）
  //    断言的是**结构**：sticky 那层必须把标题行和分区条包进去，而 pane 必须在它**外面**
  //    —— 如果 pane 被包进 sticky，整页就都粘住了，等于没做。
  {
    seeds[8] = 'advanced'
    seeds[9] = 'all'
    cursor = 0
    const tree = section.type(Object.assign({}, section.props))
    // 顶层是 SectionErrorBoundary 包着 QqBridgeSection，不是 .qqb-wrap 本身 —— 得先找出来
    let wrap = null
    const findWrap = (node) => {
      if (wrap !== null || node === null || typeof node !== 'object') return
      if (Array.isArray(node)) { for (const child of node) findWrap(child); return }
      if (node.props && node.props.className === 'qqb-wrap') { wrap = node; return }
      for (const child of node.children || []) findWrap(child)
    }
    findWrap(tree)
    ok(wrap !== null, '能找到 .qqb-wrap 根节点')
    const kids = (wrap?.children ?? []).filter((child) => child && typeof child === 'object')
    const sticky = kids.find((child) => child.props?.className === 'qqb-sticky')
    ok(sticky !== undefined, '第一层里有 .qqb-sticky（标题行 + 分区条）')
    const stickyKids = (sticky?.children ?? []).filter((child) => child && typeof child === 'object')
    ok(stickyKids.some((child) => child.props?.className === 'qqb-head'), '标题行被包进 sticky')
    ok(stickyKids.some((child) => child.props?.className === 'qqb-tabs'), '分区条被包进 sticky')
    ok(!stickyKids.some((child) => child.props?.className === 'qqb-pane'),
      '⚠️ 内容区**没有**被包进 sticky（否则整页都粘住，等于没做）')
    ok(kids.some((child) => child.props?.className === 'qqb-pane'), '内容区仍然是 sticky 的兄弟节点')
  }
}

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
