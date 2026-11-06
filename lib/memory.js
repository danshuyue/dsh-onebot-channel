/**
 * memory.js ——「对谁的认识」落盘（关系卡）。
 *
 * 原来是内存 Map：进程一重启就失忆 —— 昨天聊过的喜好、怎么称呼他、聊到哪儿，
 * 全没了。真人不会这样，第二天见面还记得你是谁。
 *
 * 所以把「这个 QQ 号 / 这个群在我心里是什么样」落到 ~/.dsh/qq-bridge-memory.json：
 *   nick      怎么称呼他 / 这个群（模型可改，入站昵称也会自动补）
 *   facts     关于他 / 它的事实（喜欢什么、做过什么、在意什么），最多 8 条
 *   count     说过多少句话（自动记）
 *   lastSeen  最后一次说话的时间（自动记）
 *
 * 设计红线（跟 closure.js 一致的三条）：
 *   1. 纯本地 I/O，不碰网络；读坏了**不静默清空**（保留原文件，人能捞回来）。
 *   2. 注入正文必须短：一张卡最多带 4 条、约 180 字 ——
 *      记忆卡是**常驻**的（不像收尾提示只带一次），放任它膨胀就是每回合烧 token。
 *   3. 模型能主动记（qq_remember），也能被自动记（入站昵称、说话次数）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR, note } from './env.js'

/** 关系卡文件。单独一个文件，不塞进 state（loadState 会重建整个对象）。 */
export const MEMORY_FILE = join(DATA_DIR, 'qq-bridge-memory.json')

/** 当前实际读写路径（测试可以临时改走，避免污染真实记忆）。 */
let memoryFile = MEMORY_FILE

/** 测试用：把读写路径换到临时文件，并清掉内存缓存。传空 = 恢复默认。 */
export function useMemoryFile(path) {
  memoryFile = typeof path === 'string' && path !== '' ? path : MEMORY_FILE
  table = null
}

/** 一张卡最多留多少条事实（多了挤掉最老的）。 */
const MAX_FACTS = 8
/** 单条事实最长多少字。 */
const MAX_FACT_LEN = 120
/** 注入正文时最多带几条事实。 */
const INJECT_FACTS = 4
/** 注入正文时「记得」那一段的字数上限。 */
const INJECT_CHARS = 180
/** 称呼最长多少字。 */
const MAX_NICK_LEN = 40

let table = null

/**
 * 写节流：touchPeer 在每条消息投递成功后都调用，群消息密集时可能几秒内触发十几次，
 * 每次都 writeFileSync 是不必要的磁盘 I/O。30 秒内只写一次，脏数据攒在内存里。
 */
const PERSIST_INTERVAL_MS = 30_000
let persistTimer = null
let persistDirty = false

function loadTable() {
  if (table !== null) return table
  table = {}
  try {
    if (existsSync(memoryFile)) {
      const parsed = JSON.parse(readFileSync(memoryFile, 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) table = parsed
    }
  } catch (error) {
    // 读坏了不静默当空：留一条日志，原文件不动，让人能自己修/捞
    note('memory', `关系卡读坏了（保留原文件）：${error instanceof Error ? error.message : error}`)
  }
  return table
}

function persist() {
  persistDirty = true
  if (persistTimer !== null) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    if (!persistDirty) return
    persistDirty = false
    try {
      writeFileSync(memoryFile, JSON.stringify(table, null, 2), 'utf8')
    } catch (error) {
      note('memory', `关系卡写失败：${error instanceof Error ? error.message : error}`)
    }
  }, PERSIST_INTERVAL_MS)
}

/** 立刻把内存态写盘（插件卸载 / 进程退出前调用，防丢数据）。 */
export function flushPersist() {
  if (persistTimer !== null) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  if (!persistDirty) return
  persistDirty = false
  try {
    writeFileSync(memoryFile, JSON.stringify(table, null, 2), 'utf8')
  } catch (error) {
    note('memory', `关系卡 flush 失败：${error instanceof Error ? error.message : error}`)
  }
}

function cardOf(key) {
  const card = loadTable()[key]
  return card !== null && typeof card === 'object' && !Array.isArray(card) ? card : null
}

/** 取一张卡（没有就 null）。 */
export function loadMemory(key) {
  if (typeof key !== 'string' || key === '') return null
  return cardOf(key)
}

/**
 * 记一条关于某人 / 某群的东西。
 * @param {string} key `private:123` / `group:456`
 * @param {{nick?: string, fact?: string}} patch
 * @returns {boolean} 有没有写进去
 */
export function remember(key, patch) {
  if (typeof key !== 'string' || key === '') return false
  const t = loadTable()
  const card = cardOf(key) ?? {}

  const nick = String(patch?.nick ?? '').trim().slice(0, MAX_NICK_LEN)
  if (nick !== '') card.nick = nick

  const fact = String(patch?.fact ?? '').trim().slice(0, MAX_FACT_LEN)
  if (fact !== '') {
    const facts = Array.isArray(card.facts) ? card.facts : []
    // 同一条事实不重复记（按文本去重；措辞变了算新的一条）
    if (!facts.some((item) => String(item?.text ?? '') === fact)) {
      facts.push({ at: Date.now(), text: fact })
      card.facts = facts.slice(-MAX_FACTS)
    }
  }

  if (nick === '' && fact === '') return false
  card.updatedAt = Date.now()
  t[key] = card
  persist()
  return true
}

/**
 * 入站时自动记：昵称、说话次数、最后说话时间。
 * 只在**真正投递**的消息上调用（不是每条群消息），写盘频率可控。
 */
