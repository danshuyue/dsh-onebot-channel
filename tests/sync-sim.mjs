/**
 * sync-sim.mjs —— 检查运行副本的模块完整性 + 工具注册 + 包名一致性。
 *
 * 为什么需要（2026-10-27）：
 *   插件在 DSH 里有两份：`~/.dsh/plugins/dsh-onebot-channel/`（源）和
 *   `~/.dsh/profiles/desktop/node_modules/dsh-onebot-channel/`（运行副本）。
 *   `sync.mjs` 如果只同步前者，运行副本会是旧的 → 日志写着工具注册成功，
 *   agent 那边却只有 `qq_send`。
 *
 * 这个脚本直接检查**运行副本**，防止再漏。
 * 用法：`node tests/sync-sim.mjs`
 */
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')

/** 运行副本目录（DSH 真正 import 的那份）。 */
const RUNTIME_DIR = join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-onebot-channel')

/** 源目录（pnpm file: 依赖的那份）。 */
const SOURCE_DIR = PROJECT_ROOT

let failed = 0
let passed = 0

function assert(condition, message) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${message}`)
  } else {
    failed += 1
    console.error(`  ✗ ${message}`)
  }
}

function checkDir(label, dir) {
  console.log(`\n[${label}] ${dir}`)
  assert(existsSync(dir), '目录存在')
  if (!existsSync(dir)) {
    console.error(`    → ${label} 目录不存在，跳过后续检查`)
    return false
  }
  return true
}

function checkModuleIntegrity(label, dir) {
  // 核心模块列表（lib/ 下所有 .js）
  const libDir = join(dir, 'lib')
  assert(existsSync(libDir), 'lib/ 目录存在')

  if (!existsSync(libDir)) return

  const expectedModules = [
    'index.js', 'config.js', 'state.js', 'env.js', 'onebot.js',
    'poll.js', 'ws.js', 'merge.js', 'deliver.js', 'outbound.js',
    'split.js', 'sessions.js', 'tool.js', 'api.js', 'client.js',
    'sendapi.js', 'closure.js', 'rhythm.js', 'memory.js', 'proactive.js',
    'images.js', 'emoticons.js', 'emoji-mark.js', 'title.js', 'history.js',
    'health.js', 'snowluma.js', 'blocked.js', 'allowlist.js', 'sensitive.js',
    'sys-faces.js', 'face-resolve.js', 'custom-faces.js', 'collect.js',
    'preview.js', 'qzone.js', 'backfill.js', 'instance.js', 'collect.js'
  ]

  const foundModules = []
  try {
    const files = readdirSync(libDir)
    for (const f of files) {
      if (f.endsWith('.js')) foundModules.push(f)
    }
  } catch {
    assert(false, '无法读取 lib/ 目录')
    return
  }

  for (const mod of expectedModules) {
    const exists = foundModules.includes(mod)
    assert(exists, `lib/${mod} 存在`)
  }
}

function checkToolRegistration(label, dir) {
  // 检查 tool.js 中注册的工具数量
  const toolFile = join(dir, 'lib', 'tool.js')
  assert(existsSync(toolFile), 'lib/tool.js 存在')
  if (!existsSync(toolFile)) return

  try {
    const content = readFileSync(toolFile, 'utf8')
    const toolNames = []
    const regex = /name:\s*['"](\w+)['"]/g
    let match
    while ((match = regex.exec(content)) !== null) {
      toolNames.push(match[1])
    }
    // 去重（name 会出现多次）
    const uniqueTools = [...new Set(toolNames)]
    assert(uniqueTools.length >= 10, `工具注册数 >= 10（实际 ${uniqueTools.length}：${uniqueTools.join(', ')}）`)
  } catch (error) {
    assert(false, `读取 tool.js 失败：${error.message}`)
  }
}

function checkPackageName(label, dir) {
  const pkgFile = join(dir, 'package.json')
  assert(existsSync(pkgFile), 'package.json 存在')
  if (!existsSync(pkgFile)) return

  try {
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    assert(pkg.name === 'dsh-onebot-channel', `package.json name = "dsh-onebot-channel"（实际 "${pkg.name}"）`)
    assert(pkg.version !== undefined, `package.json version 存在（${pkg.version}）`)

    // 目录名必须跟包名一致
    const dirName = basename(dir)
    assert(dirName === 'dsh-onebot-channel', `目录名 = "dsh-onebot-channel"（实际 "${dirName}"）`)
  } catch (error) {
    assert(false, `读取 package.json 失败：${error.message}`)
  }
}

// ---- 主流程 ----

console.log('=== 运行副本完整性检查 ===')

const runtimeExists = checkDir('运行副本', RUNTIME_DIR)
const sourceExists = checkDir('源码', SOURCE_DIR)

if (runtimeExists) {
  console.log('\n[运行副本] 模块完整性')
  checkModuleIntegrity('运行副本', RUNTIME_DIR)

  console.log('\n[运行副本] 工具注册')
  checkToolRegistration('运行副本', RUNTIME_DIR)

  console.log('\n[运行副本] 包名一致性')
  checkPackageName('运行副本', RUNTIME_DIR)
}

if (sourceExists) {
  console.log('\n[源码] 模块完整性')
  checkModuleIntegrity('源码', SOURCE_DIR)

  console.log('\n[源码] 工具注册')
  checkToolRegistration('源码', SOURCE_DIR)

  console.log('\n[源码] 包名一致性')
  checkPackageName('源码', SOURCE_DIR)
}

// ---- 对比两份副本的版本 ----
if (runtimeExists && sourceExists) {
  console.log('\n[对比] 版本一致性')
  try {
    const runtimePkg = JSON.parse(readFileSync(join(RUNTIME_DIR, 'package.json'), 'utf8'))
    const sourcePkg = JSON.parse(readFileSync(join(SOURCE_DIR, 'package.json'), 'utf8'))
    const sameVersion = runtimePkg.version === sourcePkg.version
    assert(sameVersion, `版本一致（运行副本 ${runtimePkg.version} vs 源码 ${sourcePkg.version}）`)
    if (!sameVersion) {
      console.error(`    → 运行副本是旧版本！请跑 \`node sync.mjs\` 并重启 DSH`)
    }
  } catch (error) {
    assert(false, `对比版本失败：${error.message}`)
  }
}

console.log(`\n=== 结果：${passed} 通过，${failed} 失败 ===`)
if (failed > 0) {
  console.error('\n⚠ 有检查失败，请根据上面的 ✗ 标记修复')
  process.exit(1)
} else {
  console.log('\n✓ 全部通过')
}
