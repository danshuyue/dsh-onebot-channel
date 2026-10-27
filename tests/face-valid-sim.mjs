/**
 * 表情编号有效性测试：node tests/face-valid-sim.mjs，退出码 0 = 全过，1 = 有失败。
 *
 * 背景（2026-10-27 真实事故）：
 *   协议端 makeFaceElem 会**无条件**先跑 SysFaceStore.resolve(faceId)，
 *   本地目录查不到这个 id 时就去 OIDB 0x9155 单查，
 *   查不到就抛 "id N sysemojis cfg not found" —— **整条消息发不出去**。
 *
 *   而内置表情表是社区通用编号表，275 条里有 109 条在 QQ 官方目录里查无此 id
 *   （幽灵 id），另有 11 条名字对得上但 id 错位（「晕」内置 17、官方实际 34）。
 *
 *   实测后果：她写 `[表情:晕]` → 解析成 17 → 幽灵 id → 两条回复整条被吞。
 *
 * 这个文件覆盖三件事：
 *   1. 有效性校验能识别幽灵 id（内置表 vs 官方目录）
 *   2. 解析时能自动纠正错位（「晕」→ 34 而不是 17）
 *   3. 发送层兜底：带表情失败时退回只发文字，文字不能丢
 */
import { BLOCKED_ACTIONS } from '../lib/blocked.js'
import { isKnownSysFaceId, resetKnownFaceIds } from '../lib/sys-faces.js'
import { resolveFaceId, resolveFaceIdSafe } from '../lib/face-resolve.js'
import { splitEmojiMarksAsync } from '../lib/emoji-mark.js'
import { faceIdOf } from '../lib/emoticons.js'

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

// ---- mock OneBot：官方目录里没有 17（真机就是这样）----
// ⚠️ 字段名必须是 q_sid / q_des —— 协议端真实返回的就是这两个。
//    写成 id / name 的话 normFace 会把它们全过滤掉，测试会假绿。
const OFFICIAL = [
  ['0', '惊讶'], ['5', '流泪'], ['6', '害羞'],
  ['9', '大哭'], ['13', '呲牙'], ['14', '微笑'],
  ['16', '酷'], ['18', '抓狂'], ['20', '偷笑'],
  ['21', '可爱'], ['23', '傲慢'], ['25', '困'],
  ['32', '疑问'], ['34', '晕'], ['99', '鼓掌'],
  ['106', '委屈'], ['124', 'OK'], ['319', '比心']
]
const FACES = OFFICIAL.map(([id, name]) => ({ q_sid: id, q_des: `/${name}`, is_super: false }))
globalThis.fetch = async (url, init) => {
  const payload = JSON.parse(init.body)
  if (payload.action === 'search_sys_faces') {
    const q = String(payload.params?.query ?? '')
    const hits = FACES.filter((f) => f.q_des.includes(`/${q}`))
    return { ok: true, json: async () => ({ retcode: 0, data: { faces: hits } }) }
  }
  if (payload.action === 'fetch_sys_faces') {
    return {
      ok: true,
      json: async () => ({ retcode: 0, data: { packs: [{ pack_name: '测试', emojis: FACES }] } })
    }
  }
  return { ok: true, json: async () => ({ retcode: 0, data: null }) }
}

// ---- 1. 有效性校验 ----

console.log('isKnownSysFaceId：')
{
  resetKnownFaceIds()
  ok(await isKnownSysFaceId(13), '官方目录里的 id（13）被认可')
  ok(await isKnownSysFaceId(319), '官方目录里的 id（319）被认可')
  ok(!(await isKnownSysFaceId(17)), '幽灵 id（17）被识别为无效')
  ok(!(await isKnownSysFaceId(54)), '幽灵 id（54 闪电）被识别为无效')
  ok(!(await isKnownSysFaceId(9999)), '不存在的 id 被识别为无效')
}

// ---- 2. 解析纠正错位 ----

console.log('resolveFaceId：')
{
  resetKnownFaceIds()
  const id = await resolveFaceId('晕')
  eq(id, 34, '「晕」解析成官方编号 34（不是内置表的 17）')
}
{
  resetKnownFaceIds()
  eq(await resolveFaceId('13'), 13, '纯数字有效编号照常用')
}
{
  resetKnownFaceIds()
  let threw = false
  try {
    await resolveFaceId('17')
  } catch {
    threw = true
  }
  ok(threw, '纯数字幽灵 id（17）被拒绝，不会发出去')
}
{
  resetKnownFaceIds()
  // 「闪电」不在官方目录里，内置表说 54，但 54 也是幽灵 → 必须拒绝
  let threw = false
  try {
    await resolveFaceId('闪电')
  } catch {
    threw = true
  }
  ok(threw, '内置表的幽灵 id（闪电 54）被拒绝')
}
{
  resetKnownFaceIds()
  eq(await resolveFaceIdSafe('晕'), 34, '安全版：有效的照常解析')
  eq(await resolveFaceIdSafe('17'), null, '安全版：幽灵 id 返回 null 而不是抛错')
  eq(await resolveFaceIdSafe('闪电'), null, '安全版：幽灵名字返回 null 而不是抛错')
}

// ---- 3. 标记解析：无效表情被跳过，但文字留着 ----

console.log('splitEmojiMarksAsync：')
{
  resetKnownFaceIds()
  const r = await splitEmojiMarksAsync('搞定了[表情:晕]')
  eq(r.text, '搞定了', '正文文字保留')
  eq(r.faces.map((f) => f.id), [34], '「晕」解析成 34')
}
{
  resetKnownFaceIds()
  const r = await splitEmojiMarksAsync('文字[表情:17]')
  eq(r.text, '文字', '幽灵 id 的标记被摘掉，文字保留')
  eq(r.faces.length, 0, '幽灵 id 不生成表情段（不会把整条消息搞没）')
}
{
  resetKnownFaceIds()
  const r = await splitEmojiMarksAsync('文字[表情:闪电]文字')
  eq(r.text, '文字文字', '幽灵名字的标记也被摘掉')
  eq(r.faces.length, 0, '幽灵名字不生成表情段')
}
{
  resetKnownFaceIds()
  const r = await splitEmojiMarksAsync('第一句[表情:呲牙]。第二句')
  eq(r.text, '第一句。第二句', '正常表情的标记正确摘掉')
  eq(r.faces.length, 1, '正常表情解析成功')
}

// ---- 4. 内置表自身的性质（记录事实，不改行为） ----

console.log('内置表性质：')
{
  eq(faceIdOf('晕'), 17, '内置兜底表仍把「晕」记成 17（这是已知的错位，出站靠官方目录纠正）')
  ok(BLOCKED_ACTIONS.size === 14, '封禁清单仍是 14 项（本次改动没动它）')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed > 0 ? 1 : 0)
