/**
 * 能力接入测试：node tests/capability-sim.mjs，退出码 0 = 全过，1 = 有失败。
 *
 * 覆盖这一轮接入的东西：
 *   1. blocked.js —— C 档 14 个 action 必须被物理拦截（连 HTTP 都不发）
 *   2. sys-faces.js —— 官方表情目录搜索 / 反查 / 降级
 *   3. face-resolve.js —— 表情名反查顺序（官方目录优先，内置表兜底）
 *   4. history.js —— 群 / 好友消息历史
 *   5. qzone.js —— 发说说（可见性校验、空正文拒绝）
 *
 * 全程 mock fetch，不碰真 QQ。
 */
import { BLOCKED_ACTIONS, assertNotBlocked, isBlocked } from '../lib/blocked.js'
import { callOneBot } from '../lib/onebot.js'
import { searchSysFaces, fetchSysFacePacks, lookupSysFaceId } from '../lib/sys-faces.js'
import { resolveFaceId } from '../lib/face-resolve.js'
import { getGroupHistory, getFriendHistory } from '../lib/history.js'
import { sendQzoneMsg } from '../lib/qzone.js'
import { splitEmojiMarksAsync } from '../lib/emoji-mark.js'

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
async function throws(fn, name) {
  try {
    await fn()
    ok(false, `${name}（但没有抛错）`)
  } catch {
    ok(true, name)
  }
}

// ---- mock OneBot ----
let calls = []
/** 协议端返回的假数据，按 action 分发。 */
let responses = {}
globalThis.fetch = async (url, init) => {
  const payload = JSON.parse(init.body)
  calls.push(payload)
  const data = responses[payload.action]
  if (data === undefined) {
    return { ok: true, json: async () => ({ retcode: 0, data: null }) }
  }
  return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data }) }
}

// ---- 1. blocked.js ----

console.log('blocked.js：')
{
  ok(BLOCKED_ACTIONS.size === 13, `封禁清单是 13 项（实际 ${BLOCKED_ACTIONS.size}）`)
  const mustHave = [
    'get_cookies', 'get_credentials', 'get_csrf_token', 'get_clientkey',
    'get_rkey_server', 'request_decrypt_key', 'bot_exit', 'set_online_status',
    'set_diy_online_status', 'set_input_status', 'send_like', 'set_qzone_ban',
    'delete_qzone_msg'
  ]
  for (const name of mustHave) {
    ok(BLOCKED_ACTIONS.has(name), `封禁了 ${name}`)
  }
  // add_custom_face 已于 2026-10-27 放开（收藏表情包需要它，走受控工具 qq_collect_face）
  ok(!BLOCKED_ACTIONS.has('add_custom_face'), 'add_custom_face 已放开（收藏表情包需要）')
  // 允许的必须没被误伤
  const allowed = [
    'send_group_msg', 'send_private_msg', 'get_group_msg_history',
    'get_friend_msg_history', 'search_sys_faces', 'fetch_sys_faces',
    'send_qzone_msg', 'get_qzone_feeds', 'send_custom_face', 'fetch_custom_face_detail'
  ]
  for (const name of allowed) {
    ok(!isBlocked(name), `没误伤 ${name}`)
  }
}
{
  calls = []
  await throws(async () => {
    await callOneBot({ action: 'get_cookies', params: {} })
  }, 'callOneBot 拦截 get_cookies')
  ok(calls.length === 0, '被拦截的 action 连 HTTP 都没发出去')
}
{
  calls = []
  await throws(async () => {
    await callOneBot({ action: 'bot_exit', params: {} })
  }, 'callOneBot 拦截 bot_exit')
  ok(calls.length === 0, 'bot_exit 没发到协议端')
}
{
  // 错误对象带标记，方便上层识别
  try {
    assertNotBlocked('get_credentials')
    ok(false, 'assertNotBlocked 应该抛错')
  } catch (error) {
    ok(error.code === 'QQ_ACTION_BLOCKED', '拦截错误带 QQ_ACTION_BLOCKED 标记')
    ok(String(error.message).includes('get_credentials'), '错误信息里带上被拦的 action 名')
  }
}
{
  assertNotBlocked('send_group_msg') // 不该抛
  ok(true, '允许的 action 正常放行')
}

// ---- 2. sys-faces.js ----

console.log('sys-faces.js：')
{
  calls = []
  responses = {
    search_sys_faces: {
      faces: [
        { q_sid: '319', q_des: '/比心', em_code: '10319', is_super: true },
        { q_sid: '318', q_des: '/打call', em_code: '10318', is_super: false }
      ]
    }
  }
  const list = await searchSysFaces('比心')
  eq(list.map((f) => f.id), ['319', '318'], '搜索返回 id 列表')
  eq(list[0].name, '比心', 'q_des 前导斜杠被剥掉')
  eq(list[0].isSuper, true, 'is_super 被规整成布尔')
  eq(calls[0].params, { query: '比心' }, '参数名是 query（不是 keyword）')
}
{
  calls = []
  responses = {}
  const list = await searchSysFaces('比心')
  eq(list, [], '协议端不支持时降级为空数组，不抛错')
}
{
  calls = []
  responses = {
    fetch_sys_faces: {
      packs: [
        { pack_name: '超级表情', emojis: [{ q_sid: '5', q_des: '/流泪' }] },
        { pack_name: '空包', emojis: [] }
      ]
    }
  }
  const packs = await fetchSysFacePacks()
  eq(packs.length, 1, '空表情包被过滤掉')
  eq(packs[0].packName, '超级表情', '包名正确')
  eq(packs[0].faces[0].id, '5', '包内表情 id 正确')
}
{
  responses = { search_sys_faces: { faces: [{ q_sid: '319', q_des: '/比心' }] } }
  const hit = await lookupSysFaceId('比心')
  eq(hit?.id, '319', '反查命中')
}

