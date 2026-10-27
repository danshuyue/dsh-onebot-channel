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
import { faceTextOf, mfaceTextOf, emojiTextOf } from '../lib/emoticons.js'
import { textOf } from '../lib/onebot.js'

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

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed > 0 ? 1 : 0)
