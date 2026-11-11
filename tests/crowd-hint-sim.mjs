/**
 * 群聊「消息过多 → 请用引用或 @」提示的验证（0.21.4，用户 2026-11-09 提出）。
 *
 * ## 需求（用户原话）
 *
 *   「针对一轮消息超过 5（默认）条的情况下加入一句
 *     『当前消息过多，请使用引用或者 @ 来明确你要回复的对象』」
 *
 * ## 这个测试为什么分两半
 *
 *   ① **纯函数**（prompt.js 的 `crowdHintText`）：判据、0=关、`>=` 而不是 `>`
 *      —— 这几条都能直接调，不必起插件。
 *   ② **接线**（poll.js 的两条投递路）：断言正文里真的拼进了那句提示。
 *      用源码切片，理由同 `window-batch-render-sim.mjs`：
 *      `deliverWindowBatch` 要端到端跑起来得让 routes.group 落盘生效，
 *      手写 cfg 会被 loadConfig 合并吞掉。源码断言不如集成测试，
 *      但比一个跑不起来的测试有价值，而且能被变异抓住。
 *
 * ## ⚠️ 两条路必须都有（这是本文件存在的第二个理由）
 *
 *   一次性 @（`deliverGroupMessage`）和窗口批次（`deliverWindowBatch`）是**两条路**，
 *   而窗口批次承担了绝大多数续聊。0.21.1 就是只改了一条路，
 *   结果核心信息在 95% 的正文里都没生效，而测试全绿。
 *   所以这里对两条路分别断言 —— 只写一条的话，同一个错误会再犯一次。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')

let pass = 0
const failures = []
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log('  ✓ ' + label) } else { failures.push(label); console.error('  ✗ ' + label) }
}

// ===========================================================================
// 1. 纯函数：判据本身
// ===========================================================================
console.log('crowdHintText 的判据：')
const { crowdHintText } = await import('../lib/prompt.js')

const at = (count, limit) => crowdHintText(count, limit === undefined ? {} : { groupCrowdHintCount: limit })

// --- 默认阈值 5 ---
ok(at(0) === '', '0 条上下文 → 不提示')
ok(at(4) === '', '4 条（未达阈值）→ 不提示')
// ⚠️ 这一条是本文件的**核心断言**：默认 5 时必须提示。
//    写成 `>` 而不是 `>=` 的话，这里会变红 ——
//    而一次性 @ 那条路的上下文软上限恰好就是 5，所以 5 条是最常见的情况。
ok(at(5) !== '', '5 条（正好达到默认阈值 5）→ **要**提示（判据是 >=，不是 >）')
ok(at(6) !== '', '6 条 → 提示')
ok(at(20) !== '', '20 条（窗口批次上限）→ 提示')

// --- 提示语要包含用户要的那两个办法 ---
const text5 = at(5)
ok(text5.includes('消息过多'), '提示语里有「消息过多」')
ok(text5.includes('引用'), '提示语里提到「引用」')
ok(text5.includes('@'), '提示语里提到「@」')
ok(text5.includes('5'), '提示语里报出了实际条数（方便她判断场面）')

// --- 0 = 关（设置页原话）。⚠️ 不能用 || 取默认值，否则 0 被吞成 5 ---
ok(at(20, 0) === '', '阈值设 0 → 彻底关闭（不能把 0 吞成默认 5）')
ok(at(20, 3) !== '', '阈值设 3、20 条 → 提示（自定义阈值生效）')
ok(at(2, 3) === '', '阈值设 3、2 条 → 不提示')
ok(at(5, 10) === '', '阈值设 10、5 条 → 不提示（阈值真的被用上了）')
ok(at(10, 10) !== '', '阈值设 10、正好 10 条 → 提示（边界同样是 >=）')

// --- 脏值 / 缺值必须回默认，不能变成「永不提示」或「总是提示」 ---
ok(at(5, undefined) !== '', '配置里没有这个键 → 按默认 5 走')
ok(at(5, null) !== '', '配置是 null → 按默认 5 走')
ok(at(5, 'abc') !== '', '配置是脏字符串 → 回默认 5（不能变成 NaN 判定）')

// ===========================================================================
// 2. 接线：两条投递路都要拼进正文
// ===========================================================================
console.log('')
console.log('接线（poll.js 的两条路）：')
const pollSrc = readFileSync(join(PLUGIN, 'lib', 'poll.js'), 'utf8')

// ⚠️ 切片再断言，不全文搜 —— 全文搜必然命中两处，等于没验证任何一处
//    （本项目踩坑记录 §4 坑 29：文本断言匹配到别处的同名词 = 假绿）。
function sliceFn(src, name) {
  const start = src.indexOf(`export async function ${name}`)
  if (start < 0) return ''
  const rest = src.slice(start)
  const nextExport = rest.indexOf('\nexport ', 10)
  return nextExport < 0 ? rest : rest.slice(0, nextExport)
}

// `deliverGroupMessage` 是 module-private（没 export），按名字找函数声明
function slicePrivateFn(src, name) {
  const start = src.indexOf(`async function ${name}(`)
  if (start < 0) return ''
  const rest = src.slice(start)
  const next = rest.indexOf('\nasync function ', 10)
  const nextExport = rest.indexOf('\nexport ', 10)
  const ends = [next, nextExport].filter((n) => n > 0)
  return ends.length === 0 ? rest : rest.slice(0, Math.min(...ends))
}

const onceBody = slicePrivateFn(pollSrc, 'deliverGroupMessage')
const batchBody = sliceFn(pollSrc, 'deliverWindowBatch')

ok(onceBody.length > 500, `切到了一次性 @ 的函数体（${onceBody.length} 字符）`)
ok(batchBody.length > 500, `切到了窗口批次的函数体（${batchBody.length} 字符）`)
ok(!onceBody.includes('对话窗口批次'), '两个切片没串味（一次性 @ 里没有批次标记）')
ok(batchBody.includes('对话窗口批次'), '窗口批次切片正确（有批次标记）')

// --- 路 1：一次性 @ ---
ok(onceBody.includes('crowdHintText('), '【一次性 @】调用了 crowdHintText')
ok(/crowdHintText\(\s*context\.length/.test(onceBody),
  '【一次性 @】判据用的是 context.length（**实际列出来的行数**，不是 unread 总量）')
ok(onceBody.includes('${crowdLine}'),
  '【一次性 @】把提示拼进了正文 body（算了不用等于没做）')

// --- 路 2：窗口批次 ---
ok(batchBody.includes('crowdHintText('), '【窗口批次】调用了 crowdHintText（绝大多数续聊走这条路）')
ok(/crowdHintText\(\s*lines\.length/.test(batchBody),
  '【窗口批次】判据用的是 lines.length（渲染后的行数）')
ok(batchBody.includes('${crowdLine}'),
  '【窗口批次】把提示拼进了正文 body')

// --- 提示必须落在「这段时间的群聊」块**之内**，不是块外面 ---
// 放在块外的话，模型会把这句话当成一段独立的历史消息，而不是对这段上下文的提示。
ok(onceBody.indexOf('${crowdLine}') > onceBody.indexOf('[这段时间的群聊]'),
  '【一次性 @】提示排在〔这段时间的群聊〕标题之后（在她正看的那块里）')
ok(batchBody.indexOf('${crowdLine}') > batchBody.indexOf('[这段时间的群聊]'),
  '【窗口批次】提示排在〔这段时间的群聊〕标题之后')

console.log('')
if (failures.length > 0) {
  for (const item of failures) console.error('✗ ' + item)
  process.exit(1)
}
console.log(`✓ 全部通过（${pass} 条）：判据 >= 阈值且 0=关，两条投递路都接上了`)
process.exit(0)
