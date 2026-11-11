/**
 * 窗口批次正文的「节奏 + 自己」验证（2026-11-09 复查补上）。
 *
 * ## 为什么这个文件用的是**源码断言**而不是集成跑一遍
 *
 * 0.21.0 交付前，`group-self-context-sim` 只覆盖了**一次性 @** 那条路的正文渲染
 * （`deliverGroupMessage`）。而实测 2026-11-09 05:41~05:45 那一轮，
 * 群里主要对话走的是**窗口批次**（`deliverWindowBatch`）——
 * 那条路当时还是老样子：没有秒级间隔、没有「你自己」。
 *
 * 结果：本次修复最核心的两条信息（对方多快、我刚刚说过什么），
 * **在最常用的那条路上完全没生效**，而测试全绿。
 *
 * ## 为什么不做集成测试
 *
 * 试过。`deliverWindowBatch` 要真的投递出去，得先让 `getConfig().routes.group`
 * 落到那个群上 —— 而手写整份 cfg 会被 `loadConfig` 的默认值合并吞掉
 * （实测 `routes.group` 变成 `{}`，投递直接 `failed`，白折腾半小时）。
 * `group-context-sim` 之所以能跑，是因为它**从真实配置备份出发**再改，
 * 依赖真实机器上的配置文件存在。
 *
 * 所以这里照 `voice-fail-sim` / `autoforward-mutation` 的先例做源码断言：
 * 直接钉住「那段渲染代码里必须有 gapOf 和 你自己」。
 * 它不如集成测试端到端，但**比一个跑不起来的测试有价值**，
 * 而且能被变异抓住（见 window-batch-render-mutation.mjs）。
 *
 * ⚠️ 真实侧的佐证：2026-11-09 05:42 的插件日志里
 *    `[window] delivered batch 716197431 count=2` 反复出现，
 *    说明这条链路在真机上是通的，缺陷只在**渲染内容**。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')
const pollSrc = readFileSync(join(PLUGIN, 'lib', 'poll.js'), 'utf8')

/**
 * 切片：只取 `deliverWindowBatch` 的函数体。
 *
 * ⚠️ 必须切片再断言，不能全文搜 —— 全文里 `deliverGroupMessage` 也有 gapOf/你自己，
 *    那样断言会假绿（这正是本项目 §4 坑 29 的形态：匹配到别处的同名词）。
 */
function sliceWindowBatch(src) {
  const start = src.indexOf('export async function deliverWindowBatch')
  if (start < 0) return ''
  // 到下一个顶层 export 为止
  const rest = src.slice(start)
  const nextExport = rest.indexOf('\nexport ', 10)
  return nextExport < 0 ? rest : rest.slice(0, nextExport)
}

const batch = sliceWindowBatch(pollSrc)

let pass = 0
const failures = []
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log('  ✓ ' + label) } else { failures.push(label); console.error('  ✗ ' + label) }
}

console.log('切片正确性（防假绿的第一道）:')
// 改坏方式：sliceWindowBatch 改成返回全文 → 「切片里不含 deliverGroupMessage 的身份提示」这条变红
ok(batch.length > 500, `切到了 deliverWindowBatch 的函数体（${batch.length} 字符）`)
ok(batch.includes('对话窗口批次'), '切片里有窗口批次专属标记')
ok(batch.includes('deliverWindowBatch') === false || !batch.includes('async function deliverGroupMessage'),
  '切片里不含 deliverGroupMessage 的函数体（没切过头）')

console.log('')
console.log('秒级时间戳（stampOf 已全局加秒，这里确认它被调用）:')
// 改坏方式：把 stampOf 调用换成手拼分钟格式 → 变红
ok(batch.includes('stampOf(message)'), '批次每行调用 stampOf')

console.log('')
console.log('间隔标注 —— 本次复查补上的缺口:')
// 改坏方式：删掉 `const gap = prev === null ? '' : gapOf(...)` → 这条变红
ok(batch.includes('gapOf('), '批次调用了 gapOf')
ok(batch.includes("const prev = index > 0 ? list[index - 1] : null"), '按 index 找上一条（间隔的基准）')
// ⚠️ 必须精确到**两条 return**都带 gapPart。
//   只写 includes('gapPart') 太松：删掉一处的拼装、另一处还在，测试照样绿
//   （本轮变异验证实测踩到，M3 漏网），所以这里逐条钉。
//   判据用「按行切 + 逐行查」，避开模板字符串里的反引号/换行转义地狱。
const batchLines = batch.split('\n')
const returnLines = batchLines.filter((line) => line.includes('return `') && line.includes('stampOf(message)'))
ok(returnLines.length >= 2, `批次里有 2 条 return 拼正文（实际 ${returnLines.length}）`)
ok(returnLines.every((line) => line.includes('gapPart')), '每一条 return 都拼了间隔（删一处就会被抓住）')

console.log('')
console.log('「你自己」标注 —— 同上:')
// 改坏方式：删掉 `selfUin !== '' && senderUin === selfUin ? '你自己'` → 变红
ok(batch.includes("'你自己'"), '批次里有「你自己」分支')
ok(batch.includes('selfUin'), '读的是配置里的 selfUin')

console.log('')
console.log('别人的标注没被破坏:')
ok(batch.includes('群友'), '别人仍标「群友」')
ok(batch.includes('不是用户本人'), '带身份提示')

console.log('')
if (failures.length > 0) {
  for (const item of failures) console.error('✗ ' + item)
  console.error(`\n结果：${pass} 过 / ${failures.length} 败`)
  process.exit(1)
}
console.log(`结果：${pass} 过 / 0 败`)
process.exit(0)
