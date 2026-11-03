/**
 * 变异验证（手工驱动版）：node tests/turn-notice-mutation.mjs --check <变异名>
 *
 * 为什么是这种形状（2026-11-03 实测）：
 *   `dsh-onebot-channel/lib` 的 ACL 断了继承（docs/维护索引.md §9 坑 1），
 *   脚本里的 `writeFileSync` 对 lib/*.js 一律 EPERM —— 连还原都写不回去。
 *   所以**不能**让脚本自己改源码。改成：脚本只负责跑测试、报告哪条断言抓到了；
 *   改坏和还原由宿主文件工具（有权限）按这里的清单逐条做。
 *
 * 变异清单在本文件 MUTATIONS 里，两处必须一致：
 *   - 这里的 from/to 是要手工施加的改动
 *   - expected 是对应必须变红的那条断言文案
 */
import { execFileSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 每个变异：改哪个文件、把什么换成什么、期望哪条断言抓到它。
 * `applied: true` 表示这一版源码里已经带着这个变异（正在验证中）。
 */
export const MUTATIONS = [
  {
    name: 'error 分支不通知',
    file: 'lib/outbound.js',
    from: "            if (noticeKind !== '') {\n              await notifyEntryOnce(entry, noticeKind, String(reason?.error?.message ?? reason?.kind ?? ''))\n            }",
    to: '',
    expect: 'error 回合发出了通知'
  },
  {
    name: 'aborted 也当故障',
    file: 'lib/notice.js',
    from: "  if (kind === 'interrupted') return 'interrupted'",
    to: "  if (kind === 'interrupted') return 'interrupted'\n  if (kind === 'aborted') return 'interrupted'",
    expect: '用户主动停止不发通知'
  },
  {
    name: '在跑也直接丢弃',
    file: 'lib/outbound.js',
    from: '            if (alive && (Number(entry.ttlKeeps) || 0) < TTL_STALL_KEEP_MAX) {',
    to: '            if (false) {',
    expect: '条目被保留'
  },
  {
    name: '取消保留上限',
    file: 'lib/outbound.js',
    from: '            if (alive && (Number(entry.ttlKeeps) || 0) < TTL_STALL_KEEP_MAX) {',
    to: '            if (alive) {',
    expect: '超过上限必须丢弃'
  },
  {
    name: '去掉条目级去重',
    file: 'lib/notice.js',
    from: "  if (marks !== null && typeof marks === 'object' && marks[kind] === true) return false",
    to: '',
    expect: '仍是同条目只播一次'
  },
  {
    name: '去掉时间冷却',
    file: 'lib/notice.js',
    from: '  if (previous !== undefined && now - Number(previous) < NOTICE_COOLDOWN_MS) {',
    to: '  if (false) {',
    expect: '冷却期内只发一条'
  },
  {
    name: '冷却是全局的而非按目标',
    file: 'lib/notice.js',
    from: '  const key = keyOf(target)',
    to: "  const key = 'shared'",
    expect: '群和私聊各收到一条'
  },
  {
    name: '把目标改成 peerUin',
    file: 'lib/notice.js',
    from: '    await sendOneToQQ(target, text)',
    to: "    await sendOneToQQ({ kind: 'private', id: '1321833118' }, text)",
    expect: '发给了这个群'
  },
  {
    name: '通知文案缺了「没能发出来」这层意思',
    file: 'lib/notice.js',
    from: "  error: '[系统] 这一回合出错了，她的回复没能发出来。可以再发一条，或者稍后再试。',",
    to: "  error: '[系统] 这一回合出错了。',",
    expect: '通知说明了「回复没能发出来」'
  }
]

/**
 * 跑一遍测试，返回「失败的断言行」。
 *
 * ⚠️ 不能用 `stdio: 'pipe'`（2026-11-03 踩到）：受限环境下子进程的管道
 * 会以 EPERM 失败，`error.stdout` 是空的 —— 表现成「什么都没红」，
 * 于是每个变异都被判成「没被抓住」，看着像断言是假绿的，其实是**一个字节都没读到**。
 * 改成把子进程的 stdout/stderr 重定向到临时文件再读，绕开命名管道。
 * （维护索引 §4 坑 28 记的 forward-mutation 跑不了，也是同一个原因。）
 */
export function failingAssertions() {
  const log = join(tmpdir(), `qq-bridge-mutation-${process.pid}.log`)
  let fd
  try {
    fd = openSync(log, 'w')
    execFileSync(process.execPath, [join(HERE, 'turn-notice-sim.mjs')], {
      stdio: ['ignore', fd, fd]
    })
    return []
  } catch {
    // 退出码非 0 = 有断言失败（正是我们要看的），不当作脚本自身出错
    let output = ''
    try {
      output = readFileSync(log, 'utf8')
    } catch {
      return ['（读不到子进程输出）']
    }
    return output.split('\n').filter((line) => line.includes('✗'))
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* 已关 */ }
      try { rmSync(log, { force: true }) } catch { /* 清不掉不算失败 */ }
    }
  }
}

const checkName = process.argv[2]
if (checkName !== undefined) {
  const mutation = MUTATIONS.find((item) => item.name === checkName)
  if (mutation === undefined) {
    console.error(`未知变异：${checkName}`)
    process.exit(2)
  }
  const failures = failingAssertions()
  if (failures.some((line) => line.includes(mutation.expect))) {
    console.log(`✓ 「${mutation.name}」被断言「${mutation.expect}」抓住`)
    process.exit(0)
  }
  console.error(`✗ 「${mutation.name}」没被抓住。当前红的是：`)
  for (const line of failures) console.error(`   ${line.trim()}`)
  if (failures.length === 0) {
    console.error('   （什么都没红：先确认这个变异真的写进源码了。')
    console.error('     本机 lib/*.js 的 ACL 断了继承，脚本写不进去（维护索引 §9 坑 1），')
    console.error('     变异必须用宿主文件工具手工施加。施加过还是全绿 → 那条断言是假绿的。）')
  }
  process.exit(1)
}
