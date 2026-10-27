/**
 * /state 离线自测：不需要真连 QQ，也不需要 DSH。
 *
 * 验证设置页拿到的东西：会话列表不为空、绑定的会话在列表里、QQ 号/昵称在 self 里。
 * 会话列表有两个来源（sessions 服务 + 扫 ~/.dsh/sessions 落盘目录），这里把
 * sessions 服务打成只返回空，专门验扫盘那条路能不能兜住。
 */
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')

// 假的 OneBot：好友/群/登录信息都从简，重点是别真发请求出去
globalThis.fetch = async () => ({
  ok: true,
  json: async () => ({ status: 'ok', retcode: 0, data: [] })
})

let handler = null
const ctx = {
  get(key) {
    if (key === 'webServer') return { register: (def) => { handler = def.handler } }
    if (key === 'agents') return { get: () => undefined, resume: async () => undefined }
    if (key === 'tools') return { register: () => {} }
    // 故意让 sessions 服务返回空列表：逼它走扫盘兜底
    if (key === 'sessions') return { list: () => [] }
    return undefined
  },
  effect() {},
  on() {}
}

const mod = await import(`${pathToFileURL(join(PLUGIN, 'lib', 'index.js')).href}?t=${Date.now()}`)
mod.apply(ctx)

if (handler === null) {
  console.error('API 没注册上（webServer 桩没接住）')
  process.exit(1)
}

let body = ''
const res = {
  statusCode: 0,
  setHeader() {},
  writeHead(code) { this.statusCode = code },
  end(text) { body = text }
}
await handler({ url: '/api/qq-bridge/state', method: 'GET' }, res)

const data = JSON.parse(body)
const sessions = Array.isArray(data.sessions) ? data.sessions : []
console.log('HTTP', res.statusCode, ' ok =', data.ok)
console.log('self =', JSON.stringify(data.self))
console.log('可选会话数 =', sessions.length)
for (const s of sessions) console.log('  ·', s.id, '|', s.title === '' ? '（无标题）' : s.title, '|', s.updatedAt)

const bound = Object.values(data.routes?.private ?? {})[0]?.sessionId
const inList = bound !== undefined && sessions.some((s) => s.id === bound)
console.log('\n已绑定的会话:', bound)
console.log('在列表里 =', inList, inList ? '' : '（设置页会显示「不在当前工作区」）')

process.exit(0)
