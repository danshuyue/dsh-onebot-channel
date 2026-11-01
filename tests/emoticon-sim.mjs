/**
 * 表情包渲染测试：node tests/emoticon-sim.mjs，退出码 0 = 全过，1 = 有失败。
 *
 * 覆盖：
 *   1. face（经典表情）—— cid 查中文名，查不到就报编号
 *   2. mface（商城大表情）—— summary / key / emoji_id 三级回退
 *   3. textOf() 整条消息渲染 —— 表情不再落进 default 变成 [mface]
 *
 * 纯函数，不碰真 QQ、不碰真会话。
 */
import { faceTextOf, mfaceTextOf, emojiTextOf, faceIdOf, faceSegmentOf, faceNameList } from '../lib/emoticons.js'
import { textOf } from '../lib/onebot.js'
import { splitEmojiMarks, attachFacesToParts } from '../lib/emoji-mark.js'

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

// ---- face：经典表情 ----

console.log('emoticons.js · face：')
{
  eq(faceTextOf({ cid: 13 }), '[表情:呲牙]', 'cid 13 查得到中文名')
  eq(faceTextOf({ cid: 0 }), '[表情:惊讶]', 'cid 0 查得到中文名')
  eq(faceTextOf({ cid: 999 }), '[表情:999]', '查不到的名字就原样报编号')
  eq(faceTextOf({}), '[表情]', '没有 cid 就退化成 [表情]')
  eq(faceTextOf({ id: 14 }), '[表情:微笑]', '只有 id 也能查（cid 缺省时回退 id）')
}

// ---- mface：商城大表情 ----

console.log('emoticons.js · mface：')
{
  eq(mfaceTextOf({ summary: '滑稽', emoji_id: '76' }), '[表情:滑稽]', '优先用 summary')
  eq(mfaceTextOf({ key: 'jiong', emoji_id: '76' }), '[表情:jiong]', '没有 summary 就用 key')
  eq(mfaceTextOf({ emoji_id: '76' }), '[表情:76]', '只剩 emoji_id 也认')
  eq(mfaceTextOf({}), '[表情]', '字段全缺就退化成 [表情]')
  eq(mfaceTextOf({ summary: '一'.repeat(50) }), `[表情:${'一'.repeat(20)}…]`, 'summary 过长会被掐短')
  eq(mfaceTextOf({ summary: '  滑稽  ' }), '[表情:滑稽]', 'summary 两边空白会去掉')
}

// ---- emojiTextOf：分发 ----

console.log('emoticons.js · 分发：')
{
  eq(emojiTextOf({ type: 'face', data: { cid: 13 } }), '[表情:呲牙]', 'face 段走 face 分支')
  eq(emojiTextOf({ type: 'mface', data: { summary: '滑稽' } }), '[表情:滑稽]', 'mface 段走 mface 分支')
  eq(emojiTextOf({ type: 'text', data: { text: '你好' } }), '', '非表情段返回空串')
  eq(emojiTextOf({ type: 'image', data: {} }), '', '图片段不是表情段')
}

// ---- textOf：整条消息 ----

console.log('onebot.js · textOf 整条消息：')
{
  const msg = [
    { type: 'text', data: { text: '看这个 ' } },
    { type: 'face', data: { cid: 13 } },
    { type: 'mface', data: { summary: '滑稽', emoji_id: '76' } }
  ]
  eq(textOf(msg), '看这个 [表情:呲牙][表情:滑稽]', '一条消息里的表情都渲染成中文标签')

  const mfaceOnly = [{ type: 'mface', data: { summary: '滑稽' } }]
  eq(textOf(mfaceOnly), '[表情:滑稽]', 'mface 不再落进 default 变成 [mface]')

  eq(textOf([{ type: 'forward', data: { id: '1' } }]), '[转发消息]', '转发消息给中文标签而不是 [forward]')
  eq(textOf([{ type: 'record', data: { file: 'a.amr' } }]), '[语音]', '语音给中文标签而不是 [record]')
  eq(textOf([{ type: 'json', data: { data: '{}' } }]), '[卡片消息]', '卡片消息给中文标签')
  eq(textOf([{ type: 'markdown', data: { markdown: 'x' } }]), '', 'markdown 段不产生噪声')
  eq(textOf([{ type: 'wxamp', data: {} }]), '[wxamp]', '完全没见过的段类型仍然原样报类型名')
}

