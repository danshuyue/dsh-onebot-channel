/**
 * 常驻系统段落测试：node tests/prompt-section-sim.mjs，退出码 0 = 全过。
 *
 * 钉住「要干活时先出一声」这条纪律怎么挂上去（2026-11-03 用户要求），
 * 以及它**不能**挂错的方式。三个真实会出事的地方：
 *
 *   1. `interpolate` 必须显式 false —— 宿主的系统段落默认会做 `{{变量}}` 插值，
 *      正文里万一出现 `{{…}}` 就抛错，而它抛在**提示词组装路径**上，
 *      等于每个回合都开不了口。这条最贵，必须钉死。
 *   2. `order` 必须是有限数 —— `systemPrompt.section()` 直接 `Number.isFinite` 校验，
 *      不合法会抛（注册失败 → 提示静默缺席）。
 *   3. 拿不到 `systemPrompt` 服务时**只少这一段提示**，绝不能抛出去带崩插件加载。
 *
 * 另外钉住文案的取向：必须限定「带 QQ 前缀的消息」，且必须明说
 * 「普通对话别这么做」—— 否则每个会话都会被教成「稍等我看看」复读机。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const prompt = await import(pathToFileURL(join(PLUGIN, 'lib', 'prompt.js')).href)

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.error(`  ✗ ${name}`) }
}

// ---- 文案本身 ----
const TEXT = prompt.LONG_TASK_SECTION_TEXT
ok(typeof TEXT === 'string' && TEXT.length > 0, '有正文')
ok(TEXT.includes('qq_send'), '告诉她用 qq_send 先出声')
ok(/长|作业|工具|文件|命令/.test(TEXT), '界定了「什么算长任务」')
ok(TEXT.includes('别') || TEXT.includes('不'), '明说了普通对话不要这么做')
ok(TEXT.includes('QQ'), '限定了只管 QQ 来的消息（这条段落对所有会话可见）')
// 段落会进每一次请求，必须短
ok(TEXT.length < 700, `正文够短，不会每回合烧太多 token（${TEXT.length} 字）`)

// ---- 注册形状 ----
{
  const captured = []
  const fakeCtx = {
    get: () => ({ section: (value) => { captured.push(value); return () => {} } })
  }
  const mounted = prompt.mountPromptSection(fakeCtx)
  ok(mounted === true, '服务可用时报告挂载成功')
  ok(captured.length === 1, `只注册一次（实际 ${captured.length}）`)
  const section = captured[0] ?? {}
  ok(section.name === prompt.PROMPT_SECTION_NAME, '段落名一致')
  ok(section.name.startsWith('qq-'), '段落名带插件前缀，不跟宿主的 harness:/deployment: 撞名')
  // ⚠️ 这条是最贵的：默认插值会让正文里的 {{…}} 在组装时抛错
  ok(section.interpolate === false, '显式 interpolate:false（否则 {{}} 会让提示词组装抛错）')
  ok(Number.isFinite(section.order), 'order 是有限数（宿主会直接校验）')
  ok(section.order > 10000, '排在宿主 TOOL_* 段落之后')
  ok(section.order < 10200, '排在部署人设收尾之前（人设保留最后一句话）')
  ok(section.text === TEXT, '注册的正文就是那段纪律')
}

// ---- 拿不到服务时：只少一段提示，不抛 ----
{
  let threw = ''
  let result = null
  try {
    // 既没有 systemPrompt，也没有 ctx.inject —— 最老实的降级路径
    result = prompt.mountPromptSection({})
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  ok(threw === '', `没有服务时不抛（实际：${threw || '无'}）`)
  ok(result === false, '如实报告「没挂上」')
}

// ---- 有 inject 但没有服务：走 inject 分支，仍然不抛 ----
{
  let injected = false
  let threw = ''
  let result = null
  try {
    result = prompt.mountPromptSection({
      inject: (deps, callback) => {
        injected = Array.isArray(deps) && deps.includes('systemPrompt')
        // 模拟「服务迟迟不来」：回调立刻收到一个同样取不到服务的子 ctx
        callback({ get: () => undefined })
      }
    })
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  ok(threw === '', `inject 分支不抛（实际：${threw || '无'}）`)
  ok(injected, '声明了要注入 systemPrompt')
  ok(result === true, '走 inject 时先报告已安排（服务来了才真注册）')
}

// ---- 服务的 section() 自己抛错：也吞掉，不影响别的 ----
{
  let threw = ''
  let result = null
  try {
    result = prompt.mountPromptSection({
      get: () => ({ section: () => { throw new Error('宿主内部炸了') } }),
      inject: () => {}
    })
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error)
  }
  ok(threw === '', `section() 抛错时不外泄（实际：${threw || '无'}）`)
  ok(result === true, '直取失败后仍交给 inject 再试一次')
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exit(1)
console.log('prompt-section-sim: all assertions passed')
process.exit(0)
