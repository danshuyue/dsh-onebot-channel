/**
 * emoji-mark.js —— 文本里的表情标记解析。
 *
 * 标记语法：`[表情:呲牙]`、`[表情:13]`、`[表情包:猫]`。
 *
 * 为什么要有这个：
 *   1. qq_send 工具的 emoji 参数只能带**一个**表情，
 *      而 agent 一句话里可能想表达好几个（"搞定了[表情:OK][表情:庆祝]"）。
 *   2. 自动转发链路（outbound.flushOutbound）拿的是 agent 的纯文本正文，
 *      那条路没有工具参数可用 —— 只能靠正文里的标记。
 *
 * 所以两条路都支持：
 *   - 工具参数 emoji：一次一个，附在最后一句后面
 *   - 正文标记：多个，按出现位置插在对应位置
 *
 * 标记解析后会被**从正文里摘掉** —— 不然 QQ 上会出现"[表情:呲牙]"这种明文。
 */
import { faceIdOf } from './emoticons.js'
import { resolveFaceId } from './face-resolve.js'
import { note } from './env.js'

/**
 * 匹配一个表情标记。返回 null 表示不是标记。
 * 形如 [表情:xxx] / [表情包:xxx] / [emoji:xxx]
 */
const MARK_RE = /\[(?:表情|表情包|emoji)\s*[:：]\s*([^\]]{1,40})\]/gi

/**
 * 把正文里的表情标记拆成「纯文本部分」和「表情序列」——**同步版**，只用内置表。
 *
 * 保留它是因为它是纯函数、便于单测；真正发消息走的是下面的异步版
 * （异步版会先查 QQ 官方表情目录，内置表兜底）。
 *
 * @param {string} text
 * @returns {{ text: string, faces: Array<{ id: number, name: string, index: number }> }}
 *   index 是该表情在**去掉标记后的文本**里的字符位置（用来决定附在哪条消息上）
 */
export function splitEmojiMarks(text) {
  const source = String(text ?? '')
  const faces = []
  let plain = ''
  let last = 0
  MARK_RE.lastIndex = 0
  let match = MARK_RE.exec(source)
  while (match !== null) {
    plain += source.slice(last, match.index)
    const raw = match[1].trim()
    const id = faceIdOf(raw)
    if (id !== null) {
      faces.push({ id, name: raw, index: plain.length })
    }
    // 认不出来的标记也摘掉？留着会让 QQ 上出现明文标记，更难看。
    last = match.index + match[0].length
    match = MARK_RE.exec(source)
  }
  plain += source.slice(last)
  return { text: plain.trim(), faces }
}

/**
 * 异步版标记解析：**先查 QQ 官方表情目录，查不到再落内置表**。
 *
 * 为什么需要异步：官方目录是协议端 action（HTTP），而内置表是静态的。
 * 官方目录里有内置表没有的新表情，也能认得官方写法。
 *
 * 认不出来的标记：照样从正文摘掉（不然 QQ 上出现"[表情:xxx]"明文更难看），
 * 但不生成表情段 —— 少一个表情总比发错表情强。
 *
 * ⚠️ 2026-10-27：这里必须**吞掉解析异常**，不能让一个表情标记把整条消息搞没。
 *   协议端遇到无效的 face id 会报 OIDB 错误，**整条消息发不出去** ——
 *   实测她的两条回复（「[表情:晕]」这种）直接被吞了，文字也没发出去。
 *   所以解析不出来就当没有这个表情，文字照发。
 */
export async function splitEmojiMarksAsync(text) {
  const source = String(text ?? '')
  const faces = []
  let plain = ''
  let last = 0
  MARK_RE.lastIndex = 0
  let match = MARK_RE.exec(source)
  while (match !== null) {
    plain += source.slice(last, match.index)
    const raw = match[1].trim()
    try {
      const id = await resolveFaceId(raw)
      faces.push({ id, name: raw, index: plain.length })
    } catch (error) {
      // 记一笔，别静默丢 —— 出问题时日志里能看到「她想发表情但发不出去」
      note('emoji', `表情「${raw}」无法发送，已跳过：${error instanceof Error ? error.message : error}`)
    }
    last = match.index + match[0].length
    match = MARK_RE.exec(source)
  }
  plain += source.slice(last)
  return { text: plain.trim(), faces }
}

/**
 * 把表情按位置分配到若干条文本消息里。
 *
 * 规则（对应「小表情跟随前一句话」）：
 *   表情挂在**它前面那条**消息末尾；开头的表情挂第一条。
 *
 * @param {string[]} parts 已分条好的文本
 * @param {Array<{ index: number }>} faces 带位置的表情
 * @returns {Array<{ part: string, faces: number[] }>} 每条消息 + 附在它末尾的表情编号
 */
export function attachFacesToParts(parts, faces) {
  const result = parts.map((part) => ({ part, faces: [] }))
  if (result.length === 0) return result
  // 每条消息的结束位置（累计字符数）
  const ends = []
  let acc = 0
  for (const part of parts) {
    acc += part.length
    ends.push(acc)
  }
  for (const face of faces) {
    // face.index = 标记前面有多少个纯文本字符，也就是表情「贴」在哪个位置。
    // 归属规则：表情跟在**它前面那句话**后面 ——
    //   「第一句[表情:X]。第二句」→ index=3，落在第一条范围内 → 挂第一条
    //   「第一句。第二句[表情:X]」→ index=8，落在第二条末尾 → 挂第二条
    // 所以条件是「第一条结束位置 ≥ 表情位置」，用 <= 而不是 <：
    // 表情正好在句末（index == 结束位置）时显然属于那一句。
    let target = result[result.length - 1]
    for (let i = 0; i < result.length; i += 1) {
      if (face.index <= ends[i]) {
        target = result[i]
        break
      }
    }
    target.faces.push(face.id)
  }
  return result
}
