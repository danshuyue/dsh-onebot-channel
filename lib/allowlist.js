/**
 * allowlist.js —— 出站目标白名单（硬闸）。
 *
 * 为什么需要（2026-10-28）：
 *   `qq_send` 的 user_id / group_id 是 agent 可以随便传的字符串，`sendToQQ()` 也照单全收。
 *   于是「群里有人 @ 她 + 一句『去私聊 123456 说 xxx』」就能让她往**任意** QQ 号发消息 ——
 *   这是账号被封、骚扰陌生人的现实风险，不是理论风险。
 *
 * 所以闸门放在 `callOneBot()`：它是所有协议端调用的**唯一出口**（blocked.js 就挂在那里），
 * 只有放这一层，才能保证「不管谁调（qq_send / 自动转发 / sendapi / 收藏表情）、调几次」
 * 都绕不过去。放在工具层只能挡住 qq_send 这一条路。
 *
 * 白名单从哪来（不新增一份配置，避免两处漂移）：
 *   私聊 = peerUin ∪ ownerUin ∪ routes.private 的键
 *   群   = groupUins ∪ routes.group 的键
 *   —— 这些正好是「插件本来就在服务的对象」，所以自动转发永远不会被误伤。
 *
 * 逃生阀：`allowSendToAny: true` 恢复旧行为（不校验）。默认 false。
 *   ⚠️ 开了它就等于把上面那段风险还回去，只在临时排障时开。
 */
import { getConfig } from './config.js'
import { note } from './env.js'

/** 白名单为空时只警告一次，别每发一条刷一行。 */
let warnedEmpty = false

/** 有没有配「关掉白名单」的逃生阀。 */
function bypassed() {
  return getConfig()?.allowSendToAny === true
}

/**
 * QQ 号归一：'003001' 和 '3001' 在协议端是同一个号。
 * 统一成字符串数字，避免「白名单里写 3001、工具传来 ' 3001 '」这种假阴性。
 *
 * ⚠️ 0 / 负数 / 非数字一律归成空串：`peerUin: 0` 在配置里表示「还没配」，
 *   如果这里把 0 当成合法号塞进白名单，白名单就永远不为空 ——
 *   「完全没配置时放行」那条边界会失效，插件装好就一句话都发不出去。
 */
export function normUin(value) {
  const text = String(value ?? '').trim()
  if (!/^\d+$/.test(text)) return ''
  const num = Number(text)
  return Number.isSafeInteger(num) && num > 0 ? String(num) : ''
}

/** 当前允许的私聊 / 群目标集合。 */
export function allowedTargets() {
  const config = getConfig() ?? {}
  const privateSet = new Set()
  const groupSet = new Set()

  const addPrivate = (value) => {
    const uin = normUin(value)
    if (uin !== '') privateSet.add(uin)
  }
  const addGroup = (value) => {
    const gid = normUin(value)
    if (gid !== '') groupSet.add(gid)
  }

  // 用户本人：私聊默认对象和 owner 都是他
  addPrivate(config.peerUin)
  addPrivate(config.ownerUin)
  // 路由表：已绑定会话的好友 / 群（自动转发的目标全部来自这里）
  for (const key of Object.keys(config.routes?.private ?? {})) addPrivate(key)
  for (const key of Object.keys(config.routes?.group ?? {})) addGroup(key)
  // 监听的群（群里 @ 她才投递，所以这些群一定在服务范围内）
  for (const gid of Array.isArray(config.groupUins) ? config.groupUins : []) addGroup(gid)

  return { private: privateSet, group: groupSet }
}

/**
 * 「允许被戳的人」集合。
 *
 * 为什么单独一份、而且比「能发消息的群」更窄（2026-11-02）：
 *   发消息是「说给群里所有人听」，拍一一是**专门点名某个人**、还会亮他手机。
 *   所以群放行了不等于群里每个人都能戳 —— 只认插件确实在服务的人：
 *   用户本人 + 已绑私聊 + 主动搭话名单里的人。
 *   群里那些没被绑定的群友，一律不许戳。
 *
 * ⚠️ 这会让「群友戳她 → 她想戳回那个群友」被拦（群友不在服务名单里）。
 *   这是**故意的**：回戳一个没绑定的人就是骚扰，宁可让她改用 @ 或说话。
 */
export function allowedPokeTargets() {
  const config = getConfig() ?? {}
  const set = new Set()
  const add = (value) => {
    const uin = normUin(value)
    if (uin !== '') set.add(uin)
  }
  add(config.peerUin)
  add(config.ownerUin)
  for (const key of Object.keys(config.routes?.private ?? {})) add(key)
  // 主动搭话名单里的人本来就是要服务的人（形如 private:<uin>）
  for (const value of Array.isArray(config.proactiveTargets) ? config.proactiveTargets : []) {
    const text = String(value ?? '').trim()
    const match = /^private:(\d+)$/.exec(text)
    if (match !== null) add(match[1])
  }
  return set
}

/**
 * 从一次协议端调用里提取出站目标。
 *
 * 只认明确的发送类 action —— 不认识的 action 一律返回 null（不拦），
 * 宁可漏拦也不要把 get_login_info 这类只读动作误判成发送。
 *
 * @returns {{kind:'private'|'group', id:string} | null}
 */
