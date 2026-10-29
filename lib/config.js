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
  //     合并窗口在 ws.js 里是按常量实现的，那个键从没生效过。2026-10-29 删除。
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
  backfillDeliver: 20
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
