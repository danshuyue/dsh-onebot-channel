/**
 * progress-mutation.mjs —— 变异验证：把实现改坏，确认 progress-sim 真的会红。
 *
 * 为什么必须有（docs 踩坑 §27）：
 *   一条断言如果「删掉实现照样绿」，它就什么都没测到。
 *   这里对 progress.js 逐个注入小破坏，跑一遍 progress-sim，期望它**变红**。
 *   哪个变异没被抓住，就说明对应的断言是假的。
 *
 * ⚠️ 每个变异都在临时副本上做，**绝不改工作区里的源文件**。
 *   做法：把整个 lib/ + tests/ 复制到临时目录，改副本，在副本里跑。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')

/** 挑一个可写的临时根（沙箱下 os.tmpdir 有时只读）。 */
function pickRoot() {
  for (const root of [join(tmpdir(), `qq-mutation-${process.pid}`), join(PLUGIN, '..', '.tmp-test', `mutation-${process.pid}`)]) {
    try {
      mkdirSync(root, { recursive: true })
      return root
    } catch {
      /* 换下一个 */
    }
  }
  throw new Error('找不到可写的临时目录')
}

const ROOT = pickRoot()

/** 变异清单：文件、原片段、替换片段、说明。 */
const MUTATIONS = [
  {
    name: '僵尸判定：去掉新鲜度检查',
    file: 'lib/progress.js',
    from: '  if (fresh) return \'running\'',
    to: '  if (true) return \'running\'',
    expectRed: '★ 有残留 pendingCalls 但 90 天没写盘 → 必须是 idle'
  },
  {
    name: '归档过滤：不过滤归档会话',
    file: 'lib/progress.js',
    from: '    if (!includeArchived && archived.has(id)) {',
    to: '    if (false && archived.has(id)) {',
    expectRed: '★ 归档会话不出现在进度列表里'
  },
  {
    name: '时间窗：不做 24h 过滤',
    file: 'lib/progress.js',
    from: '    else if (digest.lastActiveAt > 0 && now - digest.lastActiveAt <= idleWindowMs) recent.push(digest)',
    to: '    else recent.push(digest)',
    expectRed: '★ 24h 窗外的不进「最近活跃」'
  },
  {
    name: '工作区过滤：忽略 cwd',
    file: 'lib/progress.js',
    from: '    if (wantCwd !== \'\' && normCwd(cwd) !== wantCwd) continue',
    to: '    if (false) continue',
    expectRed: '★ 过滤掉别的 cwd'
  },
  {
    name: '坏文件：解析失败就抛',
    file: 'lib/progress.js',
    from: '    } catch {\n      // 正在写 / 半截 —— 跳过这一个，别连累其他会话\n      continue\n    }',
    to: '    } catch {\n      throw new Error(\'mutated: 坏文件必须炸\')\n    }',
    expectRed: '★ 一个坏掉的投影文件不会让整次读取抛错'
  },
  {
    name: '命令解析：前缀为空也当命令',
    file: 'lib/commands.js',
    from: '  if (head === \'\') return null',
    to: '  if (false) return null',
    expectRed: '★ 前缀为空 = 命令层关闭'
  },
  {
    name: '紧贴写法：不支持 /去3',
    file: 'lib/commands.js',
    from: '  if (glued !== null) return { name: glued[1].toLowerCase(), arg: glued[2] }',
    to: '  if (false) return { name: glued[1].toLowerCase(), arg: glued[2] }',
    expectRed: '★ 中文输入法常见的紧贴写法 /去3'
  },
  {
    name: '编号表：过期也放行',
    file: 'lib/commands.js',
    from: '    if (now - Number(table.at ?? 0) > TABLE_TTL_MS) return { ok: false, reason: \'expired\', max: table.entries.length }',
    to: '    if (false) return { ok: false, reason: \'expired\', max: table.entries.length }',
    expectRed: '★ 过期表查不到'
  },
  {
    name: 'todo：把 in_progress 当完成',
    file: 'lib/progress.js',
    from: '  const current = items.find((item) => item.status === \'in_progress\') ?? items.find((item) => item.status !== \'completed\')',
    to: '  const current = items.find((item) => item.status === \'completed\') ?? items.find((item) => item.status !== \'completed\')',
    expectRed: 'todo 当前那条取 in_progress'
  }
]

