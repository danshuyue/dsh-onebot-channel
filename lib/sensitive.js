/**
 * sensitive.js —— 出站内容审计（本机路径 / 凭据特征）。
 *
 * 为什么需要（2026-10-28）：
 *   回复正文是直接发进 QQ 群的。agent 完全可能在回答里顺嘴写出
 *   「我看了 C:\Users\xxx\.dsh\qq-bridge.config.json」「token 是 xxxx 这样」——
 *   这就把本机路径和凭据送到了群里。工具层没有这道闸，等于所有出站都是裸奔。
 *
 * 和 allowlist.js 的分工：
 *   · allowlist：**发给谁**（目标）
 *   · 本文件：**发什么**（内容）
 *   两道闸互相独立，缺一道就漏一种。
 *
 * ⚠️ 为什么**不**匹配裸的 32 位十六进制串（比如 /[0-9a-f]{32}/）：
 *   本插件的表情包文件名就是 MD5，图片 URL 里也全是十六进制串。
 *   加上这条会把正常的表情和消息整条拦掉 —— 误伤面远大于收益。
 *   真要防令牌泄漏，请走「已知令牌精确比对」，别把启发式正则当万能。
 *
 * 凭据关键词必须**带赋值关系**（`token=xxx` / `密码：xxx`）才算命中，
 * 这样群里正常聊「我密码忘了」「token 是什么意思」不会被拦。
 */

/**
 * 本机路径 + 凭据赋值特征。
 *
 * 拆解：
 *   · `[A-Za-z]:[\\/]xxx`        Windows 盘符路径（前面不能紧跟字母数字，避免误伤 URL 里的 a:/）
 *   · `\\\\host\\share`          UNC 路径（主机名与共享名之间只有一个反斜杠）
 *   · `/home/` `/Users/` `/etc/` `/var/` `/root/`  常见 Unix 路径
 *   · 凭据关键词 + 赋值         token / 密码 / 密钥 / password / secret / api_key / bearer ...
 *
 * ⚠️ 赋值后面的取值**限定成 ASCII 字母数字串**（`[A-Za-z0-9_\-./+]{4,}`），
 *   不能用「任意非空白字符」—— 那样「token 是什么意思」会命中
 *   （关键词 token + 连接词「是」+「什么意思」），把正常聊天整条拦掉。
 *   真实凭据不会是中文短语，限定 ASCII 就够了。
 */
const ASSIGN_CHARS = '[A-Za-z0-9_\\-./+]'
const ASSIGN_VALUE = `${ASSIGN_CHARS}{4,}`

export const SENSITIVE_RE = new RegExp(
  '('
  + '(?<![A-Za-z0-9])[A-Za-z]:[\\\\/][^\\s"\'<>|]+' // Windows 盘符路径
  + '|\\\\\\\\[^\\\\\\s"\'<>|]+\\\\[^\\s"\'<>|]+' // UNC
  + '|(?<![A-Za-z0-9])(?:/home/|/Users/|/etc/|/var/|/root/)[^\\s"\'<>|]*' // Unix 路径
  + '|(?:token|密码|密钥|口令|password|passwd|secret|api[_-]?key|authorization|bearer|access[_-]?key|credential)'
  + '["\']?(?:\\s*(?:[:=：]|是|为)\\s*["\']?' + ASSIGN_VALUE // 带赋值
  + '|\\s+(?=' + ASSIGN_CHARS + '{6,}))' // 或「token abcdef...」这种空格分隔的长串
  + ')',
  'i'
)

/** 凭据类关键词（命中时给更明确的提示，路径类则说路径）。 */
const CREDENTIAL_RE = /token|密码|密钥|口令|password|passwd|secret|api[_-]?key|authorization|bearer|access[_-]?key|credential/i

/**
 * 把命中片段打码：只留头尾。
 *
 * ⚠️ 日志本身也是落盘的 —— 审计日志里再写一遍明文凭据就白干了。
 * 所以这里只给「长什么样」的线索，不给原文。
 */
export function maskHit(hit) {
  const text = String(hit ?? '')
  if (text.length <= 6) return '***'
  return `${text.slice(0, 3)}***${text.slice(-2)}（共 ${text.length} 字符）`
}

/**
 * 检查一段出站文本。
 *
 * @param {string} text 要发出去的正文
 * @returns {{kind:'path'|'credential', sample:string} | null} 命中信息；null = 干净
 */
export function findSensitive(text) {
  const body = String(text ?? '')
  if (body === '') return null
  const match = SENSITIVE_RE.exec(body)
  if (match === null) return null
  const hit = String(match[0] ?? '')
  return {
    kind: CREDENTIAL_RE.test(hit) ? 'credential' : 'path',
    sample: maskHit(hit)
  }
}

/**
 * 审计闸：命中就抛错，让上层拒绝发送。
 *
 * 抛错而不是「打码后照发」是**故意的**：
 *   ① 打码后句子会变得莫名其妙（「我看了 C:***」），不如干脆不发；
 *   ② 抛错能让 agent 知道自己踩线了，她会换个说法重讲；
 *   ③ 悄悄打码发送会让人误以为闸门没生效。
 */
export function assertClean(text, where = '出站') {
  const hit = findSensitive(text)
  if (hit === null) return
  const what = hit.kind === 'credential' ? '凭据特征' : '本机路径'
  throw new Error(
    `${where}内容被审计拦截：${what}（${hit.sample}）。`
    + '这条消息没有发出去。请换一种不含本机路径 / 令牌 / 配置内容的说法重讲。'
  )
}
