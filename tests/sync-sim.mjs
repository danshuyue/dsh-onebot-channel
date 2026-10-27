/**
 * 同步链路自检：node tests/sync-sim.mjs，退出码 0 = 全过，1 = 有失败。
 *
 * 覆盖 2026-10-27 查出的一个「同步了等于没同步」的坑：
 *
 *   插件在 DSH 里有**两个**副本：
 *     A) ~/.dsh/plugins/dsh-qq-bridge/                      ← pnpm file: 依赖的**源**
 *     B) ~/.dsh/profiles/desktop/node_modules/dsh-qq-bridge/ ← DSH 运行时**真正 import** 的
 *
 *   之前的 sync.mjs 只同步 A。A 和 B 不是硬链接（inode 不同），
 *   所以改了 A，B 一动不动 —— 现象是「日志写着工具注册成功，
 *   但 agent 那边就是没有这个工具」。
 *
 *   实际踩到的时候：DSH 18:35 启动，加载的是 12:50 的 B 副本，
 *   里面只有 qq_send。agent 明确说「本会话里没有 qq_collect_face 这个工具，只剩 qq_send」。
 *
 * 这个测试直接检查**运行副本**里有没有全部模块和全部工具注册。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
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

const SRC = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')

/** 插件在 DSH 里的两个副本。 */
const DIRS = {
  source: join(homedir(), '.dsh', 'plugins', 'dsh-qq-bridge'),
  runtime: join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-qq-bridge')
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

console.log('\nsync.mjs 本身：')
{
  const syncPath = join(SRC, 'sync.mjs')
  if (existsSync(syncPath)) {
    const sync = readFileSync(syncPath, 'utf8')
    ok(sync.includes("'profiles', 'desktop', 'node_modules'"), 'sync.mjs 里写了运行副本路径')
    ok(sync.includes("'plugins', 'dsh-qq-bridge'"), 'sync.mjs 里写了源副本路径')
    ok(!/const DEST =/.test(sync), 'sync.mjs 不再只有一个目标（避免又漏同步一个）')
  } else {
    ok(false, 'sync.mjs 存在')
  }
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed > 0 ? 1 : 0)
