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
import { copyFileSync, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = dirname(fileURLToPath(import.meta.url))
// ⚠️ 路径修正（2026-10-27）：插件实际装在 ~/.dsh/plugins/dsh-qq-bridge/，
//    **不是** ~/.dsh/profiles/desktop/node_modules/dsh-onebot-channel ——
//    后者根本不存在（目录名是 dsh-qq-bridge，包名才是 dsh-onebot-channel）。
//    之前一直指错，每次跑都报"副本目录不存在"，等于同步从来没生效过。
const DEST = join(homedir(), '.dsh', 'plugins', 'dsh-qq-bridge')

if (join(SRC).toLowerCase() === join(DEST).toLowerCase()) {
  console.error('当前就在 node_modules 副本里，源码目录是 ~/.dsh/plugins/dsh-onebot-channel')
  process.exit(1)
}
if (!existsSync(DEST)) {
  console.error(`副本目录不存在：${DEST}\n先用 DSH 重新安装这个插件。`)
  process.exit(1)
}

let copied = 0
let skipped = 0
const libDir = join(SRC, 'lib')
for (const name of readdirSync(libDir)) {
  const from = join(libDir, name)
  const to = join(DEST, 'lib', name)
  // 已经是同一份（硬链接）就跳过
  if (existsSync(to) && statSync(to).ino === statSync(from).ino) {
    skipped += 1
    continue
  }
  try {
    // ⚠️ 必须先删目标再拷 —— 副本里的文件跟源码是**硬链接**（同一 inode）。
    //   copyFileSync 直接覆盖会顺着硬链接把**源码也改了**，
    //   于是「同步」变成「源码被副本污染」，git diff 会出现莫名其妙的改动。
    //   先 unlink 断链接，再拷一份独立的，源码保持不动。
    if (existsSync(to)) {
      try {
        unlinkSync(to)
      } catch {
        // 删不掉（DSH 正占用）→ 那就退化成原地覆盖，至少能同步内容
        console.log(`提示：lib/${name} 删不掉（可能被占用），改为原地覆盖`)
      }
    }
    copyFileSync(from, to)
    copied += 1
    console.log(`已同步 lib/${name}`)
  } catch (error) {
    console.error(`同步 lib/${name} 失败：${error.message}`)
    console.error('多半是 DSH 正占用文件，退出 DSH 后再跑一次。')
    process.exit(1)
  }
}

// 副本里可能有源码已经没有的旧文件（重构删掉的模块），列出来提醒，不自动删
for (const name of readdirSync(join(DEST, 'lib'))) {
  if (!existsSync(join(libDir, name))) {
    console.log(`提示：副本里有源码已删除的文件 lib/${name}（未自动删除，确认无用可自行清理）`)
  }
}

console.log(`\n完成：新同步 ${copied} 个文件，跳过 ${skipped} 个（已是硬链接）→ ${DEST}`)
console.log('配置和游标不在这里（在 ~/.dsh/qq-bridge.*），不用同步，也不会被覆盖。')
console.log('要生效：重启 DSH，或在 DSH 里重载插件。')
