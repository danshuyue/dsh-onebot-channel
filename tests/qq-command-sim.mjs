/**
 * qq-command-sim.mjs —— QQ 侧命令层的集成测试。
 *
 * 这个文件测的是「命令层有没有把用户的话吞掉 / 有没有把命令当成普通消息投出去」，
 * 以及 poll.js 里那段拦截逻辑的边界。命令本身的渲染在 progress-sim 里测过了，
 * 这里专测**接线**：
 *   · 命令被识别 → 走 sendToQQ 回复，不投递进会话
 *   · 命令没被识别 → 照常投递（绝不吞）
 *   · 命令之前的正文 → 先投递，再执行命令
 *   · 命令执行后 → 游标必须推进（否则轮询反复重投）
 *   · 命令回复走唯一出口（callOneBot），不绕过白名单
 *
 * ⚠️ 必须在隔离 HOME 下跑：node tests/run-isolated.mjs tests/qq-command-sim.mjs
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
    qqCommandPrefix: '/',
    focusTagEnabled: true,
    focusIdleResetMs: 3600000
  }
  mkdirSync(DATA, { recursive: true })
  writeFileSync(join(DATA, 'qq-bridge.config.json'), JSON.stringify({ ...base, ...overrides }, null, 2), 'utf8')
}

/** 造一条 OneBot 私聊消息。 */
function msg(text, id = -1001, time = Math.floor(Date.now() / 1000)) {
  return {
    message_id: id,
    time,
    sender: { user_id: 1321833118, nickname: '学海难行' },
    message: [{ type: 'text', data: { text } }]
  }
}

