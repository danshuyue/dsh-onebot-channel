/**
 * isolated-home.mjs —— 给「单跑某个测试」时准备一个隔离 HOME。
 *
 * ## 为什么需要单独一个模块
 *
 * 这些测试都要一个干净的 `~/.dsh`（否则会读到、甚至写坏真实的用户配置）。
 * 常规用法是 `node tests/run-isolated.mjs`，它会替你把 HOME 指好。
 * 但**直接单跑**一个测试文件时（排障时最常干的事），得自己建。
 *
 * ## 坑（本机实测，2026-11-07）
 *
 * `mkdtempSync(join(tmpdir(), …))` 在沙箱下会 `EPERM` —— 而且
 * **系统 Temp、C:/Windows/Temp、插件目录、用户目录全都不行**，
 * 唯独**工作区根下的 `.tmp-test`** 能建。
 * 而 `fs.accessSync(W_OK)` 对这些位置**全部误报成可写**，
 * 所以不能用 access 判断，只能真的 mkdir 一次试试。
 *
 * 结论：按候选顺序**真建一次**，第一个成功的就是它。
 */
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/**
 * 建一个隔离目录并返回路径。
 *
 * ⚠️ 候选里那条「工作区下的 .tmp-test」是**从 ROOT 往上找**的，不能写死深度：
 *    变异验证会把整个插件复制到 `.tmp-test/xxx/` 里再跑，
 *    那时 `ROOT/../.tmp-test` 会变成 `.tmp-test/.tmp-test`（不存在），
 *    于是所有候选全落空 —— 实测就是这么炸的。
 *    所以这里往上逐级找第一个**已存在且可写**的 `.tmp-test`；都找不到再退回系统临时目录。
 *
 * @param {string} prefix 目录名前缀（一眼看出是哪个测试建的）
 * @returns {string} 已创建的目录绝对路径
 */
export function makeIsolatedHome(prefix = 'tts-') {
  const candidates = []

  // ① 从 ROOT 往上逐级找已存在的 .tmp-test（最多 5 级，够覆盖「复制到 .tmp-test/x/ 再跑」）
  let cursor = ROOT
  for (let depth = 0; depth < 5; depth += 1) {
    candidates.push(join(cursor, '.tmp-test'))
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }

  // ② 再加系统临时目录
  candidates.push('C:/Windows/Temp', tmpdir())

  for (const base of candidates.filter((item) => typeof item === 'string' && item !== '')) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const name = join(base, `${prefix}${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
      try {
        mkdirSync(name, { recursive: false })
        return name
      } catch {
        // 这个候选/名字不行，换一个
      }
    }
  }
  // 走到这里说明全都建不了 —— 抛出去比静默降级好：
  // 静默降级会让测试读写真实的 ~/.dsh（事故复盘里就有这么一次）。
  throw new Error(
    '建不出隔离目录。候选都试过了：' + candidates.join(' / ')
    + '\n别改成用真实 HOME 跑测试 —— 那会读写你真实的 ~/.dsh。'
  )
}

/**
 * 把 HOME / USERPROFILE 指到隔离目录，并建好 `.dsh`。
 *
 * @param {string} prefix
 * @returns {string} 隔离 HOME 的路径
 */
export function useIsolatedHome(prefix = 'tts-') {
  const home = makeIsolatedHome(prefix)
  process.env.HOME = home
  process.env.USERPROFILE = home
  mkdirSync(join(home, '.dsh'), { recursive: true })
  return home
}
