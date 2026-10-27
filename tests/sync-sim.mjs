/**
 * 同步链路自检：node tests/sync-sim.mjs，退出码 0 = 全过，1 = 有失败。
 *
 * 覆盖 2026-10-27 查出的两个坑：
 *
 * 坑一「同步了等于没同步」：
 *   插件在 DSH 里有**两个**副本：
 *     A) ~/.dsh/plugins/dsh-onebot-channel/                      ← pnpm file: 依赖的**源**
 *     B) ~/.dsh/profiles/desktop/node_modules/dsh-onebot-channel/ ← DSH 运行时**真正 import** 的
 *   之前的 sync.mjs 只同步 A。A 和 B 不是硬链接（inode 不同），
 *   所以改了 A，B 一动不动 —— 现象是「日志写着工具注册成功，
 *   但 agent 那边就是没有这个工具」。
 *   实际踩到的时候：DSH 18:35 启动，加载的是 12:50 的 B 副本，
 *   里面只有 qq_send。agent 明确说「本会话里没有 qq_collect_face 这个工具，只剩 qq_send」。
 *
 * 坑二「名字对不上，设置页入口消失」：
 *   DSH 按**安装目录名**去 node_modules 找包，并且校验 package.json 的 name
 *   等于目录名 —— 对不上就跳过整个包，浏览器侧拿不到 client bundle，
 *   设置页就没入口了（而服务端 API 和工具全都正常，特别难查）。
 *
 * 这个测试直接检查**运行副本**里有没有全部模块和全部工具注册。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { dirname } from 'node:path'

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}`)
  }
}
function eq(actual, expected, name) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, `${name}${same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`)
}

const SRC = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')

/** 插件在 DSH 里的安装目录名 —— package.json 的 name 必须等于它。 */
const PKG_DIR_NAME = 'dsh-onebot-channel'

/** 插件在 DSH 里的两个副本。 */
const DIRS = {
  source: join(homedir(), '.dsh', 'plugins', PKG_DIR_NAME),
  runtime: join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', PKG_DIR_NAME)
}

/** 插件对外暴露的工具（注册函数名 → 工具名）。 */
const TOOLS = [
  ['registerSendTool', 'qq_send'],
  ['registerEmojiSearchTool', 'qq_emoji_search'],
  ['registerHistoryTool', 'qq_msg_history'],
  ['registerQzoneTool', 'qq_qzone_post'],
  ['registerCollectTool', 'qq_collect_face'],
  ['registerFacePreviewTool', 'qq_face_preview']
]

console.log('运行副本（DSH 真正加载的那个）：')
{
  const dir = DIRS.runtime
  ok(existsSync(dir), `运行副本存在：${dir}`)
  if (existsSync(dir)) {
    // 1. 所有 lib 模块都得在
    const srcLib = join(SRC, 'lib')
    const missing = existsSync(srcLib)
      ? readdirSync(srcLib).filter((name) => !existsSync(join(dir, 'lib', name)))
      : ['（源码目录不存在）']
    ok(missing.length === 0, `运行副本里没有缺模块${missing.length > 0 ? `（缺 ${missing.join(', ')}）` : ''}`)

    // 2. index.js 必须注册全部工具 —— 这是「agent 能不能用到」的关键
    const indexPath = join(dir, 'lib', 'index.js')
    if (existsSync(indexPath)) {
      const index = readFileSync(indexPath, 'utf8')
      const missingReg = TOOLS.filter(([fn]) => !index.includes(`${fn}(ctx)`))
      ok(missingReg.length === 0, `index.js 注册了全部工具${missingReg.length > 0 ? `（缺 ${missingReg.map(([f]) => f).join(', ')}）` : ''}`)
    } else {
      ok(false, '运行副本有 lib/index.js')
    }

    // 3. tool.js 里得有全部工具定义
    const toolPath = join(dir, 'lib', 'tool.js')
    if (existsSync(toolPath)) {
      const tool = readFileSync(toolPath, 'utf8')
      const missingTool = TOOLS.filter(([, name]) => !tool.includes(`name: '${name}'`))
      ok(missingTool.length === 0, `tool.js 里定义了全部工具${missingTool.length > 0 ? `（缺 ${missingTool.map(([, n]) => n).join(', ')}）` : ''}`)
    } else {
      ok(false, '运行副本有 lib/tool.js')
    }
  }
}

console.log('\n源副本（pnpm file: 依赖的来源）：')
{
  const dir = DIRS.source
  ok(existsSync(dir), `源副本存在：${dir}`)
  if (existsSync(dir)) {
    const srcLib = join(SRC, 'lib')
    const missing = existsSync(srcLib)
      ? readdirSync(srcLib).filter((name) => !existsSync(join(dir, 'lib', name)))
      : ['（源码目录不存在）']
    ok(missing.length === 0, `源副本里没有缺模块${missing.length > 0 ? `（缺 ${missing.join(', ')}）` : ''}`)
  }
}

console.log('\n两个副本的内容一致：')
{
  if (existsSync(DIRS.source) && existsSync(DIRS.runtime)) {
    const srcLib = join(SRC, 'lib')
    if (existsSync(srcLib)) {
      const names = readdirSync(srcLib)
      const differs = names.filter((name) => {
        const a = join(SRC, 'lib', name)
        const b = join(DIRS.runtime, 'lib', name)
        if (!existsSync(b)) return true
        return statSync(a).size !== statSync(b).size
      })
      ok(differs.length === 0, `运行副本与源码逐个文件大小一致${differs.length > 0 ? `（不一致：${differs.join(', ')}）` : ''}`)
    }
  }
}

