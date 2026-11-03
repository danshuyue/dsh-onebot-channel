/**
 * voice-mutation.mjs —— 证明 voice-sim 不是恒真的。
 *
 * 维护索引 §4 坑 27：写完断言要把实现改坏再跑一遍，确认它变红。
 * 这里把 voice.js / tool.js 的关键逻辑逐个改坏，看 voice-sim 有没有抓到。
 *
 * 跑法：node tests/voice-mutation.mjs
 *
 * 同 forward-mutation：源码只读，变异跑在仓库外的临时副本上
 * （插件目录 ACL 断过继承，低完整性令牌改不了里面的文件）。
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, copyFileSync, openSync, closeSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const ORIGINALS = {
  'voice.js': readFileSync(join(ROOT, 'lib', 'voice.js'), 'utf8'),
  'tool.js': readFileSync(join(ROOT, 'lib', 'tool.js'), 'utf8')
}

const SANDBOX = join(ROOT, '..', `.tmp-voice-mutation-${process.pid}`)
const SANDBOX_LIB = join(SANDBOX, 'lib')
const SANDBOX_TESTS = join(SANDBOX, 'tests')

function prepareSandbox() {
  rmSync(SANDBOX, { recursive: true, force: true })
  mkdirSync(SANDBOX_LIB, { recursive: true })
  mkdirSync(SANDBOX_TESTS, { recursive: true })
  for (const file of readdirSync(join(ROOT, 'lib'))) {
    if (!file.endsWith('.js')) continue
    writeFileSync(join(SANDBOX_LIB, file), readFileSync(join(ROOT, 'lib', file), 'utf8'), 'utf8')
  }
  try {
    copyFileSync(join(ROOT, 'package.json'), join(SANDBOX, 'package.json'))
  } catch {}
  writeFileSync(join(SANDBOX_TESTS, 'voice-sim.mjs'), readFileSync(join(HERE, 'voice-sim.mjs'), 'utf8'), 'utf8')
}

function cleanup() {
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch {}
}
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(130) })

const MUTATIONS = [
  {
    // 最核心的一条：转不出来时**不许**把失败说成成功
    name: '失败当成功（retcode≠0 也算 ok）',
    file: 'voice.js',
    from: "  if (result?.retcode !== 0) {\n    const why = String(result?.wording ?? result?.message ?? '').trim()",
    to: "  if (false) {\n    const why = String(result?.wording ?? result?.message ?? '').trim()"
  },
  {
    // message_id 必须按数字发；传字符串协议端会判参数错误
    name: 'message_id 以字符串发给协议端',
    file: 'voice.js',
    from: '      params: { message_id: Number(raw) },',
    to: '      params: { message_id: raw },'
  },
  {
    // 非法 id 必须不发请求（`0` 在协议端会被当成「取最新」）
    name: '不校验 message_id（0 也照发）',
    file: 'voice.js',
    from: "  if (!isValidMessageId(raw)) return { ok: false, error: `message_id 不合法：${raw === '' ? '（空）' : raw}` }",
    to: '  void isValidMessageId'
  },
  {
    // 空文本当成功 → 模型会以为「内容是空的」，而不是「这次没转出来」
    name: '空文本当成功',
    file: 'voice.js',
    from: "  if (text === '') {",
    to: '  if (false) {'
  },
  {
    // 超时预算短于协议端内部的 20 秒 → 两边同时超时，日志分不清谁断的
    name: '超时比协议端还短',
    file: 'voice.js',
    from: 'export const VOICE_TIMEOUT_MS = 25000',
    to: 'export const VOICE_TIMEOUT_MS = 8000'
  },
  {
    // 网络抛错必须兜住，不能冒到宿主变成无上下文的 ToolError
    name: '网络错误向上抛',
    file: 'voice.js',
    from: "  } catch (error) {\n    const message = error instanceof Error ? error.message : String(error)\n    note('voice', `fetch_ptt_text 调用失败 id=${raw}：${message}`)",
    to: "  } catch (error) {\n    throw error\n    const message = ''"
  },
  {
    // 失败文案引导「重试」= 让模型反复烧 20 秒（实测转不出来就是转不出来）
    name: '失败文案引导重试',
    file: 'tool.js',
    from: "              + '别重试，直接跟他说「语音我没听清，再说一遍或者打字」。'",
    to: "              + '可以再试一次看看。'"
  },
  {
    // 参数名写错 = 模型永远填不对
    name: '工具参数名写错',
    file: 'tool.js',
    from: '          message_id: {\n            type: \'string\',\n            description: \'要转写哪条语音。',
    to: '          id: {\n            type: \'string\',\n            description: \'要转写哪条语音。'
  }
]

function runSim() {
  const log = join(SANDBOX, 'out.log')
  let fd
  try {
    fd = openSync(log, 'w')
    execFileSync(process.execPath, [join(SANDBOX_TESTS, 'voice-sim.mjs')], {
      stdio: ['ignore', fd, fd],
      cwd: SANDBOX
    })
    return { failed: 0 }
  } catch {
    let output = ''
    try { output = readFileSync(log, 'utf8') } catch { return { failed: 1 } }
    const failed = (output.match(/✗/g) ?? []).length
    return { failed: failed === 0 ? 1 : failed }
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch {}
  }
}

prepareSandbox()

console.log('先确认原始代码是绿的…')
const baseline = runSim()
if (baseline.failed !== 0) {
  console.error('原始代码就是红的（或在沙箱里跑不起来），变异测试没意义。')
  cleanup()
  process.exit(1)
}
console.log('  ✓ 原始代码全过\n')

let caught = 0
const missed = []
for (const m of MUTATIONS) {
  const original = ORIGINALS[m.file]
  if (!original.includes(m.from)) {
    console.log(`  ? 「${m.name}」变异点没找到（源码改过了？）`)
    missed.push(`${m.name}（变异点缺失）`)
    continue
  }
  writeFileSync(join(SANDBOX_LIB, m.file), original.replace(m.from, m.to), 'utf8')
  const result = runSim()
  if (result.failed > 0) {
    console.log(`  ✓ 抓到「${m.name}」—— ${result.failed} 条断言变红`)
    caught += 1
  } else {
    console.log(`  ✗ 漏掉「${m.name}」—— 改坏了测试还是绿的`)
    missed.push(m.name)
  }
  writeFileSync(join(SANDBOX_LIB, m.file), original, 'utf8')
}

cleanup()
console.log(`\n变异测试：${caught}/${MUTATIONS.length} 被抓到`)
if (missed.length > 0) {
  console.log('漏掉的变异：')
  for (const name of missed) console.log('  - ' + name)
}
process.exit(missed.length > 0 ? 1 : 0)
