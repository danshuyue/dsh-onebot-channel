/**
 * interest-mutation —— 兴趣点（0.23.0）变异验证。
 *
 * ## 与 wake-mutation 的关键差别
 *
 * 兴趣点的断言分散在**三个**测试文件里：
 *   · `interest-judge-sim`    —— 判定器（JSON 容错、失败即 false）
 *   · `interest-window-sim`   —— 取材、任务、落盘、剪辑
 *   · `interest-dedupe-sim`   —— 去重、额度、下发两路
 *   · `interest-wiring-sim`   —— 接线（组件有没有真的被用上）
 *
 * 所以这里每个变异都**指定跑哪个测试**：变异改的是哪个模块，
 * 就看那个模块的测试有没有抓住它。这一点很容易搞错 ——
 * 第一版 wake-mutation 里就有两条变异改 `poll.js`、却只跑 `wake-sim`，
 * 结果「没被抓住」其实是**断言根本不在那个文件里**。代价是白排查一轮。
 *
 * ## 判据纪律
 *
 * `expect` 写的是**预期变红的那条断言的标签片段**。红了但红的不是它，算漏网
 * （「红的不是预期断言」）—— 因为那说明变异连坐了别的东西，或者断言不区分实现。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, closeSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')

function pickRoot() {
  for (const root of [
    join(tmpdir(), `int-mut-${process.pid}`),
    join(PLUGIN, '..', '.tmp-test', `int-mut-${process.pid}`)
  ]) {
    try { mkdirSync(root, { recursive: true }); return root } catch { /* 换下一个 */ }
  }
  throw new Error('没有可写的临时目录')
}

const ROOT = pickRoot()
mkdirSync(ROOT, { recursive: true })

/** 隔离 HOME + 一份够用的配置（多数 interest 测试会自己再钉一遍）。 */
function makeHome(tag) {
  const home = join(ROOT, `home-${tag}`)
  mkdirSync(join(home, '.dsh'), { recursive: true })
  writeFileSync(join(home, '.dsh', 'qq-bridge.config.json'), JSON.stringify({
    enabled: true,
    selfUin: 3566906627,
    peerUin: 1321833118,
    ownerUin: 1321833118,
    onebotHttp: 'http://127.0.0.1:3000/',
    token: 'test-token',
    workspaceCwd: '',
    groupUins: ['716197431'],
    groupOnlyWhenAt: true,
    routes: {
      private: { 1321833118: { sessionId: 'session-isolated-test' } },
      group: { 716197431: { sessionId: 'session-isolated-test' } }
    },
    mergeWindowMs: 0,
    replyQuietMs: 0,
    splitReply: true,
    autoForwardPrivate: true,
    autoForwardGroup: true,
    backfillOnStart: false,
    memoryEnabled: false,
    wsEnabled: false,
    proactiveEnabled: false,
    windowEnabled: true,
    waterWindows: ['00:00-23:59']
  }, null, 2), 'utf8')
  return home
}

function makeCopy(tag) {
  const dir = join(ROOT, `copy-${tag}`)
  cpSync(PLUGIN, dir, {
    recursive: true,
    filter: (src) => !src.includes('node_modules') && !src.includes('.git') && !src.includes('.tmp-test')
      && !src.includes('_tmp-') && !src.includes('int-mut-')
  })
  return dir
}

function runTest(copyDir, testRel, home) {
  const log = join(home, `log-${Math.random().toString(36).slice(2)}.txt`)
  let fd
  try {
    fd = openSync(log, 'w')
    execFileSync(process.execPath, [join(copyDir, testRel)], {
      cwd: copyDir,
      stdio: ['ignore', fd, fd],
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        DSH_TEST_HOME: home,
        TMPDIR: home,
        TEMP: home,
        TMP: home
      }
    })
    closeSync(fd); fd = undefined
    return { ok: true, output: '' }
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* 已关 */ } }
    let output = ''
    try { output = readFileSync(log, 'utf8') } catch { output = '' }
    return { ok: false, output: output || `（读不到输出：${error instanceof Error ? error.message : error}）` }
  }
}