// ---- 3. face-resolve.js ----

console.log('face-resolve.js：')
{
  responses = { search_sys_faces: { faces: [{ q_sid: '319', q_des: '/比心' }] } }
  const id = await resolveFaceId('比心')
  eq(id, 319, '官方目录命中')
}
{
  responses = { search_sys_faces: { faces: [] } }
  const id = await resolveFaceId('呲牙')
  eq(id, 13, '官方目录查不到时落内置表')
}
{
  responses = { search_sys_faces: { faces: [] } }
  eq(await resolveFaceId('13'), 13, '纯数字直接当编号用')
}
{
  responses = { search_sys_faces: { faces: [] } }
  await throws(async () => {
    await resolveFaceId('压根没有的表情名')
  }, '两边都查不到就抛错')
}
{
  responses = {}
  const id = await resolveFaceId('OK')
  ok(id !== null && id !== undefined, '协议端完全不可用时内置表仍能顶上')
}

// ---- 4. history.js ----

console.log('history.js：')
{
  calls = []
  responses = {
    get_group_msg_history: {
      messages: [
        {
          time: 1793063251, message_id: -122396081, message_seq: 4373,
          group_id: 1046436553, user_id: 3472302240,
          message: [{ type: 'text', data: { text: '群里的消息' } }],
          sender: { nickname: '求道者见月', card: '王浩宇喵', role: 'owner' }
        }
      ]
    }
  }
  const list = await getGroupHistory('1046436553', 5)
  eq(list.length, 1, '群历史条数正确')
  eq(list[0].text, '群里的消息', '群历史正文正确')
  eq(list[0].kind, 'group', 'kind 标记正确')
  eq(list[0].nickname, '求道者见月', '昵称取自 sender.nickname')
  eq(calls[0].params.group_id, 1046436553, 'group_id 转成了数字')
  eq(calls[0].params.count, 5, 'count 传对了')
}
{
  calls = []
  responses = {
    get_friend_msg_history: {
      messages: [
        {
          time: 1793079271, message_id: 626662466, message_seq: 56482, user_id: 3655191092,
          message: [{ type: 'text', data: { text: '私聊消息' } }],
          sender: { nickname: '洛殿下' }
        }
      ]
    }
  }
  const list = await getFriendHistory('3655191092', 3)
  eq(list[0].text, '私聊消息', '好友历史正文正确')
  eq(list[0].kind, 'private', 'kind 标记为 private')
  eq(calls[0].params.user_id, 3655191092, 'user_id 转成了数字')
}
{
  await throws(async () => {
    await getGroupHistory('0', 5)
  }, '群号不合法直接抛错，不发请求')
}
{
  await throws(async () => {
    await getFriendHistory('abc', 5)
  }, 'QQ 号不合法直接抛错')
}

// ---- 5. qzone.js ----

console.log('qzone.js：')
{
  calls = []
  responses = { send_qzone_msg: { tid: '123' } }
  const result = await sendQzoneMsg({ content: '今天天气不错' })
  ok(result?.retcode === 0, '发说说成功')
  eq(calls[0].action, 'send_qzone_msg', '调的是 send_qzone_msg')
  eq(calls[0].params.content, '今天天气不错', '正文传对了')
  eq(calls[0].params.ugc_right, 1, '默认所有人可见')
}
{
  calls = []
  responses = { send_qzone_msg: { tid: '123' } }
  await sendQzoneMsg({ content: '只有好友看', visibility: 4 })
  eq(calls[0].params.ugc_right, 4, '可见性传对了')
}
{
  calls = []
  responses = { send_qzone_msg: { tid: '123' } }
  await sendQzoneMsg({ content: '给特定的人', visibility: 64, targetUins: ['111', '222'] })
  eq(calls[0].params.target_uins, [111, 222], '指定好友列表转成数字')
}
{
  calls = []
  await throws(async () => {
    await sendQzoneMsg({ content: '   ' })
  }, '空正文拒绝发送')
  ok(calls.length === 0, '空正文没发请求')
}
{
  await throws(async () => {
    await sendQzoneMsg({ content: '正文', visibility: 7 })
  }, '非法可见性被拒绝')
}
{
  calls = []
  responses = { send_qzone_msg: { tid: '123' } }
  await throws(async () => {
    await sendQzoneMsg({ content: 'a'.repeat(1001) })
  }, '超过 1000 字的正文拒绝发送')
  ok(calls.length === 0, '超长正文没发请求')
}

// ---- 6. 异步标记解析 ----

console.log('emoji-mark.js（异步版）：')
{
  responses = { search_sys_faces: { faces: [{ q_sid: '319', q_des: '/比心' }] } }
  const marked = await splitEmojiMarksAsync('搞定了[表情:比心]')
  eq(marked.text, '搞定了', '标记被摘掉')
  eq(marked.faces.length, 1, '解析出一个表情')
  eq(marked.faces[0].id, 319, '表情 id 来自官方目录')
}
{
  responses = { search_sys_faces: { faces: [] } }
  const marked = await splitEmojiMarksAsync('文字[表情:呲牙]')
  eq(marked.faces[0].id, 13, '官方查不到时落内置表')
}
{
  responses = { search_sys_faces: { faces: [] } }
  const marked = await splitEmojiMarksAsync('文字[表情:不存在的表情]')
  eq(marked.text, '文字', '认不出的标记也从正文摘掉')
  eq(marked.faces.length, 0, '认不出的标记不产生表情段')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed > 0 ? 1 : 0)
