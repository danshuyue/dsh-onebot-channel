/**
 * commands.js —— QQ 侧命令层。
 *
 * 为什么需要（2026-11-05 用户需求）：
 *   原来 QQ 里发来的每个字都只会变成「绑定会话的用户消息」。
 *   想看一眼别的会话干到哪了、或者把一句话说给另一个会话，压根没有入口 ——
 *   因为插件里根本没有「指令」这个概念。
 *
 * 三条设计红线：
 *   1. **命令不进会话、不产生回合、不烧 token。** 在插件内部消费掉，
 *      回复直接走 sendToQQ（→ callOneBot 唯一出口，白名单照旧生效）。
 *   2. **绝不吞用户的话。** 只认「整条消息以 prefix 开头 + 命令名精确命中」；
 *      不认识的 `/xxx` 原样投给会话（用户可能就是在聊天里打了个斜杠）。
 *   3. **编号不做持久承诺。** `/进度` 给的 1、2、3 存在一张带 TTL 的表里，
 *      过期就要求重发 `/进度`，绝不按新列表去解释旧编号。
 *      （幽灵编号比「请重发」糟糕一百倍：它会静默地把话投给错误的会话。）
 *
 * 这个模块只做「解析 + 生成回复文本」，不碰 ctx、不投递、不发网。
 * 真正执行（投递 / 发消息 / 落盘）由 poll.js 调用方做 —— 这样它能被纯单测。
 */
import { getConfig } from './config.js'
import { listProgress, readSessionDigest, describeOneLine, buildWorkspaceIndex, readWorkspaces, readProjCache } from './progress.js'

/** 命令回复的表最大存活时间。过期不猜，要求重发。 */
export const TABLE_TTL_MS = 10 * 60 * 1000

/** 表里最多记多少条（防止一次 `/进度` 撑爆 state）。 */
export const TABLE_MAX = 30

/**
 * 把一条消息文本解析成命令。
 *
 * @param text 消息纯文本
 * @param prefix 命令前缀（config.qqCommandPrefix）；空串 = 命令层关闭
 * @returns {{ name: string, arg: string } | null}
 *   null = 不是命令（原样投给会话）
 */
export function parseCommand(text, prefix) {
  const head = String(prefix ?? '')
  if (head === '') return null
  const body = String(text ?? '').trim()
  if (body === '' || !body.startsWith(head)) return null
  const rest = body.slice(head.length).trim()
  if (rest === '') return null
  // 只切第一个空白：`/看 3 备注` 的 arg 是 "3 备注"，由各命令自己再切。
  // ⚠️ `/去3` 这种「紧贴写法」在中文输入法下非常常见（不像英文会自然打空格），
  //   所以除了空白分隔，还要允许**命令名后面直接跟数字**：
  //   先按空白切，如果整段不是已知命令名、但以已知命令名开头且余下全是数字/中划线，
  //   就把它拆成 name + arg。纯 `/xxx` 仍然是未知命令（原样投给会话）。
  const match = /^(\S+)\s*([\s\S]*)$/.exec(rest)
  if (match === null) return null
  const whole = match[1]
  const arg = (match[2] ?? '').trim()
  if (arg !== '') return { name: whole.toLowerCase(), arg }
  // 无空白：考虑 `/去3` `/看12`
  const glued = /^([^\d\s]+?)(-?\d+)$/.exec(whole)
  if (glued !== null) return { name: glued[1].toLowerCase(), arg: glued[2] }
  return { name: whole.toLowerCase(), arg: '' }
}

/** 命令名 → 规范名（别名收敛在这里，未知命令原样返回小写）。 */
export function canonicalName(name) {
  const lower = String(name ?? '').toLowerCase()
  // ⚠️ 加了新命令**必须**在这里登记，否则 parseCommand 认得、dispatchCommand 不认，
  //    表现是「发了没反应」—— 它会被当成未知命令原样投给会话，用户完全看不出问题。
  const alias = {
    p: '进度', status: '进度', 进度: '进度',
    peek: '看', view: '看', 看: '看',
    go: '去', use: '去', 去: '去',
    back: '回', 回: '回',
    who: '在哪', where: '在哪', 在哪: '在哪',
    h: '帮助', help: '帮助', '?': '帮助', 帮助: '帮助'
  }
  return alias[lower] ?? ''
}

/**
 * 生成 `/进度` 的回复正文。
 *
 * @param ctx 宿主上下文
 * @param options { cwd, limit, idleWindowMs }
 * @returns { text, entries } entries 用于写编号表（`[{ n, sessionId, label }]`）
 */