function patch(copyDir, rel, from, to) {
  const file = join(copyDir, rel)
  const src = readFileSync(file, 'utf8')
  if (!src.includes(from)) throw new Error(`变异没命中：${rel} 里找不到\n${from.slice(0, 240)}`)
  writeFileSync(file, src.replace(from, to), 'utf8')
}

const TESTS = {
  judge: 'tests/interest-judge-sim.mjs',
  window: 'tests/interest-window-sim.mjs',
  dedupe: 'tests/interest-dedupe-sim.mjs',
  wiring: 'tests/interest-wiring-sim.mjs'
}

// ---- baseline：四个测试必须全绿 -------------------------------------------
for (const [name, rel] of Object.entries(TESTS)) {
  const dir = makeCopy(`baseline-${name}`)
  const result = runTest(dir, rel, makeHome(`baseline-${name}`))
  if (!result.ok) {
    console.error(`✗ baseline(${name}) 就红了 —— 后面的变异结论没意义，先把它修绿：\n`)
    console.error(result.output.split('\n').filter((l) => l.includes('✗') || /Error/.test(l)).slice(0, 20).join('\n'))
    process.exit(1)
  }
  console.log(`✓ baseline(${name}) 绿`)
  rmSync(dir, { recursive: true, force: true })
}

const MUTATIONS = [
  // ===== 判定器（judge.js）=====
  {
    test: 'judge',
    label: '坏 JSON 当命中（解析失败时返回 match:true）',
    apply: (dir) => patch(dir, 'lib/judge.js',
      "if (parsed === null) {\n      return { ok: false, result: null, why: `输出不是合法 JSON（前 120 字：${text.slice(0, 120)}）` }\n    }",
      "if (parsed === null) {\n      return { ok: true, result: validateJudgeResult({ match: true }) || null, why: '' }\n    }"),
    expect: ['坏 JSON → ok:false']
  },
  {
    test: 'judge',
    label: 'finish.reason.kind=error 不判失败（接口报错仍然采信那半截输出）',
    apply: (dir) => patch(dir, 'lib/judge.js',
      "if (kind === 'error') failure = String(chunk.reason?.failure?.message ?? '模型返回错误')",
      "if (kind === 'never') failure = 'x'"),
    expect: ['finish.kind=error → ok:false']
  },
  {
    test: 'judge',
    label: 'max-tokens 不当失败（截断的 JSON 被当成结论）',
    apply: (dir) => patch(dir, 'lib/judge.js',
      "else if (kind === 'max-tokens') failure = '输出被截断（max-tokens）'",
      ''),
    // ⚠️ 抓它的是「失败原因写明『截断』」那条，不是 `ok:false` 那条：
    //    去掉这个分支后，那段残 JSON 仍然解析不出来 → extractJson 返回 null → 依旧 ok:false。
    //    也就是说 `ok:false` 断言**区分不了**这个变异（两条路都通向同一个结果）。
    //    真正能区分的是「失败原因有没有说清是截断」—— 这条断言的价值正在这里：
    //    截断和「模型返回了废话」是两种故障，日志里混成一句就没法排查。
    expect: ['失败原因写明「截断」']
  },
  {
    test: 'judge',
    label: 'match 认字符串 "true"（没按契约输出也采信）',
    apply: (dir) => patch(dir, 'lib/judge.js',
      'const match = raw.match === true',
      "const match = raw.match === true || raw.match === 'true'"),
    expect: ['match 是字符串 "true" → 判 false']
  },
  {
    test: 'judge',
    label: 'JSON 容错只剩第一层（模型加一句前言就判不了）',
    apply: (dir) => patch(dir, 'lib/judge.js',
      'const fenced = body.match(/```(?:json)?\\s*([\\s\\S]*?)```/i)',
      'const fenced = null'),
    // ⚠️ 这条**如实标成不可区分**，不是为了凑绿而补一条假断言。
    //
    //    事实：`extractJson` 的第三层（第一个 { 到最后一个 }）会兜住代码块里的 JSON，
    //    所以砍掉第二层后，`'好的：\n```json\n{...}\n```'` 这种输入照样能解析出来
    //    —— 第 2 层在功能上被第 3 层完全覆盖，是**冗余容错**。
    //
    //    要不要因此把它删掉？不删：它挡的是「块内有合法 JSON、块外也有一段更长的
    //    不合法花括号」这种极端情况，那时第 3 层会抠出一坨废字符串。
    //    但这不值得为它写一条测试 —— 那种断言只能靠人造输入成立，
    //    对真实模型输出没有代表性，写了也只是给自己找个绿。
    //
    //    纪律：**看似漏网但经查证是冗余实现的变异，要标出来并写清理由**，
    //    否则下一个人会以为这里有个洞，再去补一条没用的测试。
    expect: [],
    knownUndistinguishable: true,
    why: '第 2 层被第 3 层完全覆盖（冗余容错）；补断言只能靠人造输入'
  },
  {
    test: 'judge',
    label: 'prompt 不带主人的原话（只剩关键词 → 「昨天我的程序崩溃了」也会算）',
    apply: (dir) => patch(dir, 'lib/judge.js',
      "lines.push(`主人的原话：${String(point?.description ?? '').trim() || '（主人没写描述，按关键词理解）'}`)",
      "lines.push('主人的原话：（略）')"),
    expect: ['判定 prompt 包含命中条件']
  },
  {
    test: 'judge',
    label: '没有跟进时留白（不给「没人再说话」这句 → 模型自己猜）',
    apply: (dir) => patch(dir, 'lib/judge.js',
      "lines.push('（等待期内没有人再说话）')",
      "lines.push('')"),
    expect: ['没有跟进时**明说**没有']
  },
  {
    test: 'judge',
    label: '下发文本首行不是【群名】[群友]：「内容」（用户逐字要求的格式丢了）',
    apply: (dir) => patch(dir, 'lib/judge.js',
      "lines.push(`【${gname}】[${keyNick}]：「${keyText}」`)",
      "lines.push(`群 ${String(task?.groupId ?? '')} 有新情况`)"),
    expect: ['首行就是 `【群名】[群友]：「内容」`']
  },

  // ===== 取材 / 任务（interest.js）=====
  {
    test: 'window',
    label: '创建任务时不存 pre（10 分钟后前因全没了）',
    apply: (dir) => patch(dir, 'lib/interest.js',
      'pre: Array.isArray(options.pre) ? options.pre : snapshotBefore(options.buffer, message, preMinutes),',
      'pre: [],'),
    expect: ['缓冲里 3 条都在 preMinutes 内 → 全部进 pre']
  },
  {
    test: 'window',
    label: 'pre 快照不按 preMinutes 过滤（把一小时前的事也当成前因）',
    apply: (dir) => patch(dir, 'lib/interest.js',
      'if (at > 0 && at < from) continue',
      ''),
    expect: ['超出 preMinutes 的消息不进 pre']
  },
  {
    test: 'window',
    label: '等待期消息不追加（during 永远是空 → 看不到「有没有人跟进」）',
    apply: (dir) => patch(dir, 'lib/interest.js',
      'if (appended) return',
      ''),
    // ⚠️ 抓它的是「等待期内的消息**不开新任务**」那条：
    //    去掉 `if (appended) return` 之后，等待期内的消息会**再建一个任务**，
    //    于是「任务数还是 1」直接红。而 `during.length === 1` 那条反而**不红** ——
    //    因为 appendToRunningTasks 照旧执行了，只是返回值没人管。
    //    这正好说明「同一个风险要两条断言」（开没开新任务 / during 有没有进），
    //    它们各自盯的是不同的失败方式。
    expect: ['等待期内的消息不开新任务']
  },
  {
    test: 'window',
    label: 'during 不判 dueAt（过了等待期还在往旧任务里塞消息）',
    apply: (dir) => patch(dir, 'lib/interest.js',
      'if (Number(task.dueAt) <= nowMs()) continue',
      ''),
    expect: ['过了 dueAt 之后再命中 → 开**新**任务']
  },
  {
    test: 'window',
    label: '任务不落盘（热重载 / 重启后那次「帮你盯着」静默失效）',
    apply: (dir) => patch(dir, 'lib/interest.js',
      'tasks.set(task.id, task)\n  persistInterests()',
      'tasks.set(task.id, task)'),
    // ⚠️ 抓它的是「落盘的是同一条任务」：文件里还留着**上一条**任务的残留
    //    （测试自己写了一份空账本，但 createTask 不再写），于是「盘上的 id === 内存的 id」直接红。
    //    「INTEREST_FILE 存在」那条不红，因为文件本来就被测试自己建过 ——
    //    这提醒一件事：**判「有没有写盘」不能只看文件在不在**，要比内容。
    expect: ['落盘的是同一条任务']
  },
  {
    test: 'window',
    label: 'trimTask 优先丢 during（把「有没有人跟进」先扔掉，留下可有可无的前因）',
    apply: (dir) => patch(dir, 'lib/interest.js',
      'const cutPre = Math.min(need, pre.length)\n  const keptPre = pre.slice(cutPre)\n  need -= cutPre\n  const keptDuring = need > 0 ? during.slice(need) : during',
      'const cutDuring = Math.min(need, during.length)\n  const keptDuring = during.slice(cutDuring)\n  need -= cutDuring\n  const keptPre = need > 0 ? pre.slice(need) : pre'),
    // ⚠️ 抓它的是「need(16) 超过 pre 全长(10) → pre 整体丢弃」那一组
    //    （实际变成「pre 留 4 条、during 全丢」，两条都红）。
    //    而「need 小于 pre 长度时 during 完整保留」那条**不红** ——
    //    因为 need(5) < pre 长度(6) 时，两种实现的**结果一致**（都从 pre 砍）。
    //    换句话说：这个变异只在「need 大到吃穿 pre」时才暴露，
    //    所以断言必须包含那个算例（这也是我一开始把 10/10 那个算例写进测试的理由，
    //    虽然当时把预期写反了 —— 见测试里的长注释）。
    expect: ['need(16) 超过 pre 全长(10) → pre 整体丢弃']
  },

  // ===== 去重 / 额度 / 下发（interest.js）=====
  {
    test: 'dedupe',
    label: '去掉内容指纹（同一件事被三个人复述 → 通知三遍）',
    apply: (dir) => patch(dir, 'lib/interest.js',
      'if (hasRecentFingerprint(fp, at)) {',
      'if (false) {'),
    // ⚠️ 抓它的是 **1b 节**（冷却关掉、单独验指纹）那条「同一件事（指纹相同）→ 不再通知」。
    //    不能指望第 1 节：那里冷却开着，第二次先被冷却挡住，根本走不到指纹 ——
    //    这正是「同一事实被多个因素满足」的假绿温床（坑 27），
    //    也是这个变异第一轮没被抓住的真实原因。
    expect: ['同一件事（指纹相同）→ 不再通知']
  },
  {
    test: 'dedupe',
    label: '指纹只剩 pointId|groupId（不同的事也撞同一个指纹 → 这个关注点在群里只通知一次）',
    apply: (dir) => patch(dir, 'lib/interest.js',
      "  const parts = [\n    String(pointId ?? ''),\n    String(groupId ?? ''),\n    String(result?.keyMessage?.text ?? '').replace(/\\s+/g, ' ').trim()\n  ]\n  for (const row of Array.isArray(result?.related) ? result.related.slice(0, 2) : []) {\n    parts.push(String(row?.text ?? '').replace(/\\s+/g, ' ').trim())\n  }\n  return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16)",
      "  return createHash('sha1').update(`${pointId}|${groupId}`).digest('hex').slice(0, 16)"),
    // ⚠️ 第一版这个变异**只把 keyMessage.text 清空**，留了 related ——
    //    结果指纹仍然不同（复述那组的 related 不同），测试全绿，
    //    于是被报成「没被抓住」。那不是断言有洞，是**变异没改彻底**：
    //    我要验证的是「正文内容参与指纹」，就得让指纹只剩 id 级信息。
    //    教训：变异只改半个条件时，绿不代表断言弱 —— 可能是变异没碰到被测行为。
    expect: ['不同的事（指纹不同）→ 照常通知']
  },
  {
    test: 'dedupe',
    label: '冷却不判（热点事件十分钟内通知十几遍）',
    apply: (dir) => patch(dir, 'lib/interest.js',
      'if (last > 0 && at - last < cooldownMinutes * 60_000) {',
      'if (false) {'),
    expect: ['冷却期内 → 不通知（即使内容不同）']
  },
  {
    test: 'dedupe',
    label: '每群每日额度不判',
    apply: (dir) => patch(dir, 'lib/interest.js',
      'if (used >= limit) return { ok: false, why: `这个群今天已经通知 ${used} 次（上限 ${limit}）` }',
      ''),
    expect: ['这个群今天已通知 5 次 → 不再通知']
  },
  {
    test: 'dedupe',
    label: '成本硬顶挪到送判之后（钱已经花了才拦）',
    apply: (dir) => {
      // 把额度检查从 due 循环里删掉，改到判完再判 —— 结果就是「花了钱才发现超了」
      patch(dir, 'lib/interest.js',
        "    const callLimit = Number(config.interestDailyMaxCalls)\n    if (Number.isFinite(callLimit) && callLimit > 0) {\n      const used = Number(daily[dayKey(at)]?.calls ?? 0)\n      if (used >= callLimit) {\n        tasks.delete(task.id)\n        stats.skipped += 1\n        note('interest', `任务丢弃 ${task.id}：今日判定调用已达上限（${used}/${callLimit}）`)\n        continue\n      }\n    }\n",
        '')
    },
    expect: ['调用额度用尽 → **一次模型调用都没发生**']
  },
  {
    test: 'dedupe',
    label: '两条下发路合流成一个开关（用户要的两个复选框变成一个）',
    apply: (dir) => patch(dir, 'lib/interest.js',
      "if (config?.interestNotifySession === true) {",
      "if (config?.interestNotifySelf !== false) {"),
    // ⚠️ 抓它的是§「路 B 素材」那三条：路 B 的条件被替换后，
    //    「只开 session」的场景里路 B 根本不会跑（因为 self 是关的），
    //    于是 followup 没被调用、素材里没有那句声明 → 三条全红。
    //    而「两个都开 → 只有 self 成功」那条**不红**：两个都开时，
    //    变异版同样会走 self 那一条（结果巧合相同）。
    //    这类「oggles 组合」必须至少测「只开 A / 只开 B / 都开」三种，
    //    少测一种就会漏掉一半的接反可能。
    expect: ['路 B 真的调了 followup']
  },
  {
    test: 'dedupe',
    label: '路 B 素材不带「不是主人说的话」声明（主会话会以为主人在跟它聊）',
    apply: (dir) => patch(dir, 'lib/interest.js',
      "          '【插件上报 · 兴趣点命中】',\n          '下面这段不是主人说的话，是插件替主人盯着群时发现的情况。请据此给主人一条提醒（可以更自然一些，但不要编造细节）。',",
      "          '【插件上报 · 兴趣点命中】',"),
    expect: ['路 B 的首行写明「这是插件上报，不是主人说的话」']
  },
  {
    test: 'dedupe',
    label: '下发了也不记账（冷却与额度全部失效 → 下一轮又发）',
    apply: (dir) => patch(dir, 'lib/interest.js',
      'lastNotified[String(point.id)] = at',
      ''),
    expect: ['冷却期内 → 不通知（即使内容不同）']
  },

  // ===== 接线 =====
  {
    test: 'wiring',
    label: 'observe 挪到忽略指令之前（#sl 这类命令会被当成主人在意的事）',
    apply: (dir) => {
      // 把 ignore 判定整块删掉 —— 等价于「observe 先于忽略判定」
      patch(dir, 'lib/poll.js',
        "  if (isIgnoredMessage(textSegmentsOf(message.message), config.ignoreCommands)) {\n    noteCoalesced('ignore', `ignore:group:${groupId}`, `group ${groupId} 命中忽略指令，跳过`)\n    return { status: 'skipped' }\n  }\n",
        '')
    },
    expect: ['observe 在「忽略指令」判定**之后**']
  },
  {
    test: 'wiring',
    label: 'observe 挪到「no at」return 之后（只有 @ 时才看兴趣点 → 主要触发源全丢）',
    apply: (dir) => patch(dir, 'lib/poll.js',
      "  void interest.observe(ctx, groupId, message, {\n    buffer: groupBuffer(groupId).slice(),\n    groupName: groupNames.get(groupId) ?? ''\n  })\n",
      ''),
    expect: ['poll.js 里真的调了 interest.observe']
  },
  {
    test: 'wiring',
    label: 'index.js 不启动兴趣点循环（任务能建但永远不判）',
    apply: (dir) => patch(dir, 'lib/index.js',
      'stopFns.push(startInterestLoop(ctx))',
      'void startInterestLoop'),
    expect: ['index.js 真的调用了它']
  },
  {
    test: 'wiring',
    label: 'buffer 传函数而不是快照（10 分钟后再取缓冲，前因早被挤掉）',
    apply: (dir) => patch(dir, 'lib/poll.js',
      'buffer: groupBuffer(groupId).slice(),',
      'buffer: groupBuffer(groupId),'),
    expect: ['buffer 传的是**此刻的快照**']
  },
  {
    test: 'wiring',
    label: 'ARRAY_CLEANERS 不登记 interestPoints（对象数组被通用清洗成垃圾）',
    apply: (dir) => patch(dir, 'lib/api.js',
      'interestPoints: cleanInterestPoints',
      'interestPoints: cleanIgnoreCommands'),
    expect: []
  }
]

