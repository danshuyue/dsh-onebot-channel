/**
 * focus-mutation.mjs —— 变异验证：把 focus.js 的路由逻辑改坏，确认 focus-sim 真的会红。
 *
 * 为什么必须有（docs 踩坑 §27）：
 *   这个功能最危险的失败模式是「静默投给了错误的会话」——
 *   断言如果抓不住它，那这堆测试就只是让人安心的装饰。
 *
 * 做法和 progress-mutation.mjs 一致：把 lib/ 复制到临时目录，改副本，在副本里跑。
 * 绝不碰工作区里的源文件。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, openSync, closeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')

function pickRoot() {
  for (const root of [join(tmpdir(), `qq-focus-mut-${process.pid}`), join(PLUGIN, '..', '.tmp-test', `focus-mut-${process.pid}`)]) {
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

const MUTATIONS = [
  {
    name: '兜底：没有绑定时回落到「最近会话」',
    file: 'lib/focus.js',
    from: '  // ④ 都没有 —— 不猜。\n  return { sessionId: \'\', via: \'none\' }',
    to: '  // ④ 都没有 —— 不猜。\n  return { sessionId: \'session-nearest-guess\', via: \'default\' }',
    expectRed: '★★ 没有默认绑定时返回空（绝不兜底到最近会话）'
  },
  {
    name: '优先级：焦点盖过引用',
    file: 'lib/focus.js',
    from: '  const quoted = sessionOfSent(replyToId, now)\n  if (quoted !== null && quoted.targetKey === targetKey) {',
    to: '  const quoted = sessionOfSent(replyToId, now)\n  if (false && quoted !== null && quoted.targetKey === targetKey) {',
    expectRed: '★ 引用优先于焦点（用户亲手点的最明确）'
  },
  {
    name: '跨 target：引用别的号的消息也照搬',
    file: 'lib/focus.js',
    from: '  if (quoted !== null && quoted.targetKey === targetKey) {',
    to: '  if (quoted !== null) {',
    expectRed: '★★ 引用别的 target 的消息时不跨 target 搬运（回落到焦点）'
  },
  {
    name: '焦点寿命：永不过期',
    file: 'lib/focus.js',
    from: '  if (Number.isFinite(idleMs) && idleMs > 0 && now - Number(entry.at ?? 0) > idleMs) {',
    to: '  if (false) {',
    expectRed: '★★ 焦点闲置超过 focusIdleResetMs 自动回默认（跨天不串台）'
  },
  {
    name: '归档：焦点指向归档会话也不清',
    file: 'lib/focus.js',
    from: '  if (isArchived(sessionId)) {\n    note(\'focus\', `焦点 ${key} 指向的 ${sessionId} 已归档，清掉焦点`)\n    clearFocus(key)\n    return null\n  }',
    to: '  if (false) {\n    clearFocus(key)\n    return null\n  }',
    expectRed: '★★ 焦点指向归档会话时回落到默认（不往收起来的会话里投）'
  },
  {
    name: '引用 TTL：永不过期',
    file: 'lib/focus.js',
    from: '  if (now - entry.at > SENT_TTL_MS) {\n    sentIndex.delete(id)\n    return null\n  }',
    to: '  if (false) {\n    sentIndex.delete(id)\n    return null\n  }',
    expectRed: '★ 引用索引超过 6 小时就失效'
  },
  {
    name: '引用容量：不设上限',
    file: 'lib/focus.js',
    from: '  while (sentIndex.size > SENT_LIMIT) {',
    to: '  while (false) {',
    expectRed: '★★ 引用索引超过 500 条时丢最早的（不会无限长）'
  },
  {
    name: '标签：默认会话也加标签',
    file: 'lib/focus.js',
    from: '  if (sid === defaultSession) return \'\'',
    to: '  if (false) return \'\'',
    expectRed: '★ 默认会话不加标签（日常聊天不污染）'
  },
  {
    name: '标签：不截断',
    file: 'lib/focus.js',
    from: '  return `〔${clip(text, 24)}〕`',
    to: '  return `〔${text}〕`',
    expectRed: '★ 标签被截断（不会把 100 字的标题塞进每条消息）'
  },
  {
    // 精确打「targetKey 隔离」这条断言的做法：
    // 让 resolveSession 查焦点时**去掉 kind**，只按 id 查 ——
    // 于是 `private:1321833118` 和 `group:1321833118` 会互相串。
    // 用一个不存在的组合来暴露它：测试里 private 设了焦点，
    // 群查询应当不受影响；变异后群会拿到 private 的焦点。
    //
    // ⚠️ 之前试过改 setFocus / focusOf 的 key 归一化，副作用太大（所有焦点都失效），
    //    变红但先撞别的断言 —— 那种变异证明不了隔离性，只能证明「焦点坏了」。
    name: 'targetKey 隔离：resolveSession 查焦点时丢掉 kind',
    file: 'lib/focus.js',
    from: '  const focus = focusOf(targetKey, now)',
    to: '  const focus = focusOf(`private:${String(id ?? \'\')}`, now)',
    expectRed: '★★ 同一个数字 id 在私聊设的焦点，群那边查不到（kind 必须参与 key）'
  }
]

function runSim(workdir) {
  const log = join(ROOT, `log-${Math.random().toString(36).slice(2)}.txt`)
  let fd
  try {
    fd = openSync(log, 'w')
  } catch {
    fd = undefined
  }
  try {
    execFileSync(process.execPath, [join(workdir, 'tests', 'focus-sim.mjs')], {
      cwd: workdir,
      // ⚠️ 文件重定向而不是 'pipe'：受限环境下管道会 EPERM，连 stdout 都读不到，
      //    现象是「全都说绿」而其实一个字节都没读到（踩坑记录 §28）。
      stdio: ['ignore', fd ?? 'ignore', fd ?? 'ignore'],
      env: {
        ...process.env,
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
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {}
    }
  }
}

function prepareCopy(tag) {
  const dir = join(ROOT, `copy-${tag}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  cpSync(join(PLUGIN, 'lib'), join(dir, 'lib'), { recursive: true })
  mkdirSync(join(dir, 'tests'), { recursive: true })
  cpSync(join(PLUGIN, 'tests', 'focus-sim.mjs'), join(dir, 'tests', 'focus-sim.mjs'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'focus-mutation-copy', type: 'module' }), 'utf8')
  return dir
}

let pass = 0
let fail = 0
const problems = []

try {
  mkdirSync(join(ROOT, 'home', '.dsh'), { recursive: true })

  console.log('基线检查（未变异，应当绿）…')
  const base = runSim(prepareCopy('base'))
  if (base.ok) {
    pass += 1
    console.log('  ✓ 基线绿')
  } else {
    fail += 1
    problems.push('基线就是红的 —— 后面所有变异都不作数')
    console.log('  ✗ 基线红：')
    console.log(base.output.split('\n').slice(-12).join('\n'))
  }

  for (let i = 0; i < MUTATIONS.length; i++) {
    const m = MUTATIONS[i]
    const dir = prepareCopy(`m${i}`)
    const file = join(dir, m.file)
    const src = readFileSync(file, 'utf8')
    if (!src.includes(m.from)) {
      fail += 1
      problems.push(`${m.name}：变异点在源码里找不到（源码变了？）`)
      console.log(`  ✗ ${m.name} —— 变异点找不到`)
      rmSync(dir, { recursive: true, force: true })
      continue
    }
    writeFileSync(file, src.replace(m.from, m.to), 'utf8')
    const result = runSim(dir)
    if (!result.ok) {
      if (result.output.includes(m.expectRed)) {
        pass += 1
        console.log(`  ✓ ${m.name} → 变红，命中「${m.expectRed}」`)
      } else {
        fail += 1
        problems.push(`${m.name}：变红了但没命中预期断言「${m.expectRed}」`)
        console.log(`  ✗ ${m.name} → 变红但没命中预期断言`)
        console.log(result.output.split('\n').filter((l) => l.includes('✗')).slice(0, 4).join('\n'))
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

console.log(`\nfocus-mutation: ${pass} 过 / ${fail} 败`)
if (fail > 0) {
  console.log('问题：')
  for (const p of problems) console.log('  -', p)
  process.exit(1)
}
