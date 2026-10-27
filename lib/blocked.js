/**
 * blocked.js —— C 档封禁清单（物理拦截，不是提示词约束）。
 *
 * 为什么必须物理拦截，不能只在 prompt 里写「别调用这些」：
 *   提示词是「建议」，模型在长上下文里、被诱导、或自己想「帮忙」时随时会越界。
 *   而下面这些 action 一旦被调通，交出去的就是账号登录态本身 ——
 *   不是「多知道点信息」，而是**别人可以直接冒用这个 QQ 号**。
 *
 * 分类：
 *   凭据泄露 —— get_cookies / get_credentials / get_csrf_token / get_clientkey
 *                get_rkey_server / request_decrypt_key
 *   账号接管 —— bot_exit（把机器人踢下线）
 *   状态篡改 —— set_online_status / set_diy_online_status / set_input_status
 *   越权社交 —— send_like（替用户点赞）、set_qzone_ban（拉黑好友）
 *   空间写操作 —— delete_qzone_msg（删说说；发说说是允许的，删不允许）
 *   收藏写入 —— add_custom_face（往收藏夹塞东西；读取收藏夹是允许的）
 *
 * 拦截点放在 callOneBot() 入口 —— 这是所有协议端调用的唯一出口，
 * 所以不管调用方写在哪儿（工具、HTTP 接口、未来的新功能），都绕不过去。
 */

/** 被封禁的 action 名（小写，与协议端一致）。 */
export const BLOCKED_ACTIONS = new Set([
  // 凭据类 —— 能交出账号登录态
  'get_cookies',
  'get_credentials',
  'get_csrf_token',
  'get_clientkey',
  'get_rkey_server',
  'request_decrypt_key',
  // 账号接管 / 状态篡改
  'bot_exit',
  'set_online_status',
  'set_diy_online_status',
  'set_input_status',
  // 越权社交动作
  'send_like',
  'set_qzone_ban',
  // 空间与收藏夹的写操作（读允许、写封禁）
  'delete_qzone_msg',
  'add_custom_face'
])

/** 封禁原因，写进报错里，方便在日志里一眼看出是谁踩了线。 */
const REASONS = {
  get_cookies: '会交出账号登录态（Cookie）',
  get_credentials: '会交出账号登录凭证',
  get_csrf_token: '会交出账号登录令牌',
  get_clientkey: '会交出客户端密钥',
  get_rkey_server: '会交出登录密钥服务器信息',
  request_decrypt_key: '会交出本地数据库解密密钥',
  bot_exit: '会把机器人踢下线',
  set_online_status: '会改动账号在线状态',
  set_diy_online_status: '会改动账号在线状态',
  set_input_status: '会改动账号输入状态',
  send_like: '会替用户点赞，属于越权社交动作',
  set_qzone_ban: '会拉黑/解除拉黑好友，属于越权社交动作',
  delete_qzone_msg: '会删除已发表的说说',
  add_custom_face: '会往收藏夹写入内容'
}

/**
 * 断言这个 action 没被封禁；被封禁就抛错。
 *
 * 抛错而不是返回失败对象 —— 调用方如果只看 retcode 而不看异常，
 * 会把「被拒绝」当成「协议端返回了空」，从而继续往下走。
 */
export function assertNotBlocked(action) {
  const name = String(action ?? '').trim()
  if (name === '') return
  if (!BLOCKED_ACTIONS.has(name)) return
  const reason = REASONS[name] ?? '属于已封禁的高风险操作'
  const error = new Error(`已封禁的 action：${name} —— ${reason}。此操作被插件层物理拦截，不会发到协议端。`)
  error.code = 'QQ_ACTION_BLOCKED'
  error.action = name
  throw error
}

/** 这个 action 是否被封禁（给设置页/文档用）。 */
export function isBlocked(action) {
  return BLOCKED_ACTIONS.has(String(action ?? '').trim())
}

/** 封禁清单的可读列表，给设置页和日志用。 */
export function blockedList() {
  return [...BLOCKED_ACTIONS].map((name) => ({ action: name, reason: REASONS[name] ?? '' }))
}
