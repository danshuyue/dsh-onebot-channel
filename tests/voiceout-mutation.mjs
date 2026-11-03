/**
 * voiceout-mutation.mjs —— 证明 voiceout-sim 不是恒真的（维护索引 §4 坑 27）。
 *
 * 把 voiceout.js / tool.js 的关键逻辑逐个改坏，看 voiceout-sim 抓不抓得住。
 *
 * 跑法：node tests/voiceout-mutation.mjs
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
  'voiceout.js': readFileSync(join(ROOT, 'lib', 'voiceout.js'), 'utf8'),
  'tool.js': readFileSync(join(ROOT, 'lib', 'tool.js'), 'utf8')
}

const SANDBOX = join(ROOT, '..', `.tmp-voiceout-mutation-${process.pid}`)
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
  writeFileSync(join(SANDBOX_TESTS, 'voiceout-sim.mjs'), readFileSync(join(HERE, 'voiceout-sim.mjs'), 'utf8'), 'utf8')
}

function cleanup() {
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch {}
}
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(130) })

const MUTATIONS = [
  {
    // 核心：一旦把两步合成一步，就拿不到 file_path（实测协议端只回 chunk_received）
    name: '两步上传合并成一步',
    file: 'voiceout.js',
    from: "  try {\n    const done = await callOneBot({\n      action: 'upload_file_stream',\n      params: { stream_id: streamId, is_complete: true },",
    to: "  try {\n    const done = await callOneBot({\n      action: 'upload_file_stream',\n      params: { stream_id: streamId, is_complete: false },"
  },
  {
    // 本地路径直接填进 record 段 → 跨机器 ENOENT（这次踩到的真问题）
    name: '用本地路径而不是协议端返回的路径',
    file: 'voiceout.js',
    from: '  const uploaded = await uploadVoiceFile(filePath)\n  if (uploaded.ok !== true) throw new Error(uploaded.error)',
    to: '  const uploaded = { ok: true, filePath: filePath }\n  if (uploaded.ok !== true) throw new Error(uploaded.error)'
  },
  {
    // 不校验扩展名 → 文本文件也会被当语音传上去，浪费一次上传还发不出去
    name: '不校验音频扩展名',
    file: 'voiceout.js',
    from: "  if (!looksLikeAudio(raw)) {",
    to: "  if (false) {"
  },
  {
    // 空文件照样传 → 协议端转码失败，报一个看不懂的错
    name: '不拦空文件',
    file: 'voiceout.js',
    from: "    if (info.size === 0) return { ok: false, error: `文件是空的：${raw}` }",
    to: '    void 0'
  },
  {
    // 第 1 步失败还继续走第 2 步 → 浪费一次请求，错误信息也会变成第 2 步的
    name: '第 1 步失败继续走第 2 步',
    file: 'voiceout.js',
    from: "      note('voiceout', `上传第 1 步失败：retcode=${first?.retcode ?? '?'} ${why}`)\n      return { ok: false, error: why === '' ? `上传失败（retcode=${first?.retcode ?? '?'}）` : why }",
    to: "      void why"
  },
  {
    // 发失败当成功 → 模型以为发出去了（本仓库最典型的事故形态）
    name: '发送失败当成功',
    file: 'voiceout.js',
    from: "  if (result?.retcode !== 0) {\n    throw new Error(`语音没发出去",
    to: "  if (false) {\n    throw new Error(`语音没发出去"
  },
  {
    // 群发到私聊接口（或反之）→ 白名单字段对不上
    name: '群聊走私聊接口',
    file: 'voiceout.js',
    from: "    action: isGroup ? 'send_group_msg' : 'send_private_msg',\n    params: isGroup",
    to: "    action: 'send_private_msg',\n    params: isGroup"
  },
  {
    // 只给 voice、不给 text 时，qq_send 应该照样能发（不能因为「空内容」提前抛）
    name: '只发语音时被「空内容」拦住',
    file: 'tool.js',
    from: "          const hasTextPart = text.trim() !== '' || segments.length > 0 || faceSegment !== null || customEmojiId !== ''",
    to: "          const hasTextPart = true"
  },
  {
    // voice_sent 不写进 schema → 宿主 additionalProperties:false 判成 ToolOutputError
    name: 'voice_sent 没进 output schema',
    file: 'tool.js',
    from: "              // 发了语音时为 true（不声明同样会被判 ToolOutputError）\n              voice_sent: { type: 'boolean' }",
    to: "              voice_sent_typo: { type: 'boolean' }"
  }
]

function runSim() {
  const log = join(SANDBOX, 'out.log')
  let fd
  try {
    fd = openSync(log, 'w')
    execFileSync(process.execPath, [join(SANDBOX_TESTS, 'voiceout-sim.mjs')], {
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
