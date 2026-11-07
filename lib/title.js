/**
 * title.js —— 从落盘的会话日志里抠标题（设置页列表用）。
 *
 * 标题不是 header 字段，是日志里的 `session/title` 事件（data.title），取最后一条。
 * 没有标题事件就退回首条用户消息的前半句 —— 总比显示一串 id 强。
 *
 * 日志是多帧 zstd 拼接，得按 magic 28 B5 2F FD 切帧逐帧解。
 * 结果按 (size, mtime) 缓存：标题不变就不重复解压。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { note } from './env.js'

const TITLE_CACHE = new Map()
const TITLE_MAX_BYTES = 16 * 1024 * 1024

/**
 * 实测落盘目录命名规则：先把 : \ / 的连续段压成一个 -，
 * 再把非 [A-Za-z0-9._-] 转成 ~XXXX，最后两侧包 --。
 * 例：D:\DSH workspace\QQ -> --D-DSH~0020workspace-QQ~5BF9~8BDD--
 */
export function encodeCwdDir(cwd) {
  const body = String(cwd)
    .replace(/[:\\/]+/g, '-')
    .replace(/[^A-Za-z0-9._-]/g, (ch) => '~' + ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'))
  return '--' + body + '--'
}

/** 路径比较用：大小写、斜杠方向、结尾斜杠都可能不一致，先归一化再比。 */
export function normCwd(value) {
  return String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function decodeZstdFrames(buf) {
  const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
      starts.push(i)
    }
  }
  const lines = []
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i]
    const to = i + 1 < starts.length ? starts[i + 1] : buf.length
    try {
      const text = zstdDecompressSync(buf.subarray(from, to)).toString('utf8')
      for (const line of text.split('\n')) if (line !== '') lines.push(line)
    } catch {
      // 末尾可能是正在写的半帧，跳过就行
    }
  }
  return lines
}

/** 从一条 user/message 里抽第一段纯文本。 */
function firstTextOf(messageEvent) {
  const blocks = messageEvent?.data?.content
  if (Array.isArray(blocks) !== true) return ''
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') return block.text
  }
  return ''
}

export function readTitleFromLog(file) {
  let stat
  try {
    stat = statSync(file)
  } catch {
    return ''
  }
  if (stat.size > TITLE_MAX_BYTES) return ''
  const key = `${stat.size}:${Math.round(stat.mtimeMs)}`
  const cached = TITLE_CACHE.get(file)
  if (cached !== undefined && cached.key === key) return cached.title

  let title = ''
  try {
    const lines = decodeZstdFrames(readFileSync(file))
    let firstMessage = ''
    for (const line of lines) {
      // 取最后一条标题事件（后面的会覆盖前面的，跟 foldSessionTitle 一个口径）
      if (line.includes('"session/title"')) {
        try {
          const event = JSON.parse(line)
          if (event?.type === 'session/title' && typeof event.data?.title === 'string') title = event.data.title
        } catch {}
        continue
      }
      if (firstMessage === '' && line.includes('"user/message"')) {
        try {
          const event = JSON.parse(line)
          if (event?.type === 'user/message') firstMessage = firstTextOf(event)
        } catch {}
      }
    }
    if (title === '' && firstMessage !== '') {
      // 首条消息可能很长，截到第一个标点或 24 个字
      title = firstMessage.split(/[。！？!?\n]/)[0].slice(0, 24)
    }
    // 一行消息都没有的空壳会话（早期自动建会话的遗留），明说一句，别让人以为是坏数据
    if (title === '') title = '（空会话，没有消息）'
  } catch (error) {
    note('api', `读标题失败 ${file}: ${error instanceof Error ? error.message : error}`)
  }

  title = String(title).trim()
  TITLE_CACHE.set(file, { key, title })
  return title
}

/**
 * 按**会话 id** 去落盘目录里找它的标题（2026-11-06）。
 *
 * 为什么需要这个：`listLiveSessions` 的标题靠 `sessionTitle` 服务，但
 *   · 服务没 inject 时 serviceOf 抛错 → titleSvc = undefined
 *   · 而活着的会话对象上**没有 title 字段**（标题在投影里）
 * 于是 title 恒空，前端 sessionLabel 兜底显示 `#43de6086`。
 *
 * 扫盘那条路（scanSessionDirs）只在 workspaceCwd 非空且有值时兜得住，
 * 而「按 id 找」不依赖任何配置 —— 只要会话日志还在，就一定找得到。
 *
 * ⚠️ **只按需调用**（标题为空时才调），绝不整棵 sessions 树全扫：
 *    实测直接扫全部工作区是 342 个会话 / 8.3 秒，那会把 /state 拖回卡死的状态。
 *    这里只在这个 id 名下的少数几个候选目录上 stat —— 通常 1~3 次文件探测。
 *
 * @param id  会话 id（可能带 `session-` 前缀，也可能不带）
 * @returns 标题；找不到返回空串
 */
export function titleByIdFromDisk(id) {
  const bare = String(id ?? '').trim().replace(/^session-/, '')
  if (bare === '') return ''
  const root = join(homedir(), '.dsh', 'sessions')
  // 同一个会话在不同工作区目录下的写法可能带/不带 session- 前缀，两种都试
  const names = [`session-${bare}`, bare]
  let top
  try {
    top = readdirSync(root, { withFileTypes: true })
  } catch {
    return ''
  }
  for (const ws of top) {
    if (ws.isDirectory() !== true) continue
    for (const name of names) {
      const file = join(root, ws.name, name, 'session.v4.jsonl.zstd')
      try {
        statSync(file)
      } catch {
        continue // 这个工作区下没有这个会话，正常
      }
      const title = readTitleFromLog(file)
      // 命中就返回。空标题也返回空 —— 别继续找，
      // 因为同一个会话不会在两个工作区里有两份不同标题。
      return title
    }
  }
  return ''
}

/**
 * 扫落盘目录拿全部会话（没打开的也能选，标题从日志里抠）。
 * 这是会话列表的兜底来源：sessions 服务只列「活着」的会话。
 *
 * ⚠️ `want === ''` 时**返回空**（不扫全部工作区）。
 *    历史原因：空串 = 「不筛工作区」，而扫全部实测是 342 个会话 / 8.3 秒 —— 太慢。
 *    空工作区下缺标题的会话由 listWorkspaceSessions 用 titleByIdFromDisk 按 id 补，
 *    那样只探测少数几个目录，不会拖慢 /state。
 */
export function scanSessionDirs(want) {
  const out = []
  if (want === '') return out
  const dir = join(homedir(), '.dsh', 'sessions', encodeCwdDir(want))
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    note('api', `扫盘跳过 ${dir}: ${error instanceof Error ? error.message : error}`)
    return out
  }
  for (const entry of entries) {
    if (entry.isDirectory() !== true) continue
    const sessionDir = join(dir, entry.name)
    let updatedAt = ''
    try {
      updatedAt = new Date(statSync(sessionDir).mtimeMs).toISOString()
    } catch {}
    out.push({
      id: entry.name,
      title: readTitleFromLog(join(sessionDir, 'session.v4.jsonl.zstd')),
      cwd: want,
      updatedAt
    })
  }
  return out
}
