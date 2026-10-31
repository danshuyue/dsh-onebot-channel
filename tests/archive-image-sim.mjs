/**
 * 图片三路 + 归档会话（0.12.0）。
 *
 * 覆盖：
 *   A. qq_msg_history 返回的图片（tool.js 的 images 字段 + render 贴回）
 *   B. 群 @ 上下文里的图片（poll.js 的 contextImages）
 *   C. 已归档会话：设置页下拉过滤 / 投递拦截 / 兜底候选过滤
 *
 * 隔离：整个测试跑在临时 HOME 里（DATA_DIR = <tmp>/.dsh），
 * 不碰真实 ~/.dsh —— 跟 pass-forward-sim.mjs 一个套路。
 *
 * 跑法：node tests/archive-image-sim.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX_HOME = join(tmpdir(), `qq-bridge-archive-${process.pid}`)
const SANDBOX_DATA = join(SANDBOX_HOME, '.dsh')
mkdirSync(join(SANDBOX_DATA, 'storages'), { recursive: true })
// env.js 在 import 时就算 DATA_DIR，所以必须先设 HOME 再动态 import
process.env.USERPROFILE = SANDBOX_HOME
process.env.HOME = SANDBOX_HOME

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

const WORKSPACE_FILE = join(SANDBOX_DATA, 'storages', 'workspace.json')

try {
  // ---- C1. archive.js：读归档集合 ----
  console.log('archive.js：')
  writeFileSync(WORKSPACE_FILE, JSON.stringify({
    global: { archivedSessionIds: ['session-old-1', 'session-old-2', ''] }
  }), 'utf8')

  const { archivedSessionIds, isArchived, invalidateArchiveCache } = await import('../lib/archive.js')
  invalidateArchiveCache()
  eq(archivedSessionIds().size, 2, '读到 2 个归档会话（空串被滤掉）')
  ok(isArchived('session-old-1'), 'isArchived 认得出归档会话')
  ok(!isArchived('session-live-1'), 'isArchived 不误伤正常会话')
  ok(!isArchived(''), 'isArchived("") 是 false（没有 id ≠ 已归档）')
  ok(!isArchived(null), 'isArchived(null) 是 false')

  // ---- C2. 坏 JSON 不抛、退化成「无归档」 ----
  writeFileSync(WORKSPACE_FILE, '{ 这不是 JSON', 'utf8')
  invalidateArchiveCache()
  eq(archivedSessionIds().size, 0, 'workspace.json 坏掉 → 归档数 0（不抛异常）')
  ok(!isArchived('session-old-1'), '坏文件时 isArchived 一律 false')

  // ---- C3. 文件不存在也不抛 ----
  rmSync(WORKSPACE_FILE, { force: true })
  invalidateArchiveCache()
  eq(archivedSessionIds().size, 0, 'workspace.json 不存在 → 归档数 0（不抛异常）')

  // ---- C4. 缓存 5 秒内不重复读盘 ----
  writeFileSync(WORKSPACE_FILE, JSON.stringify({ global: { archivedSessionIds: ['session-x'] } }), 'utf8')
  invalidateArchiveCache()
  ok(isArchived('session-x'), '缓存建立前读到 session-x')
  // 改成空集合，但缓存还在 → 仍然认为 x 归档
  writeFileSync(WORKSPACE_FILE, JSON.stringify({ global: { archivedSessionIds: [] } }), 'utf8')
  ok(isArchived('session-x'), '5 秒缓存内不重读盘（改文件不影响已缓存的判定）')
  invalidateArchiveCache()
  ok(!isArchived('session-x'), '手动失效缓存后立刻读到新值')

  // ---- C5. deliver() 拒绝投递到归档会话 ----
  console.log('\ndeliver.js 的归档拦截：')
  writeFileSync(WORKSPACE_FILE, JSON.stringify({ global: { archivedSessionIds: ['session-archived'] } }), 'utf8')
  invalidateArchiveCache()

  const { deliver } = await import('../lib/deliver.js')
  const { loadConfig } = await import('../lib/config.js')
  loadConfig()

  let followupCalls = 0
  const fakeAgent = {
    session: { seq: 10 },
    followup() { followupCalls += 1 },
  }
  const fakeCtx = {
    get(name) {
      if (name === 'agents') {
        return { get: () => fakeAgent, resume: async () => fakeAgent }
      }
      return undefined
    },
    agents: { get: () => fakeAgent, resume: async () => fakeAgent },
    llm: undefined,
    attachments: undefined,
  }
  const usedArchived = await deliver(fakeCtx, 'session-archived', '你好', { kind: 'private', id: '10001' })
  eq(usedArchived, '', '投递到归档会话 → 返回空串（被拒绝）')
  eq(followupCalls, 0, '投递到归档会话 → followup 一次都没调（没白拉起 agent）')

  const usedLive = await deliver(fakeCtx, 'session-live', '你好', { kind: 'private', id: '10001' })
  eq(usedLive, 'session-live', '投递到正常会话 → 照常放行')
  eq(followupCalls, 1, '投递到正常会话 → followup 调了 1 次')

  // ---- C6. sessionCandidates 过滤归档 ----
  console.log('\nsessions.js 的候选过滤：')
  const { sessionCandidates } = await import('../lib/sessions.js')
  const candCtx = {
    get(name) {
      if (name === 'sessions') {
        return {
          list: () => [
            { header: { id: 'session-archived', updatedAt: '2026-10-31' } },
            { header: { id: 'session-live', updatedAt: '2026-10-30' } },
          ],
        }
      }
      return undefined
    },
  }
  const cands = sessionCandidates(candCtx, '')
  ok(!cands.includes('session-archived'), '兜底候选里没有归档会话')
  ok(cands.includes('session-live'), '兜底候选里有正常会话')

  // ---- A. tool.js 的 images schema 声明 ----
  console.log('\nqq_msg_history 的图片（主题 A）：')
  const { registerHistoryTool } = await import('../lib/tool.js')
  let captured = null
  const toolCtx = {
    get(name) {
      if (name === 'tools') return { register: (def) => { captured = def; return () => {} } }
      return undefined
    },
    effect() {},
  }
  await registerHistoryTool(toolCtx)
  ok(captured !== null, 'qq_msg_history 注册成功')
  const schemaProps = captured?.output?.schema?.properties ?? {}
  // ⚠️ schema 是 additionalProperties:false，没声明的字段会被宿主直接丢弃
  ok(Object.prototype.hasOwnProperty.call(schemaProps, 'images'), 'output.schema 显式声明了 images（否则会被丢弃）')
  eq(schemaProps.images?.type, 'array', 'images 是数组')
  const itemProps = schemaProps.images?.items?.properties ?? {}
  ok(Object.prototype.hasOwnProperty.call(itemProps, 'order'), 'images[].order 有声明')
  ok(Object.prototype.hasOwnProperty.call(itemProps, 'ref'), 'images[].ref 有声明')
  eq(schemaProps.images?.items?.additionalProperties, false, 'images[] 也是 additionalProperties:false')
  eq(itemProps.ref?.additionalProperties, true, 'ref 放开 additionalProperties（附件字段随宿主版本变）')

  // render 把图贴回所属消息
  const blocks = captured.output.render({}, {
    messages: [
      { time: 1, nickname: '甲', text: '看这个 [图片]' },
      { time: 2, nickname: '乙', text: '文字' },
    ],
    images: [{ order: 0, ref: { id: 'att-1' } }],
  })
  ok(Array.isArray(blocks) && blocks.length >= 2, 'render 返回文本块 + 图片块')
  ok(blocks[0]?.type === 'text', '第一块是文本（消息列表）')
  const imageBlocks = blocks.filter((b) => b.type === 'image')
  eq(imageBlocks.length, 1, 'render 产出 1 个 image 块')
  eq(imageBlocks[0]?.attachment?.id, 'att-1', 'image 块的 attachment 就是那个 ref')
  const label = blocks.find((b) => b.type === 'text' && b.text.includes('第 1 条'))
  ok(label !== undefined, 'render 标了图属于第几条（模型不会把图对错话）')

  // 空结果
  const emptyBlocks = captured.output.render({}, { count: 0, messages: [], images: [] })
  eq(emptyBlocks, [{ type: 'text', text: '没查到历史消息。' }], '空结果时 render 给「没查到历史消息。」')

  // ---- B. poll.js 的上下文图片接线 ----
  console.log('\n群上下文图片（主题 B）：')
  const { readFileSync } = await import('node:fs')
  const pollSrc = readFileSync(new URL('../lib/poll.js', import.meta.url), 'utf8')
  ok(pollSrc.includes('imageSegmentsOf'), 'poll.js 导入了 imageSegmentsOf（先判有没有图再下载）')
  ok(pollSrc.includes('contextImages'), 'poll.js 收集了 contextImages')
  ok(/\[\.\.\.mainImages,\s*\.\.\.contextImages\]/.test(pollSrc), '投递时把主消息图和上下文图合并（主图在前）')
  // 「只对确实带图的消息下载」这条要成立：必须有 imageSegmentsOf 的前置判断
  // 注意参数里本身含括号（Array.isArray(...)），所以不能用 [^)]* 去匹配
  ok(
    /if \(imageSegmentsOf\([\s\S]{0,120}?\)\.length === 0\) continue/.test(pollSrc),
    '无图的消息直接跳过，不产生网络请求'
  )

  console.log(`\n结果：${passed} 过 / ${failed} 败`)
  process.exitCode = failed === 0 ? 0 : 1
} finally {
  try { rmSync(SANDBOX_HOME, { recursive: true, force: true }) } catch {}
}
