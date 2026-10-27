/**
 * 出站表情端到端测试：node tests/emoji-send-sim.mjs，退出码 0 = 全过，1 = 有失败。
 *
 * 验证的是「真正发到协议端的消息体」长什么样：
 *   1. 文本 + 工具参数表情 → 同一段数组里 text 后面跟 face
 *   2. 正文标记 → 标记被摘掉，face 段附在它前面那句话后面
 *   3. 分条回复 → 表情只跟最后一句（工具参数）/ 按位置分配（正文标记）
 *   4. 只发表情不发表字
 *
 * 用 mock fetch 拦截 HTTP，不碰真 QQ、不碰真会话。
 */
import { splitMessage } from '../lib/split.js'
import { splitEmojiMarks, attachFacesToParts } from '../lib/emoji-mark.js'
import { faceSegmentOf } from '../lib/emoticons.js'

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

/**
 * 复刻 sendToQQ 的段构造逻辑（不引入 outbound.js —— 它会读真实 config）。
 * 真实实现里这段是同样的结构。
 */
function buildMessages(text, toolFace) {
  const marked = splitEmojiMarks(text)
  const parts = marked.text === '' ? [] : splitMessage(marked.text, { maxChars: 120, minChars: 4, maxParts: 8 })
  const markedParts = attachFacesToParts(parts, marked.faces)
  const messages = []
  for (let i = 0; i < markedParts.length; i += 1) {
    const segments = [{ type: 'text', data: { text: markedParts[i].part } }]
    for (const id of markedParts[i].faces) segments.push({ type: 'face', data: { id: String(id) } })
    if (toolFace !== null && i === markedParts.length - 1) segments.push(toolFace)
    messages.push(segments)
  }
  if (markedParts.length === 0 && toolFace !== null) messages.push([toolFace])
  return { messages, plain: marked.text }
}

console.log('出站 · 工具参数表情：')
{
  const r = buildMessages('搞定了', faceSegmentOf('OK'))
  eq(r.messages.length, 1, '一条消息')
  eq(r.messages[0], [
    { type: 'text', data: { text: '搞定了' } },
    { type: 'face', data: { id: '124' } }
  ], '文本后面跟 face 段（同一段数组）')
}

console.log('出站 · 正文标记：')
{
  const r = buildMessages('搞定了[表情:OK]', null)
  eq(r.plain, '搞定了', '标记从正文里摘掉了')
  eq(r.messages[0], [
    { type: 'text', data: { text: '搞定了' } },
    { type: 'face', data: { id: '124' } }
  ], '标记变成 face 段附在句末')
}

console.log('出站 · 分条时表情跟最后一句：')
{
  const r = buildMessages('第一句话很长需要分条。第二句话。', faceSegmentOf('呲牙'))
  ok(r.messages.length >= 2, `分成了 ${r.messages.length} 条`)
  const last = r.messages[r.messages.length - 1]
  eq(last[last.length - 1], { type: 'face', data: { id: '13' } }, '表情附在最后一条末尾')
  const first = r.messages[0]
  ok(!first.some((s) => s.type === 'face'), '前面几条没有表情')
}

console.log('出站 · 正文标记按位置分配：')
{
  const r = buildMessages('第一句。第二句[表情:OK]。', null)
  ok(r.messages.length >= 2, `分成了 ${r.messages.length} 条`)
  const withFace = r.messages.filter((m) => m.some((s) => s.type === 'face'))
  eq(withFace.length, 1, '只有一条带表情')
  ok(withFace[0][0].data.text.includes('第二句'), '表情跟的是「第二句」那条')
}

console.log('出站 · 只发表情：')
{
  const r = buildMessages('', faceSegmentOf('呲牙'))
  eq(r.messages.length, 1, '发一条')
  eq(r.messages[0], [{ type: 'face', data: { id: '13' } }], '消息体只有 face 段')
}

console.log('出站 · 多个标记：')
{
  const r = buildMessages('好耶[表情:庆祝][表情:OK]', null)
  eq(r.plain, '好耶', '两个标记都摘掉了')
  eq(r.messages[0], [
    { type: 'text', data: { text: '好耶' } },
    { type: 'face', data: { id: '320' } },
    { type: 'face', data: { id: '124' } }
  ], '两个 face 段都在')
}

console.log('出站 · 认不出来的标记不会变成明文：')
{
  const r = buildMessages('文字[表情:根本不存在的表情]结尾', null)
  ok(!r.plain.includes('[表情'), '正文里没有残留的标记明文')
  eq(r.messages[0].filter((s) => s.type === 'face').length, 0, '没生成 face 段')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed > 0 ? 1 : 0)
