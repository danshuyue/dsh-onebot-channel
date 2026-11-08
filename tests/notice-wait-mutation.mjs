/**
 * notice-wait-mutation.mjs —— 0.20.0 两处改动的变异验证。
 * node tests/run-isolated.mjs tests/notice-wait-mutation.mjs
 *
 * ## 为什么必须有这个文件（不是形式主义）
 * 项目里已经栽过两次「测试全绿但实现是坏的」：
 *   · 0.19.0 语音配置漏进 publicConfig —— ui-wiring 105 过 0 败，洞漏到实机才发现
 *   · 0.19.7 一条「无关事件没被收」恒真 —— 哨兵放错字段，实现全删也绿
 * 所以新写的断言必须**先把实现改坏**，确认它真的变红；红的还得是**预期那一条**，
 * 而不是「测试整体崩了」。
 *
 * 做法：把源码文本按精确片段替换成变坏的版本 → 跑对应测试 → 期待失败 →
 * 失败行里必须出现指定的关键字（证明红的是对的那条断言）。
 * **每个变异用独立 HOME**：否则前一个变异残留的配置会污染后一个
 * （现象是「单跑绿、整串红」或「每次红的项都不一样」）。
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync, cpSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0
let fail = 0
const report = []
function line(text) {
  process.stdout.write(`${text}\n`)
  report.push(text)
}
function ok(condition, name) {
  if (condition) { pass += 1; line(`  ✓ ${name}`) } else { fail += 1; line(`  ✗ ${name}`) }
}

/**
 * 把一个变异应用到「插件的临时副本」上，再在独立 HOME 里跑测试。
 *
 * ⚠️ 为什么要复制整个插件目录：变异要改 lib/*.js，绝不能动工作区里的真源码
 *    （改坏了忘记还原就是事故）。副本跑完即删。
 * ⚠️ 子进程输出走**文件重定向**而不是管道：受限环境下管道会 EPERM，
 *    连 stdout 都读不到（见 run-isolated.mjs 里同一段注释）。
 */
