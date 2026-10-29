/**
 * 把插件源码推进 profile 的 node_modules 副本。
 *
 * 现状（实测）：pnpm 用 file: 装目录依赖时会**硬链接**，源码和副本是同一个 inode，
 * 改源码副本就跟着变，根本不需要同步。所以这个脚本第一件事是先判断硬链接：
 *   - 是硬链接 → 只提示一句，直接退出
 *   - 不是     → 逐文件覆盖（不要整目录 cp，Windows 上会报 EPIPE / 自己拷自己）
 *
 * 2026-10-27 补充：模块化重构后 lib/ 下多了十几个新文件 —— 硬链接只对「已存在的文件」成立，
 * 新建的模块在副本里根本没有。所以现在改成**逐文件比对**：
 *   目标不存在 → 补拷（这正是新增模块的路径）
 *   两边 inode 不同 → 覆盖（副本被改过 / 已经不是硬链接了）
 *   两边 inode 相同 → 跳过（本来就是同一份）
 * 之前那个「index.js 是硬链接就整体退出」的判断会把新文件漏掉，已废弃。
 *
 * 用法：node sync.mjs
 */
import { copyFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = dirname(fileURLToPath(import.meta.url))

/**
 * 副本（profile 的 node_modules）的全部可能位置。
 *
 * ⚠️ 2026-10-29：这里原来写死的是 dsh-qq-bridge —— 那是这个插件的**旧包名**，
 *   目录早就跟着 package.json 的 name 改成 dsh-onebot-channel 了。
 *   结果是脚本每次都报「副本目录不存在」直接退出，等于白写。
 *   改成按 profile **自动发现**：不写死 profile 名，也不写死目录名。
 */
const PROFILE_ROOT = join(homedir(), '.dsh', 'profiles')

function discoverDestinations() {
  if (!existsSync(PROFILE_ROOT)) return []
  const found = []
  for (const profile of readdirSync(PROFILE_ROOT)) {
    const candidate = join(PROFILE_ROOT, profile, 'node_modules', 'dsh-onebot-channel')
    if (existsSync(candidate) && existsSync(join(candidate, 'lib'))) found.push(candidate)
  }
  return found
}

const DESTS = discoverDestinations()
if (DESTS.length === 0) {
  console.error(`没找到已安装的副本：${PROFILE_ROOT}\\<profile>\\node_modules\\dsh-onebot-channel`)
  console.error('先用 DSH 重新安装这个插件。')
  process.exit(1)
}

let copied = 0
let skipped = 0
const libDir = join(SRC, 'lib')
for (const DEST of DESTS) {
  if (join(SRC).toLowerCase() === join(DEST).toLowerCase()) {
    console.log(`跳过：当前就在副本里（${DEST}）`)
    continue
  }
  console.log(`\n→ ${DEST}`)
  for (const name of readdirSync(libDir)) {
    const from = join(libDir, name)
    const to = join(DEST, 'lib', name)
    // 已经是同一份（硬链接）就跳过
    if (existsSync(to) && statSync(to).ino === statSync(from).ino) {
      skipped += 1
      continue
    }
    try {
      copyFileSync(from, to)
      copied += 1
      console.log(`  已同步 lib/${name}`)
    } catch (error) {
      console.error(`  同步 lib/${name} 失败：${error.message}`)
      console.error('  多半是 DSH 正占用文件，退出 DSH 后再跑一次。')
      process.exit(1)
    }
  }

  // 根目录这几个文件以前漏了同步：副本的 package.json 一直停在旧版本号，
  // 「源码 0.8.1 / 副本 0.7.0」这种错位查起来很费劲（0.9.0 补上）。
  for (const name of ['package.json', 'cordis.patch.yml']) {
    const from = join(SRC, name)
    const to = join(DEST, name)
    if (!existsSync(from)) continue
    if (existsSync(to) && statSync(to).ino === statSync(from).ino) {
      skipped += 1
      continue
    }
    try {
      copyFileSync(from, to)
      copied += 1
      console.log(`  已同步 ${name}`)
    } catch (error) {
      console.error(`  同步 ${name} 失败：${error.message}`)
      process.exit(1)
    }
  }

  // 副本里可能有源码已经没有的旧文件（重构删掉的模块），列出来提醒，不自动删
  for (const name of readdirSync(join(DEST, 'lib'))) {
    if (!existsSync(join(libDir, name))) {
      console.log(`  提示：副本里有源码已删除的文件 lib/${name}（未自动删除，确认无用可自行清理）`)
    }
  }
}

console.log(`\n完成：新同步 ${copied} 个文件，跳过 ${skipped} 个（已是硬链接）→ ${DESTS.length} 个副本`)
console.log('配置和游标不在这里（在 ~/.dsh/qq-bridge.*），不用同步，也不会被覆盖。')
console.log('要生效：重启 DSH，或在 DSH 里重载插件。')
