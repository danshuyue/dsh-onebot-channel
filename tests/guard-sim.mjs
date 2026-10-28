/**
 * 出站闸门专项测试：node tests/guard-sim.mjs，退出码 0 = 全过。
 *
 * 覆盖 2026-10-28 新增的两道闸：
 *   1. allowlist.js —— 出站**目标**白名单（挂在 callOneBot 这个唯一出口上）
 *   2. sensitive.js —— 出站**内容**审计（本机路径 / 凭据特征）
 *
 * 为什么这两道必须一起测：
 *   它们解决的是两个不同的问题 ——「发给谁」和「发什么」。
 *   只做目标白名单，她照样能把 C:\Users\... 念进群里；
 *   只做内容审计，群里一句 prompt injection 就能让她去骚扰任意 QQ 号。
 *
 * 会临时改写 ~/.dsh/qq-bridge.config.json（白名单从配置派生，绕不开），
 * 结束时按退出钩子恢复原样 —— 跟 dup-send-sim.mjs 同一套做法。
 */
import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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
function eq(actual, expected, name) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, `${name}${same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`)
}
/** 断言抛错，并返回错误信息方便再断言内容。 */
async function throws(fn, name) {
  try {
    await fn()
    ok(false, `${name}（没有抛错）`)
    return ''
  } catch (error) {
    ok(true, name)
    return error instanceof Error ? error.message : String(error)
  }
}

const CONFIG = join(homedir(), '.dsh', 'qq-bridge.config.json')
const PEER = 1000000001
const FRIEND = 1000000004
const GROUP = 2000000001
const STRANGER = 9999999999

const configBackup = readFileSync(CONFIG, 'utf8')
process.on('exit', () => {
  try { writeFileSync(CONFIG, configBackup, 'utf8') } catch {}
})

/** 写一份测试配置并重新加载（白名单是从配置现算的，所以必须走这条路）。 */
async function useConfig(patch) {
  const base = JSON.parse(configBackup)
  const next = {
    ...base,
    peerUin: PEER,
    ownerUin: PEER,
    selfUin: 1000000002,
    routes: { private: { [String(PEER)]: { sessionId: 's1' }, [String(FRIEND)]: { sessionId: 's2' } }, group: { [String(GROUP)]: { sessionId: 's3' } } },
    groupUins: [GROUP],
    allowSendToAny: false,
    ...patch
  }
  writeFileSync(CONFIG, JSON.stringify(next, null, 2), 'utf8')
  const { loadConfig } = await import('../lib/config.js')
  loadConfig()
}

// ---- 1. 号归一 ----
const { normUin, allowedTargets, sendTargetOf } = await import('../lib/allowlist.js')
const { findSensitive, maskHit } = await import('../lib/sensitive.js')

console.log('normUin：')
{
  eq(normUin('003001'), '3001', '前导零被吃掉')
  eq(normUin(' 3001 '), '3001', '首尾空白被吃掉')
  eq(normUin(3001), '3001', '数字转字符串')
  eq(normUin(0), '', '0 归成空（表示「没配」）')
  eq(normUin(-1), '', '负数归成空')
  eq(normUin(''), '', '空串归成空')
  eq(normUin('abc'), '', '非数字归成空')
  eq(normUin(null), '', 'null 归成空')
}

// ---- 2. 白名单派生 ----
console.log('白名单派生：')
await useConfig({})
{
  const allowed = allowedTargets()
  ok(allowed.private.has(String(PEER)), '用户本人在私聊白名单里')
  ok(allowed.private.has(String(FRIEND)), '绑了会话的好友在白名单里')
  ok(allowed.group.has(String(GROUP)), '监听的群在群白名单里')
  ok(!allowed.private.has(String(STRANGER)), '没配的号不在白名单里')
}

// ---- 3. 发送类 action 的目标提取 ----
console.log('sendTargetOf：')
{
  eq(sendTargetOf('send_private_msg', { user_id: 123 }), { kind: 'private', id: '123' }, 'send_private_msg 取 user_id')
  eq(sendTargetOf('send_group_msg', { group_id: 456 }), { kind: 'group', id: '456' }, 'send_group_msg 取 group_id')
  eq(sendTargetOf('send_msg', { message_type: 'group', group_id: 789 }), { kind: 'group', id: '789' }, 'send_msg 按 message_type 判群')
  eq(sendTargetOf('send_msg', { message_type: 'private', user_id: 111 }), { kind: 'private', id: '111' }, 'send_msg 按 message_type 判私聊')
  eq(sendTargetOf('send_msg', { group_id: 222 }), { kind: 'group', id: '222' }, 'send_msg 没写类型时按有 group_id 猜')
  eq(sendTargetOf('get_login_info', {}), null, '只读 action 不参与目标校验')
  eq(sendTargetOf('get_group_msg_history', { group_id: 1 }), null, '查历史不参与目标校验')
}

