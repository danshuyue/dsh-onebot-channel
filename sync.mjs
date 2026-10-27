/**
 * 把插件源码推进 DSH 真正加载的副本。
 *
 * ⚠️ 2026-10-27 修掉一个「同步了等于没同步」的坑：
 *
 *   插件在 DSH 里有**两个**副本，缺一不可：
 *     A) ~/.dsh/plugins/dsh-qq-bridge/          ← 「源」
 *        profile 的 package.json 里写的是 "dsh-qq-bridge": "file:../../plugins/dsh-qq-bridge"，
 *        pnpm 装的时候从这里取。**重装 / pnpm 重建时会从这里覆盖**。
 *     B) ~/.dsh/profiles/desktop/node_modules/dsh-qq-bridge/   ← 「运行副本」
 *        **DSH 运行时真正 import 的就是这个目录**。
 *
 *   之前这个脚本只同步 A。A 和 B 不是硬链接（inode 不同），
 *   所以改了 A，B 一动不动 —— 结果就是「日志里明明写着工具注册成功，
 *   但糖糖那边就是没有这个工具」。DSH 18:35 启动时加载的是 12:50 的 B 副本，
 *   里面只有 qq_send。
 *
 *   现在两个都同步：A 保证 pnpm 重装不丢，B 保证立刻生效。
 *
 * 用法：node sync.mjs
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = dirname(fileURLToPath(import.meta.url))

/** 要同步到的目录（都存在才同步；不存在就跳过并提示）。 */
const DESTS = [
  // A) 源目录 —— pnpm file: 依赖的来源，重装时会从这里取
  join(homedir(), '.dsh', 'plugins', 'dsh-qq-bridge'),
  // B) 运行副本 —— DSH 进程真正 import 的目录，改完这个才立刻生效
  join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-qq-bridge')
]

const targets = DESTS.filter((dir) => {
  if (existsSync(dir)) return true
  console.log(`提示：目标目录不存在，跳过 → ${dir}`)
  return false
})

if (targets.length === 0) {
  console.error('一个目标目录都没有，先用 DSH 重新安装这个插件。')
  process.exit(1)
}

/**
 * ⚠️ 同步前必须校验：package.json 的 name == 插件目录名。
 *
 * 踩过的坑（2026-10-27）：源码里 package.json 的 name 写成了 `dsh-onebot-channel`，
 * 而插件目录叫 `dsh-qq-bridge`。sync 把 package.json 覆盖到运行副本后，
 * **设置页的「QQ 桥接」入口直接消失了** ——
 *   DSH 按**目录名**去 node_modules 里找包（nearestPackage），
 *   并且会校验 package.json 的 name **等于**目录名，对不上就跳过整个包。
 *   结果：插件不进 boot graph → 浏览器侧拿不到 client bundle → 设置页没入口。
 *   （服务端 API 和工具都正常，因为那是 cordis 按 patch 文件里的 name 加载的。）
 *
 * 这里提前拦住，别等同步完才发现设置页没了。
 */
const PKG_NAME = JSON.parse(readFileSync(join(SRC, 'package.json'), 'utf8')).name
const DIR_NAME = basename(SRC)
if (PKG_NAME !== DIR_NAME) {
  console.error(`\n❌ package.json 的 name（${PKG_NAME}）跟插件目录名（${DIR_NAME}）不一致，拒绝同步。`)
  console.error('   DSH 按目录名找包并校验 name 一致，不一致会导致设置页的插件入口消失。')
  console.error('   把 package.json 的 name 改成 ' + DIR_NAME + ' 再跑。')
  process.exit(1)
}
console.log(`包名校验通过：${PKG_NAME}`)

/** 把一个文件从源码拷到目标（先 unlink 断硬链接，再拷独立的一份）。 */
function syncFile(from, to) {
  if (existsSync(to) && statSync(to).ino === statSync(from).ino) return 'skipped'
  try {
    // ⚠️ 必须先删目标再拷 —— 副本里的文件可能跟源码是**硬链接**（同一 inode）。
    //   copyFileSync 直接覆盖会顺着硬链接把**源码也改了**，
    //   于是「同步」变成「源码被副本污染」，git diff 会出现莫名其妙的改动。
    //   先 unlink 断链接，再拷一份独立的，源码保持不动。
    if (existsSync(to)) {
      try {
        unlinkSync(to)
      } catch {
        // 删不掉（DSH 正占用）→ 退化成原地覆盖，至少内容能对上
        console.log(`  提示：${to} 删不掉（可能被占用），改为原地覆盖`)
      }
    }
    copyFileSync(from, to)
    return 'copied'
  } catch (error) {
    console.error(`  同步失败 ${to}：${error.message}`)
    console.error('  多半是 DSH 正占用文件，退出 DSH 后再跑一次。')
    process.exit(1)
  }
}

const libDir = join(SRC, 'lib')
const libNames = readdirSync(libDir)
let totalCopied = 0
let totalSkipped = 0

for (const dest of targets) {
  console.log(`\n=== 同步到 ${dest} ===`)
  if (!existsSync(join(dest, 'lib'))) {
    try {
      mkdirSync(join(dest, 'lib'), { recursive: true })
    } catch (error) {
      console.error(`  建 lib 目录失败：${error.message}`)
      continue
    }
  }
  let copied = 0
  let skipped = 0
  for (const name of libNames) {
    const from = join(libDir, name)
    const to = join(dest, 'lib', name)
    const result = syncFile(from, to)
    if (result === 'copied') {
      copied += 1
      console.log(`  已同步 lib/${name}`)
    } else {
      skipped += 1
    }
  }
  // package.json 也得跟上（版本号、依赖）
  const pkgFrom = join(SRC, 'package.json')
  if (existsSync(pkgFrom)) syncFile(pkgFrom, join(dest, 'package.json'))

  // cordis.patch.yml 也得跟上 —— 里面是插件在 profile 里的**注册条目**
  // （id + name）。name 决定 DSH 按哪个包名去加载它，改错了插件就不加载。
  const patchFrom = join(SRC, 'cordis.patch.yml')
  if (existsSync(patchFrom)) syncFile(patchFrom, join(dest, 'cordis.patch.yml'))

  // 副本里可能有源码已经没有的旧文件（重构删掉的模块），列出来提醒，不自动删
  for (const name of readdirSync(join(dest, 'lib'))) {
    if (!existsSync(join(libDir, name))) {
      console.log(`  提示：副本里有源码已删除的文件 lib/${name}（未自动删除，确认无用可自行清理）`)
    }
  }
  console.log(`  → 新同步 ${copied} 个，跳过 ${skipped} 个（已是同一份）`)
  totalCopied += copied
  totalSkipped += skipped
}

console.log(`\n完成：共新同步 ${totalCopied} 个文件，跳过 ${totalSkipped} 个`)
console.log('配置和游标不在这里（在 ~/.dsh/qq-bridge.*），不会被动。')
console.log('要生效：**重启 DSH**（插件是进程启动时加载的，热重载不保证能换掉工具表）。')
