/**
 * 诊断包「对话流水」一节回归测试（2026-11-09，0.21.0）。
 *
 * ## 背景（用户原话）
 *
 * 「这个诊断不太清楚。我觉得应该带上具体的聊天记录和这段时间的会话的思考过程
 *   工具调用等详细信息。这个更方便你诊断。」
 *
 * 旧 `/diag-export` 有七节，但**没有一节能回答「她当时看到了什么」**。
 * 上次「群聊不连贯」的三条根因全在投递正文里，插件日志一条都看不出来。
 *
 * ## 要钉住的
 *
 * 1. `recordBody` 真的进得了 `exportDiagLog()`（不是写了个没人读的数组）
 * 2. 正文超长要截断（否则一个 20 条上下文的消息能到几十 KB，包发不出去）
 * 3. 环形容量有限（否则进程跑一天会长到几百 MB）
 * 4. `recordTool` 也进得去，且带参数/返回摘要
 * 5. 时间窗过滤生效（用户选的「最近 1~2 小时」）
 * 6. **记录失败绝不影响主链路** —— 这条最重要：诊断是辅助，投递是主业务
 *
 * ⚠️ 不引 env.js 的 note 断言日志，用返回值直接验。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')

const diag = await import(pathToFileURL(join(PLUGIN, 'lib', 'diaglog.js')).href)
const { recordBody, recordTool, exportDiagLog, resetDiagLog } = diag

let pass = 0
const failures = []
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log('  ✓ ' + label) } else { failures.push(label); console.error('  ✗ ' + label) }
}
const eq = (actual, expected, label) => ok(actual === expected, `${label}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`)

console.log('正文能进去、能读出来：')
resetDiagLog()
recordBody({ sessionId: 's1', kind: 'group', targetId: '716197431', body: '第一段正文', images: 2 })
let out = exportDiagLog()
eq(out.bodies.length, 1, '一条正文记录')
eq(out.bodies[0].body, '第一段正文', '正文原文没被改写')
eq(out.bodies[0].images, 2, '图片张数记下来了')
eq(out.bodies[0].kind, 'group', '渠道记下来了')

console.log('')
console.log('超长正文要截断：')
resetDiagLog()
const huge = 'X'.repeat(5000) + '尾巴这几个字'
recordBody({ sessionId: 's1', kind: 'group', targetId: 'g', body: huge })
out = exportDiagLog()
// 改坏方式：删掉 recordBody 里的 `clip(payload.body, MAX_BODY_CHARS)` 改成 `String(payload.body)` → 这条变红
ok(out.bodies[0].body.length <= 2000, `正文被截断（实际 ${out.bodies[0].body.length} ≤ 2000）`)
// 头尾都留：报错常在尾部，只留头会丢掉关键信息
ok(out.bodies[0].body.includes('尾巴这几个字'), '截断时保留了尾部（报错常常在末尾）')
// 原始长度要记下来，否则看的人以为她只收到 2000 字
eq(out.bodies[0].chars, huge.length, '原始长度另记（不因截断而失真）')

console.log('')
console.log('环形容量有限（不能无限涨）：')
resetDiagLog()
for (let i = 0; i < 260; i += 1) recordBody({ sessionId: 's1', kind: 'group', targetId: 'g', body: `第${i}条` })
out = exportDiagLog()
// 改坏方式：删掉 `while (bodies.length > MAX_BODIES) bodies.shift()` → 这条变红
ok(out.bodies.length <= 200, `最多留 200 条（实际 ${out.bodies.length}）`)
ok(out.bodies[out.bodies.length - 1].body === '第259条', '留的是最新的那批')

console.log('')
console.log('工具调用也记得住：')
resetDiagLog()
recordTool({ tool: 'qq_send', args: { target: 'group:716197431', text: '你好' }, result: { message_id: 123 }, durationMs: 42 })
recordTool({ tool: 'qq_msg_history', args: { group_id: '716197431' }, result: '拉群消息历史失败：timeout', isError: true, durationMs: 30000 })
out = exportDiagLog()
eq(out.tools.length, 2, '两条工具记录')
ok(out.tools[0].args.includes('qq_send') === false && out.tools[0].args.includes('716197431'), '参数摘要带上了关键信息')
eq(out.tools[1].isError, true, '失败标记正确')
ok(out.tools[1].result.includes('timeout'), '失败原因带上了')

console.log('')
console.log('时间窗过滤（用户选的「最近 1~2 小时」）：')
resetDiagLog()
const twoHoursAgo = Date.now() - 3 * 60 * 60 * 1000
recordBody({ sessionId: 's1', kind: 'group', targetId: 'g', body: '三小时前的老消息', at: twoHoursAgo })
recordBody({ sessionId: 's1', kind: 'group', targetId: 'g', body: '刚才的消息' })
out = exportDiagLog()
// 改坏方式：把 exportDiagLog 里的 `.filter(within)` 删掉 → 这条变红
eq(out.bodies.length, 1, '只保留窗口内的（三小时前那条被滤掉）')
eq(out.bodies[0].body, '刚才的消息', '留下的是新的那条')
// 默认窗口应该是 2 小时
eq(out.windowMs, 2 * 60 * 60 * 1000, '默认窗口 2 小时')

console.log('')
console.log('工具记录也有容量上限：')
resetDiagLog()
for (let i = 0; i < 460; i += 1) recordTool({ tool: 't' + i, args: { i }, result: 'ok' })
out = exportDiagLog()
// 改坏方式：删掉 recordTool 里的 `while (tools.length > MAX_TOOLS) tools.shift()` → 这条变红
ok(out.tools.length <= 400, `工具记录被裁到上限内（实际 ${out.tools.length} ≤ 400）`)
ok(out.tools[out.tools.length - 1].tool === 't459', '留的是最新的那批')

console.log('')
console.log('记录失败绝不影响主链路（最重要的一条）：')
resetDiagLog()
let threw = false
try {
  // 传一个循环引用 + 怪物对象，逼内部 JSON.stringify / 取值路径出错
  const evil = { get body() { throw new Error('boom') } }
  recordBody(evil)
  recordTool({ tool: 'x', args: (() => { const o = {}; o.self = o; return o })() })
} catch {
  threw = true
}
// 改坏方式：把 recordBody/recordTool 外层的 try/catch 删掉 → 这条变红
ok(threw === false, '畸形输入不会把异常抛给调用方（投递主链路）')
ok(Array.isArray(exportDiagLog().bodies), '出事后导出仍然可用')

console.log('')
if (failures.length > 0) {
  for (const item of failures) console.error('✗ ' + item)
  console.error(`\n结果：${pass} 过 / ${failures.length} 败`)
  process.exit(1)
}
console.log(`结果：${pass} 过 / 0 败`)
process.exit(0)
