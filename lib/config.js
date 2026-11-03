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

export const DEFAULTS = {
  enabled: true,
  /** 设置页列会话、以及新建会话归属的工作区。 */
  workspaceCwd: 'D:\\DSH workspace\\QQ对话',
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
  /** 要监听的群号；留空 = 不监听任何群。 */
  groupUins: [],
  /** 群里只有 @ 到本号才投递。 */
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
  /** 每条之间的停顿毫秒区间（实际按字数在区间内取随机值）。 */
  splitDelayMinMs: 200,
  splitDelayMaxMs: 700,
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
  forwardBudgetMs: 6000
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
  try {
    config = { ...DEFAULTS, ...JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) }
  } catch (error) {
    note('config', `FAILED ${error instanceof Error ? error.message : error}`)
    config = { ...DEFAULTS, enabled: false }
  }
  // ownerUin 没配就退化成 peerUin：私聊对象本来就是用户本人
  if (Number(config.ownerUin) <= 0) config.ownerUin = config.peerUin

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
