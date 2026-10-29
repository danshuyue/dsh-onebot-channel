/**
 * 模型自主分段测试：node tests/segments-sim.mjs，退出码 0 = 全过。
 *
 * 验证 sendToQQ 的分段取舍：
 *   1. 传 segments 就按模型给的分段发，**不再**按标点切
 *   2. 同时给 text 和 segments 时，text 被忽略（分段才是话）
 *   3. 空段丢掉
 *   4. 不传 segments 时按换行分条（0.10.0 起；句号不再拆）
 *
 * 网络层用 globalThis.fetch 假协议端，不碰真 QQ。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG = join(homedir(), '.dsh', 'qq-bridge.config.json')
const backup = readFileSync(CONFIG, 'utf8')
// 崩了也要还原，别把真实配置改坏
process.on('exit', () => {
  writeFileSync(CONFIG, backup, 'utf8')
})

const cfg = JSON.parse(backup)
cfg.splitReply = true
cfg.splitMaxChars = 120
cfg.splitMaxParts = 8
cfg.splitDelayMinMs = 10
cfg.splitDelayMaxMs = 20
// 测试用一个虚构的号，得放开白名单（生产默认是拦着的）
cfg.allowSendToAny = true
writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), 'utf8')

const sent = []
globalThis.fetch = async (_url, options) => {
  const payload = JSON.parse(options?.body ?? '{}')
  if (payload.action === 'send_private_msg' || payload.action === 'send_group_msg') sent.push(payload)
  return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) }
}

const { loadConfig } = await import('../lib/config.js')
loadConfig()
const { sendToQQ } = await import('../lib/outbound.js')

const target = { kind: 'private', id: '100001' }
const textsOf = (payload) => (payload.params?.message ?? [])
  .filter((segment) => segment.type === 'text')
  .map((segment) => segment.data.text)

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

console.log('自主分段')

// 1. 显式三段：标点不该把它们再切开
sent.length = 0
await sendToQQ(target, '', { segments: ['第一句。', '第二句。', '第三句。'] })
eq(sent.length, 3, '显式分段发 3 条')
eq(sent.flatMap(textsOf), ['第一句。', '第二句。', '第三句。'], '分段内容与顺序不变')

// 2. text 被忽略
sent.length = 0
await sendToQQ(target, '这段不该发出去', { segments: ['只发这个'] })
eq(sent.length, 1, '同时给 text 和 segments 时按分段走')
ok(!JSON.stringify(sent).includes('这段不该发出去'), 'text 被忽略')

// 3. 空段丢掉
sent.length = 0
await sendToQQ(target, '', { segments: ['甲', '   ', '', '乙'] })
eq(sent.length, 2, '空段被丢掉')
eq(sent.flatMap(textsOf), ['甲', '乙'], '只发有内容的段')

// 4. 不传 segments：0.10.0 起按**换行**分条，句号不再拆
sent.length = 0
await sendToQQ(target, '第一句话在这里。第二句话也在这里。', {})
ok(sent.length === 1, `不传 segments 且没换行 → 一整条（实际 ${sent.length} 条）`)

sent.length = 0
await sendToQQ(target, '第一句。\n第二句也在这一行里。', {})
ok(sent.length === 2, `不传 segments 时按换行分条（实际 ${sent.length} 条）`)

// 5. 只给一段就发一条
sent.length = 0
await sendToQQ(target, '', { segments: ['一句话说完'] })
eq(sent.length, 1, '只给一段就发一条')

console.log(`\n${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