export function touchPeer(key, info = {}) {
  if (typeof key !== 'string' || key === '') return false
  const t = loadTable()
  const card = cardOf(key) ?? {}
  const nick = String(info?.nick ?? '').trim().slice(0, MAX_NICK_LEN)
  if (nick !== '') card.nick = nick
  card.count = (Number(card.count) || 0) + 1
  card.lastSeen = Date.now()
  t[key] = card
  persist()
  return true
}

/**
 * 把一张卡压成给模型看的一两行（没有卡返回空串）。
 * 长度受 INJECT_FACTS / INJECT_CHARS 限制 —— 它会被拼进**每回合**的正文。
 */
export function describeMemory(key) {
  if (typeof key !== 'string' || key === '') return ''
  const card = cardOf(key)
  if (card === null) return ''

  const lines = []
  if (typeof card.nick === 'string' && card.nick !== '') lines.push(`称呼：${card.nick}`)

  const facts = Array.isArray(card.facts) ? card.facts.slice(-INJECT_FACTS) : []
  if (facts.length > 0) {
    let text = facts
      .map((item) => String(item?.text ?? '').trim())
      .filter((s) => s !== '')
      .join('；')
    if (text.length > INJECT_CHARS) text = `${text.slice(0, INJECT_CHARS)}…`
    if (text !== '') lines.push(`记得：${text}`)
  }

  if (lines.length === 0) return ''
  const subject = key.startsWith('group:') ? '关于这个群' : '关于他'
  return `（${subject}：${lines.join('；')}）`
}

/** 清空内存态（测试用；不删磁盘文件）。 */
export function clearMemory() {
  table = {}
}

/**
 * 设置页用的摘要：有多少张卡、各自记了几条。
 * 只返回能给人看的字段 —— 不把整段事实吐到 /state 里，那会让设置页越来越慢。
 */
export function memorySummary() {
  const t = loadTable()
  const peers = []
  for (const [key, card] of Object.entries(t)) {
    if (card === null || typeof card !== 'object') continue
    const nick = typeof card.nick === 'string' ? card.nick : ''
    const facts = Array.isArray(card.facts) ? card.facts.length : 0
    peers.push({
      key,
      nick,
      facts,
      count: Number(card.count) || 0,
      lastSeen: Number(card.lastSeen) || 0
    })
  }
  // 最近说过的排前面（设置页只显示前几条，不铺满）
  peers.sort((a, b) => b.lastSeen - a.lastSeen)
  return { file: memoryFile, count: peers.length, peers: peers.slice(0, 20) }
}

/**
 * 「她把我忘了」：清空整表并删掉落盘文件。
 * 和 clearMemory 的区别是它**真的动磁盘**，所以只给设置页的显式确认按钮用。
 */
export function wipeMemory() {
  table = {}
  try {
    if (existsSync(memoryFile)) {
      writeFileSync(memoryFile, '{}\n', 'utf8')
    }
    note('memory', '关系卡已被设置页清空')
    return true
  } catch (error) {
    note('memory', `关系卡清空失败：${error instanceof Error ? error.message : error}`)
    return false
  }
}

/** 关系卡文件的路径（给设置页显示「在哪儿」）。 */
export function memoryFilePath() {
  return memoryFile
}

/**
 * 读原始 JSON 文本（设置页的「编辑原始文件」用，2026-11-06）。
 *
 * 为什么给原始文本而不是结构化对象：结构一旦抄进界面，schema 改动就要改两处，
 * 迟早不一致。直接让人编辑文件内容更省事，代价是需要一个校验 —— 见 saveMemoryRaw。
 *
 * 文件不存在返回 `'{}'`（不是空串）：空串在编辑器里看着像「坏了」，
 * 而 `{}` 明确表达「现在是空的」。
 */
export function readMemoryRaw() {
  try {
    if (!existsSync(memoryFile)) return { ok: true, text: '{}\n' }
    return { ok: true, text: readFileSync(memoryFile, 'utf8') }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `读不到关系卡文件（${message}）` }
  }
}

/**
 * 校验并保存原始 JSON 文本（2026-11-06）。
 *
 * 校验到什么程度：只查「是不是一个 JSON 对象」。不逐字段校验形状 ——
 * describeMemory / memorySummary 对坏字段本来就是宽容的（`cardOf` 返回 null 就跳过、
 * 字段不是字符串就当空），所以最坏结果是「这条记忆不生效」，不会崩。
 * 这一点在 docs/提示词现状-2026-11-06.md §7.3 里写过，是**有意**的选择。
 *
 * ⚠️ 校验失败**不动原文件**：宁可让用户改到对为止，也不能把一个坏 JSON 写进去
 *    把之前攒的记忆全冲掉。
 */
export function saveMemoryRaw(text) {
  const body = String(text ?? '')
  if (body.trim() === '') return { ok: false, error: '内容是空的。要清空请用「清空记忆」，别存空文件' }

  let parsed
  try {
    parsed = JSON.parse(body)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `不是合法 JSON（${message}）` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '最外层必须是一个对象，形如 {"private:123": {...}}' }
  }

  try {
    writeFileSync(memoryFile, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `写不进关系卡文件（${message}）` }
  }

  // 内存态作废，下次读会重新从盘上载入 —— 否则刚存的东西要等重启才生效
  table = null
  note('memory', `关系卡已被设置页手动改写（${Object.keys(parsed).length} 张卡）`)
  return { ok: true, count: Object.keys(parsed).length }
}
