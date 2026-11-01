/**
 * archive.js —— 识别 DSH 里「已归档」的会话，别往用户收起来的会话里投消息。
 *
 * 为什么需要（0.12.0）：
 *   DSH 的「归档」只是把会话从侧栏移走，**磁盘目录还在**。
 *   而插件列会话有两个来源（见 sessions.js 的头注释）：
 *     ① sessions 服务 —— 只有活着的会话
 *     ② 直接扫 ~/.dsh/sessions/<cwd编码>/ —— 全部会话，**完全不认归档**
 *   于是归档会话照样出现在设置页下拉里、能被绑上；更糟的是「昨天绑的会话今天被归档」，
 *   消息会一直投进一个用户以为已经收起来的会话，而日志里一切正常。
 *
 * ⚠️ 为什么读文件而不是问 DSH：
 *   权威来源是 `ctx.workspaceRegistry.archivedSessionIds`，但 workspaceRegistry
 *   **不在本插件的 inject 清单里**（lib/index.js 的 inject 数组），
 *   `ctx.get('workspaceRegistry')` 会直接抛 "cannot get property X without inject"。
 *   而 inject 清单是插件安装时声明的，为了读一个归档集合去扩大 inject 面并不划算。
 *   所以这里直接读 `~/.dsh/storages/workspace.json` 的 `global.archivedSessionIds` ——
 *   跟 workspaceRegistry 是同一个数据源，只是绕开了 inject。
 *   如果哪天 inject 里加上了 workspaceRegistry，应改用它（更正统，还能自动跟随变更）。
 *
 * 健壮性：归档是「锦上添花」的功能，任何读取失败都退化成「没有归档」，
 * 绝不能让一个坏掉的 workspace.json 把整条投递链路拖垮。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR, note } from './env.js'

const WORKSPACE_FILE = join(DATA_DIR, 'storages', 'workspace.json')

/**
 * 缓存。投递是**每条消息都走**（deliver 的候选循环里要判），
 * 不缓存的话群消息密集时每秒会读好几次盘。
 */
const CACHE_MS = 5000
let cache = { at: 0, ids: new Set() }
/** 「读不到」的日志只记一次，否则每条消息刷一行。 */
let warnedOnce = false

/** 当前已归档的会话 id 集合（缓存 5 秒）。读不到就返回空集合。 */
export function archivedSessionIds() {
  const now = Date.now()
  if (now - cache.at < CACHE_MS) return cache.ids
  try {
    const data = JSON.parse(readFileSync(WORKSPACE_FILE, 'utf8'))
    const ids = Array.isArray(data?.global?.archivedSessionIds) ? data.global.archivedSessionIds : []
    cache = {
      at: now,
      ids: new Set(ids.filter((id) => typeof id === 'string' && id !== ''))
    }
    if (cache.ids.size > 0) note('archive', `读到 ${cache.ids.size} 个归档会话`)
  } catch (error) {
    // 文件不存在 / JSON 坏 / 结构变了 —— 一律退化成「没有归档」
    if (!warnedOnce) {
      warnedOnce = true
      note('archive', `读不到归档集合（当作无归档）：${error instanceof Error ? error.message : error}`)
    }
    cache = { at: now, ids: new Set() }
  }
  return cache.ids
}

/** 这个会话是不是已归档。空 id 一律 false（不是「已归档」，是「没有 id」）。 */
export function isArchived(sessionId) {
  const id = String(sessionId ?? '').trim()
  if (id === '') return false
  return archivedSessionIds().has(id)
}

/** 手动失效缓存（测试用；运行时不调，5 秒自然过期）。 */
export function invalidateArchiveCache() {
  cache = { at: 0, ids: new Set() }
}
