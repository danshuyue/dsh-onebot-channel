/**
 * 私聊游标专项测试：node tests/priv-cursor-sim.mjs，退出码 0 = 全过。
 *
 * 回归一个真踩过的坑（2026-10-28）：
 *   私聊历史里 `message_seq` 是**两套编号混着的** ——
 *     · 机器人自己发的 → 本地 store 连续编号（实测 7130, 7131, 7132…）
 *     · 对方发来的     → QQ 服务器漫游记录编号（实测 50764, 50765, 50766…）
 *   而且对方那一套自己也不单调（实测 50764 → 50765 → 50766 → 20590）。
 *
 *   于是「seq ≤ lastSeq 就是旧消息」在私聊上根本不成立：
 *   树树 13:26 的消息 seq=20590，被上一条 50766 的游标判成旧消息直接丢弃，
 *   现象就是「我发了消息，DSH 收不到」。
 *
 * 现在私聊改用「时间戳 + message_id」，群聊仍用 seq（群消息 seq 单调）。
 */
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

const { isSeen, markSeen } = await import('../lib/poll.js')

console.log('私聊游标（用时间戳，不用 seq）：')

// ---- 场景一：回归 —— 对方消息的 seq 比游标小，但时间是新的，必须放行 ----
{
  // 游标：上一条处理到的是 seq=50766（对方那套编号）、time=13:15:25
  const bucket = {
    lastSeq: 50766,
    lastTime: 1793164525, // 13:15:25
    seenIds: [-141948751]
  }
  // 新消息：seq=20590（对方编号跳回 20xxx），但时间是 13:26:43，更晚
  const fresh = { message_id: 1467586298, message_seq: 20590, time: 1793165203 }

  ok(
    isSeen(bucket, fresh, false) === false,
    'seq 跳号但时间更新的消息不被当成旧消息（旧版会丢）'
  )
}

{
  // 同样这条消息，但如果是群聊模式（useSeqCursor=true）→ 会被误杀。
  // 这正是「为什么私聊必须单独走时间戳」的证据。
  const bucket = { lastSeq: 50766, lastTime: 1793164525, seenIds: [] }
  const fresh = { message_id: 1467586298, message_seq: 20590, time: 1793165203 }
  ok(isSeen(bucket, fresh, true) === true, '群聊模式（seq 判断）确实会误杀这条 —— 说明两套逻辑必须分开')
}

{
  // 真的旧消息：时间比游标早 → 跳过
  const bucket = { lastSeq: 50766, lastTime: 1793164525, seenIds: [] }
  const old = { message_id: 111111, message_seq: 99999, time: 1793160000 }
  ok(isSeen(bucket, old, false) === true, '时间早于游标的旧消息被跳过')
}

{
  // 没有游标（首次运行 / 老 state）→ 不据此判断，不能把所有消息都当旧的
  const bucket = { seenIds: [] }
  const any = { message_id: 222, message_seq: 50765, time: 1793160000 }
  ok(isSeen(bucket, any, false) === false, '没有时间游标时不判旧（宁可多看也别漏）')

  const bucketZero = { lastTime: 0, seenIds: [] }
  ok(isSeen(bucketZero, any, false) === false, 'lastTime=0 视为「无游标」而不是「全部都是旧的」')
}

// ---- 场景二：同秒的多条消息不能互相吞掉 ----
{
  // 时间戳是秒级的，同一秒发两条，时间相同但 message_id 不同
  const bucket = { lastTime: 1793164525, seenIds: [] }
  const a = { message_id: 1001, message_seq: 20590, time: 1793164525 }
  const b = { message_id: 1002, message_seq: 20591, time: 1793164525 }
  ok(isSeen(bucket, a, false) === false, '同秒的第一条不被跳过')
  ok(isSeen(bucket, b, false) === false, '同秒的第二条也不被跳过（不能互相吞）')

  // 记了第一条之后，第二条仍要能过（靠 message_id 精确区分，不靠时间）
  markSeen(bucket, a)
  ok(isSeen(bucket, a, false) === true, '记过的第一条会被精确去重')
  ok(isSeen(bucket, b, false) === false, '同秒的第二条不受影响，仍然能过')
}

// ---- 场景三：message_id 精确去重（负数也要准）----
{
  const bucket = { lastTime: 1793164525, seenIds: [] }
  const negative = { message_id: -1880740179, message_seq: 20590, time: 1793165000 }
  ok(isSeen(bucket, negative, false) === false, '负数 id 的新消息不被误判')
  markSeen(bucket, negative)
  ok(isSeen(bucket, negative, false) === true, '负数 id 记过后能精确认出来（靠相等，不靠比大小）')
}

// ---- 场景四：群聊继续用 seq（seq 单调，判断成立）----
{
  const bucket = { lastSeq: 4376, seenIds: [] }
  const newer = { message_id: 3001, message_seq: 4377, time: 1793064704 }
  const older = { message_id: 3002, message_seq: 4375, time: 1793064000 }
  ok(isSeen(bucket, newer, true) === false, '群聊：seq 更大的新消息不算旧')
  ok(isSeen(bucket, older, true) === true, '群聊：seq 更小的旧消息算旧')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed > 0 ? 1 : 0)
