/**
 * tool-toggle-mutation.mjs —— 变异验证：把开关的实现改坏，确认 tool-toggle-sim 真的会红。
 *
 * 为什么必须有（docs 踩坑 §27）：
 *   一条断言如果「删掉实现照样绿」，它就什么都没测到。
 *   这个文件对 toolFeatures 的每个关键点注入小破坏，跑一遍 tool-toggle-sim，期望它**变红**，
 *   而且必须命中**预期的那条断言**（不能是语法崩了碰巧红的）。
 *
 * ⚠️ 每个变异都在临时副本上做，**绝不改工作区里的源文件**。
 *   做法照 tests/progress-mutation.mjs：把 lib/ + 单个测试复制到临时目录，改副本，在副本里跑。
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
  for (const root of [join(tmpdir(), `qq-toggle-mut-${process.pid}`), join(PLUGIN, '..', '.tmp-test', `toggle-mut-${process.pid}`)]) {
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

/**
 * 变异清单。
 *
 * `expectRed` 必须是 tool-toggle-sim 里那条断言**标签的一个子串** ——
 * 用来确认「红的是我预期的这条」，而不是别的断言先红、或者文件语法崩了。
 */
const MUTATIONS = [
  {
    // ① 表情包档关着也照样注册 —— 那关开关就毫无意义
    name: '忽略 emoji 开关，照样注册表情包档',
    file: 'lib/index.js',
    from: '    if (features.emoji) {\n      void registerEmojiSearchTool(ctx, toolRegistration.signal)',
    to: '    if (true) {\n      void registerEmojiSearchTool(ctx, toolRegistration.signal)',
    // sim 里第 1 节「默认关着的档 → qq_emoji_search 没注册」会红。
    // ⚠️ 但 sim 的 boot() 复刻的是分支逻辑，不 import index.js ——
    //   所以这条变异在 sim 里抓不到（见下面「已知局限」一节）。
    //   真正抓住它的是第 9 节的静态断言。
    // ⚠️ 2026-11-09：那条静态断言原来是 `indexSrc.includes('if (features.emoji)')`
    //   —— 只证明字符串出现过，而文件里有**两处**该分支，改坏一处照样绿（假绿）。
    //   已改成「每个工具所在块的入口必须是 features.emoji」，标签也变了。
    //   ⚠️ expectRed 必须和「✗ 」之后**紧跟**的文本对齐：判定用的是
    //      `output.includes('✗ ' + expectRed)`，所以标签中间不能跳过工具名。
    //      实际标签是 `index.js：registerEmojiSearchTool 所在的块由 features.emoji 把守（…）`，
    //      这里取一个**跨所有工具都成立**的公共片段。
    expectRed: '所在的块由 features.emoji 把守'
  },
  {
    // ② 描述不动态化：把 feature 判断去掉，表情段永远出现
    name: '描述不动态化（表情段永远拼进去）',
    file: 'lib/tool.js',
    from: '  if (features.emoji) {\n    parts.push(\n      \'\\n\\n表情：真人聊天会发表情。',
    to: '  if (true) {\n    parts.push(\n      \'\\n\\n表情：真人聊天会发表情。',
    expectRed: 'description 里没有 qq_face_pick'
  },
  {
    // ③ voice 参数不去掉（留着参数、调用时报错 —— 正是最坏的那种）
    name: 'voiceOut 关着也把 voice 放进 schema',
    file: 'lib/tool.js',
    from: '            ...(features.voiceOut ? {',
    to: '            ...(true ? {',
    expectRed: 'parameters.properties 里没有 voice 键'
  },
  {
    // ④ 沉默权关着也照样写沉默四件套的话术
    name: '沉默权段不跟着关（仍指向 qq_skip 等）',
    file: 'lib/tool.js',
    from: '  if (features.silence) {\n    parts.push(\n      \'\\n\\n你不一定非得开口。',
    to: '  if (true) {\n    parts.push(\n      \'\\n\\n你不一定非得开口。',
    expectRed: '沉默权关着 → 不出现 qq_skip'
  },
  {
    // ⑤ 失败路径悬空：render 的错误提示不跟表情包开关走
    name: 'render 的错误提示不跟着表情包开关',
    file: 'lib/tool.js',
    from: '            const next = features.emoji\n',
    to: '            const next = true\n',
    expectRed: 'render 的错误提示里没有 qq_face_pick'
  },
  // ⑥ 原来的「execute throw 死写 qq_face_pick」变异已**删除**（2026-11-05）。
  //
  //    原因不是它不重要，而是它已经**测不到**了：
  //    custom_emoji 参数在表情包档关闭时被整个移除（审计结论），
  //    于是 customEmojiMissed 恒为空、那条 throw 走不到，
  //    把 `features.emoji` 改成 `true` 自然也就没有可观察的差异 —— 变异必然绿。
  //
  //    ⚠️ 这正是「假变异」的典型：留着它会让人以为这条路径被覆盖了。
  //    真正的覆盖在 tool-toggle-sim 的「表情包开着时 execute 报错指路」那条用例里，
  //    那条走的是活分支。
  {
    // ⑥b custom_emoji 无条件保留（2026-11-05 审计后的新红线）
    //     关掉表情包档时它必须从 schema 消失 ——
    //     实测「保留窄口」会让模型猜错备注词还静默发出错误表情。
    name: 'custom_emoji 不跟着表情包档移除',
    file: 'lib/tool.js',
    from: '            ...(features.emoji\n              ? {\n                  custom_emoji: {',
    to: '            ...(true\n              ? {\n                  custom_emoji: {',
    expectRed: '★ 表情包关掉时 custom_emoji 从 schema 移除'
  },
  {
    // ⑦ normalizeToolFeatures 容错失效：字符串 "true" 被当成开
    name: '容错把字符串 "true" 当成开',
    file: 'lib/config.js',
    from: "    if (typeof value[key] === 'boolean') out[key] = value[key]",
    to: '    if (value[key] !== undefined) out[key] = value[key] === true || value[key] === \'true\'',
    expectRed: 'emoji:"true"（字符串）不被当成开'
  },
  {
    // ⑧ 多传的键不丢弃（会把垃圾写进配置）
    name: '容错把不认识的键也留下',
    file: 'lib/config.js',
    from: "  for (const key of Object.keys(TOOL_FEATURE_DEFAULTS)) {\n    // 只认真正的布尔值：字符串 \"true\" / 数字 1 都算「不认识」，回默认\n    if (typeof value[key] === 'boolean') out[key] = value[key]\n  }",
    to: "  for (const key of Object.keys(value)) out[key] = value[key]\n  for (const key of Object.keys(TOOL_FEATURE_DEFAULTS)) { if (out[key] === undefined) out[key] = TOOL_FEATURE_DEFAULTS[key] }",
    expectRed: '不认识的键被丢掉'
  },
  {
    // ⑨ 默认值被改（表情包默认开 → 装好即烧 token）
    name: '默认值改错（emoji 默认开）',
    file: 'lib/config.js',
    from: '  emoji: false,',
    to: '  emoji: true,',
    expectRed: '表情包 / 语音识别 / 发送语音 / 戳一戳 默认关'
  },
  {
    // ⑩ 设置页不说「要重启」—— 用户改完以为立刻生效
    name: '设置页不说要重启 DSH',
    file: 'lib/client.js',
    from: '改完这一块要**重启 DSH** 才生效',
    to: '改完这一块会立刻生效',
    expectRed: '工具箱卡片里写明了「改完这一块要重启 DSH 才生效」'
  },
  {
    // ⑪ 设置页手写死字符数（这功能的要求就是「别手写常量」）
    name: '设置页改用写死的字符数',
    file: 'lib/client.js',
    from: '        var sizes = (data && data.toolSizes) || null',
    to: '        var sizes = { emoji: 24000, silence: 15000, voiceIn: 2000, voiceOut: 3000, poke: 2400 }',
    expectRed: '设置页没有残留虚报的「2.4 万字符」常量'
  },
  {
    // ⑫ face-resolve 又指回工具名（失败路径悬空）
    name: 'face-resolve 的报错又指回 qq_emoji_search',
    file: 'lib/face-resolve.js',
    from: "        + '换用中文名，或换一个编号再试。'\n      )\n    }\n    return id",
    to: "        + '换用中文名，或先用 qq_emoji_search 查一下正确的编号。'\n      )\n    }\n    return id",
    expectRed: 'face-resolve.js 的报错不再提 qq_emoji_search'
  }
]

