/**
 * 变异测试：把 forward.js 的关键逻辑逐个改坏，确认 forward-sim 会变红。
 * 断言恒真的测试等于没测 —— 这个脚本就是用来证明它不是恒真的。
 *
 * 跑法：node tests/forward-mutation.mjs
 *
 * ⚠️ 为什么不直接改 lib/forward.js：
 *   本机插件目录的 ACL 断过继承，低完整性令牌（普通 shell）**改不了**里面的文件，
 *   只会 EPERM。所以这里把整个 lib/ 复制到仓库外的临时目录，
 *   在副本上做变异，然后把 forward-sim 指到副本上跑。
 *   好处：源码零风险（哪怕脚本崩了也不会留下半改的文件）。
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, copyFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const ORIGINAL_FORWARD = readFileSync(join(ROOT, 'lib', 'forward.js'), 'utf8')

// 沙箱放仓库外：插件目录里建新文件会 EPERM
const SANDBOX = join(ROOT, '..', `.tmp-mutation-${process.pid}`)
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
  // package.json（env.js 可能要读版本）
  try {
    copyFileSync(join(ROOT, 'package.json'), join(SANDBOX, 'package.json'))
  } catch {}
  // 测试脚本也拷进去（它们用 ../lib 相对路径）
  writeFileSync(join(SANDBOX_TESTS, 'forward-sim.mjs'), readFileSync(join(HERE, 'forward-sim.mjs'), 'utf8'), 'utf8')
}

function cleanup() {
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch {}
}
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(130) })

/** 每次变异：描述 + 把源码里某段换成坏的 */
const MUTATIONS = [
  {
    name: '开关失效：永远当成开启',
    from: "    enabled: pick('forwardExpandEnabled') !== false,",
    to: '    enabled: true,'
  },
  {
    name: '渲染永远走占位（等于没展开）',
    from: '      return renderForward(hit.messages, depth, c, ind, forwards)',
    to: "      return '[转发消息]'"
  },
  {
    name: '嵌套深度算两次（内层永远超限）',
    from: '      return renderForward(hit.messages, depth, c, ind, forwards)',
    to: '      return renderForward(hit.messages, depth + 1, c, ind, forwards)'
  },
  {
    name: '不递归预取（内层取不到）',
    from: '        await prefetchInto(out, item.message, depth + 1, config, budget)',
    to: '        void 0'
  },
  {
    name: '截断不明说（静默丢内容）',
    from: "    ? `，还有 ${droppedCount} 条未展开`",
    to: "    ? ''"
  },
  {
    name: '条数上限失效',
    from: '    if (used >= c.maxMessages) break',
    to: '    if (false) break'
  },
  {
    name: '失败也当成功（空卡片当内容）',
    from: '      if (hit === undefined || hit.ok !== true) {',
    to: '      if (hit === undefined) {'
  },
  {
    name: '缓存失效（每次都请求）',
    from: '  const hit = CACHE.get(id)',
    to: '  const hit = undefined'
  },
  {
    name: '单条超长不截断（字数上限形同虚设）',
    from: '    if (chars === 0 && line.length > c.maxChars) {',
    to: '    if (false) {'
  },
  {
    // 审核发现的退化：renderSegments 自己复制一套段渲染、漏掉 face/mface，
    // 会让「一批里有卡片」时整批表情退化。这条变异模拟「自己写 switch」。
    name: '段渲染不走公共函数（表情退化）',
    from: '      if (segment?.type !== \'forward\') return segmentToText(segment)',
    to: '      if (segment?.type !== \'forward\') return String(segment?.data?.text ?? (segment?.type === \'text\' ? \'\' : `[${segment?.type}]`))'
  },
  {
    // 审核发现：并发数被当成「最多展开几张」，多出来的卡片被永久丢掉。
    name: '并发数当总数上限（丢弃多余卡片）',
    from: '    const batch = ids.slice(i, i + Math.min(config.concurrency, left))',
    to: '    const batch = ids.slice(i, i + Math.min(config.concurrency, left))\n    if (i > 0) break'
  },
  {
    // 审核指出：预取抛错会穿透到 pollGroup 的 catch，而游标已前进 → 整条 @ 消息永久丢。
    name: '预取异常穿透（丢整条消息）',
    from: '  try {\n    await prefetchInto(out, message, startDepth, config, budget)\n  } catch (error) {',
    to: '  if (true) {\n    await prefetchInto(out, message, startDepth, config, budget)\n  }\n  if (false) {'
  },
  {
    // 审核指出：不正的 getter 能让渲染抛错，同样会丢消息。
    name: '渲染不兜畸形数据',
    from: '  try {\n    body = renderSegments(item?.message, depth + 1, config, indent, forwards)\n  } catch (error) {',
    to: '  if (true) {\n    body = renderSegments(item?.message, depth + 1, config, indent, forwards)\n  }\n  if (false) {'
  },
  {
    // 审核指出：抓取不受渲染上限约束，depth 大时请求数失控会拖停投递链。
    name: '预算闸失效（请求数失控）',
    from: '    const left = Math.max(0, Math.floor(budget.left))',
    to: '    const left = Number.MAX_SAFE_INTEGER'
  }
]

function runSim() {
  try {
    execFileSync(process.execPath, [join(SANDBOX_TESTS, 'forward-sim.mjs')], {
      stdio: 'pipe',
      encoding: 'utf8',
      cwd: SANDBOX
    })
    return { failed: 0 }
  } catch (error) {
    const output = String(error.stdout ?? '') + String(error.stderr ?? '')
    const failed = (output.match(/✗/g) ?? []).length
    return { failed: failed === 0 ? 1 : failed }
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
  if (!ORIGINAL_FORWARD.includes(m.from)) {
    console.log(`  ? 「${m.name}」变异点没找到（源码改过了？）`)
    missed.push(`${m.name}（变异点缺失）`)
    continue
  }
  const mutated = ORIGINAL_FORWARD.replace(m.from, m.to)
  writeFileSync(join(SANDBOX_LIB, 'forward.js'), mutated, 'utf8')
  const result = runSim()
  if (result.failed > 0) {
    console.log(`  ✓ 抓到「${m.name}」—— ${result.failed} 条断言变红`)
    caught += 1
  } else {
    console.log(`  ✗ 漏掉「${m.name}」—— 改坏了测试还是绿的`)
    missed.push(m.name)
  }
  // 还原沙箱里的 forward.js，再跑下一个变异
  writeFileSync(join(SANDBOX_LIB, 'forward.js'), ORIGINAL_FORWARD, 'utf8')
}

cleanup()
console.log(`\n变异测试：${caught}/${MUTATIONS.length} 被抓到`)
if (missed.length > 0) {
  console.log('漏掉的变异：')
  for (const name of missed) console.log('  - ' + name)
}
process.exit(missed.length === 0 ? 0 : 1)