// ---- 4. 出站闸门 ----
// 不需要重新 import：assertSendAllowed 每次都现读配置，改完 loadConfig 立即生效。
console.log('出站闸门：')
await useConfig({})
{
  const { assertSendAllowed } = await import('../lib/allowlist.js')

  try {
    assertSendAllowed('send_private_msg', { user_id: FRIEND })
    ok(true, '范围内的好友：放行')
  } catch (error) {
    ok(false, `范围内的好友：放行（实际抛错 ${error.message}）`)
  }
  try {
    assertSendAllowed('send_group_msg', { group_id: GROUP })
    ok(true, '范围内的群：放行')
  } catch (error) {
    ok(false, `范围内的群：放行（实际抛错 ${error.message}）`)
  }
  const msg1 = await throws(() => assertSendAllowed('send_private_msg', { user_id: STRANGER }), '范围外的 QQ 号：拦截')
  ok(msg1.includes('白名单'), '拦截原因说清了是白名单')
  ok(msg1.includes('allowSendToAny'), '拦截信息里给了逃生阀怎么开')
  const msg2 = await throws(() => assertSendAllowed('send_group_msg', { group_id: 999 }), '范围外的群：拦截')
  ok(msg2.includes('群'), '拦截信息标明了是群')
  try {
    assertSendAllowed('get_login_info', {})
    ok(true, '只读 action 不受影响')
  } catch {
    ok(false, '只读 action 不受影响（被误拦了）')
  }
  // 数字与字符串混用不该造成假阴性（白名单里存字符串，协议端传数字）
  try {
    assertSendAllowed('send_private_msg', { user_id: Number(FRIEND) })
    ok(true, '数字形态的 QQ 号同样命中白名单')
  } catch (error) {
    ok(false, `数字形态的 QQ 号被判成范围外（${error.message}）`)
  }
}

// 逃生阀：allowSendToAny 实时生效
await useConfig({ allowSendToAny: true })
{
  const { assertSendAllowed } = await import('../lib/allowlist.js')
  try {
    assertSendAllowed('send_private_msg', { user_id: STRANGER })
    ok(true, 'allowSendToAny=true 时放行任意目标（逃生阀生效）')
  } catch (error) {
    ok(false, `allowSendToAny=true 应该放行（实际抛错 ${error.message}）`)
  }
}

// 空配置边界
await useConfig({ peerUin: 0, ownerUin: 0, routes: { private: {}, group: {} }, groupUins: [] })
{
  const { assertSendAllowed } = await import('../lib/allowlist.js')
  const allowed = allowedTargets()
  eq(allowed.private.size + allowed.group.size, 0, '全空配置下白名单确实是空的')
  try {
    assertSendAllowed('send_private_msg', { user_id: STRANGER })
    ok(true, '全空配置下放行（还没配好，不该把插件锁死）')
  } catch (error) {
    ok(false, `全空配置下应该放行（实际抛错 ${error.message}）`)
  }
}

// ---- 5. 内容审计 ----
console.log('内容审计：')
{
  const hits = [
    ['我看了 C:\\Users\\Administrator\\.dsh\\qq-bridge.config.json', 'path', 'Windows 盘符路径'],
    ['配置在 /home/tree/.config 下面', 'path', 'Unix 路径'],
    ['token=abc123def456 你拿去用', 'credential', 'token 赋值'],
    ['密码：12345678', 'credential', '中文关键词 + 全角冒号'],
    ['api_key: sk-abcdefghijklmn', 'credential', 'api_key 赋值'],
    ['Authorization: Bearer eyJhbGciOi', 'credential', 'Bearer 头'],
    ['密钥是 abcdefg', 'credential', '中文「是」连接']
  ]
  for (const [text, kind, name] of hits) {
    const hit = findSensitive(text)
    ok(hit !== null, `命中：${name}`)
    eq(hit?.kind, kind, `  分类正确：${name}`)
    ok(!String(hit?.sample ?? '').includes('Administrator'), `  命中片段已打码：${name}`)
  }

  const clean = [
    ['我在 C 盘找到的', '光说盘符没路径不算'],
    ['我密码忘了', '没赋值不算'],
    ['token 是什么意思', '正常提问不算（这条曾经被误拦过）'],
    ['这个表情是 d41d8cd98f00b204e9800998ecf8427e.jpg', 'MD5 文件名不算（表情包就是 MD5）'],
    ['md5:a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6', '裸十六进制串不算'],
    ['https://example.com/path?a=1', '普通 URL 不算'],
    ['今天天气不错，去操场跑了三公里', '普通聊天不算'],
    ['我的 QQ 是 3472302240', 'QQ 号不算']
  ]
  for (const [text, name] of clean) {
    const hit = findSensitive(text)
    ok(hit === null, `不误伤：${name}${hit === null ? '' : `（误判成 ${hit.kind}）`}`)
  }

  eq(maskHit('abcdefghij'), 'abc***ij（共 10 字符）', '打码保留头尾')
  eq(maskHit('abc'), '***', '太短的整段打码')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
