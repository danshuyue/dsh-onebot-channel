/**
 * config.js —— 配置加载 / 保存 / 迁移。
 *
 * 模块持有单例 config（loadConfig() 时从 CONFIG_FILE 读入），
 * 其他模块一律 getConfig() 读取，绝不直接改。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { CONFIG_FILE } from './env.js'
import { note } from './env.js'
import { discoverWsEndpoint } from './snowluma.js'
import { readWorkspaces } from './progress.js'
import { normCwd } from './title.js'

/**
 * 工具箱分档的默认值（0.17.4）。
 *
 * 为什么是「分档」而不是 12 个独立开关：用户要的是「发送工具 / 接受工具 / 语音识别 /
 * 发送语音」这种**按用途**的组，不是一屏英文工具名复选框。
 *
 * 为什么默认把 4 档关掉：工具 schema 每次请求都进上下文（实测全开 JSON.stringify 共 10272 字符），
 * 而语音识别、发语音、戳一戳、表情包都是「常规情况不用」的附加能力。
 *
 * ⚠️ **表情包这一档必须整档启停，不能拆**：档内 5 个工具互相指名
 *   （qq_face_rename 让你先调 qq_face_pick，qq_face_preview 让你看完去 qq_collect_face，
 *    qq_collect_face 又让你先 qq_face_preview 看清单）。单独关掉其中任意一个，
 *    剩下那几个的描述和报错就会指向一个不存在的工具 —— 模型看到 UNKNOWN_TOOL 会换个写法再试，
 *    那正是「关掉开关反而更烧 token」的翻车方式。
 *    所以这里只有 emoji 一个键，没有 per-tool 键（结构上就表达不出「只关一个」）。
 *
 * ⚠️ 这里**没有 qq_send**：它不可关。写进来只会让人以为关了有用。
 *   prompt.js 的常驻段落也提到 qq_send（「先 qq_send 一句」）—— 正因为不可关，那段才不用动态化。
 *   哪天要允许关 qq_send，prompt.js 必须一起改。
 */
export const TOOL_FEATURE_DEFAULTS = {
  /** 沉默权：qq_pass / qq_skip / qq_wait / qq_close —— 「什么时候不说话」四件套，对话手感的一部分。 */
  silence: true,
  /** 表情包：qq_emoji_search / qq_face_pick / qq_face_preview / qq_face_rename / qq_collect_face（必须整档启停） */
  emoji: false,
  /** 语音识别：qq_voice */
  voiceIn: false,
  /**
   * 发送语音：不是独立工具，是 qq_send 的 voice 参数（关掉时连参数一起从 schema 里去掉）。
   *
   * ⚠️ 0.19.0 起**不再由用户直接设置** —— 它由 `voiceMode` 推导：
   *    `voiceMode === 'off'` → false，其余三档 → true（见 index.js 的 deriveToolFeatures）。
   *    保留这个键是因为 `tool.js` 的 `featuresOf()` 和一批测试都按它工作，
   *    把它删掉会让「voice 参数在不在 schema 里」这条逻辑没有落点。
   *    设置页**不再渲染它**（那个复选框已挪去「对话节奏 → 语音模式」四档）。
   */
  voiceOut: false,
  /** 戳一戳：qq_poke */
  poke: false
}

/**
 * 从语音四档推导出 toolFeatures。
 *
 * 为什么要有这层：设置页只暴露四档，而 tool.js / index.js 内部按 voiceOut 判断
 * 「qq_send 的 voice 参数在不在」。两者必须有一处**单向**换算，
 * 否则会出现「四档选了主动、但 voice 参数还在缺席」这种自相矛盾的状态。
 *
 * 单向 = 只从 voiceMode 推 voiceOut，绝不反向写回 —— 反向会让两个真相源打架。
 */
export function deriveToolFeatures(config) {
  const base = { ...TOOL_FEATURE_DEFAULTS, ...(config?.toolFeatures ?? {}) }
  base.voiceOut = String(config?.voiceMode ?? 'off') !== 'off'
  return base
}

/**
 * 容错：把配置里那个 `toolFeatures` 收成一个干净的五键对象。
 *
 * 手改配置文件写 `"toolFeatures": "yes"` / `{emoji: "true"}` / `null` 都不该让插件崩，
 * 也不该静默变成「全开」或「全关」—— 认不出来的值一律回默认值（emoji 仍是关）。
 */
export function normalizeToolFeatures(value) {
  const out = { ...TOOL_FEATURE_DEFAULTS }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out
  for (const key of Object.keys(TOOL_FEATURE_DEFAULTS)) {
    // 只认真正的布尔值：字符串 "true" / 数字 1 都算「不认识」，回默认
    if (typeof value[key] === 'boolean') out[key] = value[key]
  }
  return out
}

/**
 * 语音模式四档（0.19.0）。
 *
 * 为什么不是布尔值：「发不发语音」有四种真实语义，用户 2026-11-07 逐字确认过
 * （那些文案是**定义**，不是装饰 —— 用户原话「既然主动这个字有歧义」）。
 *
 * ⚠️ 四档是**提示词 + 工具可见性**的组合，不是运行时代码判断。
 *    「这句话适不适合用语音」是语义问题，代码判不了 —— 别在 qq_tts 里写
 *    `if (mode === 'active') 强制语音`。正确做法见 docs/开发提示词-语音合成双引擎.md §2.1。
 */
export const VOICE_MODES = ['off', 'passive', 'free', 'active']

/** 四档的悬浮说明。**逐字来自用户**，不许改写（见设计文档 §1.1）。 */
export const VOICE_MODE_LABELS = {
  off: '禁用',
  passive: '被动',
  free: '自由',
  active: '主动'
}

export const VOICE_MODE_HELP = {
  off: '这个模式下ai无语音工具调用权限，无法发语音',
  passive: '这个模式下除非你要求，否则ai不会发语音',
  free: '这个模式下ai可以发语音，且直接考虑该不该发语音，实际效果可能和被动模式类似',
  active: '这个模式下ai将尽可能全部用语音回复你，除非你要求用文字或者不适合用语音'
}

/** 合成引擎二选一。**只是「默认」** —— 它不阻止模型自己去调 gptsovits MCP。 */
export const VOICE_ENGINES = ['gptsovits', 'breeze']

/**
 * 容错：把 voiceMode / voiceEngine 收成合法值。
 *
 * 手改配置写成 `"voiceMode": "ACTIVE"` / `"on"` / `true` 都不该让插件崩，
 * 也不该静默变成「主动」（那会开始花钱）。认不出来一律 `'off'` —— 往安全那边倒。
 */
export function normalizeVoiceMode(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return VOICE_MODES.includes(raw) ? raw : 'off'
}

export function normalizeVoiceEngine(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return VOICE_ENGINES.includes(raw) ? raw : 'gptsovits'
}