export function renderProgress(ctx, options = {}) {
  const config = getConfig() ?? {}
  const limit = Number(options.limit) > 0 ? Math.floor(Number(options.limit)) : Number(config.progressMaxRows) || 12
  const idleWindowMs = Number(options.idleWindowMs) > 0 ? Number(options.idleWindowMs) : Number(config.progressIdleWindowMs) || 24 * 60 * 60 * 1000
  const cwd = String(options.cwd ?? '')

  let list
  try {
    list = listProgress(ctx, { cwd, limit, idleWindowMs })
  } catch (error) {
    return { text: `进度读不出来：${error instanceof Error ? error.message : error}`, entries: [] }
  }

  const rows = [...list.running, ...list.recent]
  if (rows.length === 0) {
    const hint = cwd === '' ? '' : `\n（只看了 ${cwd}；去掉工作区过滤用 /进度 全部）`
    return {
      text: `最近 ${Math.round(idleWindowMs / 3600000)} 小时内没有活跃会话。${hint}\n数据可能滞后几秒——投影缓存是延后写盘的。`,
      entries: []
    }
  }

  const entries = []
  const lines = []
  lines.push(`📊 正在跑 ${list.running.length} · 最近 ${list.recent.length}${list.total > rows.length ? ` · 共 ${list.total}` : ''}（数据可能滞后几秒）`)
  let currentCwd = null
  for (let index = 0; index < rows.length; index++) {
    const item = rows[index]
    const n = index + 1
    const wsTitle = item.workspaceTitle !== '' ? item.workspaceTitle : tailOf(item.cwd)
    if (wsTitle !== currentCwd) {
      currentCwd = wsTitle
      lines.push('')
      lines.push(`▍${wsTitle === '' ? '（未知工作区）' : wsTitle}`)
    }
    const state = item.running ? '运行中' : relTime(item.lastActiveAt)
    const turn = item.lastTurn > 0 ? `第 ${item.lastTurn} 轮` : '还没跑过'
    const todo = item.todos.total > 0 ? ` · 待办 ${item.todos.done}/${item.todos.total}` : ''
    lines.push(` ${n}  ${item.title}   ${turn} · ${state}${todo}`)
    if (item.todos.current !== '') lines.push(`     └ 正在做：${clip(item.todos.current, 40)}`)
    entries.push({ n, sessionId: item.sessionId, label: `${wsTitle}·${clip(item.title, 24)}` })
  }
  lines.push('')
  lines.push('发 /看 <编号> 看详情，/去 <编号> 把话说给它，/回 回到默认会话。')
  if (list.archivedSkipped > 0) lines.push(`（已跳过 ${list.archivedSkipped} 个归档会话）`)
  return { text: lines.join('\n'), entries }
}

/** 生成 `/看 <n>` 的回复正文。 */
export function renderPeek(ctx, entry) {
  const digest = readSessionDigest(ctx, entry.sessionId)
  if (digest.hasData !== true) {
    return `会话 ${entry.sessionId} 没有进度数据（可能刚建、还没跑过回合）。`
  }
  const lines = []
  lines.push(`📄 ${digest.title}`)
  if (digest.workspaceTitle !== '') lines.push(`工作区：${digest.workspaceTitle}`)
  if (digest.cwd !== '') lines.push(`目录：${digest.cwd}`)
  lines.push(`状态：${digest.running ? '运行中' : '空闲'} · 第 ${digest.lastTurn} 轮 / 共 ${digest.turns} 轮 · ${digest.steps} 步`)
  if (digest.goal !== '') lines.push(`目标：${clip(digest.goal, 120)}`)
  if (digest.todos.items.length > 0) {
    lines.push(`待办（${digest.todos.done}/${digest.todos.total}）：`)
    // 只列未完成的 + 最近完成的一条，否则长任务会刷屏
    const open = digest.todos.items.filter((item) => item.status !== 'completed')
    const shown = open.length > 0 ? open : digest.todos.items.slice(-1)
    for (const item of shown.slice(0, 8)) {
      const mark = item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '▶' : '·'
      lines.push(` ${mark} ${clip(item.content, 60)}`)
    }
    if (open.length > 8) lines.push(` … 还有 ${open.length - 8} 条未完成`)
  }
  if (digest.tokens.out > 0) lines.push(`输出 token：${fmtNum(digest.tokens.out)}`)
  if (digest.context.window > 0) {
    const pct = Math.round((digest.context.pressure / digest.context.window) * 100)
    lines.push(`上下文：${fmtNum(digest.context.pressure)} / ${fmtNum(digest.context.window)}（${pct}%）`)
  }
  if (digest.permissions.preset !== '') lines.push(`权限：${digest.permissions.preset}`)
  lines.push('')
  lines.push(`会话 id：${digest.sessionId}`)
  lines.push(`要跟它说话：/去 ${entry.n}`)
  return lines.join('\n')
}

