/**
 * 收藏表情测试：node tests/collect-sim.mjs，退出码 0 = 全过，1 = 有失败。
 *
 * 覆盖 2026-10-27 加的「收到表情包 → 存进 QQ 收藏夹」这条链路：
 *   1. toFileUrl —— Windows 路径 → file:// URL 的转换
 *   2. collectFace —— 调用 add_custom_face + modify_custom_face
 *   3. 备注（desc）—— 没给时用文件名兜底
 *   4. add_custom_face 已从 C 档封禁清单里放开
 */
import { BLOCKED_ACTIONS, isBlocked } from '../lib/blocked.js'
import { toFileUrl } from '../lib/collect.js'
import { findCustomFace } from '../lib/custom-faces.js'

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

// ---- mock OneBot ----
let calls = []
let customFaceResult = { emoji_id: '3655191092_0_0_0_ABCDEF0123456789ABCDEF0123456789_0_0' }
let customFaceList = []
globalThis.fetch = async (url, init) => {
  const payload = JSON.parse(init.body)
  calls.push(payload)
  if (payload.action === 'add_custom_face') {
    return { ok: true, json: async () => ({ retcode: 0, data: customFaceResult }) }
  }
  if (payload.action === 'modify_custom_face') {
    const id = payload.params.emoji_id
    const desc = payload.params.desc
    customFaceList = customFaceList.map((item) => (item.emojiId === id ? { ...item, desc, summary: desc } : item))
    if (customFaceList.length === 0) customFaceList.push({ emojiId: id, url: '', summary: desc, desc })
    return { ok: true, json: async () => ({ retcode: 0, data: null }) }
  }
  if (payload.action === 'fetch_custom_face_detail') {
    // ⚠️ 协议端真实字段名是 emoji_id / url / summary / desc（不是 emojiId）
    return {
      ok: true,
      json: async () => ({
        retcode: 0,
        data: customFaceList.map((item) => ({
          emoji_id: item.emojiId,
          url: item.url ?? '',
          summary: item.summary ?? '',
          desc: item.desc ?? ''
        }))
      })
    }
  }
  return { ok: true, json: async () => ({ retcode: 0, data: null }) }
}

// ---- 1. 封禁清单 ----

console.log('blocked.js：')
{
  ok(!isBlocked('add_custom_face'), 'add_custom_face 已从封禁清单放开（收藏表情包需要它）')
  ok(BLOCKED_ACTIONS.size === 13, `封禁清单剩 13 项（实际 ${BLOCKED_ACTIONS.size}）`)
  ok(isBlocked('get_cookies'), '凭据类仍然封禁')
  ok(isBlocked('delete_qzone_msg'), '删说说仍然封禁')
}

// ---- 2. toFileUrl ----

console.log('toFileUrl：')
{
  const u = toFileUrl('D:\\a b\\x.jpg')
  ok(u.startsWith('file:///D:/'), `Windows 路径转 file:// URL（实际 ${u}）`)
  ok(u.includes('%20'), '空格被编码')
}
{
  eq(toFileUrl('http://x.com/a.jpg'), 'http://x.com/a.jpg', 'http 直链原样透传')
  eq(toFileUrl('base64://abc'), 'base64://abc', 'base64 原样透传')
  eq(toFileUrl(''), '', '空串返回空')
}

// ---- 3. collectFace ----

console.log('collectFace：')
{
  const { collectFace } = await import('../lib/collect.js')
  calls = []
  customFaceList = []
  const r = await collectFace({ file: 'D:\\x\\a.jpg', desc: '测试表情' })
  eq(calls[0].action, 'add_custom_face', '先调 add_custom_face')
  eq(calls[0].params.file.startsWith('file:///D:/'), true, 'file 参数是 file:// URL')
  eq(r.emojiId, customFaceResult.emoji_id, '返回 emoji_id')
  eq(calls[1].action, 'modify_custom_face', '接着调 modify_custom_face 写备注')
  eq(calls[1].params.desc, '测试表情', '备注内容对')
}
{
  const { collectFace } = await import('../lib/collect.js')
  calls = []
  customFaceList = []
  // 没给 desc 时用文件名兜底
  await collectFace({ file: 'D:\\dir\\20261027-180031_3472302240_原名.jpg' })
  const desc = calls.find((c) => c.action === 'modify_custom_face')?.params?.desc
  eq(desc, '原名', '没给 desc 时用文件名（去掉时间戳和 QQ 号前缀）')
}
{
  const { collectFace } = await import('../lib/collect.js')
  calls = []
  customFaceList = []
  await throws(async () => {
    await collectFace({})
  }, '既没 file 也没 recent 时报错')
  ok(calls.length === 0, '参数缺失时没发请求')
}

// ---- 4. findCustomFace 大小写 ----

console.log('findCustomFace：')
{
  customFaceList = [
    {
      emojiId: '3655191092_0_0_0_5F7484A8D8B68F2715712492C65166BA_0_0',
      url: '', summary: '测试表情A', desc: '测试表情A'
    }
  ]
  const hit = await findCustomFace('测试表情A')
  ok(hit !== null, '按备注名能找到')
}
{
  customFaceList = [
    {
      emojiId: '3655191092_0_0_0_5F7484A8D8B68F2715712492C65166BA_0_0',
      url: '', summary: '', desc: ''
    }
  ]
  // 小写 hash（agent 手上的文件名是小写，QQ 返回的是大写）
  const hit = await findCustomFace('5f7484a8d8b68f2715712492c65166ba')
  ok(hit !== null, '按小写 hash 也能找到（大小写无关匹配）')
}
{
  customFaceList = []
  eq(await findCustomFace('不存在的表情'), null, '找不到返回 null')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed > 0 ? 1 : 0)

async function throws(fn, name) {
  try {
    await fn()
    ok(false, `${name}（但没有抛错）`)
  } catch {
    ok(true, name)
  }
}