/**
 * 旧配置迁移（0.19.0，一次性，幂等）。
 *
 * `toolFeatures.voiceOut` 被四档取代。映射规则：
 *   voiceOut === true  → voiceMode 'free'   （**不是 'off'**）
 *   voiceOut === false → voiceMode 'off'
 *   已经显式设了 voiceMode 的 → **不覆盖**（用户自己选过的算数）
 *
 * ⚠️ 为什么 true 映射成 'free' 而不是 'off'：
 *    见 tool.js 文件头那段警告 —— 「升级插件这个动作会**静默**去掉用户本来有的能力」
 *    是本仓库明确的事故类型。老用户 voiceOut=true 说明他要发语音，
 *    升级后给他 'free' 才是行为等价；给 'off' 等于悄悄关掉他的功能。
 *    而 false→off 是安全的，因为那本来就是「关」。
 *
 * ⚠️ 为什么不能只靠 DEFAULTS：「{...DEFAULTS, ...raw}」里 raw 的旧值优先，
 *    所以存量配置文件里那个 voiceOut 会一直存在，必须主动读它一次。
 *
 * @returns {boolean} 是否发生了迁移（调用方据此决定要不要 saveConfig）
 */
export function migrateVoiceMode(config, rawFile) {
  const hasExplicit = rawFile !== null && typeof rawFile === 'object'
    && typeof rawFile.voiceMode === 'string' && rawFile.voiceMode.trim() !== ''
  if (hasExplicit) return false

  const legacy = rawFile !== null && typeof rawFile === 'object'
    && rawFile.toolFeatures !== null && typeof rawFile.toolFeatures === 'object'
    && !Array.isArray(rawFile.toolFeatures)
    ? rawFile.toolFeatures.voiceOut
    : undefined
  if (legacy !== true && legacy !== false) return false

  config.voiceMode = legacy === true ? 'free' : 'off'
  note('config', `迁移 toolFeatures.voiceOut=${legacy} -> voiceMode=${config.voiceMode}`)
  return true
}

/**
 * 语音对象名单的语义迁移（2026-11-07，一次性，幂等）。
 *
 * 语义从「空 = 全部放行」反转成「空 = 谁都不能用」（用户要求，更符合直觉）。
 * 直接反转会让存量用户**升级后语音突然全哑**，且不知道为什么 ——
 * 所以这里把「原来是空的」自动补成「当前已绑的全部对象」，
 * 保持升级前的实际可用范围不变。
 *
 * ⚠️ 只在**两个名单都是空**、且用户确实开过语音（voiceMode ≠ off）时补。
 *    全新用户（刚装、没配过）保持空 = 谁都不能用，那才是新语义该有的默认。
 *
 * @returns {boolean} 是否发生了迁移
 */
export function migrateVoiceTargets(config, rawFile) {
  if (rawFile === null || typeof rawFile !== 'object') return false
  // 已经迁过（名单里已经有东西）就不动
  const priv = Array.isArray(config.voiceTargetsPrivate) ? config.voiceTargetsPrivate : []
  const grp = Array.isArray(config.voiceTargetsGroup) ? config.voiceTargetsGroup : []
  if (priv.length > 0 || grp.length > 0) return false

  // 只在「用户本来就在用语音」时迁移：全新安装不该被塞进一堆对象
  const mode = String(config.voiceMode ?? 'off')
  if (mode === 'off') return false

  // 老配置的特征：有 toolFeatures.voiceOut 或已经有 voiceMode，但名单是空的。
  // 用「已绑对象」补全 —— 那是升级前实际生效的范围。
  const boundPrivate = Object.keys(config?.routes?.private ?? {}).map((uin) => `private:${uin}`)
  const boundGroup = Object.keys(config?.routes?.group ?? {}).map((gid) => `group:${gid}`)
  if (boundPrivate.length === 0 && boundGroup.length === 0) return false

  config.voiceTargetsPrivate = boundPrivate
  config.voiceTargetsGroup = boundGroup
  note('config', `迁移语音对象名单（空 = 全放开 → 空 = 谁都不能用）：`
    + `private=${boundPrivate.length} group=${boundGroup.length}`)
  return true
}

