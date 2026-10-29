/**
 * 主动搭话的判定测试：node tests/proactive-sim.mjs，退出码 0 = 全过。
 *
 * 这块的成败全在「不该说的时候真的不说」：
 *   静默时段、没聊过、刚聊完、今天说过了、上次说没人理（要退避）。
 * 只要有一条闸漏了，它就从「她想起你」变成「每天定时问候」。
 *
 * 状态文件走临时路径，不碰 ~/.dsh/qq-bridge-proactive.json。
 */
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  shouldNudge, minutesOf, inQuietHours, dayKey, formatGap,
  notePeerSpoke, noteNudge, useProactiveFile, clearProactiveState, PROACTIVE_FILE,
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

console.log(`\n${passed} 过 ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
