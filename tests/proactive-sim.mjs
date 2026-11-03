/**
 * 主动搭话的判定测试：node tests/proactive-sim.mjs，退出码 0 = 全过。
 *
 * 这块的成败全在「不该说的时候真的不说」：
 *   静默时段、没聊过、刚聊完、今天说过了、上次说没人理（要退避）。
 * 只要有一条闸漏了，它就从「她想起你」变成「每天定时问候」。
 *
 * 状态文件走临时路径，不碰 ~/.dsh/qq-bridge-proactive.json。
 */
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  shouldNudge, minutesOf, inQuietHours, dayKey, formatGap,
  notePeerSpoke, noteNudge, useProactiveFile, clearProactiveState, PROACTIVE_FILE, flushPersist,
  targetAllowed, candidates, orderByStalest
} from '../lib/proactive.js'

const TMP = join(tmpdir(), `qq-proactive-test-${process.pid}.json`)
useProactiveFile(TMP)
rmSync(TMP, { force: true })
clearProactiveState()

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`) } else { failed += 1; console.error(`  ✗ ${name}`) }
}

const HOUR = 60 * 60 * 1000
/** 本地 14:00 —— 稳在默认静默时段（23:00–08:00）之外。 */
const NOW = new Date(2026, 9, 29, 14, 0, 0).getTime()

const base = {
  now: NOW,
  enabled: true,
  idleHours: 6,
  dailyMax: 1,
  quietFrom: '23:00',
  quietTo: '08:00',
  backoffMax: 4
}

// ---- 1. 时段解析 ------------------------------------------------------------
ok(minutesOf('23:00', 0) === 1380, "'23:00' 解析成 1380 分钟")
ok(minutesOf('08:05', 0) === 485, "'08:05' 解析成 485 分钟")
ok(minutesOf('24:00', -1) === 0, "'24:00' 归一到 0 点")
ok(minutesOf('乱写', 999) === 999, '格式不对回退默认值')
ok(inQuietHours(23 * 60 + 30, 1380, 480) === true, '23:30 落在跨午夜的静默时段里')
ok(inQuietHours(7 * 60, 1380, 480) === true, '07:00 仍然在静默时段里')
ok(inQuietHours(8 * 60, 1380, 480) === false, '08:00 静默结束')
ok(inQuietHours(12 * 60, 1380, 480) === false, '中午不静默')
ok(inQuietHours(12 * 60, 600, 600) === false, '起止相同视为不静默')

// ---- 2. 开关关着 = 一次都不主动 ---------------------------------------------
{
  const r = shouldNudge({ ...base, enabled: false, entry: { lastIncomingAt: NOW - 10 * HOUR } })
  ok(r.ok === false && r.reason === 'off', '开关关着直接拒绝')
}

// ---- 3. 静默时段 ------------------------------------------------------------
{
  const threeAm = new Date(2026, 9, 29, 3, 0, 0).getTime()
  const r = shouldNudge({ ...base, now: threeAm, entry: { lastIncomingAt: threeAm - 10 * HOUR } })
  ok(r.ok === false && r.reason === 'quiet-hours', '凌晨三点不主动')
}

// ---- 4. 从没聊过的人不主动 ---------------------------------------------------
{
  const r = shouldNudge({ ...base, entry: {} })
  ok(r.ok === false && r.reason === 'never-talked', '没有互动记录就不开口（不做陌生推销）')
}

// ---- 5. 空闲不够 ------------------------------------------------------------
{
  const r = shouldNudge({ ...base, entry: { lastIncomingAt: NOW - 1 * HOUR } })
  ok(r.ok === false && r.reason === 'not-idle-enough', '才过 1 小时，不打扰')
  ok(r.eligibleAt === NOW - 1 * HOUR + 6 * HOUR, '给出下次可开口的时间')
}

// ---- 6. 够久了就开口 --------------------------------------------------------
{
  const r = shouldNudge({ ...base, entry: { lastIncomingAt: NOW - 7 * HOUR } })
  ok(r.ok === true && r.reason === 'ok', '过了 7 小时可以主动')
}

// ---- 7. 日配额 --------------------------------------------------------------
{
  const r = shouldNudge({
    ...base,
    entry: { lastIncomingAt: NOW - 7 * HOUR, day: dayKey(NOW), countToday: 1 }
  })
  ok(r.ok === false && r.reason === 'daily-quota', '今天已经主动过 1 次 → 不再说')
}
{
  const r = shouldNudge({
    ...base,
    entry: { lastIncomingAt: NOW - 7 * HOUR, day: '2026-10-28', countToday: 5 }
  })
  ok(r.ok === true, '昨天的次数不算今天的')
}
{
  const r = shouldNudge({ ...base, dailyMax: 0, entry: { lastIncomingAt: NOW - 7 * HOUR } })
  ok(r.ok === false && r.reason === 'daily-quota', 'dailyMax=0 就完全不主动')
}

// ---- 8. 上次没被回 → 退避 ---------------------------------------------------
{
  // 没被回一次 → 需要 12 小时；现在只有 7 小时
  const r = shouldNudge({ ...base, entry: { lastIncomingAt: NOW - 7 * HOUR, unanswered: 1 } })
  ok(r.ok === false && r.reason === 'backoff', '上次开口没人理 → 这次要等更久')
  ok(r.eligibleAt === NOW - 7 * HOUR + 12 * HOUR, '退避后要求 12 小时（6 × 2）')
}
{
  // 没被回两次 → 24 小时，够久了才放行
  const r = shouldNudge({ ...base, entry: { lastIncomingAt: NOW - 25 * HOUR, unanswered: 2 } })
  ok(r.ok === true, '退避之后等够了仍然会开口（不是永久放弃）')
}
{
  // 放大倍数封顶
  const r = shouldNudge({ ...base, entry: { lastIncomingAt: NOW - 20 * HOUR, unanswered: 10 } })
  ok(r.ok === false && r.reason === 'backoff', 'unanswered=10 也不会放大到无限（封顶 4 倍 = 24 小时）')
}

// ---- 9. 手动触发闸门全开 -----------------------------------------------------
{
  const r = shouldNudge({ ...base, enabled: false, force: true, entry: {} })
  ok(r.ok === true && r.reason === 'force', '手动触发不受开关/空闲/静默限制')
}

// ---- 10. 记账：说话清退避，主动没回累积 ---------------------------------------
{
  clearProactiveState()
  notePeerSpoke('private:100', NOW - 7 * HOUR)
  noteNudge('private:100', NOW)
  let r = shouldNudge({ ...base, entry: { lastIncomingAt: NOW - 7 * HOUR, unanswered: 1, lastProactiveAt: NOW, day: dayKey(NOW), countToday: 1 } })
  ok(r.reason === 'daily-quota', '刚主动过 → 今天额度用完')

  // 对方回话 → 退避清零（countToday 用 0：跨到第二天，配额也从零开始）
  notePeerSpoke('private:100', NOW + HOUR)
  r = shouldNudge({
    ...base,
    now: NOW + 8 * HOUR,
    entry: { lastIncomingAt: NOW + HOUR, unanswered: 0, lastProactiveAt: NOW, day: dayKey(NOW + 8 * HOUR), countToday: 0 }
  })
  ok(r.ok === true, '对方回了话之后，第二次主动不用再等 12 小时')
}

// ---- 11. 人话时长 ------------------------------------------------------------
ok(formatGap(30 * 60 * 1000) === '30 分钟', '半个多小时说成「30 分钟」')
ok(formatGap(2 * HOUR + 20 * 60 * 1000) === '2 小时 20 分钟', '两小时二十分')
ok(formatGap(50 * HOUR) === '2 天', '两天（不写小时）')
ok(PROACTIVE_FILE.endsWith('qq-bridge-proactive.json'), '状态文件位置固定（重启不丢）')

// ---- 12. 主动搭话可以对谁开口（0.9.1）----------------------------------------
// 白名单为空 = 全放开（老行为）；填了人就只对名单里的人。
ok(targetAllowed({}, 'private:100') === true, '没配名单 = 全放开')
ok(targetAllowed({ proactiveTargets: [] }, 'private:100') === true, '空名单 = 全放开')
ok(targetAllowed({ proactiveTargets: ['private:100'] }, 'private:100') === true, '名单里的人可以开口')
ok(targetAllowed({ proactiveTargets: ['private:100'] }, 'private:200') === false, '名单外的人不行')
ok(targetAllowed({ proactiveTargets: ['group:1'] }, 'private:100') === true, '脏数据被忽略 → 退化成全放开（不能因为一条写错的就变成谁都不理）')
ok(targetAllowed({ proactiveTargets: ['private:100', 'private:100'] }, 'private:100') === true, '重复项不影响判定')

{
  const cfg = {
    routes: { private: { '100': { sessionId: 's1' }, '200': { sessionId: 's2' }, '300': {} } },
    proactiveTargets: ['private:200']
  }
  const picked = candidates(cfg)
  ok(picked.length === 1 && picked[0].key === 'private:200', '名单只留勾上的人（且必须有会话）')

  cfg.proactiveTargets = []
  const all = candidates(cfg)
  ok(all.length === 2, '空名单：两个绑好会话的都算候选')
  ok(all.every((item) => item.key !== 'private:300'), '没绑会话的人永远不算候选')

  cfg.proactiveTargets = ['private:300']
  ok(candidates(cfg).length === 0, '只勾了没绑会话的人 → 一个候选都没有')
}

// ---- 13. 手动「现在试一次」要轮转（0.9.2）----------------------------------
// 踩过：手动触发固定打候选列表第一个，连点三次全发给同一个人，
// 另一个号永远轮不到 —— 用户看到的就是「另一个对话没收到」。
console.log('\n主动搭话 · 手动触发轮到谁：')
{
  clearProactiveState()
  noteNudge('private:100', NOW) // 100 刚被主动过
  const rotated = orderByStalest([{ key: 'private:100' }, { key: 'private:200' }])
  ok(rotated[0].key === 'private:200', '刚主动过的人排到后面 → 连点会换人')
  ok(rotated.length === 2, '排序不会丢人')

  clearProactiveState()
  const stable = orderByStalest([{ key: 'private:b' }, { key: 'private:a' }])
  ok(stable[0].key === 'private:a', '都没主动过时按 key 稳定排序（不随机）')

  noteNudge('private:b', NOW)
  ok(orderByStalest([{ key: 'private:b' }, { key: 'private:a' }])[0].key === 'private:a',
    '只有 b 主动过 → 下次轮到 a')
  ok(orderByStalest([{ key: 'private:b' }, { key: 'private:a' }])[0].key !== 'private:b',
    '同一个对象不会连着被手动触发两次')
}

// ---- 跨天计数：昨天主动过 2 次，今天第一次必须从 1 开始 ----
// 之前的 bug：noteNudge 只写 day、不清 countToday，于是昨天的次数被算进今天 ——
// UI 上「今天 N 次」只涨不刷新，每日配额也会提前用完。
{
  clearProactiveState()
  rmSync(TMP, { force: true })
  const yesterday = NOW - 24 * HOUR
  noteNudge('private:100', yesterday)
  noteNudge('private:100', yesterday + 60 * 1000)
  noteNudge('private:100', NOW)
  flushPersist()

  const dump = JSON.parse(readFileSync(TMP, 'utf8'))
  const findEntry = (node) => {
    if (node === null || typeof node !== 'object') return null
    if (Object.prototype.hasOwnProperty.call(node, 'countToday')) return node
    for (const value of Object.values(node)) {
      const hit = findEntry(value)
      if (hit !== null) return hit
    }
    return null
  }
  const entry = findEntry(dump)
  ok(entry !== null, '跨天计数：状态文件里能找到记录')
  ok(entry !== null && entry.day === dayKey(NOW), '跨天计数：day 已更新为今天')
  ok(entry !== null && entry.countToday === 1, '跨天计数：昨天 2 次不计入今天，今天从 1 开始')
}

// ---------------------------------------------------------------------------
// 从上游 0.15.2 搬来的三处修复（0.16.18）
// ---------------------------------------------------------------------------
console.log('上游修复 · rollBetween 摇号：')
{
  const { rollBetween } = await import('../lib/proactive.js')
  const a = rollBetween(2, 6, 12345)
  const b = rollBetween(2, 6, 12345)
  ok(a === b, `同一个 seed 摇出同一个值（${a}）`)
  ok(a >= 2 && a < 6, `结果落在 [2,6) 内（${a}）`)
  // 相邻时间戳必须摇出不同的值 —— 只做 FNV 的话小数部分会挤在一起
  const near = [1, 2, 3, 4, 5].map((s) => rollBetween(2, 6, s))
  ok(new Set(near.map((n) => n.toFixed(4))).size >= 4, `相邻 seed 摇出的值足够分散（${near.map((n) => n.toFixed(2)).join(', ')}）`)
  ok(rollBetween(5, 3, 1) === 5, 'max <= min 时退回 min（配置写反不会崩）')
  ok(rollBetween(2, 6, 'abc') >= 2, 'seed 是字符串也能用')
}

console.log('上游修复 · 空闲起算点（她刚说完不该立刻又能开口）：')
{
  const now = Date.now()
  const base = {
    enabled: true, idleHours: 6, dailyMax: 5,
    quietFrom: '', quietTo: '', backoffMax: 1, now
  }
  // 对方 8 小时前说过话（远超 6 小时门槛），但她**1 分钟前刚主动说过**
  const entry = {
    lastIncomingAt: now - 8 * 3600 * 1000,
    lastProactiveAt: now - 60 * 1000,
    day: null, countToday: 0, unanswered: 0
  }
  const r = shouldNudge({ ...base, entry })
  // 旧实现只看 lastIncomingAt → 算作「已空闲 8 小时」→ 放行 → 一分钟一条把额度烧光
  ok(r.ok === false, `她刚主动说完之后【不】立刻再开口（ok=${r.ok} reason=${r.reason}）`)
  ok(r.reason === 'not-idle-enough' || r.reason === 'backoff', `拦下的理由说得清（${r.reason}）`)

  // 反过来：她很久没主动、对方也很久没说话 → 应该放行
  const quiet = { lastIncomingAt: now - 9 * 3600 * 1000, lastProactiveAt: now - 9 * 3600 * 1000, day: null, countToday: 0, unanswered: 0 }
  ok(shouldNudge({ ...base, entry: quiet }).ok === true, '真的安静了 9 小时就正常放行（没拦过头）')
}

console.log('上游修复 · 摇号区间 idleMaxHours：')
{
  const now = Date.now()
  const base = {
    enabled: true, idleHours: 2, idleMaxHours: 6, dailyMax: 5,
    quietFrom: '', quietTo: '', backoffMax: 1, now
  }
  // 同一个 anchor，多次调用应给出同一个 eligibleAt（不会每 60 秒变）
  const entry = { lastIncomingAt: now - 3 * 3600 * 1000, lastProactiveAt: 0, day: null, countToday: 0, unanswered: 0 }
  const r1 = shouldNudge({ ...base, entry })
  const r2 = shouldNudge({ ...base, entry })
  ok(r1.eligibleAt === r2.eligibleAt, '同一次安静期内门槛固定（不会每 60 秒重摇）')
  // 门槛必须落在 [2h, 6h] 区间内
  const gapHours = (r1.eligibleAt - entry.lastIncomingAt) / 3600000
  ok(gapHours >= 2 - 0.01 && gapHours <= 6 + 0.01, `摇出的门槛在 [2,6] 小时内（${gapHours.toFixed(2)}h）`)
  // idleMaxHours=0（默认）时退回固定值
  const fixed = shouldNudge({ ...base, idleMaxHours: 0, entry })
  ok(Math.abs((fixed.eligibleAt - entry.lastIncomingAt) / 3600000 - 2) < 0.01, 'idleMaxHours=0 时用固定门槛（不随机）')
}

console.log('上游修复 · formatClock：')
{
  const { formatClock } = await import('../lib/proactive.js')
  const text = formatClock(new Date('2026-11-03T14:05:00').getTime())
  ok(/^2026-11-03 14:05（周[一二三四五六日]）$/.test(text), `格式正确（${text}）`)
  ok(text.includes('周'), '带星期几（周末和工作日说的话不一样）')
}

console.log(`\n${passed} 过 ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