export const DEFAULTS = {
  enabled: true,
  /**
   * 会话来源工作区：设置页列哪些会话、以及「收到的图片」副本存在哪。
   *
   * ⚠️ 这个值**必须能在 `~/.dsh/storages/workspace.json` 里找到**，
   *    设置页的保存接口会拿 `normCwd` 比一遍，找不到就 400（见 api.js 的 /save）。
   *    以前这里写死在 `D:\DSH workspace\QQ对话` —— 本机上根本没有这个目录，
   *    于是「N 个可选会话」永远是 0，用户根本没法绑。0.18.4 起改成真实工作区，
   *    并且设置页给了下拉框（`/api/qq-bridge/workspaces`）。
   */
  workspaceCwd: 'D:\\Yansunsky\\Desktop\\文本\\DSHQQ对话',
  /** 路由表：每个 QQ 号 / 群绑一个会话。空 = 未配置，该号的消息被忽略。 */
  routes: { private: {}, group: {} },
  onebotHttp: 'http://127.0.0.1:3000/',
  token: '',
  selfUin: 0,
  peerUin: 0,
  /**
   * 用户本人的 QQ 号。留 0 = 用 peerUin（私聊对象就是他）。
   * 群聊靠这个号区分「本人」和「群友」—— 不配的话 agent 分不清谁是谁。
   */
  ownerUin: 0,
  sessionId: '',
  pollMs: 2000,
  /** 单次 OneBot 请求超时。协议端偶发挂死，不设超时会把轮询彻底卡住。 */
  requestTimeoutMs: 8000,
  seedOnFirstRun: true,
  textPrefix: '（QQ 私聊）',
  /**
   * 私聊正文头的模板（2026-11-06）。留空 = 用内置默认，与旧行为逐字一致。
   *
   * 可用变量：{prefix} {prefixTrimmed} {tag} {uin} {ownerUin}
   *   - {prefix}        原始前缀（就是上面 textPrefix，或绑定表里那条路由的 prefix）
   *   - {prefixTrimmed} 前缀，但若以「）」结尾会先切掉它 —— 默认模板用这个，
   *                     否则会拼出 `（QQ 私聊）·用户本人 QQ 123）` 双右括号
   *   - {tag}           `·用户本人 QQ 123）` 或 `·QQ 456）`，自带右括号
   *
   * 保存时由 prompttext.validateTemplate 校验（变量名、长度、渲染非空）。
   */
  privateHeaderTemplate: '',
  /**
   * 群消息正文头的模板（2026-11-06）。留空 = 内置默认，与旧行为逐字一致。
   *
   * 可用变量：{groupId} {groupName} {senderLabel} {nickname} {senderUin}
   *
   * ⚠️ **有护栏**：渲染结果必须含「群友」二字，否则保存被拒。
   *    原因见 prompttext.js 文件头 —— 群身份提示（防 prompt injection）
   *    靠 includes('群友') 触发，模板把它去掉就等于静默关掉那道防线。
   */
  groupHeaderTemplate: '',
  /** 要监听的群号；留空 = 不监听任何群。 */
  groupUins: [],  /** 群里只有 @ 到本号才投递。 */
  groupOnlyWhenAt: true,
  /**
   * 被 @ 时，把这条之前最近几条群消息一并带上当上下文（0 = 不带）。
   * 只带「投递这一刻」的前文，不为每条群消息单独跑回合。
   */
  groupContextCount: 5,
  /** 群轮询间隔，比私聊慢一点，避免群多时打爆本机接口。 */
  groupPollMs: 3000,
  /** 群消息投递到哪个会话；留空 = 跟私聊同一个。（旧单路由字段，见 loadConfig 的迁移） */
  groupSessionId: '',
  /**
   * 首选会话没有活着的 agent 时，是否改投「最近活跃且有 agent」的会话。
   *
   * ⚠️ 默认 **false** —— 这个开关会**绕过路由表**，
   *   与「没绑定的号一律忽略、不乱投到别的会话」的设计直接矛盾：
   *   开了之后，原本该被忽略的号的消息可能被投进别的会话。
   *
   * 2026-10-27 从 true 改成 false：默认值不该让人误以为「兜底是好事」。
   */
  fallbackToLiveSession: false,
  /**
   * 出站目标白名单的逃生阀（2026-10-28）。
   *
   * 默认 **false**：`qq_send` 只能发给 routes / groupUins / peerUin / ownerUin
   * 里列出的对象。设 true = 恢复旧行为（agent 可以发给任意 QQ 号）。
   *
   * ⚠️ 开了它等于把「群里有人 @ 她 + 一句『去私聊 123456 说 xxx』就能让她
   *   往任意号发消息」这个风险还回去。只在临时排障时开，排完改回 false。
   */
  allowSendToAny: false,
  /** 会话没开着时，是否用 AgentRegistry.resume 把它冷启动出来。 */
  resumeColdSession: true,
  /**
   * 冷启动时要显式补的模型选择 —— 正常打开会话时由 dsh-agent-default-model 插件补，
   * 我们 resume 出来的 agent 拿不到那份配置，缺了会报
   * 「prompt variable "{{model}}" has no value」。
   */
  agentOptions: { provider: 'deepseek-account', model: 'deepseek-flash' },
  /** 回合结束后，把最终回复自动转发回 QQ（不依赖 qq_send 工具）。 */
  autoForwardReply: true,
  /**
   * 回复前先把「静默」补足（毫秒，默认 0 = 关掉）。
   *
   * 为什么默认关：这是一条会**明显拖慢回复**的改动。开了之后，
   * 每条消息都要先等够这段时间才投给模型，群里连发时会更慢。
   * 先试 5000（5 秒）看看手感，受不了就改回 0。
   *
   * 计时从**最后一条来信**开始，中间又有新消息会重新计时。
   * 总预算 60 秒，防止有人在群里刷屏把她吊住。
   */
  replyQuietMs: 0,
  /** qq_wait 一次最多能等多久（毫秒，上限保护，默认 60 秒）。 */
  waitMaxMs: 60000,
  /**
   * 一个回合里 qq_wait 累计最多等多久（毫秒，默认 60 秒，0 = 不限）。
   *
   * 为什么要在「单次上限」之外再加一道（2026-11-03 用户实测）：
   *   waitMaxMs 只管一次。她可以连打四次 40000ms，一个回合照样拖到几分钟，
   *   而这期间进来的消息全堆在宿主 inbox 里排队，等轮到它们时早就是旧话了。
   *   回合长度是排队问题的**上游**，所以单独设闸。
   *
   * 额度按 QQ 号/群记，**每次有新消息投给她就重置**（有新东西要处理，就该给新预算）。
   * 用完了不报错：qq_wait 立刻返回当前情况 + 一句「额度用完了，现在开口或者收掉这一轮」。
   */
  waitTurnMaxMs: 60000,
  /**
   * qq_close 收尾前要不要先让 closure 模块过一遍（默认开）。
   *
   * 关掉之后 qq_close 变成「无条件记账」，不再拦「对方还在问就收摊」这种情况。
   * 排障（模型死卡在收尾上）时可以临时关。
   */
  closureEnabled: true,
  /**
   * 记忆卡（关系 / 话题持久化，默认开）。
   *
   * 开：每次投递前把她对这个号/群的称呼和几条事实带进正文（很短，约 180 字上限），
   *     入站自动记昵称 / 说话次数，qq_remember 写进 ~/.dsh/qq-bridge-memory.json，重启不丢。
   * 关：完全不注入、也不自动记昵称（qq_remember 仍能写，只是不会读回来）。
   * 嫌正文里多出一段「关于他：…」时关掉。
   */
  memoryEnabled: true,
  /**
   * 私聊合并窗口（毫秒，默认 2500；设 0 = 关，回到「来一条投一条」）。
   *
   * 这是「标记已读」的中间态：消息一到就记账（markSeen + 去重），
   * 但不立刻开回合 —— 先在池子里攒一会儿，等他这一波说完再一起回。
   * 效果：连发三句只回一次，而不是被连问三遍；游标推进、失败回滚逻辑完全不变。
   *
   * ⚠️ 跟 replyQuietMs 会叠加（2.5s 窗口 + 5s 静默 = 7.5s）。两个都想开时建议只留一个：
   *   合并窗口解决「连发几条被打断」，静默解决「秒回太假」。
   */
  mergeWindowMs: 2500,
  /** 合并窗口的总时长上限（毫秒）：对方一直发也不能无限等，到点强制放行。 */
  mergeMaxWaitMs: 15000,
  /** 池子里攒到这么多条就立刻放行（一口气十条已经不是「还没说完」）。 */
  mergeMaxMessages: 10,
  /** @ 唤醒后的群聊连续对话窗口。 */
  windowEnabled: true,
  windowIdleMs: 120000,
  windowMaxMs: 600000,
  windowMaxReplies: 5,
  windowPerPeerDaily: 10,
  windowPerGroupDaily: 20,
  /** 活动时段，支持跨午夜。 */
  waterWindows: ['12:00-14:00', '18:00-09:00'],
  /**
   * 主动搭话（默认关）—— 没人叫她时，她自己想起来找你。
   *
   * 关着的时候完全没有任何定时器行为；打开后每 60 秒看一次该不该开口，
   * 真正开口还要过四道闸：静默时段 / 空闲时长 / 当日配额 / 没被回应的退避。
   *
   * ⚠️ 这是**对外动作**（会真的发消息出去），所以默认关，需要人去设置页打开。
   */
  proactiveEnabled: false,
  /** 距上次互动至少多久才考虑主动开口（小时，可小数）。 */
  proactiveIdleHours: 6,
  /** 空闲上限（小时，0=不随机）。填得比下限大时，门槛在「下限~上限」之间按这段安静期摇号。 */
  proactiveIdleMaxHours: 0,
  /** 每天最多主动几次（0 = 一次都不主动）。 */
  proactiveDailyMax: 1,
  /** 静默时段（本地时间 HH:MM），这段时间一次都不主动。跨午夜写成 23:00 → 08:00。 */
  proactiveQuietFrom: '23:00',
  proactiveQuietTo: '08:00',
  /** 上次主动对方没回时，下次要求空闲时长按 2^n 放大，最多放大到这么多倍。 */
  proactiveBackoffMax: 4,
  /**
   * 允许主动搭话的对象（形如 `private:1000000001`，跟内部 key 一致）。
   *
   * 空数组 = 所有已绑会话的私聊都算候选（老行为）。非空 = 白名单，只对名单里的人开口。
   * 为什么不是按「群」也能选：主动进群打扰不是这功能的目的，candidates() 只取私聊。
   */
  proactiveTargets: [],
  /**
   * 待转发队列条目的寿命（毫秒，默认 5 分钟）。
   *
   * turn/end 永远不来（DSH 崩了、会话被中断）时，条目会卡在队头把后面全堵死，
   * 表现成「她突然不理人了」。超时就丢弃并记日志，宁可少发一条也不让管道死掉。
   * 设 0 或负数 = 不超时（老行为，不推荐）。
   */
  outboundEntryTtlMs: 300000,
  /** 回复分条总开关；关掉 = 一整条发出去。 */
  splitReply: true,
  /**
   * 分条依据（0.10.0）：
   *
   *   paragraph（默认）换行才另起一条，句号不算 —— 「说几条」由她自己用换行决定。
   *   sentence         老行为：每个句末标点后断开，像真人一句一句打出来。
   *
   * 为什么默认改成 paragraph：模型写的是一段完整回复，按句号切会把连贯的话剁成五六条弹出来，
   * 既不是她的本意，读起来也像刷屏。
   */
  splitMode: 'paragraph',
  /** 单条最长字数；超了就再切。 */
  splitMaxChars: 120,
  /** 小于这个字数的碎片并进相邻一条，避免「嗯。」单独成条（只对 sentence 模式生效）。 */
  splitMinChars: 4,
  /** 一次回复最多拆几条；超出的合并。 */
  splitMaxParts: 8,
  /**
   * 两条消息之间的停顿（2026-11-07 用户要求，原 splitDelayMin/MaxMs 被它取代）。
   *
   * 为什么改：原来只有 `splitDelayMinMs` + `splitDelayMaxMs` + 硬编码的
   * `perCharMs: 12` 混在一起算，**两种意图都表达不清楚**：
   *   · 想「固定等一会儿」得同时改两个值，还得知道 min 不能超 max；
   *   · `max` 把按字数的增长截断了 —— 实测 40 字就封顶 700ms，
   *     更长的段落不会等更久。而用户报的症状正是「连着发、太急」。
   *
   * 现在是一个模式 + 一组参数：
   *   `mode: 'fixed'`    每条之间等 `fixedMs`（默认）
   *   `mode: 'perChar'`  每条之间等 `字数 × perCharMs`
   *
   * 默认 `fixed 800ms`：800 是「明显不是在连发、又不至于让人等」的位置
   * （输入框那边的「正在输入」消失后大约就是这个量级）。
   */
  splitDelayMode: 'fixed',
  splitDelayMs: 800,
  /** `perChar` 模式下每个字算多少毫秒。 */
  splitDelayPerCharMs: 120,
  /**
   * 单条间隔的上限（毫秒）。0 = 不封顶。
   *
   * ⚠️ 为什么 `perChar` 模式需要一个上限：120 字 × 120ms = 14.4 秒，
   *    四条就是将近一分钟 —— 那已经不像「分条说话」，像卡住了。
   *    3000ms 是「慢一点」和「像卡死」的分界。
   *    这个上限**只作用在最终取值上**，不改变 perChar 的计量方式。
   */
  splitDelayMaxCapMs: 3000,
  /**
   * AI 主动发消息的本地 HTTP 接口端口（只绑 127.0.0.1）。
   * 给 AI 用：不经过 QQ 也能主动发，比如提醒、问好。
   * 多个 DSH 实例同时加载时只有一个能占住端口，其余记日志后跳过，不影响收发主链路。
   */
  sendApiPort: 39273,
  /**
   * 收到的图片额外存一份人能看的副本的目录（带时间戳命名）。
   * 留空 = <workspaceCwd>\收到的图片。设成 "off" 就不存副本。
   */
  imageCopyDir: '',
  /**
   * 可发送语音的本机 TTS 产物目录。
   * 留空 = <workspaceCwd>\voice（没有工作区就落 DATA_DIR），目录不存在会自动创建。
   * 设成 "off" 才是真的关掉（拒绝从本机读取任何语音）。
   *
   * ⚠️ 2026-11-06 改：以前留空 = 直接拒绝，等于开箱即用时这个功能是坏的，
   *    而用户并不知道自己得先去填一个目录。现在给默认位置，"off" 保留硬关闭语义。
   *    安全边界没放松：目录外的文件、链接逃逸、内容签名不符、超大文件、超频
   *    照样全部拒绝（见 voiceout.js 的 resolveConfiguredVoicePath / validateVoiceBytes）。
   */
  voiceOutputDir: '',
  // ==================== 语音合成（0.19.0）====================
  //
  // 背景：在此之前插件**只负责发**语音（voiceout.js），合成整个在插件外面
  // （gptsovits MCP + text-to-speech 技能）。0.19.0 把「文本 → wav」搬进插件，
  // 出口是 qq_tts，背后两个引擎二选一。
  // 完整设计见 docs/开发提示词-语音合成双引擎.md。

  /**
   * 语音模式，四选一（全局一个，不按对象分）。
   *   'off'      禁用：qq_tts 不注册，qq_send 的 voice 参数也从 schema 里摘掉
   *   'passive'  被动：除非对方明确要求，否则不发语音
   *   'free'     自由：模型自己判断该不该发
   *   'active'   主动：尽量都用语音
   *
   * ⚠️ 默认 'off' —— 与升级前的 toolFeatures.voiceOut=false 行为一致。
   * ⚠️ 改档要**重启 DSH**（注册发生在 apply 里，同 toolFeatures 的纪律）。
   */
  voiceMode: 'off',
  /**
   * 合成引擎，二选一。
   *   'gptsovits'  本机 GPT-SoVITS（9872），免费、离线、音色靠参考音频
   *   'breeze'     Breeze Blue 商业 API，按字符计费、中文音色 530 个
   *
   * ⚠️ 这只是「默认」：它决定 qq_tts 走哪条路，**不阻止**模型自己去调 gptsovits MCP
   *    拿路径再 qq_send。用户 2026-11-07 明确要求「只是默认引擎，不拦 MCP」。
   */
  voiceEngine: 'gptsovits',
  /**
   * 能使用语音的私聊对象。空数组 = 所有已绑私聊都行。
   * 格式同 proactiveTargets：`['private:123456']`。
   */
  voiceTargetsPrivate: [],
  /**
   * 能使用语音的群。空数组 = 所有已监听群都行。
   * 格式：`['group:975663147']`。
   *
   * ⚠️ 数据源是「groupUins ∪ routes.group」（poll.js 的监听集合），
   *    不是只有绑了会话的群 —— 没绑会话的群也在监听。
   */
  voiceTargetsGroup: [],
  /**
   * 每日 Breeze 字数额度（按汉字算）。0 = 不限。
   *
   * **只算 Breeze，GPT-SoVITS 免费不计。** 全局共用一个池，不按对象分
   * （用户 2026-11-07 定：避免一群人在群里轮番点语音把人点破产）。
   *
   * ⚠️ 默认 1000 是用户选的，但实测 1000 字一次满额请求就吃掉全天额度
   *    （docs/调研-Breeze-TTS-API.md §12.9）。设置页有相应提示。
   */
  voiceDailyChars: 1000,

  // ---- 引擎 A：本机 GPT-SoVITS ----
  /** TTS 推理服务地址（9872）。跨机部署时改成宿主机的内网 IP。 */
  voiceGptsovitsUrl: 'http://127.0.0.1:9872',
  /**
   * 参考音频（绝对路径）。留空 = 用内置默认那条 Vodyanitsa 参考音频。
   * ⚠️ GPT-SoVITS 只接受 **3~10 秒**的参考音频。
   */
  voiceGptsovitsRef: '',
  /** 参考音频的台词。留空 = 读同名 .txt；再没有就回落到内置默认台词。 */
  voiceGptsovitsRefText: '',

  // ---- GPT-SoVITS 独有的调参（2026-11-07 用户要求「能调的尽量都暴露」）----
  //
  // ⚠️ 这一组**只对 GPT-SoVITS 生效**。Breeze 那边没有对应概念
  //    （Breeze 只有 speed / volume / guidance_scale / use_speaker_boost）。
  //    设置页里它们只在「选了本机引擎」时显示 —— 两个引擎的参数别混在一起。
  //
  // 全部有默认值：不填 = 与升级前逐字一致（这些就是 buildGptsovitsArgs 的默认）。
  /** 文本语种：中文 / 英文 / 日文 / 粤语 / 韩文 / 中英混合 / 日英混合 / 粤英混合 / 韩英混合 / 多语种混合 / 多语种混合(粤语) */
  voiceGptsovitsLang: '中文',
  /** 语速倍率。约 0.6~1.65，1 = 原速。 */
  voiceGptsovitsSpeed: 1,
  /** top_k。越大越发散。 */
  voiceGptsovitsTopK: 15,
  /** top_p。 */
  voiceGptsovitsTopP: 1,
  /** 采样温度。越高越随机、越低越稳。 */
  voiceGptsovitsTemperature: 1,
  /**
   * 切句方式：不切 / 凑四句一切 / 凑50字一切 / 按中文句号。切 / 按英文句号.切 / 按标点符号切
   * ⚠️ 长文本合成到一半崩掉时先换这个（默认「凑四句一切」最稳）。
   */
  voiceGptsovitsSplit: '凑四句一切',
  /** 批处理大小。显存紧张时调小。 */
  voiceGptsovitsBatchSize: 20,
  /** 分片间隔（秒）。 */
  voiceGptsovitsFragmentInterval: 0.3,
  /**
   * 随机种子。-1 = 每次不同；填正整数则**同参数下结果可复现**。
   * 想「同一段话重来得到完全一样的音频」就固定它。
   */
  voiceGptsovitsSeed: -1,
  /** 重复惩罚。越高越不容易复读。 */
  voiceGptsovitsRepetitionPenalty: 1.35,
  /**
   * 采样步数：4 / 8 / 16 / 32（存字符串）。
   * ⚠️ v2ProPlus 架构下这个参数**实际无效**（见 gptsovits-voice-calib 技能）；
   *    留着是因为 v4/v5 模型会用到。
   */
  voiceGptsovitsSampleSteps: '32',
  /** cfg_rate。0 = 关闭。 */
  voiceGptsovitsCfgRate: 0,

  // ---- 引擎 B：Breeze Blue ----
  /**
   * API key（brz_ 开头）。留空 = Breeze 不可用。
   *
   * ⚠️ 存在 ~/.dsh/qq-bridge.config.json 里（和 token / wsToken 同一个模式），
   *    **绝不回传给浏览器、绝不写进日志**。
   */
  voiceBreezeKey: '',
  /** 默认 voice_id。留空 = 不允许合成（必须先选一个，否则每次都是 404）。 */
  voiceBreezeVoice: '',
  /**
   * 模型。留空 = 不传，服务端按 language_code 自动选。
   * 实测中文会选 `breeze-tts-2`（它只支持 en + zh，正是我们要的）——
   * 见 docs/调研-Breeze-TTS-API.md §12.2。
   */
  voiceBreezeModel: '',
  /**
   * 输出格式。默认 `wav`。
   *
   * 为什么不用 mp3：Breeze 的 mp3 是**裸 MPEG 帧**（无 ID3），虽然
   * voiceout.js 的 validateVoiceBytes 认这种头，但 WAV 能过完整结构校验
   * （RIFF 长度 + fmt/data 块），且不依赖解码器差异。实测两种都正常。
   */
  voiceBreezeFormat: 'wav',
  /**
   * 「测一下」用的句子（2026-11-07 用户要求可自定义）。
   *
   * 留空 = 用内置的「你好，这是一次测试。」（10 个字符，额度断言按它算）。
   *
   * 为什么允许改：默认那句太短，听不出音色特点、也听不出语速问题 ——
   * 用户想拿自己的句子试听「这句话念出来像不像」。
   *
   * ⚠️ 上限 200 字（见 tts.js 的 VOICE_TEST_MAX_CHARS）：这是**探针**不是正式合成，
   *    句子太长会让一次「测一下」白烧大量额度（按字计费）。
   */
  voiceTestText: '',
  /**
   * 注册 / 推广链接（0.19.5）。
   *
   * 用户在设置页看到「还没有 Breeze 账号？点这里注册 →」，点开就是这一格。
   * 留空 = 用内置的官方登录页 `https://breezeblue.ai/auth/login`。
   *
   * 为什么做成配置项而不是写死：Breeze 目前**没有公开的邀请/返佣计划**
   * （sitemap、文档站、/referral 全是 404），所以插件不能替任何人背书；
   * 而部署者如果想换成自己的链接，不该需要改代码重新打包。
   * 填了之后设置页会显示「推广链接」并附一行披露 —— 带返利的链接算广告。
   *
   * ⚠️ 只接受 http/https（cleanSignupUrl），其它一律清空：这个值会变成
   *    `<a href>`，配置文件又是明文、会被用户互相分享。
   */
  voiceSignupUrl: '',
  /**
   * Breeze 的语速（2026-11-07 用户反馈「说话听起来太快了」）。
   *
   * 官方范围 0.5 ~ 2.0，默认 1.0。**变速保持音高不变**，
   * 所以调慢只是说得更从容，不会变成低沉慢放。
   *
   * 默认 0.9：实测 1.0 偏快（用户听感），0.9 约慢 11%，
   * 是「明显更从容、又不显得拖沓」的位置。想要原速填 1.0。
   */
  voiceBreezeSpeed: 0.9,
  // ---- Breeze 独有的 voice_settings（2026-11-07 全部暴露）----
  //
  // ⚠️ 这三项**只对 Breeze 生效**，GPT-SoVITS 没有对应概念。
  //    设置页里只在「选了 Breeze」时显示。
  /**
   * `guidance_scale`：对参考音色 / instructions 的贴合强度，1.0~10.0，默认 1.0。
   *
   * ⚠️ 官方说明：**当 instructions 非空且它 > 1 时，use_speaker_boost 会被忽略**。
   *    我们不传 instructions（设计上刻意不给），所以它只影响音色贴合度。
   *    官方建议：表现力强的段落从 1~3 试起；连续旁白从 1 起。
   */
  voiceBreezeGuidanceScale: 1,
  /**
   * `volume`：线性振幅乘数，0.01~2.0（1%~200%），默认 1.0。
   * ⚠️ **不是响度归一化** —— >1.0 可能削波。觉得声音小先调播放端，别靠它。
   */
  voiceBreezeVolume: 1,
  /**
   * `use_speaker_boost`：提升对参考音色的相似度，默认 false。
   * ⚠️ 与 guidance_scale 有耦合：instructions 非空且 guidance_scale > 1 时被忽略。
   */
  voiceBreezeSpeakerBoost: false,
  /**
   * OneBot 正向 WebSocket（事件推送）。留空 = 启动时自动从 SnowLuma 配置里发现。
   * 开启后入站消息是「事件到达即处理」，延迟从均值 1 秒降到接近 0。
   */
  wsEnabled: true,
  wsUrl: '',
  wsToken: '',
  /** SnowLuma 的 config 目录（自动发现用）。留空 = 常见安装位置 + 运行中进程反推。 */
  snowlumaConfigDir: '',
  /** WS 正常时轮询的补漏间隔。WS 断开时自动回到 pollMs。 */
  wsFallbackPollMs: 30000,
  // 注：这里曾有 wsPrivateMergeMs（私聊合并窗口），但全代码没有消费方 ——
  //     合并窗口现在统一由 merge.js 实现（poll.js 消费），那个键从没生效过。2026-10-29 删除。
  /**
   * 发说说是否要求显式确认（默认 true）。
   *
   * 工具参数里的 confirm=true 必须传才会真的发出去。理由：说说是对外发布，
   * 而删说说的接口是封禁的（见 blocked.js），发出去撤不回来。
   * 关掉（false）= 恢复「想发就发」，不推荐。
   */
  qzoneRequireConfirm: true,
  /** 回合故障时，是否由插件向 QQ 发送带 [系统] 的说明（默认开，兼容当前行为）。 */
  notifyTurnFailures: true,
  /**
   * QQ 侧命令前缀（2026-11-05，"跨工作区会话进度"）。
   * 空串 = 关闭命令层（所有消息照旧投给会话）。
   * 只有**整条消息**以它开头、且命令名精确命中时才算命令；
   * 不认识的 `/xxx` 原样投给会话，绝不吞掉用户的话。
   */
  qqCommandPrefix: '/',
  /**
   * 非默认会话的回复是否加会话标签（`〔工作区·会话〕`）。
   * 只在「当前会话 ≠ 该 QQ 目标的默认绑定会话」时加，日常单会话聊天不受影响。
   * 为什么需要：多个会话往同一个 QQ 推送时，分不清哪句是哪边说的。
   */
  focusTagEnabled: true,
  /**
   * 焦点闲置多久自动回默认绑定（毫秒，0 = 永不）。
   * 防止「昨天 /去 了 A，今天发消息还进 A」这种跨天串台。
   */
  focusIdleResetMs: 3600000,
  /** `/进度` 最多列几行。 */
  progressMaxRows: 12,
  /** `/进度` 的「最近活跃」时间窗（毫秒，默认 24 小时）。 */
  progressIdleWindowMs: 86400000,
  /**
   * 上线补历史（2026-10-28）。
   *
   * 轮询每轮只拉 10 条 —— 掉线期间攒的消息超过 10 条就会永久丢，
   * 而且游标会直接跳到最新（不是报错，是设计如此，所以特别难发现）。
   * 开启后每次上线先按游标把窗口翻干净，再交给常规轮询。
   *
   * backfillMaxPages：每个对象最多往回翻几页（每页 50 条），防止启动时打爆协议端。
   * backfillDeliver：每个对象最多投递几条，超出的只报数不展开（避免灌爆上下文）。
   */
  backfillOnStart: true,
  backfillMaxPages: 5,
  backfillDeliver: 20,
  /**
   * 戳一戳（2026-11-02）：别人戳她时要不要接话。
   *
   * 为什么默认开着：戳一戳是 QQ 里最轻的「叫你一声」，收到却没反应
   * 在真人对话里就是「装死」。但它是 notice 事件，不是消息 ——
   * 不加这段处理的话，事件会被 handleWsEvent 的 post_type 判断直接丢掉。
   *
   * pokeCooldownMs 是必须有的刹车：戳一戳的触发成本极低（双击头像），
   * 群里几个人闹起来一秒能戳十下，没有冷却就是「被戳一下就回一句」的刷屏机器。
   * 按群算冷却（私聊按人算），0 = 不限制。
   */
  pokeEnabled: true,
  pokeCooldownMs: 10000,
  /**
   * 合并转发（「群聊的聊天记录」卡片）的展开（2026-11-02）。
   *
   * 为什么这是缺陷修复而不是新功能：一张聊天记录卡片本来是一条**有内容**的消息，
   * 旧版把它渲染成 `[转发消息]` 就交付给模型了 —— 等于把内容丢了。
   * 但展开方式（要不要图、要不要递归、截多少）直接影响 token 成本和投递延迟，
   * 所以给一组开关，默认值取「能看懂、但别烧钱」。
   *
   * ⚠️ 展开要发网络请求（get_forward_msg），所以每一项都必须有上限 ——
   *   一张卡片实测可以有 95 条、8 条嵌套、11 张图，任一项不限都会拖垮投递链。
   */
  forwardExpandEnabled: true,
  /**
   * 递归展开几层。0 = 完全不展开（等于旧行为），1 = 只展开最外层，2 及以上继续往里钻。
   *
   * 默认 2（2026-11-02 用户定）：**不设硬上限** —— 这是可配置项，成本由配置的人自己承担。
   * 之所以敢放开：同 id 的卡片只请求一次（跨层去重），所以深嵌套不会指数爆炸；
   * 真正花钱的是「请求数」和「展开出来的字数」，那两项各自有上限。
   * 实测：一张 95 条的卡片里嵌了 8 条子卡片，默认 2 层刚好能看到子卡片内容。
   */
  forwardMaxDepth: 2,
  /** 单张卡片最多展开多少条（第一条无论多长都会收）。 */
  forwardMaxMessages: 50,
  /** 单张卡片最多展开多少字（超出就截断并明说还漏了几条）。 */
  forwardMaxChars: 2000,
  /** 卡片里的图片要不要下载给模型看（默认关：一张卡片可能有十几张图）。 */
  forwardImagesEnabled: false,
  /** 开图时，一次投递里卡片图片最多取几张（和入站上下文图共用一个预算口径）。 */
  forwardImageLimit: 6,
  /** 单张卡片展开的超时期望（毫秒）。它卡住等于整条投递卡住，所以比全局 8 秒短。 */
  forwardTimeoutMs: 4000,
  /** 同一批消息里最多同时展开几张卡片（是**并发数**，不是上限：所有卡片最终都会取）。 */
  forwardConcurrency: 3,
  /**
   * 一次投递里最多发几个展开请求 / 最多花多久（2026-11-02 审核后加）。
   *
   * 为什么必须有：`forwardMaxChars` / `forwardMaxMessages` **只管渲染，不管抓取**。
   * 抓取只受 `forwardMaxDepth` 约束，而它不设上限（成本由配置者承担）。
   * 一张卡片嵌 N 条、N 条各嵌 N 条时请求数会翻倍增长，每条最坏 `forwardTimeoutMs`，
   * 而这段跑在**串行投递链**上 —— 后果不是「慢一点」，是整条群投递停摆。
   * 预算把单次投递的花费变成常数上界，同时保留调大 depth 的自由。
   * 超预算的卡片按占位渲染，并在日志里明说，不会静默丢内容。
   */
  forwardMaxRequests: 16,
  forwardBudgetMs: 6000,
  /**
   * 工具箱：按功能组启停工具（0.17.4）。
   *
   * 关掉的那一档**根本不注册** —— schema 压根不生成，不占上下文。
   * 为什么不用 `ctx.tools.restrict({deny})`：它必须传 scoped 的 `agent.ctx`，
   * 在全局 context 上直接抛 `requires a scoped context`；而冷启动的 agent 是插件自己
   * resume 出来的，要为每个 agent 单独挂，时序根本保证不了。
   *
   * 代价：改完**要重启 DSH** 才生效（注册发生在 apply 里）。设置页必须明写这一点。
   * 默认值的理由见上面 TOOL_FEATURE_DEFAULTS 的注释。
   */
  toolFeatures: { ...TOOL_FEATURE_DEFAULTS }
}

