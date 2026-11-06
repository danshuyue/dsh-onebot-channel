/**
 * WS 推送专项测试：node tests/ws-sim.mjs，退出码 0 = 全过。
 *
 * 用假 WebSocket 顶替全局实现，验证四件事：
 *   1. 连接建立时带上了鉴权信息（URL 的 access_token / headers 二选一）
 *   2. message 事件被正确分发到回调
 *   3. 断线后自动重连（指数退避）
 *   4. 去重：同一条消息（message_id 相同）不会被处理两次
 *
 * 不连真 SnowLuma，不碰真会话。
 */
import { isSeen, markSeen, normalizeEvent } from '../lib/poll.js'

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}`)
  }
}

// ---- 假 WebSocket ----

const created = []
class FakeWebSocket {
  constructor(url, options) {
    this.url = url
    this.options = options ?? {}
    this.onopen = null
    this.onmessage = null
    this.onerror = null
    this.onclose = null
    this.closed = false
    created.push(this)
  }
  close() {
    this.closed = true
    if (typeof this.onclose === 'function') this.onclose({ code: 1000, reason: 'closed by test' })
  }
  /** 模拟连上 */
  open() {
    if (typeof this.onopen === 'function') this.onopen()
  }
  /** 模拟推来一条事件 */
  emit(data) {
    if (typeof this.onmessage === 'function') this.onmessage({ data: JSON.stringify(data) })
  }
  /** 模拟异常断开 */
  drop(code = 1006) {
    if (typeof this.onclose === 'function') this.onclose({ code, reason: 'dropped' })
  }
}
globalThis.WebSocket = FakeWebSocket

const { startWs, wsStatus, isWsConnected } = await import('../lib/ws.js')

// 配好 WS 地址和 token（config 是单例，直接改）
const { getConfig } = await import('../lib/config.js')
const config = getConfig()
config.wsEnabled = true
config.wsUrl = 'ws://127.0.0.1:3001/'
config.wsToken = 'test-token-123'

console.log('ws.js：')

const received = []
const stop = startWs((event) => {
  received.push(event)
})

// 1. 连接建立 + 鉴权信息
const socket = created[0]
ok(socket !== undefined, '创建了 WebSocket 连接')
ok(String(socket.url).includes('access_token=test-token-123'), 'URL 上带了 access_token（各版本都认的鉴权方式）')
const headerToken = String(socket.options?.headers?.Authorization ?? '')
ok(headerToken.includes('test-token-123'), '同时带了 Authorization 头（双保险）')

socket.open()
ok(isWsConnected() === true, 'open 后状态是已连接')
ok(wsStatus().connected === true, 'wsStatus 报告已连接')

// 2. 事件分发
socket.emit({
  post_type: 'message',
  message_type: 'private',
  user_id: 3472302240,
  message: [{ type: 'text', data: { text: '在吗' } }],
  message_id: -123456,
  time: 1793072000
})
ok(received.length === 1, 'message 事件被分发到回调')
ok(received[0]?.message_type === 'private', '事件内容原样传过来了')

// 非消息事件（心跳）也要能安全消化
const before = received.length
socket.emit({ post_type: 'meta_event', meta_event_type: 'heartbeat', interval: 30000 })
ok(received.length === before + 1, '心跳事件也交给回调（回调内部按 post_type 过滤）')

// 3. 断线重连
const createdBefore = created.length
socket.drop(1006)
ok(isWsConnected() === false, '断开后状态是未连接')
await new Promise((resolve) => setTimeout(resolve, 1300))
ok(created.length > createdBefore, '断线后自动重连了')

// 4. 去重
{
  const bucket = {}
  const message = { message_id: -999, message_seq: 42 }
  ok(isSeen(bucket, message) === false, '没处理过的消息不算重复')
  markSeen(bucket, message)
  ok(isSeen(bucket, message) === true, '处理过的消息能认出来（message_id 可能是负数，用相等判断）')
  ok(Array.isArray(bucket.seenIds) && bucket.seenIds.length === 1, 'seenIds 记录下来了')
  // seq 游标也能拦
  // 第三个参数 true = 群聊路径（seq 单调，可以比大小）；
  // 私聊走时间戳分支，seq 不可信 —— 见 lib/poll.js 的 isSeen 注释
  const bucket2 = { lastSeq: 100 }
  ok(isSeen(bucket2, { message_id: 1, message_seq: 50 }, true) === true, 'seq 小于等于游标位置 = 已处理')
  ok(isSeen(bucket2, { message_id: 2, message_seq: 101 }, true) === false, 'seq 大于游标位置 = 新消息')
}

// 5. 事件归一化（WS 的平铺结构 → 内部统一结构）
{
  const normalized = normalizeEvent({
    post_type: 'message',
    message_type: 'group',
    group_id: 1046436553,
    user_id: 1742196292,
    message: [{ type: 'at', data: { qq: '3655191092' } }, { type: 'text', data: { text: '在吗' } }],
    message_id: -777,
    time: 1793072000
  })
  ok(normalized.sender.user_id === '1742196292', 'sender.user_id 归一化了')
  ok(Array.isArray(normalized.message) && normalized.message.length === 2, '段数组原样保留')
  ok(normalized.message_id === '-777', 'message_id 保留为无损字符串（负数也没关系）')
  const huge = normalizeEvent({ message_id: '900719925474099312345' })
  ok(huge.message_id === '900719925474099312345', '大 message_id 超过 Number 安全范围仍原样保留')
}

// 6. 回归：stop() 必须真的能关掉连接（2026-11-06，用户报告 WS 相关问题带出来的）
// 以前 connect() 里有 `let socket = null` 遮蔽了模块级变量，事件回调靠闭包正常，
// 但 startWs() 返回的停止函数读的是模块级 socket（恒为 null）→ 关不掉，残留 TCP。
{
  const before = created.length
  const stop2 = startWs(() => {})
  const fresh = created[before]
  ok(fresh !== undefined, '重新起了一个连接')
  fresh.open()
  ok(isWsConnected() === true, '新连接已建立')
  stop2()
  ok(fresh.closed === true, 'stop() 之后底层连接被 close()（不能因为变量遮蔽而关不掉）')
  ok(isWsConnected() === false, 'stop() 之后状态是未连接')
  // 收拾干净，别影响后面的用例
  fresh.drop(1000)
}

// 7. 保障：1006 断连不会被逐次刷屏（去重确实生效）
//
// ⚠️ 这条**不是**「修了报告里的 5.2 条」——那一条核验后判定为非 bug（见 lib/ws.js
//    onclose 里的长注释）：`state.connected === false` 虽然恒真，但去重靠的是
//    wsDownLogged，它只在 onopen 里重置，所以行为一直是对的。
//    这条测试留着是为了**防止将来真把它改坏**（比如有人把 wsDownLogged 的重置删了）。
{
  const { readFileSync: rf, existsSync: ef } = await import('node:fs')
  const { homedir: hd } = await import('node:os')
  const { join: jn } = await import('node:path')
  const LOAD_LOG = jn(hd(), '.dsh', 'qq-bridge-load.log')
  const countDisconnects = () => {
    try {
      if (!ef(LOAD_LOG)) return 0
      return rf(LOAD_LOG, 'utf8').split('\n').filter((l) => l.includes('[ws] 连接断开')).length
    } catch { return 0 }
  }

  const before7 = created.length
  const stop3 = startWs(() => {})
  const s = created[before7]
  s.open()

  const c0 = countDisconnects()
  s.drop(1006) // 第一次：应该记一条
  const c1 = countDisconnects()
  ok(c1 === c0 + 1, `第一次 1006 记了一条（${c0} → ${c1}）`)

  // 第二次 1006：还没连上就又断了，不该再记
  const s2 = created[created.length - 1]
  if (s2 !== undefined && s2 !== s && typeof s2.onclose === 'function') {
    s2.onclose({ code: 1006, reason: 'dropped again' })
  }
  const c2 = countDisconnects()
  ok(c2 === c1, `第二次 1006 不再重复记（${c1} → ${c2}）`)

  try { stop3() } catch {}
}

stop()
console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed > 0 ? 1 : 0)
