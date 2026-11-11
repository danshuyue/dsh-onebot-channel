/**
 * 变异测试：把「图片占位符编号 + 摘要」的关键逻辑逐个改坏，确认
 * tests/image-label-sim.mjs 会变红。
 *
 * 断言恒真的测试等于没测 —— 这个脚本就是用来证明它不是恒真的。
 *
 * 跑法：node tests/image-label-mutation.mjs
 *
 * 变异清单针对的是四条不变量（每条都在实现过程中被踩坏过一次）：
 *   1. 编号钉在段对象上，不依赖渲染顺序；
 *   2. 同一张图重复出现要编多个号（不能按 url 去重）；
 *   3. 下载失败不占号，且必须明说「未取到」；
 *   4. 通用 summary（[图片]/[动画表情]）不进占位符。
 *
 * ⚠️ 为什么不在原地改 lib/：
 *   本机插件目录的 ACL 断过继承，低完整性令牌（普通 shell）**改不了**里面的文件，
 *   只会 EPERM。所以这里把整个 lib/ 复制到仓库外的临时目录，在副本上做变异，
 *   然后把 image-label-sim 指到副本上跑 —— 源码零风险。
 *
 * ⚠️ 为什么不能用 stdio: 'pipe'：
 *   受限环境下子进程管道会以 EPERM 失败，error.stdout 是空的 —— 于是「变异后
 *   测试挂了」会被误读成「抓到了」，其实测试压根没跑起来。必须把输出重定向到
 *   文件再读（维护索引 §4 坑 28）。
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, copyFileSync, openSync, closeSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/** 变异目标文件 → 原文（源始终从真仓库读，沙箱只是副本） */
const ORIGINALS = {
  'images.js': readFileSync(join(ROOT, 'lib', 'images.js'), 'utf8'),
  'onebot.js': readFileSync(join(ROOT, 'lib', 'onebot.js'), 'utf8')
}

// 沙箱放仓库外：插件目录里建新文件会 EPERM
const SANDBOX = join(ROOT, '..', `.tmp-img-label-mutation-${process.pid}`)
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
  writeFileSync(
    join(SANDBOX_TESTS, 'image-label-sim.mjs'),
    readFileSync(join(HERE, 'image-label-sim.mjs'), 'utf8'),
    'utf8'
  )
}

function cleanup() {
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch {}
}
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(130) })

/**
 * 每条变异都要**明确指向一条被 image-label-sim 覆盖的行为**。
 * from 里保留足够上下文，避免改到同名的另一处。
 */
const MUTATIONS = [
  {
    name: '编号不钉段对象，只按 url 排队（渲染顺序一反就串号）',
    file: 'images.js',
    from: '      if (seg.segment !== undefined && seg.segment !== null) tracker.segSerials.set(seg.segment, tracker.next)\n',
    to: ''
  },
  {
    name: '按 url 去重：同一张图出现两次只编一个号',
    file: 'images.js',
    from: '      if (!tracker.resolved.has(seg.url)) continue\n      const list = tracker.serials.get(seg.url) ?? []',
    to: '      if (!tracker.resolved.has(seg.url)) continue\n      if (tracker.serials.has(seg.url)) continue\n      const list = tracker.serials.get(seg.url) ?? []'
  },
  {
    name: '下载失败的图也吃号（后面的编号整体前移）',
    file: 'images.js',
    from: '      if (!tracker.resolved.has(seg.url)) continue\n      const list = tracker.serials.get(seg.url) ?? []',
    to: '      const list = tracker.serials.get(seg.url) ?? []'
  },
  {
    name: '失败图不标「未取到」（模型以为图就在里面）',
    file: 'images.js',
    from: '    if (tracker.failed.has(url)) return imagePlaceholder(segment, { missing: true })',
    to: '    if (tracker.failed.has(url)) return imagePlaceholder(segment)'
  },
  {
    name: '通用 summary 也当语义（[动画表情] 被塞进占位符）',
    file: 'onebot.js',
    from: "  if (GENERIC_IMAGE_SUMMARIES.has(inner)) return ''",
    to: "  if (false) return ''"
  },
  {
    name: 'label 返回空串时吞掉整段（判空逻辑会误判成「没内容」）',
    file: 'onebot.js',
    from: "        if (typeof labeled === 'string' && labeled !== '') return labeled",
    to: "        if (typeof labeled === 'string') return labeled"
  },
  {
    name: '摘要不剥方括号（渲染成 [图片1·[一锅白米饭]]）',
    file: 'onebot.js',
    from: "  const inner = raw.replace(/^\\[/, '').replace(/\\]$/, '').trim()",
    to: '  const inner = raw.trim()'
  }
]

/** 跑一次 sim，返回断言的失败条数与汇总行（不用管道） */
function runSim() {
  const log = join(SANDBOX, 'out.log')
  let fd
  try {
    fd = openSync(log, 'w')
    execFileSync(process.execPath, [join(SANDBOX_TESTS, 'image-label-sim.mjs')], {
      stdio: ['ignore', fd, fd],
      cwd: SANDBOX
    })
    return { ok: true, out: readFileSync(log, 'utf8') }
  } catch {
    let out = ''
    try { out = readFileSync(log, 'utf8') } catch {}
    return { ok: false, out }
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch {}
  }
}

prepareSandbox()

console.log('先确认原始代码是绿的…')
const baseline = runSim()
const baselineFails = (baseline.out.match(/^ {2}✗ /gm) ?? []).length
const baselineSummary = (baseline.out.match(/^\d+ 过 \/ \d+ 败$/m) ?? [''])[0]
if (!baseline.ok || baselineFails > 0) {
  console.error('  ✗ 原始代码就是红的（或在沙箱里跑不起来），变异测试没意义')
  console.error(`    ${baselineSummary || baseline.out.split('\n').slice(-3).join(' | ')}`)
  cleanup()
  process.exit(1)
}
console.log(`  ✓ 原始代码全过（${baselineSummary}）\n`)

let caught = 0
const missed = []
for (const mutation of MUTATIONS) {
  const original = ORIGINALS[mutation.file]
  if (!original.includes(mutation.from)) {
    console.log(`  ? 「${mutation.name}」变异点没找到（源码改过了？）`)
    missed.push(`${mutation.name}（变异点缺失）`)
    continue
  }
  writeFileSync(join(SANDBOX_LIB, mutation.file), original.replace(mutation.from, mutation.to), 'utf8')
  const result = runSim()
  writeFileSync(join(SANDBOX_LIB, mutation.file), original, 'utf8')

  const fails = (result.out.match(/^ {2}✗ /gm) ?? []).length
  const summary = (result.out.match(/^\d+ 过 \/ \d+ 败$/m) ?? [''])[0]
  if (fails > 0) {
    console.log(`  ✓ 抓到「${mutation.name}」—— ${fails} 条断言变红（${summary}）`)
    caught += 1
  } else if (!result.ok) {
    // 进程挂了但没有任何断言失败 = 断言可能根本没跑到，不能算抓到
    console.log(`  ? 「${mutation.name}」进程异常退出但没有断言失败，无法判定`)
    missed.push(`${mutation.name}（异常退出，无法判定）`)
  } else {
    console.log(`  ✗ 漏掉「${mutation.name}」—— 改坏了测试还是绿的`)
    missed.push(mutation.name)
  }
}

cleanup()
console.log(`\n变异测试：${caught}/${MUTATIONS.length} 被抓到`)
if (caught !== MUTATIONS.length) process.exitCode = 1