/** 把 `/进度` 的 entries 编号化成表（供 `/看` `/去` 查）。 */
export function makeTable(entries, now = Date.now()) {
  const clean = Array.isArray(entries) ? entries.slice(0, TABLE_MAX) : []
  return { at: now, entries: clean }
}

/**
 * 从表里按编号取条目。
 * @returns {{ ok: true, entry } | { ok: false, reason: 'empty'|'expired'|'range', max }}
 */
export function lookupTable(table, n, now = Date.now()) {
  if (table === null || table === undefined || !Array.isArray(table.entries) || table.entries.length === 0) {
    return { ok: false, reason: 'empty', max: 0 }
  }
  if (now - Number(table.at ?? 0) > TABLE_TTL_MS) return { ok: false, reason: 'expired', max: table.entries.length }
  const wanted = Number(n)
  if (!Number.isFinite(wanted) || Math.floor(wanted) !== wanted) return { ok: false, reason: 'range', max: table.entries.length }
  const entry = table.entries.find((item) => Number(item.n) === wanted)
  if (entry === undefined) return { ok: false, reason: 'range', max: table.entries.length }
  return { ok: true, entry }
}

/** 帮助正文。 */
export function renderHelp(prefix, options = {}) {
  const p = String(prefix ?? '/')
  // ⚠️ 帮助文本必须跟**实际实现了什么**一致。
  //    列了没做的命令 = 用户发过去没反应，比不列更糟（这个插件踩过「设置页挂着死输入框」的坑）。
  //    featureFlags 由调用方传进来，没传就按「全都有」渲染（单测/纯函数场景）。
  const has = (name) => options.features === undefined || options.features[name] !== false
  const lines = ['可用命令（在 QQ 里直接发，不进会话、不花 token）：', '']
  if (has('progress')) lines.push(`${p}进度        列正在跑和最近活跃的会话（按工作区分组）`)
  if (has('peek')) lines.push(`${p}看 <编号>   看一个会话的详情：待办、最后状态、上下文压力`)
  if (has('go')) lines.push(`${p}去 <编号>   把接下来的话投给那个会话`)
  if (has('back')) lines.push(`${p}回          回到默认绑定的会话`)
  if (has('where')) lines.push(`${p}在哪        我现在在跟谁说话`)
  lines.push(`${p}帮助        这份说明`)
  lines.push('')
  lines.push('最省事的用法：直接**长按引用**某条带标签的回复，就回给发出它的那个会话，')
  lines.push('不用切焦点、不用记编号。标签长这样：〔工作区·会话〕')
  return lines.join('\n')
}

/** 从表里没取到时统一生成提示（三种失败原因分别说清）。 */
export function tableMissText(prefix, miss) {
  const p = String(prefix ?? '/')
  if (miss.reason === 'empty') return `还没有进度表——先发 ${p}进度。`
  if (miss.reason === 'expired') return `进度表超过 ${Math.round(TABLE_TTL_MS / 60000)} 分钟了，重新发 ${p}进度（不按旧编号猜）。`
  return `编号超出范围（1–${miss.max}）。发 ${p}进度 重看列表。`
}

/** 标题里的 cwd 尾巴（`D:\a\b\CMPOR` → `CMPOR`）。 */
function tailOf(path) {
  const parts = String(path ?? '').split(/[\\/]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : ''
}

/** 相对时间：刚/3 分钟/2 小时/4 天前。 */
export function relTime(at) {
  const ms = Number(at)
  if (!Number.isFinite(ms) || ms <= 0) return '未知'
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.round(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.round(diff / 3600_000)} 小时前`
  return `${Math.round(diff / 86_400_000)} 天前`
}

/** 截断（按字符数，末尾加省略号）。 */
export function clip(text, max) {
  const str = String(text ?? '')
  const limit = Number(max) > 0 ? Number(max) : 40
  return str.length <= limit ? str : `${str.slice(0, limit)}…`
}

/** 数字千分位（`1234` → `1,234`）。 */
function fmtNum(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return '0'
  return Math.round(num).toLocaleString('en-US')
}
