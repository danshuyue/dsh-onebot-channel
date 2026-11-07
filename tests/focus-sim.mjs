/**
 * focus-sim.mjs —— 跨会话路由（focus.js）的单元测试。
 *
 * 这个文件测的是**「怎么拒绝猜」**，不是「怎么找会话」。
 * 每一条 ★ 断言都对应一个真实事故路径：
 *   · 兜底到最近会话 → 消息凭空进别人的对话
 *   · 编号过期还按旧表解释 → 静默投给错误的会话
 *   · 焦点没有寿命 → 跨天串台
 *   · 引用跨 target 搬运 → 在 A 处引用 B 的消息，把 A 的话搬到 B
 *
 * ⚠️ 必须在隔离 HOME 下跑（会写 qq-bridge-state.json）：
 *   node tests/run-isolated.mjs tests/focus-sim.mjs
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const HOME = homedir()
const DATA = join(HOME, '.dsh')

let pass = 0
let fail = 0
const failures = []
function ok(cond, label) {
  if (cond) {
    pass += 1
    return
  }
  fail += 1
  failures.push(label)
  console.log(`  ✗ ${label}`)
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  ok(a === e, `${label}（期望 ${e}，实际 ${a}）`)
}

/** 造配置文件（focus.js 会通过 config.js 读它）。 */
function writeConfig(overrides = {}) {
  const base = {
    enabled: true,
    onebotHttp: 'http://127.0.0.1:3000/',
    token: 'test-token',
    selfUin: 3566906627,
    peerUin: 1321833118,
    ownerUin: 1321833118,
    groupUins: ['975663147'],
    routes: {
      private: { 1321833118: { sessionId: 'session-default-peer' } },
      group: { 975663147: { sessionId: 'session-default-group' } }
    },
    focusTagEnabled: true,
    focusIdleResetMs: 3600000
  }
  mkdirSync(DATA, { recursive: true })
  writeFileSync(join(DATA, 'qq-bridge.config.json'), JSON.stringify({ ...base, ...overrides }, null, 2), 'utf8')
}

/** 造归档集合。 */
function writeArchived(ids = []) {
  // archive.js 读 ~/.dsh/storages/workspace.json，读不到就当作「没有归档」——
  // 但**目录必须先存在**，否则 writeFileSync 自己会 ENOENT。
  mkdirSync(join(DATA, 'storages'), { recursive: true })
  writeFileSync(
    join(DATA, 'storages', 'workspace.json'),
    JSON.stringify({ global: { archivedSessionIds: ids }, tables: { workspaces: {} } }),
    'utf8'
  )
}