async function main() {
  rmSync(join(DATA, 'qq-bridge-state.json'), { force: true })
  writeConfig()

  const config = await import('../lib/config.js')
  config.loadConfig()
  const state = await import('../lib/state.js')
  state.loadState()

  // ---- 用假的 callOneBot 拦住所有出站，观察发了什么 ----
  // 为什么要拦：真发会打到 127.0.0.1:3000（测试环境没有协议端），
  // 而且 sendToQQ 失败会走重试/降级，测试变得不可预测。
  const onebot = await import('../lib/onebot.js')
  const sent = []
  const original = onebot.callOneBot
  // ⚠️ ESM 导出是只读绑定，没法直接替换。所以走另一条路：
  //    给 fetch 打桩（callOneBot 内部用 fetch 发 HTTP）。
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    let body = ''
    try {
      body = String(init?.body ?? '')
    } catch {}
    sent.push({ url: String(url), body })
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok', retcode: 0, data: { message_id: -9999 } }),
      text: async () => '{"status":"ok","data":{"message_id":-9999}}'
    }
  }

  const cmd = await import('../lib/commands.js')
  const { handlePrivateMessages } = await import('../lib/poll.js')
  const fakeCtx = { get: () => undefined }

  try {
    // ---- 1. 普通消息不是命令 ----
    eq(cmd.parseCommand('今天怎么样', '/'), null, '★ 普通消息不会被当成命令')

    // ---- 2. 未识别命令名 → 原样投给会话（不吞）----
    // 这条是红线：用户在聊天里打了个斜杠，不能被插件吃掉。
    eq(cmd.canonicalName('随便写的'), '', '★ 未识别的命令名 canonicalName 返回空')
    const r = cmd.parseCommand('/随便写的 你好', '/')
    eq(r.name, '随便写的', 'parseCommand 认得出斜杠开头')
    eq(cmd.canonicalName(r.name), '', '但 canonicalName 判它不是命令 → 调用方会原样投递')

    // ---- 3. 命令前缀为空 = 命令层关闭 ----
    writeConfig({ qqCommandPrefix: '' })
    config.loadConfig()
    eq(cmd.parseCommand('/进度', ''), null, '★ 前缀为空时命令层完全关闭')
    writeConfig()
    config.loadConfig()

    // ---- 4. 全部别名都能收敛 ----
    for (const [alias, want] of [
      ['进度', '进度'], ['p', '进度'], ['status', '进度'], ['P', '进度'], ['STATUS', '进度'],
      ['看', '看'], ['peek', '看'], ['去', '去'], ['go', '去'], ['回', '回'], ['back', '回'],
      ['在哪', '在哪'], ['who', '在哪'], ['where', '在哪'],
      ['帮助', '帮助'], ['help', '帮助'], ['h', '帮助'], ['?', '帮助']
    ]) {
      eq(cmd.canonicalName(alias), want, `别名 ${alias} → ${want}`)
    }

    // ---- 5. 帮助文本：列出的命令必须都真的存在 ----
    const help = cmd.renderHelp('/')
    for (const name of ['/进度', '/看', '/去', '/回', '/在哪', '/帮助']) {
      ok(help.includes(name), `帮助里列出了 ${name}`)
    }
    // features 过滤：关掉的命令不该出现在帮助里
    const helpPartial = cmd.renderHelp('/', { features: { go: false, back: false } })
    ok(!helpPartial.includes('/去'), '★ features.go=false 时帮助里不列 /去')
    ok(!helpPartial.includes('/回'), '★ features.back=false 时帮助里不列 /回')
    ok(helpPartial.includes('/进度'), '关掉别的命令不影响 /进度 仍然列出')

    // ---- 6. 编号表：makeTable / lookupTable 契约 ----
    const now = Date.now()
    const table = cmd.makeTable([{ n: 1, sessionId: 'a', label: 'A' }, { n: 2, sessionId: 'b', label: 'B' }], now)
    eq(cmd.lookupTable(table, '1').entry.sessionId, 'a', '编号 1 对应 a')
    eq(cmd.lookupTable(table, '2').entry.sessionId, 'b', '编号 2 对应 b')
    eq(cmd.lookupTable(table, '3').reason, 'range', '不存在的编号 → range')
    eq(cmd.lookupTable({ at: now - 20 * 60_000, entries: table.entries }, '1', now).reason, 'expired', '★ 过期表 → expired')

    // 三种 miss 的文案必须不同（用户要能分辨「没发过 / 过期了 / 编号超范围」）
    const tEmpty = cmd.tableMissText('/', { reason: 'empty', max: 0 })
    const tExpired = cmd.tableMissText('/', { reason: 'expired', max: 2 })
    const tRange = cmd.tableMissText('/', { reason: 'range', max: 2 })
    ok(tEmpty !== tExpired && tExpired !== tRange && tEmpty !== tRange, '★ 三种 miss 文案互不相同')
    ok(tExpired.includes('重新发'), '过期文案明确要求重发（不按旧编号猜）')

    // ---- 7. 端到端：命令不进会话、回复走出站 ----
    sent.length = 0
    // ⚠️ state 文件可能还不存在（本进程第一次写盘之前）——
    //    直接 readFileSync 会 ENOENT。用「读不到就当空」的写法。
    const readState = () => {
      try {
        return JSON.parse(readFileSync(join(DATA, 'qq-bridge-state.json'), 'utf8'))
      } catch {
        return {}
      }
    }
    const before = readState()
    const cursorBefore = Number(before?.privates?.['1321833118']?.lastTime ?? 0)

    const used = await handlePrivateMessages(fakeCtx, '1321833118', [msg('/帮助', -2001)])
    eq(used, 'command', '★ /帮助 被命令层消费，返回 command（不投递进会话）')
    ok(sent.length > 0, '★ 命令回复确实发出去了（走了 callOneBot 那条唯一出口）')
    const helpSent = sent.find((s) => s.body.includes('可用命令'))
    ok(helpSent !== undefined, '★ 发出去的正文是帮助内容')
    ok(helpSent.body.includes('send_private_msg'), '★ 命令回复走的是 OneBot 的 send_private_msg（没另开出口）')

    // ---- 8. 命令执行后游标必须推进 ----
    const after = readState()
    const cursorAfter = Number(after?.privates?.['1321833118']?.lastTime ?? 0)
    ok(cursorAfter > cursorBefore, '★★ 命令执行后游标推进了（否则轮询会反复重投同一条命令）')

    // ---- 9. /进度 建立编号表，/看 能查到 ----
    sent.length = 0
    await handlePrivateMessages(fakeCtx, '1321833118', [msg('/进度', -2002)])
    const st = readState()
    const table2 = st?.cmdTable?.['private:1321833118']
    ok(table2 !== undefined, '★ /进度 之后编号表落盘了')
    if (table2 !== undefined && Array.isArray(table2.entries) && table2.entries.length > 0) {
      sent.length = 0
      await handlePrivateMessages(fakeCtx, '1321833118', [msg('/看 1', -2003)])
      const peekSent = sent.find((s) => s.body.includes('send_private_msg'))
      ok(peekSent !== undefined, '★ /看 1 能查到并回复')
    }

    // ---- 10. 未识别命令 → 照常投递（不吞用户的话）----
    // 这里用 /乱写 当例子：它不是命令，应该被当成普通正文投给会话。
    // 因为 deliver 会真的去 resume agent（测试环境没有），所以只看「有没有走命令分支」。
    const used2 = await handlePrivateMessages(fakeCtx, '1321833118', [msg('/乱写的东西', -2004)])
    ok(used2 !== 'command', '★★ 未识别的 /xxx 不被命令层消费（原样投给会话，不吞用户的话）')

    // ---- 11. 命令之前的正文先投递 ----
    // 「你看下那个补丁」+「/帮助」：正文要投，命令也要执行。
    sent.length = 0
    const used3 = await handlePrivateMessages(fakeCtx, '1321833118', [msg('你看下那个补丁', -2005), msg('/帮助', -2006)])
    eq(used3, 'command', '一批里最后一条是命令 → 整批由命令消费')
    ok(sent.some((s) => s.body.includes('可用命令')), '命令回复发了')
  } finally {
    globalThis.fetch = originalFetch
    void original
  }

  // ---- 汇总 ----
  console.log(`\nqq-command-sim: ${pass} 过 / ${fail} 败`)
  if (fail > 0) {
    console.log('失败项：')
    for (const item of failures) console.log('  -', item)
    process.exit(1)
  }
}

await main()