/** 在副本里跑 progress-sim，返回 { ok, output }。 */
function runSim(workdir) {
  const log = join(ROOT, `log-${Math.random().toString(36).slice(2)}.txt`)
  const fd = openSync(log, 'w')
  try {
    // ⚠️ stdio 用文件重定向而不是 'pipe'：受限环境下管道会 EPERM，
    //   连 stdout 都读不到（现象是「全都说绿」或「全都说红」而其实一个字节都没读到）。
    execFileSync(process.execPath, [join(workdir, 'tests', 'progress-sim.mjs')], {
      cwd: workdir,
      stdio: ['ignore', fd, fd],
      env: {
        ...process.env,
        // 隔离 HOME：测试自己会在 $HOME/.dsh 下造假数据
        HOME: join(ROOT, 'home'),
        USERPROFILE: join(ROOT, 'home'),
        TMPDIR: join(ROOT, 'home'),
        TEMP: join(ROOT, 'home'),
        TMP: join(ROOT, 'home')
      }
    })
    return { ok: true, output: '' }
  } catch (error) {
    let output = ''
    try {
      output = readFileSync(log, 'utf8')
    } catch {
      output = `（读不到输出：${error instanceof Error ? error.message : error}）`
    }
    return { ok: false, output }
  } finally {
    try {
      closeSync(fd)
    } catch {}
  }
}

/** 把插件复制一份到临时目录（只带跑测试需要的部分）。 */
function prepareCopy(tag) {
  const dir = join(ROOT, `copy-${tag}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  cpSync(join(PLUGIN, 'lib'), join(dir, 'lib'), { recursive: true })
  cpSync(join(PLUGIN, 'tests', 'progress-sim.mjs'), join(dir, 'tests', 'progress-sim.mjs'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'mutation-copy', type: 'module' }), 'utf8')
  return dir
}

let pass = 0
let fail = 0
const problems = []

try {
  mkdirSync(join(ROOT, 'home', '.dsh'), { recursive: true })

  // ---- 基线：未变异时必须绿 ----
  console.log('基线检查（未变异，应当绿）…')
  const baseDir = prepareCopy('base')
  const base = runSim(baseDir)
  if (base.ok) {
    pass += 1
    console.log('  ✓ 基线绿')
  } else {
    fail += 1
    problems.push('基线就是红的 —— 后面所有变异都不作数')
    console.log('  ✗ 基线红：')
    console.log(base.output.split('\n').slice(-12).join('\n'))
  }

  // ---- 逐个变异 ----
  for (let i = 0; i < MUTATIONS.length; i++) {
    const m = MUTATIONS[i]
    const dir = prepareCopy(`m${i}`)
    const file = join(dir, m.file)
    const src = readFileSync(file, 'utf8')
    if (!src.includes(m.from)) {
      fail += 1
      problems.push(`${m.name}：变异点在源码里找不到（源码变了？）`)
      console.log(`  ✗ ${m.name} —— 变异点找不到`)
      continue
    }
    writeFileSync(file, src.replace(m.from, m.to), 'utf8')
    const result = runSim(dir)
    if (!result.ok) {
      // 变红了 —— 但必须确认是**因为预期的那条断言**红的
      const hit = m.expectRed === '' || result.output.includes(m.expectRed)
      if (hit) {
        pass += 1
        console.log(`  ✓ ${m.name} → 变红，且命中断言「${m.expectRed}」`)
      } else {
        fail += 1
        problems.push(`${m.name}：变红了但没命中断言「${m.expectRed}」（可能是别的断言先红，或语法崩了）`)
        console.log(`  ✗ ${m.name} → 变红但没命中预期断言`)
        console.log(result.output.split('\n').filter((l) => l.includes('✗')).slice(0, 5).join('\n'))
      }
    } else {
      fail += 1
      problems.push(`${m.name}：改坏了却仍然绿 —— 断言无效`)
      console.log(`  ✗ ${m.name} → 仍然绿（这条断言没在测它）`)
    }
    rmSync(dir, { recursive: true, force: true })
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true })
}

console.log(`\nprogress-mutation: ${pass} 过 / ${fail} 败`)
if (fail > 0) {
  console.log('问题：')
  for (const p of problems) console.log('  -', p)
  process.exit(1)
}
