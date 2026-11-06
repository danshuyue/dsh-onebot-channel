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

/**
 * 已知服务商的 key 形状（2026-11-07 加，0.19.0）。
 *
 * ## 为什么需要这一条
 *
 * 原有规则全是「关键词 + 赋值」，它有个结构性盲区：**认不出 key 本身**。
 * 实测（用真实 Breeze key 跑的）：
 *
 *   `brz_AAAA1111BBBB2222CCCC3333DDDD4444`       → 漏（裸 key）
 *   `api key: brz_...`（api 和 key 之间有空格）    → 漏
 *   `API KEY = brz_...`                           → 漏
 *   `key: brz_...`                                → 漏
 *   `the api key is brz_...`                      → 漏
 *   `apikey: brz_...`                             → 抓到
 *   `xi-api-key: brz_...`                         → 抓到
 *
 * 两个根因：① 关键词是 `api[_-]?key`，**不允许中间那个空格** ——
 * 而人写英文时最自然的恰恰是带空格那个；② 裸 key 完全不在特征库里。
 *
 * 语音功能上线后模型手里就攥着一个 `brz_` key，而它经常在解释
 * 「我在干嘛」时顺嘴写出来 —— 这正是本文件头声明要挡的那件事。
 *
 * ## 为什么不用宽正则
 *
 * 本文件头明确警告过：表情包文件名是 MD5、图片 URL 全是十六进制串，
 * 加 `/[0-9a-f]{32}/` 这类宽正则会误伤正常消息。所以这里只列
 * **前缀足够独特**的真实 key 形状，宁缺毋滥。
 */
const KNOWN_KEY_PATTERNS = [
  // Breeze Blue：brz_ + 32 位字母数字（实测 36 字符总长）
  /(?<![A-Za-z0-9])brz_[A-Za-z0-9]{24,}/,
  // OpenAI 风格：sk- 后跟 20 位以上（含中转站的 sk-xxx 变体）
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/
]

export const SENSITIVE_RE = new RegExp(
  '('
  + '(?<![A-Za-z0-9])[A-Za-z]:[\\\\/][^\\s"\'<>|]+' // Windows 盘符路径
  + '|\\\\\\\\[^\\\\\\s"\'<>|]+\\\\[^\\s"\'<>|]+' // UNC
  + '|(?<![A-Za-z0-9])(?:/home/|/Users/|/etc/|/var/|/root/)[^\\s"\'<>|]*' // Unix 路径
  // 关键词 + 赋值。⚠️ `api\\s+key` 必须单列 —— `api[_-]?key` 匹配不到带空格的写法，
  // 而「api key: xxx」是最常见的那种。`key` 单独也收（但要求后面紧跟赋值，
  // 所以「this key is important」这种自然句不会被误伤）。
  + '|(?:token|密码|密钥|口令|password|passwd|secret|api[_-]?key|api\\s+key'
  + '|authorization|bearer|access[_-]?key|credential'
  + '|(?<![A-Za-z0-9])(?:key|密钥))'
  // 带赋值：`token=xxx` / `密码：xxx` / `key is xxx`
  //
  // ⚠️ `is` 必须**单独一条更严的分支**，不能并进上面那组连接词里：
  //    并进去的话「this key is important」会命中（key + is + important，
  //    而 important 恰好是 4 个以上字母）—— 实测就误伤了。
  //    英文里 is 后面接普通单词太常见，所以这里要求后面是**凭据形状**：
  //    至少 16 个字母数字，且不能是纯小写单词。
  + '["\']?(?:\\s*(?:[:=：]|是|为)\\s*["\']?' + ASSIGN_VALUE
  + '|\\s+is\\s+["\']?(?=[A-Za-z0-9_-]{16,}\\b)(?=[^\\s]*[A-Z0-9_-])' + ASSIGN_VALUE
  + '|\\s+(?=' + ASSIGN_CHARS + '{6,}))' // 或「token abcdef...」这种空格分隔的长串
  + ')',
  'i'
)

/** 凭据类关键词（命中时给更明确的提示，路径类则说路径）。 */
const CREDENTIAL_RE = /token|密码|密钥|口令|password|passwd|secret|api[_-]?key|api\s+key|authorization|bearer|access[_-]?key|credential|\bkey\b/i

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

  // ① 先按「已知 key 形状」查一遍。
  //    为什么放在关键词规则之前：裸 key（`brz_xxx`）没有任何关键词可依，
  //    只有形状能认出来。放在后面会被前面的规则抢走更长的匹配，反而漏掉。
  for (const pattern of KNOWN_KEY_PATTERNS) {
    const hit = pattern.exec(body)
    if (hit !== null) {
      return { kind: 'credential', sample: maskHit(String(hit[0])) }
    }
  }

  // ② 再走「路径 / 关键词 + 赋值」那套
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
