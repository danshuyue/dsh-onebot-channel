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
  user_id: 1000000001,
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
  const bucket2 = { lastSeq: 100 }
  ok(isSeen(bucket2, { message_id: 1, message_seq: 50 }) === true, 'seq 小于等于游标位置 = 已处理')
  ok(isSeen(bucket2, { message_id: 2, message_seq: 101 }) === false, 'seq 大于游标位置 = 新消息')
}

// 5. 事件归一化（WS 的平铺结构 → 内部统一结构）
{
  const normalized = normalizeEvent({
    post_type: 'message',
    message_type: 'group',
    group_id: 2000000001,
    user_id: 1000000003,
    message: [{ type: 'at', data: { qq: '1000000002' } }, { type: 'text', data: { text: '在吗' } }],
    message_id: -777,
    time: 1793072000
  })
  ok(normalized.sender.user_id === '1000000003', 'sender.user_id 归一化了')
  ok(Array.isArray(normalized.message) && normalized.message.length === 2, '段数组原样保留')
  ok(normalized.message_id === -777, 'message_id 保留（负数也没关系）')
}

stop()
console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed > 0 ? 1 : 0)