// ---- 出站：中文名/编号 → face 段 ----

console.log('emoticons.js · 出站解析：')
{
  eq(faceIdOf('呲牙'), 13, '中文名反查出编号')
  eq(faceIdOf('13'), 13, '纯数字直接当编号')
  eq(faceIdOf('OK'), 124, '英文名（OK）也能反查')
  eq(faceIdOf('  呲牙  '), 13, '两边空白会去掉')
  eq(faceIdOf('可爱的小呲牙'), 13, '包含关系也能匹配上')
  eq(faceIdOf('不存在的表情'), null, '认不出来返回 null')
  eq(faceIdOf(''), null, '空串返回 null')
  eq(faceIdOf('-1'), null, '负数不是合法编号')
  eq(faceSegmentOf('呲牙'), { type: 'face', data: { id: '13' } }, '中文名造出 face 段')
  eq(faceSegmentOf('99'), { type: 'face', data: { id: '99' } }, '编号造出 face 段')
  ok(faceNameList().length > 200, `可选表情清单够长（${faceNameList().length} 条）`)
  ok(faceNameList().includes('呲牙(13)'), '清单里含「呲牙(13)」这种带编号的写法')
}

// ---- 表情标记解析 ----

console.log('emoji-mark.js · 标记解析：')
{
  const r1 = splitEmojiMarks('搞定了[表情:OK]')
  eq(r1.text, '搞定了', '标记从正文里摘掉了')
  eq(r1.faces.map((f) => f.id), [124], '解析出 OK 的编号')

  const r2 = splitEmojiMarks('你好[表情:呲牙]再见[表情:13]')
  eq(r2.text, '你好再见', '多个标记都摘掉了')
  eq(r2.faces.map((f) => f.id), [13, 13], '多个标记都解析出来了')

  const r3 = splitEmojiMarks('没有表情')
  eq(r3.faces, [], '没标记就没有表情')
  eq(r3.text, '没有表情', '没标记正文原样')

  const r4 = splitEmojiMarks('[表情:不存在的表情]文字')
  eq(r4.faces, [], '认不出来的标记不算表情')
  eq(r4.text, '文字', '认不出来的标记也不会留在正文里')

  const r5 = splitEmojiMarks('[表情:呲牙]喵')
  eq(r5.faces.map((f) => f.id), [13], '「表情包:」前缀也认（同一个标记语法）')
  eq(r5.text, '喵', '标记同样被摘掉')

  const r6 = splitEmojiMarks('[表情包:猫]喵')
  eq(r6.faces, [], '「猫」不是经典表情，不算表情标记（收藏表情走 custom_emoji 参数）')
}

// ---- 表情跟在哪条消息后面 ----

console.log('emoji-mark.js · 分配到各条：')
{
  // 「第一句。第二句[表情:OK]」→ 表情跟第二句（index=8，落在第二条末尾）
  const parts = ['第一句。', '第二句']
  const r = attachFacesToParts(parts, [{ id: 124, index: 8 }])
  eq(r[0].faces, [], '第一句没挂表情')
  eq(r[1].faces, [124], '表情跟在前一句后面')

  // 「第一句[表情:X]。第二句」→ 表情跟第一句（index=3，落在第一条范围内）
  const r1b = attachFacesToParts(parts, [{ id: 13, index: 3 }])
  eq(r1b[0].faces, [13], '句中的表情跟它前面那句')
  eq(r1b[1].faces, [], '第二句没挂表情')

  // 开头的表情挂第一条
  const r2 = attachFacesToParts(['第一句。', '第二句'], [{ id: 13, index: 0 }])
  eq(r2[0].faces, [13], '开头的表情挂第一条')

  // 一条都没分（纯表情）时不能崩
  const r3 = attachFacesToParts([], [{ id: 13, index: 0 }])
  eq(r3, [], '没有消息时返回空数组')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed > 0 ? 1 : 0)