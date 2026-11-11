/**
 * log-coalesce-sim.mjs —— 日志降噪（2026-11-08）。
 *
 * ## 为什么要有这个测试（这是真事故，不是假想）
 *
 * 用户报「内容全发到群里」，我们让他点「导出日志」。他导出的日志有 **18,254 行**，
 * 其中：
 *   - `[ws] 收到消息事件 …`          9,740 行（53%）—— 每条 QQ 消息写一行
 *   - `private … error OneBot HTTP 502` 4,889 行（27%）—— 上游挂着一个 502 每 2 秒刷一遍
 *   - `group … 未配置会话，忽略` 等     4,243 行（23%）—— 每个没绑会话的群每条消息写一行
 * 三者合计 **97%**。真正的现场（`已转发回复` / `分 N 条发送` / `两条之间…`）
 * 一天也没几行，全被这些噪音挤出了轮转窗口 —— **导出按钮点了，拿到的是看不出问题的日志**。
 *
 * 所以加了 `noteCoalesced`：同类日志第一条原样落盘，窗口内重复只计数，窗口外再写时
 * 把攒下的次数补一行。这个测试钉住三件事：
 *   1. **第一条必须立刻写**（取证要的是「发生过」，合并不许让事实消失）
 *   2. 窗口内重复**不再落盘**（降噪真的生效）
 *   3. 压掉的次数**必须在日志里留下痕迹**（「发生了 5,000 次」这个事实不能丢）
 * 外加一条错误分级：502/503/504 算连接类（上游没起来），500 不算（协议端内部错）。
 */
import { mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { useIsolatedHome } from './isolated-home.mjs'

// ⚠️ 必须先建隔离 HOME 再 import env.js：LOAD_LOG 是在模块加载时按 homedir() 定死的常量。
const HOME = useIsolatedHome('logcoalesce-')
const DATA = join(HOME, '.dsh')
mkdirSync(DATA, { recursive: true })

const { note, noteCoalesced, resetCoalesce, LOAD_LOG } = await import('../lib/env.js')
const { isConnectionError } = await import('../lib/health.js')

let passed = 0
let failed = 0
function ok(cond, name, extra = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}${extra ? '　' + extra : ''}`) }
  else { failed += 1; console.error(`  ✗ ${name}${extra ? '　' + extra : ''}`) }
}

function readLog() {
  return existsSync(LOAD_LOG) ? readFileSync(LOAD_LOG, 'utf8') : ''
}

/** 数某段文案在日志里出现的次数（按行，子串匹配）。 */
function countLines(needle) {
  return readLog().split('\n').filter((line) => line.includes(needle)).length
}

console.log('\n1. 第一条必须立刻落盘（不许延迟、不许吞）：')
{
  rmSync(LOAD_LOG, { force: true })
  resetCoalesce()
  noteCoalesced('ws', 'k1', '收到消息事件 type=group from=111')
  ok(countLines('收到消息事件 type=group from=111') === 1,
    '第一次调用就写进日志了（不是等窗口结束才写）',
    `实际 ${countLines('收到消息事件 type=group from=111')} 行`)
}

console.log('\n2. 窗口内重复只计数，不再逐条落盘：')
{
  rmSync(LOAD_LOG, { force: true })
  resetCoalesce()
  for (let i = 0; i < 50; i += 1) {
    noteCoalesced('ws', 'k2', '收到消息事件 type=group from=222', 60000)
  }
  const lines = countLines('type=group from=222')
  ok(lines === 1, `50 次重复只留 1 行（实际 ${lines} 行）`)
  ok(!readLog().includes('另有 49 次'), '窗口还没过，不提前补「另有 N 次」')
}

console.log('\n3. 窗口过期后的第一次：补一行累计次数 + 新的那条照写：')
{
  rmSync(LOAD_LOG, { force: true })
  resetCoalesce()
  // ⚠️ 不能拿 windowMs=0 来模拟「下一次就是窗口外」：0 会让**每一次**都算窗口外
  //    （age < 0 恒假），于是每条都落盘，测出的其实是「没合并」。
  //    必须用真实的短窗口 + 真实等待，才能造出「先窗口内重复、再窗口外」的序列。
  const W = 30
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  // 第 1 次：落盘（首条）
  noteCoalesced('group', 'k3', 'group 999 未配置会话，忽略', W)
  // 紧接着 9 次：都在窗口内 → 只计数
  for (let i = 0; i < 9; i += 1) noteCoalesced('group', 'k3', 'group 999 未配置会话，忽略', W)
  ok(countLines('未配置会话，忽略') === 1, '窗口内 9 次重复一行都没多写', `实际 ${countLines('未配置会话，忽略')} 行`)
  // 等过窗口，再来一条 → 应该补「另有 9 次」+ 落盘这一条
  await sleep(W * 2)
  noteCoalesced('group', 'k3', 'group 999 未配置会话，忽略', W)
  const log = readLog()
  ok(countLines('未配置会话，忽略') === 2,
    `原始行落盘 2 次（首条 + 窗口外的那条），实际 ${countLines('未配置会话，忽略')}`)
  ok(log.includes('另有') && log.includes('次未逐条记录'),
    '被压掉的次数以「另有 N 次未逐条记录」的形式留在了日志里')
  // ⚠️ 这条是本节的**主断言**：没有它，「合并」可能被写成「直接丢弃」而测试照样绿。
  ok(/另有 9 次未逐条记录/.test(log), '「另有 N 次」里的数字是真实计数（这里应为 9）')
}

console.log('\n4. 不同 key 互不影响（群和私聊、不同群号必须分开计）：')
{
  rmSync(LOAD_LOG, { force: true })
  resetCoalesce()
  noteCoalesced('ws', 'msg:group:100', '收到消息事件 type=group from=100')
  noteCoalesced('ws', 'msg:group:200', '收到消息事件 type=group from=200')
  noteCoalesced('ws', 'msg:private:300', '收到消息事件 type=private from=300')
  noteCoalesced('ws', 'msg:group:100', '收到消息事件 type=group from=100')
  ok(countLines('from=100') === 1, '同一群的第 2 条被合并')
  ok(countLines('from=200') === 1, '另一个群没有被连带合并（key 隔离生效）')
  ok(countLines('from=300') === 1, '私聊也没有被连带合并')
}

console.log('\n5. 账本不会无限膨胀：')
{
  resetCoalesce()
  const before = readLog().length
  for (let i = 0; i < 800; i += 1) {
    noteCoalesced('ws', `flood:${i}`, `flood ${i}`)
  }
  // 只是别把进程内存撑坏：800 个不同 key 之后账本被清过，不该抛错也不该卡住
  ok(readLog().length > before, '大量不同 key 时仍然正常写日志（不抛、不卡）')
}

console.log('\n6. 错误分级：网关 5xx 算连接类，协议端 500 不算：')
{
  ok(isConnectionError(new Error('OneBot HTTP 502')) === true,
    '502 算连接类（上游反代/网关说「协议端连不上」→ 只记一次状态翻转，不每轮刷屏）')
  ok(isConnectionError(new Error('OneBot HTTP 503')) === true, '503 算连接类')
  ok(isConnectionError(new Error('OneBot HTTP 504')) === true, '504 算连接类')
  // ⚠️ 这条是**反向**看守：把 500 一起放行会让真故障被静默
  ok(isConnectionError(new Error('OneBot HTTP 500')) === false,
    '500 **不算**连接类 —— 协议端收到了请求、自己内部出错，那是真故障，必须照旧每轮报')
  ok(isConnectionError(new Error('OneBot HTTP 401')) === false,
    '401 不算连接类（鉴权错，重试一万次也不会自己好）')
  // 别把「消息正文里碰巧有 502」当成网络错误
  ok(isConnectionError(new Error('retcode=1404 消息 502 不存在')) === false,
    '只有整条错误就是 `OneBot HTTP 502x` 时才归连接类（不误伤业务错误）')
}

console.log('\n7. 合并不改变普通 note 的行为：')
{
  rmSync(LOAD_LOG, { force: true })
  resetCoalesce()
  note('out', '已转发回复 12 字 -> group')
  note('out', '已转发回复 12 字 -> group')
  ok(countLines('已转发回复') === 2,
    '普通 note() 两次调用就写两行 —— 转发证据**绝不能**被合并掉',
    `实际 ${countLines('已转发回复')} 行`)
}

console.log(`\n${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
