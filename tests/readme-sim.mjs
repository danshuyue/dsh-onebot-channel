/**
 * README 一致性自检：node tests/readme-sim.mjs，退出码 0 = 全过，1 = 有失败。
 *
 * README 是这个项目唯一的对外说明，写错了比没写更糟 ——
 * 用户照着错的信息配置，插件行为跟文档对不上，排查成本翻倍。
 *
 * 所以把 README 里**能被代码验证的断言**都钉住：
 *   · 配置项的默认值（README 的配置示例必须跟 config.js 一致）
 *   · 工具的名字和参数（README 的工具表必须跟 tool.js 一致）
 *   · HTTP 路由、封禁清单、表情表条数、模块清单
 *
 * 凡是「会变」的数字都从代码里读，README 改了而代码没改 → 这里报红。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

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

const SRC = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const README = readFileSync(join(SRC, 'README.md'), 'utf8')

const { getConfig, loadConfig, DEFAULTS } = await import('../lib/config.js')
loadConfig()
const cfg = getConfig()

console.log('配置默认值（README 的配置示例必须跟 config.js 的 DEFAULTS 一致）：')
{
  // ⚠️ 读的是 config.js 导出的 DEFAULTS（代码默认值），**不是** getConfig() 的结果 ——
  //   后者会被用户的 ~/.dsh/qq-bridge.config.json 覆盖（树树自己调过 pollMs 等），
  //   拿它当断言基准，测试就会误报「README 写错了」。
  //   README 的配置示例列的是**代码默认值**，那才是要跟 DEFAULTS 对齐的东西。
  const expected = {
    pollMs: 2000,
    groupPollMs: 3000,
    groupContextCount: 5,
    splitMaxChars: 120,
    splitMinChars: 4,
    splitMaxParts: 8,
    splitDelayMinMs: 200,
    splitDelayMaxMs: 700,
    requestTimeoutMs: 8000,
    wsFallbackPollMs: 30000
  }
  for (const [key, value] of Object.entries(expected)) {
    eq(DEFAULTS[key], value, `${key} 代码默认值`)
  }
  // wsPrivateMergeMs 是退役键（从未被消费，config.js 启动时会主动删掉），
  // 期望值写死 250 会永远报红 —— 真正要守的是「README 别再推荐它」。
  ok(!README.includes('wsPrivateMergeMs'), 'README 不再推荐已退役的 wsPrivateMergeMs')
  eq(DEFAULTS.resumeColdSession, true, 'resumeColdSession 默认')
  eq(DEFAULTS.groupOnlyWhenAt, true, 'groupOnlyWhenAt 默认')
  // fallbackToLiveSession 会绕过路由表，默认必须是 false（2026-10-27 从 true 改的）
  eq(DEFAULTS.fallbackToLiveSession, false, 'fallbackToLiveSession 默认')
  ok(
    README.includes('"fallbackToLiveSession": false'),
    'README 的配置示例里 fallbackToLiveSession 写的是 false'
  )
}

console.log('\n工具（README 的工具表必须跟 tool.js 一致）：')
{
  const { registerSendTool, registerEmojiSearchTool, registerHistoryTool, registerQzoneTool, registerCollectTool, registerFacePreviewTool, registerWaitTool, registerPassTool, registerCloseTool, registerRememberTool } = await import('../lib/tool.js')
  const regs = []
  const ctx = {
    get: (name) => (name === 'tools'
      ? { register: (t) => { regs.push(t); return () => {} } }
      : (name === 'attachments' ? { saveImages: async () => [] } : undefined)),
    effect: () => {}
  }
  for (const fn of [registerSendTool, registerEmojiSearchTool, registerHistoryTool, registerQzoneTool, registerCollectTool, registerFacePreviewTool, registerWaitTool, registerPassTool, registerCloseTool, registerRememberTool]) {
    await fn(ctx)
  }
  eq(regs.map((t) => t.name).sort(), [
    'qq_close', 'qq_collect_face', 'qq_emoji_search', 'qq_face_preview', 'qq_msg_history',
    'qq_pass', 'qq_qzone_post', 'qq_remember', 'qq_send', 'qq_wait'
  ], '注册的 10 个工具')

  for (const tool of regs) {
    ok(README.includes(`\`${tool.name}\``), `README 提到了 ${tool.name}`)
    for (const param of Object.keys(tool.parameters?.properties ?? {})) {
      ok(README.includes(`\`${param}\``), `README 的工具表列出了 ${tool.name} 的参数 ${param}`)
    }
  }
}

console.log('\nHTTP 路由：')
{
  const { API_PREFIX } = await import('../lib/api.js')
  const api = readFileSync(join(SRC, 'lib', 'api.js'), 'utf8')
  // 不写死路由清单：新加一个接口就报红一次太吵，真正要守的是「README 有没有漏写接口」。
  const routes = [...new Set([...api.matchAll(/route === '([^']+)'/g)].map((m) => m[1]))].sort()
  ok(routes.length >= 5, `解析到 ${routes.length} 个路由：${routes.join(' ')}`)
  for (const route of routes) {
    ok(README.includes(`${API_PREFIX}${route}`), `README 提到了 ${API_PREFIX}${route}`)
  }
}

console.log('\n封禁清单：')
{
  const { BLOCKED_ACTIONS } = await import('../lib/blocked.js')
  eq(BLOCKED_ACTIONS.size, 13, '封禁 action 数')
  ok(README.includes('13 个高风险 action'), 'README 写的是 13 个')
  for (const action of BLOCKED_ACTIONS) {
    ok(README.includes(`\`${action}\``), `README 列出了封禁项 ${action}`)
  }
}

console.log('\n表情表：')
{
  const { faceNameList } = await import('../lib/emoticons.js')
  const names = faceNameList()
  eq(names.length, 275, '经典表情表条数')
  ok(README.includes('275 个'), 'README 写的是 275 个')
  const ids = names.map((s) => Number(/\((\d+)\)$/.exec(s)?.[1])).filter(Number.isFinite)
  ok(README.includes(`0~${Math.max(...ids)}`), `README 写的编号范围 0~${Math.max(...ids)}`)
}

console.log('\n说说可见性：')
{
  const { QZONE_VISIBILITY } = await import('../lib/qzone.js')
  for (const [value, label] of Object.entries(QZONE_VISIBILITY)) {
    ok(README.includes(`\`${value}\``), `README 列出了可见性 ${value}（${label}）`)
  }
}

console.log('\n模块清单（README 必须提到每一个 lib 模块）：')
{
  const files = readdirSync(join(SRC, 'lib')).filter((f) => f.endsWith('.js'))
  const missing = files.filter((f) => !README.includes(f))
  ok(missing.length === 0, `README 覆盖全部 ${files.length} 个模块${missing.length > 0 ? `（缺 ${missing.join(', ')}）` : ''}`)
}

console.log('\nREADME 里不该出现的过期信息：')
{
  // 这些是历史上写错过的数字 / 版本号，改版后残留下来会误导人
  ok(!/\b0\.2\.0\b/.test(README), '没有残留旧版本号 0.2.0')
  ok(!/14 个.*action/.test(README), '没有残留「14 个 action」（实际 13）')
  ok(README.includes('0.6.2'), '保留 0.6.2 那条私聊去重的排障说明')
  ok(README.includes('10 个工具'), '写明了 10 个工具')
}

console.log('\n链接与文档：')
{
  for (const doc of ['docs/QQ对话说明.md', 'docs/踩坑记录.md', 'docs/开发笔记.md']) {
    ok(existsSync(join(SRC, doc)), `${doc} 存在`)
    ok(README.includes(doc), `README 引用了 ${doc}`)
  }
}

console.log('\n启动顺序（2026-10-28 加的探活门控）：')
{
  // 这几条是这次改动的核心结论，README 写漏了就会让人按旧认知排查
  ok(README.includes('health.js'), 'README 提到了 health.js（探活门控模块）')
  ok(README.includes('登录'), 'README 解释了「端口等 QQ 登录后才 listen」这件事')
  ok(README.includes('get_login_info'), 'README 写明了用 get_login_info 探活')
  // 模块数：README 里写死的那个数字必须跟 lib/ 里的实际文件数对上
  const libFiles = readdirSync(join(SRC, 'lib')).filter((f) => f.endsWith('.js'))
  const claimed = README.match(/(\d+) 个模块/)
  ok(claimed !== null, 'README 写明了模块数量')
  if (claimed !== null) {
    eq(Number(claimed[1]), libFiles.length, `README 说的模块数跟 lib/ 实际一致（${libFiles.length}）`)
  }
}

console.log('\n私聊游标（2026-10-28 的丢消息 bug）：')
{
  // 这个坑很容易在后续重构里被「优化」回去 —— 断言钉住
  ok(README.includes('重复消息'), 'README 提到了「重复消息」这个去重误杀的排查入口')
  ok(README.includes('message_seq'), 'README 解释了私聊 message_seq 不可信这件事')
  ok(README.includes('时间戳'), 'README 写明了私聊改用时间戳判新旧')
}

console.log('\n连发消息重复转发（2026-10-28）：')
{
  ok(README.includes('已转发过'), 'README 提到了「已转发过，跳过重复发送」这个排查入口')
  ok(README.includes('连着发'), 'README 解释了「连着发消息导致重复转发」这件事')
  ok(README.includes('user/message'), 'README 写明了按 user/message 定位回合')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed > 0 ? 1 : 0)
