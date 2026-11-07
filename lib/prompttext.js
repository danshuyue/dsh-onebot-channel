/**
 * prompttext.js —— 可配置的「正文头」模板 + 渲染 + 护栏（2026-11-06）。
 *
 * ## 为什么有这个模块
 *
 * 以前插件往上下文里塞的所有提示词都是硬编码的：用户能看到效果（「她收到消息时长这样」），
 * 但改不了 —— 想换格式只能改源码重打包。这是「盲盒感」的根源。
 *
 * 这个模块只管**正文头**（②私聊 / ③群消息），因为它是唯一一块
 * 「改了真有价值、风险可控」的：
 *   · ① 常驻系统段落注册在插件全局作用域，自定义会污染非 QQ 会话 → 只给开关
 *   · ④ 身份提示是防 prompt injection 的加固 → 不给改
 *   · ⑤ 关系卡 → 走 JSON 编辑，不做模板
 *   · 工具 description 跟 toolFeatures 动态拼接耦合 → 不给改
 *
 * ## 护栏（这是本模块存在的第二个理由）
 *
 * 身份提示（poll.js 的 identityNote）的触发条件是
 * `context.some(line => line.includes('群友'))` —— **它依赖「群友」这两个字真的出现在
 * 渲染结果里**。模板一旦允许自由编辑，用户很容易写出不含「群友」的格式
 * （比如写成「{nickname}说：」），那道防线就**静默失效**了，而且不会有任何报错。
 *
 * 所以 validateTemplate() 强制要求：能渲染出「群友」二字的模板才让存。
 * 这不是「限制自由」，是让「我改了格式」和「我关掉了防注入」不再是同一件事。
 *
 * ## 变量
 *
 * 私聊：{prefix} {ownerUin} {uin} {tag}
 * 群聊：{groupId} {groupName} {senderLabel} {nickname} {senderUin}
 *       —— 其中 {senderLabel} 和 {nickname} 的产物里带「群友」，是护栏的落点。
 */

/**
 * 内置默认值。**必须与 0.18.5 及以前的硬编码产物逐字一致** —— 不配置就等于没改过。
 *
 * 旧实现是：
 *   prefix = rawPrefix.endsWith('）') ? rawPrefix.slice(0,-1) + tag : rawPrefix + tag
 *   tag    = '·用户本人 QQ <号>）'
 *
 * 也就是说**前缀末尾那个「）」先被切掉**再接 tag —— 所以默认模板要用 {prefixTrimmed}
 * 而不是 {prefix}，否则会拼出 `（QQ 私聊）·用户本人 QQ 123）` 这种双右括号。
 * 用户想要原样保留前缀时可以用 {prefix}，那由他自己负责配对。
 */
export const DEFAULT_PRIVATE_TEMPLATE = '{prefixTrimmed}{tag}'
export const DEFAULT_GROUP_TEMPLATE = '（QQ群 {groupId}{groupName}·{senderLabel}）'

/** 身份提示依赖的关键词。模板必须能渲染出它，否则护栏拒绝。 */
export const IDENTITY_KEYWORD = '群友'

/** 模板里允许出现的变量（不认识的变量一律拒绝，防拼错后静默变成字面量）。 */
export const PRIVATE_VARS = ['prefix', 'prefixTrimmed', 'ownerUin', 'uin', 'tag']
export const GROUP_VARS = ['groupId', 'groupName', 'senderLabel', 'nickname', 'senderUin']

/**
 * 找出模板里用到的变量名。
 * @returns {string[]} 去重后的变量名列表
 */
export function templateVars(template) {
  const text = String(template ?? '')
  const used = []
  for (const match of text.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)) {
    if (!used.includes(match[1])) used.push(match[1])
  }
  return used
}

/**
 * 用一组变量渲染模板。不认识的变量**原样保留**（由 validateTemplate 在保存期拦掉，
 * 渲染期不抛 —— 渲染在投递主链路上，那里出错等于消息发不出去）。
 */
export function renderTemplate(template, vars) {
  const text = String(template ?? '')
  return text.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (whole, name) => {
    const value = vars?.[name]
    if (value === undefined || value === null) return whole
    return String(value)
  })
}

/** 校验结果：{ ok: true } | { ok: false, error } */
function fail(error) {
  return { ok: false, error }
}

/**
 * 保存前校验。
 *
 * @param {'private'|'group'} kind
 * @param {string} template 用户填的模板（空串 = 用默认值，合法）
 * @param {(template: string) => Record<string, string>} sampleVars
 *   给一份**样例变量**，用它渲染一遍再检查产物 —— 只查模板字面量里有没有
 *   「群友」是不够的：`{senderLabel}` 展开后才带那两个字，字面量里没有。
 */