/** 在副本里跑 tool-toggle-sim，返回 { ok, output }。 */
function runSim(workdir) {
  const log = join(ROOT, `log-${Math.random().toString(36).slice(2)}.txt`)
  const fd = openSync(log, 'w')
  try {
    // ⚠️ stdio 用文件重定向而不是 'pipe'：受限环境下管道会 EPERM，
    //   连 stdout 都读不到（现象是「全都说绿」而其实一个字节都没读到）。
    execFileSync(process.execPath, [join(workdir, 'tests', 'tool-toggle-sim.mjs')], {
      cwd: workdir,
      stdio: ['ignore', fd, fd],
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
    try { closeSync(fd) } catch {}
  }
}

/** 把插件复制一份到临时目录（只带跑测试需要的部分）。 */
function prepareCopy(tag) {
  const dir = join(ROOT, `copy-${tag}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  cpSync(join(PLUGIN, 'lib'), join(dir, 'lib'), { recursive: true })
  cpSync(join(PLUGIN, 'tests', 'tool-toggle-sim.mjs'), join(dir, 'tests', 'tool-toggle-sim.mjs'), { recursive: true })
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
    console.log(base.output.split('\n').slice(-15).join('\n'))
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
      rmSync(dir, { recursive: true, force: true })
      continue
    }
    writeFileSync(file, src.replace(m.from, m.to), 'utf8')
    const result = runSim(dir)
    if (!result.ok) {
      // 变红了 —— 但必须确认是**因为预期的那条断言**红的
      //
      // ⚠️ 判据：expectRed 必须出现在**某一条 ✗ 行里**，而不是要求
      //    `✗ ` 之后紧跟它。原因：有些标签中间夹着变量（工具名、配置键名），
      //    比如 `✗ index.js：registerEmojiSearchTool 所在的块由 … 把守`——
      //    期望片段从「所在」开始就永远对不上 `✗ 所在的…`。
      //    第一版是 `includes('✗ ' + expectRed)`，于是变异明明红了却被判「没命中」，
      //    而那条变异本身是**有效的**（手工改坏同一个位置，sim 确实红在预期那条）。
      const redLines = result.output.split(/\r?\n/).filter((l) => l.includes('✗'))
      const hit = redLines.some((l) => l.includes(m.expectRed))
      if (hit) {
        pass += 1
        console.log(`  ✓ ${m.name} → 变红，且命中「${m.expectRed}」`)
      } else {
        fail += 1
        problems.push(`${m.name}：变红了但没命中「${m.expectRed}」`)
        console.log(`  ✗ ${m.name} → 变红但没命中预期断言`)
        console.log(result.output.split('\n').filter((l) => l.includes('✗')).slice(0, 6).join('\n'))
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

console.log(`\ntool-toggle-mutation: ${pass} 过 / ${fail} 败`)
if (fail > 0) {
  console.log('问题：')
  for (const p of problems) console.log('  -', p)
  process.exit(1)
}