console.log('\n包名一致性（这条最关键）：')
{
  // ⚠️ 2026-10-27 踩过的坑：package.json 的 name 跟插件的**安装目录名**不一致
  // （一个是 dsh-onebot-channel，一个是 dsh-qq-bridge）。sync 覆盖 package.json 之后，
  // **设置页的「QQ 桥接」入口消失了**。
  //   DSH 按【安装目录名】去 node_modules 找包（nearestPackage），
  //   并校验 package.json 的 name 等于目录名 —— 对不上就跳过整个包。
  //   结果：插件不进 boot graph → 浏览器侧没有 client bundle → 设置页没入口。
  //   （服务端 API 和工具都正常，因为 cordis 是按 patch 文件里的 name 加载的，
  //    所以「功能都在、就是设置页找不到」这个现象特别难查。）
  //
  // 这条断言就是防止它再犯：name 必须同时等于安装目录名、patch 里的 name、
  // 以及 lib/index.js 导出的 name。
  const pkg = JSON.parse(readFileSync(join(SRC, 'package.json'), 'utf8'))
  eq(pkg.name, PKG_DIR_NAME, `package.json 的 name 等于安装目录名（${PKG_DIR_NAME}）`)

  const patch = readFileSync(join(SRC, 'cordis.patch.yml'), 'utf8')
  const patchName = /name:\s*(\S+)/.exec(patch)?.[1] ?? ''
  eq(patchName, PKG_DIR_NAME, 'cordis.patch.yml 里的 name 等于安装目录名')

  const index = readFileSync(join(SRC, 'lib', 'index.js'), 'utf8')
  const exportName = /export const name = '([^']+)'/.exec(index)?.[1] ?? ''
  eq(exportName, PKG_DIR_NAME, 'lib/index.js 导出的 name 等于安装目录名')

  const client = readFileSync(join(SRC, 'lib', 'client.js'), 'utf8')
  const moduleId = /id: '([^']+)'/.exec(client)?.[1] ?? ''
  eq(moduleId, PKG_DIR_NAME, 'lib/client.js 的模块 id 等于安装目录名')

  // profile 的依赖键和 bundles 也得对上 —— DSH 靠它们决定加载哪个包
  const profilePkg = join(homedir(), '.dsh', 'profiles', 'desktop', 'package.json')
  if (existsSync(profilePkg)) {
    const profile = JSON.parse(readFileSync(profilePkg, 'utf8'))
    eq(
      profile.dependencies?.[PKG_DIR_NAME] ?? '',
      `file:../../plugins/${PKG_DIR_NAME}`,
      'profile 的依赖键指向插件源目录'
    )
    ok(
      (profile.dsh?.profile?.bundles ?? []).includes(PKG_DIR_NAME),
      'profile 的 bundles 列表里有这个插件'
    )
    ok(
      !('dsh-qq-bridge' in (profile.dependencies ?? {})),
      'profile 依赖里没有旧包名残留'
    )
  }
}

console.log('\n说明文档（docs/QQ对话说明.md）：')
{
  // 树树每次开启新对话都会把这份文档发给 agent ——
  // 真正被使用的是**工作区**里那份（路径从 qq-bridge.config.json 的 workspaceCwd 读），
  // 仓库的 docs/ 只是备份。sync.mjs 末尾会把工作区那份反向拉回仓库，
  // 免得两边各改各的、最后不一样。
  const repoDoc = join(SRC, 'docs', 'QQ对话说明.md')
  ok(existsSync(repoDoc), '仓库里有 docs/QQ对话说明.md')

  const configFile = join(homedir(), '.dsh', 'qq-bridge.config.json')
  if (existsSync(configFile)) {
    const config = JSON.parse(readFileSync(configFile, 'utf8'))
    const wsCwd = String(config.workspaceCwd ?? '').trim()
    if (wsCwd !== '') {
      const wsDoc = join(wsCwd, 'QQ对话说明.md')
      if (existsSync(wsDoc)) {
        const wsBytes = readFileSync(wsDoc)
        const repoBytes = readFileSync(repoDoc)
        ok(
          wsBytes.equals(repoBytes),
          '仓库里的 docs/QQ对话说明.md 与工作区那份一致（sync 会自动反向同步）'
        )
      }
    }
  }

  // 两个副本里也得有这份文档
  for (const [label, dir] of [['源副本', DIRS.source], ['运行副本', DIRS.runtime]]) {
    ok(existsSync(join(dir, 'docs', 'QQ对话说明.md')), `${label}里有 docs/QQ对话说明.md`)
  }

  // package.json 的 files 要包含 docs，否则 npm 发布时不会带上
  const pkg = JSON.parse(readFileSync(join(SRC, 'package.json'), 'utf8'))
  ok((pkg.files ?? []).includes('docs'), "package.json 的 files 包含 'docs'")
}

console.log('\nsync.mjs 本身：')
{
  const syncPath = join(SRC, 'sync.mjs')
  if (existsSync(syncPath)) {
    const sync = readFileSync(syncPath, 'utf8')
    ok(sync.includes("'profiles', 'desktop', 'node_modules'"), 'sync.mjs 里写了运行副本路径')
    ok(sync.includes("'plugins', PKG_DIR_NAME"), 'sync.mjs 里写了源副本路径')
    ok(sync.includes("const PKG_DIR_NAME = 'dsh-onebot-channel'"), 'sync.mjs 里写了安装目录名常量')
    ok(sync.includes('PKG_NAME !== PKG_DIR_NAME'), 'sync.mjs 同步前校验包名跟安装目录名一致')
    ok(!/const DEST =/.test(sync), 'sync.mjs 不再只有一个目标（避免又漏同步一个）')
  } else {
    ok(false, 'sync.mjs 存在')
  }
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed > 0 ? 1 : 0)
