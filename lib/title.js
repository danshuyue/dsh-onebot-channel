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
 * 扫落盘目录拿全部会话（没打开的也能选，标题从日志里抠）。
 * 这是会话列表的兜底来源：sessions 服务只列「活着」的会话。
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
