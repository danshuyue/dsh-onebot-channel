/** 只在临时副本证伪：不能原地改坏生产源码再恢复。 */
import assert from 'node:assert/strict'
import { mkdirSync, cpSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { spawnSync, execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, '.tmp-test', `breeze-proof-${process.pid}`)
mkdirSync(out, { recursive: true })
const cases = [
  { name: 'baseline', expected: null },
  { name: 'old-no-dispatcher', file: 'lib/tts.js', from: '...(route.dispatcher ? { dispatcher: route.dispatcher } : {})', to: '', expected: 'TTS POST 实际传入专用代理 dispatcher' },
  { name: 'old-message-only', file: 'lib/breeze-net.js', from: '  walk(error)', to: "  errors.push({ name: 'TypeError', code: '' })", expected: '保留嵌套连接超时错误码' },
  { name: 'old-404-substring', file: 'lib/tts.js', from: 'if (result.status === 404)', to: "if (String(result.error).includes('404'))", expected: '错误码或请求 ID 含 404 不得伪装成 HTTP 404' },
  { name: 'premature-agent-close', file: 'lib/breeze-net.js', from: 'return { source: settings.source, dispatcher: new EnvHttpProxyAgent(settings) }', to: 'const dispatcher = new EnvHttpProxyAgent(settings); await dispatcher.close(); return { source: settings.source, dispatcher }', expected: '并发请求独立拥有 Agent，不互相关闭' },
  { name: 'http-body-timeout-hides-status', file: 'lib/tts.js', from: "    if (!response.ok) return { ok: false, status: response.status, error: describeBreezeError(response.status, '') }", to: '', expected: 'HTTP 401 的 body 超时不能覆盖状态或触发重试' }
]
const verdicts = []
for (const item of cases) {
  const dir = join(out, item.name)
  mkdirSync(dir, { recursive: true })
  // 副本置于项目 .tmp-test 内，依赖沿父目录查找，避免复制/硬链真实依赖目录。
  for (const sub of ['lib', 'tests']) cpSync(join(root, sub), join(dir, sub), { recursive: true })
  cpSync(join(root, 'package.json'), join(dir, 'package.json'))
  if (item.file) {
    const path = join(dir, item.file)
    const source = readFileSync(path, 'utf8')
    assert.ok(source.includes(item.from), `${item.name}: 必须命中变异锚点`)
    writeFileSync(path, source.split(item.from).join(item.to), 'utf8')
  }
  const log = join(dir, 'result.log')
  const fd = openSync(log, 'w')
  let run
  try { run = spawnSync(process.execPath, ['tests/breeze-network-sim.mjs'], { cwd: dir, stdio: ['ignore', fd, fd], timeout: 30000 }) }
  finally { closeSync(fd) }
  const text = readFileSync(log, 'utf8')
  const good = item.expected ? run.status === 1 && text.includes(`AssertionError [ERR_ASSERTION]: ${item.expected}`) : run.status === 0
  assert.ok(good, `${item.name} 未得到预期结果: ${run.error?.message ?? ''}\n${text}`)
  verdicts.push({ name: item.name, status: run.status, expected: item.expected, matched: true })
  console.log(`✓ ${item.name}: ${item.expected ? '旧行为被目标断言证伪' : '基线全绿'}`)
}
// 诊断包装恢复提交树旧实现，同样只在副本运行。
const dir = join(out, 'old-diag')
mkdirSync(dir, { recursive: true })
for (const sub of ['lib', 'tests']) cpSync(join(root, sub), join(dir, sub), { recursive: true })
cpSync(join(root, 'package.json'), join(dir, 'package.json'))
for (const file of ['lib/env.js', 'lib/diaglog.js']) {
  const fd = openSync(join(dir, file), 'w')
  try { execFileSync('git', ['show', `c4db0d5:${file}`], { cwd: root, stdio: ['ignore', fd, 'inherit'] }) }
  finally { closeSync(fd) }
}
const log = join(dir, 'result.log')
const fd = openSync(log, 'w')
let run
try { run = spawnSync(process.execPath, ['tests/run-isolated.mjs', 'tests/diag-wrap-sim.mjs'], { cwd: dir, stdio: ['ignore', fd, fd], timeout: 30000 }) }
finally { closeSync(fd) }
const text = readFileSync(log, 'utf8')
assert.equal(run.status, 1, text)
for (const label of ['different tools shells sharing one register backend record once', 'registering the same definition repeatedly does not stack execute wrappers', 'multiple env module imports do not stack wrappers']) {
  assert.ok(text.includes('✗ ' + label), text)
}
verdicts.push({ name: 'old-diag', status: run.status, matched: true })
console.log('✓ old-diag: 三种重复包装旧行为均被对应断言证伪')
writeFileSync(join(out, 'report.json'), JSON.stringify(verdicts, null, 2) + '\n')
console.log('报告：' + join(out, 'report.json'))
