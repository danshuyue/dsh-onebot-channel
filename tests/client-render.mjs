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
  config: { workspaceCwd: 'D:\\DSH workspace\\QQ对话', groupContextCount: 5, groupOnlyWhenAt: true, splitReply: true, splitMaxChars: 120, splitDelayMinMs: 200, splitDelayMaxMs: 700, pollMs: 2000, groupPollMs: 3000, resumeColdSession: true },
  routes: { private: { '3472302240': { sessionId: 'session-96114c67-e927-4b0c-83c8-f7c3de1c65f7' } }, group: {} },
  sessions: [{ id: 'session-96114c67-e927-4b0c-83c8-f7c3de1c65f7', title: 'QQ 聊天账号转交', cwd: 'D:\\DSH workspace\\QQ对话', updatedAt: '2026-10-26T10:02:08.333Z' }],
  friends: [{ id: '3472302240', name: '求道者见月' }],
  groups: []
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
    splitDelayMinMs: 200, splitDelayMaxMs: 700, pollMs: 2000, groupPollMs: 3000, resumeColdSession: true
  }
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

cursor = 0
try {
  const out = section.type(section.props)
  render(out, 0)
} catch (error) {
  console.error('组件体抛错：', error && error.stack ? error.stack.split('\n').slice(0, 6).join('\n') : error)
  process.exit(1)
}

const joined = textOut.join('')
console.log('渲染通过，文本片段：')
console.log('  ' + joined.slice(0, 300).replace(/\s+/g, ' '))
for (const expect of ['QQ 桥接', '个可选会话', 'QQ 聊天账号转交', '未绑定']) {
  console.log((joined.includes(expect) ? '✓ ' : '✗ ') + expect)
}

// 第二关：模拟 cordis 的门禁 —— 读 ctx.sessions 直接抛
// "cannot get property sessions without inject"。组件必须照样渲染（降级成宿主端那份列表）。
const hostileCtx = {
  get sessions() {
    throw new Error('cannot get property sessions without inject')
  }
}

textOut = []
cursor = 0
try {
  const out2 = section.type(Object.assign({}, section.props, { bridgeCtx: hostileCtx }))
  render(out2, 0)
} catch (error) {
  console.error('读取 ctx.sessions 抛错时组件挂了：', error && error.message ? error.message : error)
  process.exit(1)
}
const joined2 = textOut.join('')
const survived = joined2.includes('个可选会话') && joined2.includes('QQ 聊天账号转交')
console.log('\nctx.sessions 抛错时：' + (survived ? '✓ 正常降级，面板还在' : '✗ 面板被搞死了'))
