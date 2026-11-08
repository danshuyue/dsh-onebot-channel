/**
 * group-self-context-sim 的变异验证（2026-11-09）。
 *
 * 要防的假绿：断言写着「上下文里有她自己」「有 +15s」，
 * 但实现被改坏了测试照样绿。本项目在这一点上踩过两次
 * （docs/维护索引.md §4 坑 27、29），所以每条断言都要能被变异抓住。
 *
 * 五个变异：
 *   M1 stampOf 退回「只到分钟」           → 「正文里有 时:分:秒」变红
 *   M2 gapOf 永远返回空串                 → 「+15s / +1s / +39s」变红
 *   M3 nameOfSender 删掉「你自己」分支    → 「标成『你自己』」变红
 *   M4 fetchGroupHistory 恢复过滤自己     → 「她的原话带进来」变红（数据源就丢了）
 *   M5 删掉 identityNote 里「你自己」解释 → 「身份提示里解释了」变红
 *
 * ⚠️ 每个变异用独立沙箱；子进程输出走文件重定向（管道在本机会 EPERM）。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')
const TEST = 'tests/group-self-context-sim.mjs'

function pickTmp() {
  for (const base of [join(PLUGIN, '..', '.tmp-mutation'), tmpdir()]) {
    try { mkdirSync(base, { recursive: true }); return base } catch { /* 下一个 */ }
  }
  throw new Error('找不到可写的临时目录')
}
const TMP = pickTmp()

function mutate(file, from, to) {
  const source = readFileSync(file, 'utf8')
  if (!source.includes(from)) throw new Error(`变异没命中：${file}\n---\n${from}\n---`)
  writeFileSync(file, source.replace(from, to), 'utf8')
  return () => writeFileSync(file, source, 'utf8')
}

function run(logFile) {
  const fd = openSync(logFile, 'w')
  try {
    execFileSync(process.execPath, [TEST], {
      cwd: PLUGIN, stdio: ['ignore', fd, fd], timeout: 120000, env: { ...process.env }
    })
    return { ok: true, output: readFileSync(logFile, 'utf8') }
  } catch {
    let output = ''
    try { output = readFileSync(logFile, 'utf8') } catch { /* 空 */ }
    return { ok: false, output }
  } finally {
    closeSync(fd)
  }
}

const pollFile = join(PLUGIN, 'lib', 'poll.js')
const MUTATIONS = [
  {
    id: 'M1',
    label: 'stampOf 退回只到分钟',
    expect: '正文里有「时:分:秒」',
    file: pollFile,
    from: '${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}',
    to: '${pad(at.getHours())}:${pad(at.getMinutes())}'
  },
  {
    id: 'M2',
    label: 'gapOf 永远返回空串',
    expect: '15 秒的间隔写成 +15s',
    file: pollFile,
    from: '  const ms = now - prev',
    to: '  return \'\'; const ms = now - prev'
  },
  {
    id: 'M3',
    label: 'nameOfSender 删掉「你自己」分支',
    expect: '她自己发的话出现在上下文里',
    file: pollFile,
    from: '    if (String(config.selfUin ?? \'\') !== \'\' && uin === String(config.selfUin)) return \'你自己\'',
    to: ''
  },
  {
    id: 'M4',
    label: 'fetchGroupHistory 恢复「过滤自己」',
    expect: '她自己那句的原话真的带进来了',
    file: pollFile,
    from: '      return result.data?.messages ?? []\n    } catch (error) {\n      // 连接类错误往上抛',
    to: '      return (result.data?.messages ?? []).filter((m) => String(m?.sender?.user_id) !== String(getConfig().selfUin))\n    } catch (error) {\n      // 连接类错误往上抛'
  },
  {
    id: 'M5',
    label: '删掉身份提示里「你自己」那段解释',
    expect: '身份提示里解释了「你自己」是什么',
    file: pollFile,
    from: '  if (contextHas(\'你自己\')) {',
    to: '  if (false) {'
  }
]

const results = []
for (const item of MUTATIONS) {
  const sandbox = join(TMP, `mut-self-${item.id}-${process.pid}`)
  mkdirSync(sandbox, { recursive: true })
  const logFile = join(sandbox, 'out.log')
  let restore
  try {
    restore = mutate(item.file, item.from, item.to)
  } catch (error) {
    results.push({ ...item, caught: false, reason: `变异构造失败：${error.message}` })
    rmSync(sandbox, { recursive: true, force: true })
    continue
  }
  const outcome = run(logFile)
  restore()
  rmSync(sandbox, { recursive: true, force: true })
  const caught = outcome.ok === false && outcome.output.includes(item.expect)
  results.push({ ...item, caught, reason: caught ? '已变红' : (outcome.ok ? '仍然全绿（假测试！）' : `红了但不是预期那条（找「${item.expect}」）`) })
}

const baselineLog = join(TMP, `baseline-self-${process.pid}.log`)
const baseline = run(baselineLog)
try { rmSync(baselineLog, { force: true }) } catch { /* 忽略 */ }

console.log('=== 基线 ===')
console.log(baseline.ok ? '  ✓ 原样运行全绿' : '  ✗ 原样运行就是红的')
console.log('')
console.log('=== 变异结果 ===')
let missed = 0
for (const item of results) {
  if (!item.caught) missed += 1
  console.log(`  ${item.caught ? '✓' : '✗'} ${item.id} ${item.label}`)
  console.log(`      期望抓住：${item.expect}`)
  console.log(`      结果：${item.reason}`)
}
console.log('')
if (!baseline.ok || missed > 0) {
  console.error(`✗ 基线 ${baseline.ok ? '绿' : '红'}，${missed} 个变异漏网`)
  process.exit(1)
}
console.log(`✓ ${results.length} 个变异全部被抓住，基线绿`)
process.exit(0)