async function main() {
  rmSync(join(DATA, 'qq-bridge-state.json'), { force: true })
  writeConfig()
  writeArchived([])

  // config.js 是模块单例：必须在写完文件之后才 import
  const config = await import('../lib/config.js')
  config.loadConfig()
  const state = await import('../lib/state.js')
  state.loadState()
  const archive = await import('../lib/archive.js')
  const focus = await import('../lib/focus.js')
  const { getConfig } = config

  const PEER = '1321833118'
  const GROUP = '975663147'

  // ---- 1. 三个信号都没设 → 走默认绑定 ----
  focus.clearAll()
  let r = focus.resolveSession({ cfg: getConfig(), kind: 'private', id: PEER })
  eq(r.sessionId, 'session-default-peer', '★ 没有任何信号时走默认绑定')
  eq(r.via, 'default', 'via=default')

  // ---- 2. 没配默认绑定 → 绝不兜底 ----
  writeConfig({ routes: { private: {}, group: {} } })
  config.loadConfig()
  archive.invalidateArchiveCache()
  r = focus.resolveSession({ cfg: getConfig(), kind: 'private', id: PEER })
  eq(r.sessionId, '', '★★ 没有默认绑定时返回空（绝不兜底到最近会话）')
  eq(r.via, 'none', 'via=none')

  // ---- 3. 焦点优先于默认绑定 ----
  writeConfig()
  config.loadConfig()
  archive.invalidateArchiveCache()
  focus.setFocus(`private:${PEER}`, 'session-focus-a', 'CMPOR·主分支')
  r = focus.resolveSession({ cfg: getConfig(), kind: 'private', id: PEER })
  eq(r.sessionId, 'session-focus-a', '焦点优先于默认绑定')
  eq(r.via, 'focus', 'via=focus')
  eq(r.label, 'CMPOR·主分支', '焦点带 label')

  // ---- 4. 引用优先于焦点 ----
  focus.noteSent('session-reply-b', `private:${PEER}`, ['-12345'])
  r = focus.resolveSession({ cfg: getConfig(), kind: 'private', id: PEER, replyToId: '-12345' })
  eq(r.sessionId, 'session-reply-b', '★ 引用优先于焦点（用户亲手点的最明确）')
  eq(r.via, 'reply', 'via=reply')

  // ---- 5. 引用别人的消息时**不横跨** target ----
  focus.noteSent('session-other-target', `private:999999`, ['-77777'])
  r = focus.resolveSession({ cfg: getConfig(), kind: 'private', id: PEER, replyToId: '-77777' })
  eq(r.sessionId, 'session-focus-a', '★★ 引用别的 target 的消息时不跨 target 搬运（回落到焦点）')
  eq(r.via, 'focus', 'via=focus（没被跨 target 的引用劫持）')

  // ---- 6. 引用了不存在的 message_id → 忽略 ----
  r = focus.resolveSession({ cfg: getConfig(), kind: 'private', id: PEER, replyToId: '-99999' })
  eq(r.via, 'focus', '引用一个不认识的 id 时忽略引用，回落到焦点')

  // ---- 7. 引用索引 TTL ----
  const t0 = Date.now()
  focus.noteSent('session-ttl', `private:${PEER}`, ['-55555'], t0)
  ok(focus.sessionOfSent('-55555', t0 + 1000) !== null, '刚记下的引用能查到')
  ok(focus.sessionOfSent('-55555', t0 + 7 * 3600_000) === null, '★ 引用索引超过 6 小时就失效')

  // ---- 8. 引用索引容量上限 ----
  focus.clearSent()
  for (let i = 0; i < 700; i++) focus.noteSent(`s-${i}`, `private:${PEER}`, [String(-100000 - i)])
  const first = focus.sessionOfSent('-100000')
  ok(first === null, '★★ 引用索引超过 500 条时丢最早的（不会无限长）')

  // ---- 9. 焦点 TTL ----
  focus.clearAll()
  focus.setFocus(`private:${PEER}`, 'session-old-focus', '旧焦点', Date.now() - 2 * 3600_000)
  r = focus.resolveSession({ cfg: getConfig(), kind: 'private', id: PEER })
  eq(r.sessionId, 'session-default-peer', '★★ 焦点闲置超过 focusIdleResetMs 自动回默认（跨天不串台）')

  // ---- 10. focusIdleResetMs = 0 → 永不超时 ----
  writeConfig({ focusIdleResetMs: 0 })
  config.loadConfig()
  archive.invalidateArchiveCache()
  focus.clearAll()
  focus.setFocus(`private:${PEER}`, 'session-eternal', '永久焦点', Date.now() - 10 * 86_400_000)
  r = focus.resolveSession({ cfg: getConfig(), kind: 'private', id: PEER })
  eq(r.sessionId, 'session-eternal', 'focusIdleResetMs=0 时焦点永不超时')
  writeConfig()
  config.loadConfig()
  archive.invalidateArchiveCache()

  // ---- 11. 焦点指向已归档会话 → 清掉并回落 ----
  focus.clearAll()
  focus.setFocus(`private:${PEER}`, 'session-archived-x', '已归档的')
  writeArchived(['session-archived-x'])
  archive.invalidateArchiveCache()
  r = focus.resolveSession({ cfg: getConfig(), kind: 'private', id: PEER })
  eq(r.sessionId, 'session-default-peer', '★★ 焦点指向归档会话时回落到默认（不往收起来的会话里投）')
  eq(focus.focusOf(`private:${PEER}`), null, '失效的焦点已被清掉')

  // ---- 12. 默认绑定被归档 → 返回空而不是兜底 ----
  writeArchived(['session-default-peer'])
  archive.invalidateArchiveCache()
  focus.clearAll()
  r = focus.resolveSession({ cfg: getConfig(), kind: 'private', id: PEER })
  eq(r.sessionId, '', '★★ 默认绑定被归档时返回空，绝不兜底')
  writeArchived([])
  archive.invalidateArchiveCache()

  // ---- 13. targetKey 隔离：A 的焦点不影响 B ----
  focus.clearAll()
  focus.setFocus(`private:${PEER}`, 'session-for-peer', 'A 的')
  const rGroup = focus.resolveSession({ cfg: getConfig(), kind: 'group', id: GROUP })
  eq(rGroup.sessionId, 'session-default-group', '★ 私聊的焦点不影响群（targetKey 隔离）')
  const rOther = focus.resolveSession({ cfg: getConfig(), kind: 'private', id: '999' })
  eq(rOther.sessionId, '', '★ 另一个人的私聊不受影响（他那边没配绑定 → 空）')

  // ---- 13b. 同一个数字 id 跨 kind 也不能串（这才是隔离性的真正考验）----
  // ⚠️ 上一个用例用的是**不同的 id**（PEER vs GROUP），所以即使 key 里丢掉 kind
  //    也查不到对方 —— 它证明了「不同的号互不影响」，**没**证明「同一个号在私聊和群之间隔离」。
  //    变异验证抓到了这一点（去掉 kind 后那条断言照样绿）。
  //    现实里这种重叠很常见：一个人既是好友、又在群里，数字完全可能相同。
  const SHARED_ID = '123456789'
  focus.setFocus(`private:${SHARED_ID}`, 'session-private-only', '只在私聊设的')
  const rSameIdGroup = focus.resolveSession({ cfg: getConfig(), kind: 'group', id: SHARED_ID })
  ok(
    rSameIdGroup.sessionId !== 'session-private-only',
    '★★ 同一个数字 id 在私聊设的焦点，群那边查不到（kind 必须参与 key）'
  )
  const rSameIdPrivate = focus.resolveSession({ cfg: getConfig(), kind: 'private', id: SHARED_ID })
  eq(rSameIdPrivate.sessionId, 'session-private-only', '同一个 id 的私聊自己还能查到焦点')

  // ---- 14. /回 清焦点 ----
  // ⚠️ 这里必须**重新设一次** PEER 的焦点：上面 13b 的 clearAll 语义要求它自己干净，
  //    而这里要测的是「清掉之后回落」。两步之间不能靠残留状态。
  focus.setFocus(`private:${PEER}`, 'session-collect-node', '收藏节点', Date.now() - 10 * 60_000)
  const cleared = focus.clearFocus(`private:${PEER}`)
  eq(cleared, 'session-collect-node', '/回 返回被清掉的会话（实测值取被清掉的那个）')
  r = focus.resolveSession({ cfg: getConfig(), kind: 'private', id: PEER })
  eq(r.via, 'default', '/回 之后回到默认绑定')

  // ---- 15. 出站标签（2026-11-05 方向修正：标签加在**她发给用户的话**上）----
  // ⚠️ 初版这里测的是 tagFor(sessionId, kind, id, label)，调用点却挂在 poll.js 的
  //    **入站**路径上 —— 线上实测「发出去的消息一个标签都没有」，才发现方向反了。
  //    所以这个函数现在叫 tagForSession，签名是 (sessionId, target, label)。
  const PEER_T = { kind: 'private', id: PEER }
  eq(focus.tagForSession('session-default-peer', PEER_T, 'CMPOR·主分支'), '', '★ 默认会话不加标签（日常聊天不污染）')
  eq(
    focus.tagForSession('session-not-default', PEER_T, 'CMPOR·主分支'),
    '〔CMPOR·主分支〕',
    '★ 非默认会话加标签'
  )
  writeConfig({ focusTagEnabled: false })
  config.loadConfig()
  archive.invalidateArchiveCache()
  eq(focus.tagForSession('session-not-default', PEER_T, 'CMPOR'), '', 'focusTagEnabled=false 时完全不加标签')
  writeConfig()
  config.loadConfig()
  archive.invalidateArchiveCache()

  // 不给 label 时会去反查（查不到就空 —— 绝不编一个名字出来）
  eq(focus.tagForSession('session-not-default', PEER_T), '', '★ 反查不到标题时不加标签（不编名字）')

  // 标签长度上限
  const longTag = focus.tagForSession('session-x2', PEER_T, 'A'.repeat(100))
  ok(longTag.length <= 24 + 2 + 1, '★ 标签被截断（不会把 100 字的标题塞进每条消息）')

  // ---- 15b. 标签只在出站加：入站路径不该再调用它 ----
  // 这是那个方向错误的回归防线。定向 grep 源码比跑行为更直接：
  // 入站路径（poll.js）里不该再出现 tagForSession 的调用。
  const pollSrc = readFileSync(new URL('../lib/poll.js', import.meta.url), 'utf8')
  ok(!/tagForSession\s*\(/.test(pollSrc), '★★ poll.js（入站路径）里不再调用 tagForSession —— 标签只加在出站')
  const outSrc = readFileSync(new URL('../lib/outbound.js', import.meta.url), 'utf8')
  ok(/tagForSession\s*\(/.test(outSrc), '★ outbound.js（自动转发）确实加了出站标签')
  const toolSrc = readFileSync(new URL('../lib/tool.js', import.meta.url), 'utf8')
  ok(/tagForSession\s*\(/.test(toolSrc), '★ tool.js（qq_send）确实加了出站标签')

  // ---- 16. 持久化：焦点落盘后重新加载还在 ----
  focus.clearAll()
  focus.setFocus(`private:${PEER}`, 'session-persisted', '落盘的')
  state.loadState()
  eq(focus.focusOf(`private:${PEER}`)?.sessionId, 'session-persisted', '★ 焦点落盘后重载仍在')

  // ---- 17. 坏 state 不炸 ----
  writeFileSync(join(DATA, 'qq-bridge-state.json'), '{ broken json', 'utf8')
  let threw = false
  try {
    state.loadState()
    focus.focusOf(`private:${PEER}`)
    focus.resolveSession({ cfg: getConfig(), kind: 'private', id: PEER })
  } catch {
    threw = true
  }
  ok(threw === false, '★★ 坏掉的 state 文件不会让路由抛错')

  // ---- 汇总 ----
  console.log(`\nfocus-sim: ${pass} 过 / ${fail} 败`)
  if (fail > 0) {
    console.log('失败项：')
    for (const item of failures) console.log('  -', item)
    process.exit(1)
  }
}

await main()