function runMutation({ name, edits, test, expectRed }) {
  const work = join(tmpdir(), `qq-mut-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
  const home = join(work, 'home')
  const plugin = join(work, 'plugin')
  mkdirSync(home, { recursive: true })
  cpSync(PLUGIN, plugin, {
    recursive: true,
    filter: (src) => !src.includes('node_modules') && !src.includes('.git') && !src.includes('dist')
  })
  // 隔离 HOME 里放一份够用的配置（多数 sim 需要 groupUins + routes）
  const data = join(home, '.dsh')
  mkdirSync(data, { recursive: true })
  writeFileSync(join(data, 'qq-bridge.config.json'), JSON.stringify({
    enabled: true, selfUin: 3566906627, peerUin: 1321833118, ownerUin: 1321833118,
    onebotHttp: 'http://127.0.0.1:3000/', token: 'test-token', splitReply: false,
    replyQuietMs: 0, mergeWindowMs: 0, autoForwardReply: false, backfillOnStart: false,
    memoryEnabled: false, proactiveEnabled: false, wsEnabled: false,
    groupUins: ['975663147'],
    routes: {
      private: { 1321833118: { sessionId: 'session-mut' } },
      group: { 975663147: { sessionId: 'session-mut' } }
    }
  }, null, 2), 'utf8')
  writeFileSync(join(data, 'qq-bridge-state.json'), JSON.stringify({
    lastId: 0, lastSeq: 1, lastTime: 1, privates: {}, groups: {}
  }, null, 2), 'utf8')

  // 应用变异：每处替换必须**恰好命中一次**，否则说明源码变了、这个变异已经失效
  let applied = true
  for (const edit of edits) {
    const file = join(plugin, edit.file)
    const source = readFileSync(file, 'utf8')
    const hits = source.split(edit.from).length - 1
    if (hits !== 1) {
      applied = false
      line(`  ✗ ${name}：变异没命中（file=${edit.file}，命中 ${hits} 次）`)
      break
    }
    writeFileSync(file, source.replace(edit.from, edit.to), 'utf8')
  }
  if (!applied) {
    rmSync(work, { recursive: true, force: true })
    return false
  }

  const stdoutFile = join(work, 'out.txt')
  const result = spawnSync(process.execPath, [join(plugin, 'tests', test)], {
    cwd: plugin,
    env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: work, TEMP: work, TMP: work },
    encoding: 'utf8',
    timeout: 120000
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  writeFileSync(stdoutFile, output, 'utf8')

  // 「红」= 退出码非 0 且输出里有 ✗。只看退出码不够：崩溃也是非 0，
  // 但崩溃说明变异把整个模块弄坏了，那证明不了断言有效。
  const red = result.status !== 0
  const hasCross = output.includes('✗')
  const expectedLine = expectRed === undefined ? null : output
    .split(/\r?\n/)
    .filter((l) => l.includes('✗'))
    .some((l) => l.includes(expectRed))

  if (expectedLine !== null) {
    ok(red && hasCross && expectedLine, `${name} → 被抓住（红了，且是「${expectRed}」那条）`)
    if (!(red && hasCross && expectedLine)) {
      line(`     ↳ status=${result.status} 有✗=${hasCross} 命中预期=${expectedLine}`)
      line(`     ↳ 输出尾部：\n${output.split(/\r?\n/).slice(-12).map((l) => `       ${l}`).join('\n')}`)
    }
  } else {
    ok(red && hasCross, `${name} → 被抓住（红了）`)
  }

  rmSync(work, { recursive: true, force: true })
  return true
}

line('== 变异 1~4：系统消息路由（notice.js）==')

// 变异 1：off 档不生效 —— 直接去掉「off 就不发」这一行
runMutation({
  name: '变异1 去掉 off 档（该挡的不挡）',
  edits: [{
    file: join('lib', 'notice.js'),
    from: "  if (mode === 'off') return null",
    to: "  if (mode === 'off') return { target, prefix: '' }"
  }],
  test: 'notice-route-sim.mjs',
  expectRed: 'off 档一条都不发'
})

// 变异 2：private 档不换目标 —— 只是「看起来」实现了，实际还是原路
runMutation({
  name: '变异2 private 档不换目标',
  edits: [{
    file: join('lib', 'notice.js'),
    from: '  return { target: { kind: \'private\', id: String(uin) }, prefix }',
    to: '  return { target, prefix }'
  }],
  test: 'notice-route-sim.mjs',
  expectRed: '改走私聊出口'
})

// 变异 3：private 档丢掉群名前缀 —— 通知到了私聊，但看不出是哪个群的事
runMutation({
  name: '变异3 private 档丢前缀',
  edits: [{
    file: join('lib', 'notice.js'),
    from: '  const prefix = String(target?.kind ?? \'\') === \'group\'\n    ? `【${groupLabelOf(target?.id)}】`\n    : \'\'',
    to: '  const prefix = \'\''
  }],
  test: 'notice-route-sim.mjs',
  expectRed: '带【】前缀'
})

// 变异 4：迁移覆盖用户显式选的档 —— 「自己选过的算数」这条红线
runMutation({
  name: '变异4 迁移覆盖显式档',
  edits: [{
    file: join('lib', 'config.js'),
    from: "  const explicit = typeof rawFile.notifyTarget === 'string' && rawFile.notifyTarget.trim() !== ''\n  if (explicit) return false",
    to: "  const explicit = false"
  }],
  test: 'notice-route-sim.mjs',
  expectRed: '用户显式选过的档不被旧布尔覆盖'
})

line('\n== 变异 5~9：qq_wait 锚点（tool.js）==')

// 变异 5：锚点失效（回到老语义）—— 这就是用户报的那个 bug 本身
runMutation({
  name: '变异5 锚点回到「调用那一刻」',
  edits: [{
    file: join('lib', 'tool.js'),
    from: '        const seenIds = new Set()\n        if (anchorIndex >= 0) {',
    to: '        const seenIds = new Set()\n        if (false) {'
  }],
  test: 'wait-anchor-sim.mjs',
  expectRed: '报出 1 条'
})

// 变异 6：锚点取「第一条我发的」而不是「最后一条」—— 顺序理解错就退化成翻旧账
runMutation({
  name: '变异6 锚点取最旧那条自己消息',
  edits: [{
    file: join('lib', 'tool.js'),
    from: "            if (String(ordered[i]?.userId ?? '').trim() === self) anchorIndex = i",
    to: "            if (anchorIndex < 0 && String(ordered[i]?.userId ?? '').trim() === self) anchorIndex = i"
  }],
  test: 'wait-anchor-sim.mjs',
  expectRed: '锚点之前的话不算新'
})

// 变异 7：不再按时间排序 —— 协议端给的是新→旧，锚点会锚到最旧那条
//
// ⚠️ 预期红在**第 1 组**而不是第 2 组：去掉排序后「最后一条自己消息」变成列表末尾
//    = 最旧那条，于是第 1 组里那条回复直接落进「锚点之前」被吞掉 ——
//    它比第 2 组的断言更早暴露，这正是同一个根因的另一种表现。
runMutation({
  name: '变异7 不做chronological排序',
  edits: [{
    file: join('lib', 'tool.js'),
    from: '  return items\n    .map((item, index) => ({ item, index, at: Number(item?.time ?? 0) || 0 }))\n    .sort((a, b) => (a.at - b.at) || (a.index - b.index))\n    .map((entry) => entry.item)',
    to: '  return items'
  }],
  test: 'wait-anchor-sim.mjs',
  expectRed: '报出 1 条'
})

// 变异 8：去掉「已报过」去重 —— 连打两次 qq_wait 会重复播报
runMutation({
  name: '变异8 去掉重复播报去重',
  edits: [{
    file: join('lib', 'tool.js'),
    from: '          if (alreadyReported.has(id)) continue',
    to: '          if (false) continue'
  }],
  test: 'wait-anchor-sim.mjs',
  expectRed: '第二次不再重复报'
})

// 变异 9：beforeWait 恒 false —— 「等之前就到了」这个标记没了，
// 她会把同一条回复当成两件独立的事处理（看到一次 steer、又看到一次「新话」）。
//
// ⚠️ 原来这里变异的是「跳过自己发的消息」。实测那是**等价变异**：
//    锚点语义下「锚点 = 我最后一条消息」，锚点之后按定义不可能再有我的消息，
//    所以那条过滤在正常路径上不可达，删掉它测试照样绿。不是断言弱，是变异选错了。
//    它仍然保留在实现里作为防御（历史口径哪天变了也不至于把我说的话报回来）。
runMutation({
  name: '变异9 beforeWait 恒 false',
  edits: [{
    file: join('lib', 'tool.js'),
    from: '            beforeWait: Number(item.time ?? 0) > 0 && Number(item.time) * 1000 < startedAt',
    to: '            beforeWait: false'
  }],
  test: 'wait-anchor-sim.mjs',
  expectRed: '带 beforeWait 标记'
})

line('\n== 变异 10~13：余额渲染（client.js）==')
//
// 这一组的背景是用户 2026-11-08 报的那个 bug：
//   「余额积分可以查询但是显示的位置和文字是不正确的」
//   —— 顶部绿条写着 1916.0 credits，卡片那一行却写「查不到」。
// 根因：渲染判 `vs.account.ok === true`，而成功路径塞的是后端 account 子对象（没有 ok）。
// 所以变异 10 就是「把那个 bug 写回去」，它必须被 client-render 抓住。

// 变异 10：成功分支读 account.error（= 回到 bug 本身）
runMutation({
  name: '变异10 成功分支读 account.error（bug 本体）',
  edits: [{
    file: join('lib', 'client.js'),
    from: "? String(Number(vs.account.balance).toFixed(1)) + ' credits'",
    to: "? String(vs.account.error || '') + ' credits'"
  }],
  test: 'client-render.mjs',
  expectRed: '查得到余额时显示 1916.0'
})

// 变异 11：整段删掉今日额度
runMutation({
  name: '变异11 删掉今日额度',
  edits: [{
    file: join('lib', 'client.js'),
    from: "                  vs.account && vs.account.ok === true && vs.quota\n                    ? h('span', { key: 'q', className: 'qqb-hint-inline' },\n                      '今天已用 ' + String(vs.quota.used) + ' / '\n                      + (vs.quota.unlimited === true ? '不限' : String(vs.quota.limit)) + ' 字'\n                      + (vs.quota.unlimited === true ? '' : '（还剩 ' + String(vs.quota.remaining) + ' 字）'))\n                    : null,",
    to: '                  null,'
  }],
  test: 'client-render.mjs',
  expectRed: '今日额度在值节点里'
})

// 变异 12：超时文案砍成「超时了」（去掉「点刷新再试」）
runMutation({
  name: '变异12 超时文案去掉刷新引导',
  edits: [{
    file: join('lib', 'client.js'),
    from: "? '超时了（Breeze 这次响应太慢），点「刷新」再试'",
    to: "? '超时了'"
  }],
  test: 'client-render.mjs',
  expectRed: '超时文案自己就写了「刷新」'
})

// 变异 13：成功分支不再显示套餐与并发
runMutation({
  name: '变异13 成功分支不带套餐与并发',
  edits: [{
    file: join('lib', 'client.js'),
    from: "(String(vs.account.plan || '') === '' ? '' : ' · ' + String(vs.account.plan))\n                          + (Number(vs.account.concurrency) > 0 ? ' · 并发 ' + String(vs.account.concurrency) : '')",
    to: "''"
  }],
  test: 'client-render.mjs',
  expectRed: '余额旁边带上套餐与并发'
})

line('\n== 变异 14~21：忽略指令（0.20.1）==')
//
// 用户需求：「由于 snowluma 有关键词 #sl 用于查看状态。添加忽略指令配置，默认 #sl，
//   就是发送的是 #sl 就不处理。可配置。」
// 这个功能有三个经典的写错方式，每个都配一个变异：做成前缀匹配（吞人话）、
// 一批里只拦第一条（挖半句话）、拦了不推进游标（每 2 秒重投）。

// 变异 14：做成前缀匹配 —— 会把「#sl 你好」这种人话一起吞掉
runMutation({
  name: '变异14 做成 startsWith 前缀匹配',
  edits: [{
    file: join('lib', 'commands.js'),
    from: '    if (body === word) return true',
    to: '    if (body.startsWith(word)) return true'
  }],
  test: 'ignore-command-sim.mjs',
  expectRed: '「#sl 你好」不命中'
})

// 变异 15：大小写不敏感 —— 用户写 #SL 是另一个词，不该按 #sl 处理
runMutation({
  name: '变异15 大小写不敏感',
  edits: [{
    file: join('lib', 'commands.js'),
    from: '    if (body === word) return true',
    to: '    if (body.toLowerCase() === word.toLowerCase()) return true'
  }],
  test: 'ignore-command-sim.mjs',
  expectRed: '大小写不同不命中'
})

// 变异 16：空表也忽略所有 —— 破坏「空 = 关闭这项功能」
runMutation({
  name: '变异16 空表也忽略所有',
  edits: [{
    file: join('lib', 'commands.js'),
    from: "  const body = String(text ?? '').trim()\n  if (body === '') return false\n  for (const item of list) {",
    to: "  const body = String(text ?? '').trim()\n  if (body === '') return false\n  if (list.length === 0) return true\n  for (const item of list) {"
  }],
  test: 'ignore-command-sim.mjs',
  expectRed: '空表 = 关闭功能'
})

// 变异 17：私聊命中后不推进游标 —— 轮询会每 2 秒把同一条 #sl 重投一遍
runMutation({
  name: '变异17 私聊命中后不推进游标',
  edits: [{
    file: join('lib', 'poll.js'),
    from: "    noteCoalesced('ignore', `ignore:private:${uin}`, `private ${uin} 命中忽略指令，整批不投`)\n    advancePrivateCursor(state, uin, messages)",
    to: "    noteCoalesced('ignore', `ignore:private:${uin}`, `private ${uin} 命中忽略指令，整批不投`)"
  }],
  test: 'ignore-command-sim.mjs',
  expectRed: '游标推进了'
})

// 变异 18：只查第一条 —— 一批里 #sl 在第二条时就漏了，她会看到半句话
runMutation({
  name: '变异18 只检查第一条消息',
  edits: [{
    file: join('lib', 'commands.js'),
    from: '  for (const item of messages) {\n    const segments = item !== null && typeof item === \'object\' && Array.isArray(item.message)',
    to: '  for (const item of messages.slice(0, 1)) {\n    const segments = item !== null && typeof item === \'object\' && Array.isArray(item.message)'
  }],
  test: 'ignore-command-sim.mjs',
  expectRed: '整批被忽略'
})

// 变异 19：群聊用 textOf（at 段会被渲染成 @号，判不出 #sl）
//
// ⚠️ 这个变异是本轮**真踩到过的 bug**：第一版实现用的就是 text，测试立刻红了。
//    留在这里当永久看守 —— at 段污染这件事很容易在下次重构时被忘掉。
runMutation({
  name: '变异19 群聊用 textOf（at 段污染）',
  edits: [{
    file: join('lib', 'poll.js'),
    from: '  if (isIgnoredMessage(textSegmentsOf(message.message), config.ignoreCommands)) {',
    to: '  if (isIgnoredMessage(text, config.ignoreCommands)) {'
  }],
  test: 'ignore-command-sim.mjs',
  expectRed: '群里的 #sl 被跳过'
})

// 变异 20：默认值不是 #sl
runMutation({
  name: '变异20 默认值改成空表',
  edits: [{
    file: join('lib', 'config.js'),
    from: "  ignoreCommands: ['#sl'],",
    to: '  ignoreCommands: [],'
  }],
  test: 'ignore-command-sim.mjs',
  expectRed: 'DEFAULTS.ignoreCommands 含 #sl'
})

// 变异 21：publicConfig 把空表兜回默认 —— 用户清空了，重进面板又冒出 #sl
runMutation({
  name: '变异21 publicConfig 兜底成默认表',
  edits: [{
    file: join('lib', 'api.js'),
    from: "    ignoreCommands: Array.isArray(config.ignoreCommands)\n      ? config.ignoreCommands.map((v) => String(v ?? '')).filter((v) => v !== '')\n      : [],",
    to: "    ignoreCommands: (Array.isArray(config.ignoreCommands) && config.ignoreCommands.length > 0)\n      ? config.ignoreCommands.map((v) => String(v ?? '')).filter((v) => v !== '')\n      : ['#sl'],"
  }],
  test: 'ignore-command-sim.mjs',
  expectRed: 'publicConfig 如实返回空表'
})

// 变异 22：listField 的 value 写成空串 —— 控件在、但用户看不到自己的配置，
// 保存一次就把表清空（「界面能改、改了没用」的另一种形状）
runMutation({
  name: '变异22 listField 的 value 不接数组',
  edits: [{
    file: join('lib', 'client.js'),
    from: '              value: raw.join(\', \'),',
    to: "              value: '',"
  }],
  test: 'client-render.mjs',
  expectRed: '输入框里是逗号拼起来的表'
})

line('\n== 基线：不改动时必须全绿 ==')
for (const test of ['notice-route-sim.mjs', 'wait-anchor-sim.mjs', 'client-render.mjs', 'ignore-command-sim.mjs']) {
  const work = join(tmpdir(), `qq-base-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
  const home = join(work, 'home')
  mkdirSync(join(home, '.dsh'), { recursive: true })
  writeFileSync(join(home, '.dsh', 'qq-bridge.config.json'), JSON.stringify({
    enabled: true, selfUin: 3566906627, peerUin: 1321833118, ownerUin: 1321833118,
    onebotHttp: 'http://127.0.0.1:3000/', token: 'test-token', groupUins: ['975663147'],
    routes: { private: {}, group: {} }
  }, null, 2), 'utf8')
  const result = spawnSync(process.execPath, [join(PLUGIN, 'tests', test)], {
    cwd: PLUGIN,
    env: { ...process.env, HOME: home, USERPROFILE: home, TMPDIR: work, TEMP: work, TMP: work },
    encoding: 'utf8',
    timeout: 120000
  })
  ok(result.status === 0, `baseline ${test} 全绿（未变异时不能红）`)
  rmSync(work, { recursive: true, force: true })
}

const REPORT = join(PLUGIN, '.tmp-test', 'notice-wait-mutation-report.txt')
try {
  mkdirSync(dirname(REPORT), { recursive: true })
  writeFileSync(REPORT, report.join('\n'), 'utf8')
  line(`\n（完整报告已写入 ${REPORT}）`)
} catch { /* 写不进不算失败 */ }

line(`\n结果：${pass} 过 / ${fail} 败`)
process.exit(fail === 0 ? 0 : 1)