let caught = 0
const missed = []
const REPORT = join(PLUGIN, '..', '.tmp-test', 'interest-mutation-report.txt')
const report = []
function both(line, isError = false) {
  report.push(line)
  if (isError) console.error(line); else console.log(line)
}

for (const [index, item] of MUTATIONS.entries()) {
  const tag = `m${index}`
  const dir = makeCopy(tag)
  const home = makeHome(tag)
  try {
    item.apply(dir)
  } catch (error) {
    both(`✗ 变异没生效：${item.label}\n  ${error instanceof Error ? error.message : error}`, true)
    missed.push(item.label)
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    continue
  }
  const result = runTest(dir, TESTS[item.test], home)
  const reds = result.ok
    ? []
    : result.output.split('\n').filter((line) => line.includes('✗')).map((line) => line.trim())

  // ---- 已知不可区分：必须先判，而且判的是「测试仍然是绿的」---------------
  //
  // ⚠️ 这一段第一版写在了 `else`（即「测试红了」的分支）里，分支条件写反了：
  //    「不可区分」的定义就是**测试保持绿**，所以它永远进不到那个 else ——
  //    结果这条变异被报成「没被抓住」。这是我自己造的一次分流错误，
  //    正好印证「分支顺序决定结论」这类缺陷不看代码是发现不了的。
  if (item.knownUndistinguishable === true) {
    if (result.ok) {
      caught += 1
      both(`✓ 已知不可区分（${item.test}）：${item.label}`)
      both(`    └─ ${item.why}`)
    } else {
      // 它居然红了 → 说明「不可区分」的判断错了（实现变了，或它连坐了别的东西）
      missed.push(`${item.label}（标为不可区分，但它居然红了 —— 判断有误）`)
      both(`✗ 标为不可区分但变红了（${item.test}）：${item.label}`, true)
      both(`   实际红：${reds.slice(0, 5).join(' / ') || '（没有 ✗ 行）'}`, true)
    }
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
    continue
  }

  if (result.ok) {
    missed.push(item.label)
    both(`✗ 没被抓住（${item.test}）：${item.label}`, true)
  } else {
    // expect 为空 = 「只要红就行」（用在没有精确标签的看守上）
    const hit = item.expect.length === 0 || item.expect.some((label) => reds.some((line) => line.includes(label)))
    if (hit) {
      caught += 1
      both(`✓ 抓住（${item.test}）：${item.label}`)
      both(`    └─ ${reds.slice(0, 2).join(' / ')}`)
    } else {
      missed.push(`${item.label}（红了但不是预期那几条）`)
      both(`✗ 红的不是预期断言（${item.test}）：${item.label}`, true)
      both(`   预期含：${item.expect.join(' / ')}`, true)
      both(`   实际红：${reds.slice(0, 5).join(' / ') || '（没有 ✗ 行）'}`, true)
    }
  }
  rmSync(dir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}

rmSync(ROOT, { recursive: true, force: true })

both(`\n${caught} 个变异被抓住 / ${missed.length} 个漏网`)
if (missed.length > 0) {
  both('\n漏网的变异：', true)
  for (const label of missed) both(`  - ${label}`, true)
}

try {
  mkdirSync(dirname(REPORT), { recursive: true })
  writeFileSync(REPORT, report.join('\n'), 'utf8')
} catch { /* 写报告失败不影响结论 */ }

process.exit(missed.length === 0 ? 0 : 1)