let config = { ...DEFAULTS, enabled: false }

export function getConfig() {
  return config
}

/**
 * 读配置文件 + 迁移旧路由。
 *
 * 迁移（一次性，幂等）：单路由时代的 sessionId / groupSessionId 统一搬进
 * routes.private[peerUin] / routes.group —— 迁完写回文件，之后的代码只认 routes。
 * 迁移保留旧字段不删（回滚到旧版本插件时不丢配置）。
 */
export function loadConfig() {
  // 保留一份**原始文件内容**：迁移要判断「这个键是真的不存在，还是等于默认值」——
  // 合并进 DEFAULTS 之后就分不出来了（新键会以默认值出现，看着像用户配的）。
  let rawFile = null
  try {
    rawFile = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    config = { ...DEFAULTS, ...rawFile }
  } catch (error) {
    note('config', `FAILED ${error instanceof Error ? error.message : error}`)
    rawFile = null
    config = { ...DEFAULTS, enabled: false }
  }
  // ownerUin 没配就退化成 peerUin：私聊对象本来就是用户本人
  if (Number(config.ownerUin) <= 0) config.ownerUin = config.peerUin

  // toolFeatures 是**嵌套对象**，`{...DEFAULTS, ...raw}` 会整个替换掉默认值 ——
  // 老配置文件（没有这个键）拿到的是新默认，但手改过一半的只会有那半个键。
  // 统一在这里收干净，下游（index/tool/api）就不用各判一次。
  config.toolFeatures = normalizeToolFeatures(config.toolFeatures)

  // ---- 语音四档（0.19.0）----
  // 先迁移（读旧的 voiceOut），再归一化 —— 顺序反过来会把刚迁出来的值当成非法值。
  const voiceMigrated = migrateVoiceMode(config, rawFile)
  config.voiceMode = normalizeVoiceMode(config.voiceMode)
  config.voiceEngine = normalizeVoiceEngine(config.voiceEngine)
  // 名单语义反转的迁移（必须在 voiceMode 归一化之后 —— 它要看 voiceMode 决定迁不迁）
  const targetsMigrated = migrateVoiceTargets(config, rawFile)
  if (voiceMigrated || targetsMigrated) saveConfig()

  // ---- 分条间隔：旧的 min/max 区间 → 模式 + 数值（2026-11-07）----
  //
  // 老配置里是 `splitDelayMinMs: 200, splitDelayMaxMs: 700`（区间 + 隐藏的 perChar 12）。
  // 新模型是「一个模式 + 一个数值」。迁移原则：**尽量保留他现在的实际体感**，
  // 而不是粗暴地换成 800 —— 那会让人莫名其妙觉得「我什么都没改，间隔变了」。
  //
  // 取旧区间的中位数当固定值：200/700 → 450。
  // ⚠️ 只在**新键不存在**时迁移。已经设过 splitDelayMs 的不动（用户自己选过的算数）。
  if (rawFile !== null && typeof rawFile === 'object' && rawFile.splitDelayMs === undefined) {
    const legacyMin = Number(rawFile.splitDelayMinMs)
    const legacyMax = Number(rawFile.splitDelayMaxMs)
    if (Number.isFinite(legacyMin) || Number.isFinite(legacyMax)) {
      const lo = Number.isFinite(legacyMin) && legacyMin >= 0 ? legacyMin : 200
      const hi = Number.isFinite(legacyMax) && legacyMax >= lo ? legacyMax : 700
      config.splitDelayMode = 'fixed'
      config.splitDelayMs = Math.round((lo + hi) / 2)
      note('config', `迁移分条间隔区间 ${lo}~${hi}ms -> fixed ${config.splitDelayMs}ms`)
      saveConfig()
    }
  }
  // 退役键：读完之后清掉，免得它继续出现在配置文件里误导人
  for (const dead of ['splitDelayMinMs', 'splitDelayMaxMs']) {
    if (dead in config) {
      delete config[dead]
      note('config', `清理退役配置 ${dead}（已被 splitDelayMode/splitDelayMs 取代）`)
    }
  }

  // 清掉已退役的死键（见 DEFAULTS 里 wsPrivateMergeMs 的注释）。
  // 只在内存里删，下次 saveConfig 时文件里那条也会跟着消失。
  if ('wsPrivateMergeMs' in config) {
    delete config.wsPrivateMergeMs
    note('config', '清理退役配置 wsPrivateMergeMs（从未生效）')
  }

  // ---- 旧路由迁移：只搬「目标存在且 routes 里还没有」的 ----
  let migrated = false
  if (config.routes === null || typeof config.routes !== 'object') {
    config.routes = { private: {}, group: {} }
  }
  if (config.routes.private === null || typeof config.routes.private !== 'object') config.routes.private = {}
  if (config.routes.group === null || typeof config.routes.group !== 'object') config.routes.group = {}
  const legacyPrivate = typeof config.sessionId === 'string' && config.sessionId !== ''
  if (legacyPrivate && Number(config.peerUin) > 0) {
    const key = String(config.peerUin)
    if (config.routes.private[key] === undefined) {
      config.routes.private[key] = { sessionId: config.sessionId }
      migrated = true
      note('config', `迁移单路由字段 sessionId -> routes.private[${key}]`)
    }
  }
  if (typeof config.groupSessionId === 'string' && config.groupSessionId !== '') {
    // 旧单路由群：迁进第一个没绑会话的已监听群（通常也就一个）
    const watchees = [...(Array.isArray(config.groupUins) ? config.groupUins : []), ...Object.keys(config.routes.group)]
    for (const gid of watchees) {
      const key = String(gid ?? '').trim()
      if (key === '') continue
      if (config.routes.group[key]?.sessionId === undefined) {
        config.routes.group[key] = { ...(config.routes.group[key] ?? {}), sessionId: config.groupSessionId }
        migrated = true
        note('config', `迁移单路由字段 groupSessionId -> routes.group[${key}]`)
        break
      }
    }
  }
  if (migrated) saveConfig()

  // ---- 工作区自愈：配了一个注册表里没有的路径 → 改回 DEFAULTS 指的那个 ----
  //
  // 为什么需要（0.18.4）：DEFAULTS 曾写死 `D:\DSH workspace\QQ对话`，而那个目录
  // 在本机**根本不存在** —— 于是存量配置文件里就落着这个死路径，
  // 「N 个可选会话」永远是 0，用户连绑都绑不了。只改 DEFAULTS 救不了**存量配置文件**
  // （`{...DEFAULTS, ...raw}` 里 raw 的旧值优先），所以必须在这里修一次。
  //
  // ⚠️ 兜底目标**只能是 DEFAULTS 里的那个工作区**，不能是「注册表里随便挑一个」。
  //    实测踩过：早先写的是「挑会话最多的那个」，在这台机器上选出来是 CreateCMPOR
  //    （29 个会话，一个 Minecraft 模组工作区）—— 跟 QQ 毫无关系。而这个值不只筛会话，
  //    还是「收到的图片」目录的根（images.js:305 / collect.js:452），挑错等于悄悄把
  //    以后收到的图全搬到别的工作区里去。宁可不改，也不能改错。
  //
  // ⚠️ 三条纪律：
  //   ① 只修「配了但注册表里没有」的，**空串不碰** —— 空串是用户主动选「不筛工作区」；
  //   ② 注册表读不到、或默认工作区也不在注册表里 → **原样保留**，绝不凭猜测改；
  //   ③ 修完写回配置文件并记一行日志，别让「值自己变了」变成灵异事件。
  //
  // 为什么不干脆不自愈：不改的话设置页停在「N 个可选会话 = 0」，用户得自己意识到
  // 是工作区选错了才去点下拉框 —— 这正是这个缺陷当初难发现的原因。
  // 现在的改法两头都占：已知失效且**有确定正确目标**时自动修好；没有就老实留着，
  // 由选择器上那句「不在注册表里，请重新选」把它挑明。
  if (typeof config.workspaceCwd === 'string' && config.workspaceCwd !== '') {
    try {
      const { workspaces } = readWorkspaces()
      if (workspaces.length > 0) {
        const wanted = normCwd(config.workspaceCwd)
        const hit = workspaces.some((item) => normCwd(item.path) === wanted)
        if (!hit) {
          const fallback = workspaces.find((item) => normCwd(item.path) === normCwd(DEFAULTS.workspaceCwd))
          if (fallback !== undefined) {
            note('config', `工作区 ${config.workspaceCwd} 不在注册表里，自动改回默认工作区 ${fallback.path}（${fallback.title}）`)
            config.workspaceCwd = fallback.path
            saveConfig()
          } else {
            note('config', `工作区 ${config.workspaceCwd} 不在注册表里，但默认工作区也不在；保留原值，等用户在设置页选`)
          }
        }
      }
    } catch (error) {
      note('config', `工作区自愈跳过：${error instanceof Error ? error.message : error}`)
    }
  }

  // ---- WS 接入点：没配就自动从 SnowLuma 配置里发现 ----
  // 找不到不是错误：退回纯 HTTP 轮询，收发照常（只是延迟高一点）。
  if (config.wsEnabled !== false && String(config.wsToken ?? '') === '') {
    const endpoint = discoverWsEndpoint(String(config.snowlumaConfigDir ?? ''))
    if (endpoint !== null) {
      config.wsUrl = endpoint.url
      config.wsToken = endpoint.token
      saveConfig()
    }
  }

  note('config', `ok peer=${config.peerUin} owner=${config.ownerUin} groups=${JSON.stringify(config.groupUins)} routes.private=${Object.keys(config.routes.private).length} routes.group=${Object.keys(config.routes.group).length} ws=${config.wsEnabled === false ? 'off' : String(config.wsUrl ?? '')}`)
  return config
}

/** 把当前 config 写回配置文件（UTF-8 无 BOM）。 */
export function saveConfig() {
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf8')
    return true
  } catch (error) {
    note('config', `save failed ${error instanceof Error ? error.message : error}`)
    return false
  }
}

/** 配置文件是否存在（state 自洁要用来判断「从未配置过」）。 */
export function configExists() {
  return existsSync(CONFIG_FILE)
}