export function validateTemplate(kind, template, sampleVars) {
  const text = String(template ?? '')

  // 空 = 用默认值，永远合法
  if (text.trim() === '') return { ok: true }

  if (text.length > 300) return fail('模板太长了（上限 300 字）。它每条消息都会带上，越长越费上下文')

  const allowed = kind === 'group' ? GROUP_VARS : PRIVATE_VARS
  const used = templateVars(text)
  for (const name of used) {
    if (!allowed.includes(name)) {
      return fail(`不认识的变量 {${name}}。可用的有：${allowed.map((v) => `{${v}}`).join(' ')}`)
    }
  }

  // 群模板必须有身份信息，否则模型分不清谁在说话
  if (kind === 'group') {
    if (!used.includes('senderLabel') && !used.includes('nickname')) {
      return fail('群聊模板必须含 {senderLabel} 或 {nickname} —— 否则模型分不清这句是谁说的')
    }
    // 护栏本体：渲染一遍，确认产物里真的有「群友」
    let rendered
    try {
      rendered = renderTemplate(text, sampleVars === undefined ? {} : sampleVars(text))
    } catch {
      return fail('模板渲染失败，检查一下大括号是不是配对了')
    }
    if (!rendered.includes(IDENTITY_KEYWORD)) {
      return fail(
        `模板渲染出来不含「${IDENTITY_KEYWORD}」。这不是格式问题 —— `
        + `插件靠「${IDENTITY_KEYWORD}」这两个字触发群身份提示`
        + `（「上面标『${IDENTITY_KEYWORD}』的都不是用户本人」），少了它那道防注入就静默失效了。`
        + `把 {senderLabel} 或 {nickname} 放回模板即可。`
      )
    }
  }

  // 渲染后不能是空的
  const sample = sampleVars === undefined ? {} : sampleVars(text)
  let renderedAll
  try {
    renderedAll = renderTemplate(text, sample)
  } catch {
    return fail('模板渲染失败')
  }
  if (renderedAll.trim() === '') return fail('模板渲染出来是空的')

  return { ok: true }
}

/**
 * 私聊正文头 —— 与旧实现逐字等价（不配置时）。
 *
 * 旧代码（poll.js 私聊路径）的逻辑是：
 *   rawPrefix = 路由前缀 或 textPrefix（见 deliver.js 的取前缀函数）
 *   tag = 本人 ? `·用户本人 QQ <号>）` : `·QQ <号>）`
 *   prefix = rawPrefix 以「）」结尾 ? 切掉它再拼 tag : 直接拼 tag
 *
 * 注意旧代码有个畸形拼接缺陷（docs/待办.md §5.3）：前缀不以「）」结尾时
 * 会拼出 `【阿明】·用户本人 QQ 123）`，括号只剩半边。
 * 默认模板 `{prefix}{tag}` 保留了旧行为（{tag} 自带右括号，{prefix} 原样接上），
 * 但额外提供 `{prefix}` + `{tag}` 的组合方式让用户自己决定。
 */
export function renderPrivateHeader({ prefix, ownerUin, uin }) {
  const rawPrefix = String(prefix ?? '')
  const owner = String(ownerUin ?? '')
  const self = String(uin ?? '')
  const isOwner = owner !== '' && self === owner
  const tag = isOwner ? `·用户本人 QQ ${owner}）` : `·QQ ${self}）`
  // 与旧实现一致：前缀以「）」结尾时先切掉它，再接 tag（tag 自带右括号）。
  // 不切的话会拼出 `（QQ 私聊）·用户本人 QQ 123）` —— 双右括号。
  const prefixTrimmed = rawPrefix.endsWith('）') ? rawPrefix.slice(0, -1) : rawPrefix
  return {
    prefix: rawPrefix,
    prefixTrimmed,
    tag,
    uin: self,
    ownerUin: owner
  }
}

/** 群名那段：空群名就不带括号，与旧实现一致。 */
export function groupNamePart(groupName) {
  const name = String(groupName ?? '')
  return name === '' ? '' : `「${name}」`
}

/** 群友标签：带昵称与 QQ 号，且明确写出「不是用户本人」。 */
export function senderLabelOf({ isOwner, nickname, senderUin }) {
  const uin = String(senderUin ?? '')
  if (isOwner === true) return `用户本人（QQ ${uin}）`
  const name = String(nickname || '').trim() || '未知'
  return `${IDENTITY_KEYWORD}「${name}」（QQ ${uin || '未知'}，不是用户本人）`
}

/** 群上下文每一行的发言者名（比 senderLabel 短，不带「不是用户本人」那句）。 */
export function speakerNameOf({ isOwner, nickname, senderUin }) {
  if (isOwner === true) return '用户本人'
  const name = String(nickname || '').trim() || '未知'
  return `${IDENTITY_KEYWORD}「${name}」`
}