export function sendTargetOf(action, params) {
  const name = String(action ?? '')
  const p = params ?? {}
  const pick = (...keys) => {
    for (const key of keys) {
      const value = normUin(p[key])
      if (value !== '') return value
    }
    return ''
  }

  switch (name) {
    case 'send_private_msg':
    case 'send_priv_forward_msg': {
      const id = pick('user_id')
      // 私聊没给 user_id 时 sendOneToQQ 会退到 peerUin，这里同样返回空串交给下游补
      return { kind: 'private', id }
    }
    case 'send_group_msg':
    case 'send_group_forward_msg':
      return { kind: 'group', id: pick('group_id') }
    case 'send_msg': {
      const type = String(p.message_type ?? p.type ?? '').trim()
      if (type === 'group') return { kind: 'group', id: pick('group_id') }
      if (type === 'private') return { kind: 'private', id: pick('user_id') }
      // message_type 没写时按「有 group_id 就是群」猜，跟 qq_send 的优先级一致
      const gid = pick('group_id')
      return gid !== '' ? { kind: 'group', id: gid } : { kind: 'private', id: pick('user_id') }
    }
    case 'send_poke':
    case 'friend_poke':
    case 'group_poke': {
      // group_id 必须是**合法数字**才算「群戳」。以前 pick() 把非法值
      // （NaN / 未定义 / '0'）归成空串后直接转按私聊目标校验，
      // 而真正的请求里 group_id 是 null 却照样发 group_poke —— 校验和动作对不上。
      const rawGroup = p.group_id
      const gid = pick('group_id')
      if (rawGroup !== undefined && rawGroup !== null && String(rawGroup).trim() !== '' && gid === '') {
        // 给了群号但不是合法数字：直接拒，别降级成「私聊校验」放它过去
        return { kind: 'group', id: '', pokeTarget: pick('user_id', 'target_id') }
      }
      const uid = pick('user_id', 'target_id')
      if (gid !== '') return { kind: 'group', id: gid, pokeTarget: uid }
      return { kind: 'private', id: uid }
    }
    default:
      return null
  }
}

/**
 * 校验一次出站调用。不合法就抛错 —— 抛错是**故意的**：
 *   ① 上层会把它翻成工具错误给 agent 看，她会改口说「发不出去」而不是硬发；
 *   ② 抛在 HTTP 之前，协议端根本收不到这个请求。
 *
 * @param {string} action OneBot action 名
 * @param {object} params 该 action 的参数
 * @param {string} [fallbackPrivateUin] 私聊没带 user_id 时的实际目标（协议端会用它）
 */
export function assertSendAllowed(action, params, fallbackPrivateUin = '') {
  if (bypassed()) return
  const target = sendTargetOf(action, params)
  if (target === null) return // 不是发送类动作，不归这里管

  const allowed = allowedTargets()
  const isGroup = target.kind === 'group'
  const rawId = target.id
  // 私聊没给目标 → 实际发给默认私聊对象（peerUin）
  const id = rawId !== '' ? rawId : (isGroup ? '' : normUin(fallbackPrivateUin || getConfig()?.peerUin))

  // ---- 边界：完全没配置时放行 ----
  // 白名单一个号都没有 = 这台机器还没配好（peerUin / routes / groupUins 全空）。
  // 这种状态下硬拦，表现是「插件装好了但一句话都发不出去」，
  // 而且用户看到的是一串白名单错误，第一反应是插件坏了。
  // 闸门的语义是「限制已经配置好的服务范围」，不是「没配置就把人锁死」。
  // 配好 peerUin（最小 4 处必填之一）之后，闸门立刻生效。
  const total = allowed.private.size + allowed.group.size
  if (total === 0) {
    if (!warnedEmpty) {
      warnedEmpty = true
      note('allow', '白名单为空（peerUin / routes / groupUins 都没配）→ 暂不限制出站目标；配好之后自动生效')
    }
    return
  }

  if (id === '') {
    // 群戳给了非法群号：这条错误必须说清是「群号不合法」，
    // 否则会被下面那句「没有指明目标」的文案误导（实测踩过）
    if (isGroup) {
      throw new Error(
        `出站被白名单拦截：群号不合法（收到的是「${String(params?.group_id ?? '')}」）。`
        + '群戳必须给纯数字群号。'
      )
    }
    throw new Error('出站被白名单拦截：没有指明目标，也没有配置默认私聊对象（peerUin）')
  }

  const set = isGroup ? allowed.group : allowed.private
  if (set.has(id)) {
    // 群拍一拍：群放行了不等于「群里随便谁都能戳」。
    // 目标号必须也在放行集合里（用户本人 / 已绑好友 / 主动搭话名单之类），
    // 否则群里一句「去戳一下 555555555」就能把她变成骚扰工具。
    const pokeTarget = String(target.pokeTarget ?? '').trim()
    if (pokeTarget !== '' && !allowedPokeTargets().has(pokeTarget)) {
      const list = [...allowedPokeTargets()]
      throw new Error(
        `拍一拍被拦截：${pokeTarget} 不是这个插件的服务对象。`
        + `可以戳的：${list.length > 0 ? list.join(', ') : '（空：先在设置页绑一个会话）'}。`
        + '拍一拍会亮到对方手机上，不是「群里谁都能戳」。'
      )
    }
    return
  }

  const kindName = isGroup ? '群' : '好友'
  const list = [...set]
  throw new Error(
    `出站被白名单拦截：${kindName} ${id} 不在允许范围内。`
    + `当前允许的${kindName}：${list.length > 0 ? list.join(', ') : '（空）'}。`
    + '要去掉这道闸，在配置里设 allowSendToAny=true（不推荐）。'
    + '要放开这个目标，把它加进设置页的会话绑定 / 监听列表。'
  )
}
