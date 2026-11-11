/**
 * dsh-onebot-channel
 *
 * 把 QQ 私聊 / 群聊里「叫到机器人」的消息转成 DSH 会话里的用户消息，唤醒会话跑一个回合；
 * 并提供 qq_send 工具把回复发回 QQ。
 *
 * 私聊：所有在监听集合里的好友（peerUin ∪ routes.private 的键）的消息都会投递。
 * 群聊：只投递【@ 到自己】的消息（groupOnlyWhenAt），其余只更新游标、不打扰。
 *
 * 身份规则：ownerUin 是用户本人的 QQ。群消息一律标「用户本人」或「群友「昵称」（不是用户本人）」，
 * 上下文里的历史发言也逐条打标 —— agent 分不清谁是谁，就会把群友的话当成用户的指令。
 *
 * 模块划分（lib/）：
 *   env.js      数据目录、日志（带轮转）、宿主服务取用
 *   config.js   配置 + 旧单路由字段的一次性迁移
 *   state.js    轮询游标持久化（按 QQ 号/群分游标）
 *   onebot.js   OneBot HTTP 调用 + 消息段解析
 *   split.js    回复分条（纯函数，可单测）
 *   images.js   QQ 图片 -> 附件库 + 人看的副本
 *   title.js    从落盘会话日志抠标题（zstd 多帧）
 *   sessions.js 会话列表 + 冷启动（AgentRegistry.resume）
 *   deliver.js  路由查询 + 投递（agent.followup）
 *   outbound.js 回复转发回 QQ（每会话一个待转发队列）
 *   poll.js     私聊 / 群聊轮询循环（自调度防重入）+ 消息处理（WS 与轮询共用）
 *   ws.js       OneBot 正向 WebSocket 事件推送（入站实时化，断线自动重连）
 *   health.js   OneBot 探活门控 + 错误分级（分清「门没开」和「门开着但出错」）
 *   snowluma.js 从 SnowLuma 本地配置里自动发现 WS 接入点（省得手抄 token）
 *   api.js      设置页 API（/api/qq-bridge/*）
 *   tool.js     qq_send 工具注册
 *   sendapi.js  AI 主动发消息的本地 HTTP 接口
 *
 * 设计约束（都是踩过的坑）：
 * 1. 游标分两套 —— 群聊用 message_seq（群消息 seq 单调递增），私聊用时间戳：
 *      私聊的 message_seq 是两套编号混着的（自己发的 71xx 连续、对方发的 50xxx/20xxx 跳号
 *      且不单调），拿它判新旧会误杀新消息（详见 lib/poll.js 的 isSeen 注释）；
 *      message_id 只用来做「相等」判断去重，绝不拿来比大小（可能是负数）。
 * 2. 宿主包一律动态 import 并带兜底，静态 import 失败会让整个插件加载不了；
 * 3. 必须声明 cordis inject（agents / tools / webServer / llm / sessions）：
 *    没声明的服务，ctx.get 会抛 "without inject"，表现就是设置页 0 个可选会话；
 * 4. 每一步都写 qq-bridge-load.log，出问题先看日志；
 * 5. 工具先注册、入站后启动：工具是出站能力，跟 QQ 登录无关，早点给 agent；
 *    入站（轮询 + WS）要等 OneBot 端点真的能应答了再起，否则满屏 timeout 噪音。
 */
import { note, serviceOf } from './env.js'
import { getConfig, loadConfig, deriveToolFeatures } from './config.js'
import { loadState } from './state.js'
import { registerApi } from './api.js'
import { captureBootVoiceMode } from './api.js'
import { startGroupLoop, startPrivateLoop, handleWsEvent, drainMerge, deliverWindowBatch } from './poll.js'
import { flushOutbound } from './outbound.js'
import { startWs } from './ws.js'
import { waitForOneBotReady } from './health.js'
import { registerSendTool, registerEmojiSearchTool, registerQzoneTool, registerCollectTool, registerFacePreviewTool, registerFacePickTool, registerFaceRenameTool, registerWaitTool, registerPassTool, registerSkipTool, registerCloseTool, registerPokeTool, registerVoiceTool, registerTtsTool } from './tool.js'
import { startSendApi } from './sendapi.js'
import { startProactive, flushPersist as flushProactivePersist } from './proactive.js'
import { startWindowLoop, resetRecoveredWindows } from './window.js'
// 0.23.0：兴趣点循环（旁路）。触发器在 poll.js 那边，这里只管定时判定与下发。
import { startInterestLoop } from './interest.js'
import { flushPersist as flushMemoryPersist } from './memory.js'
import { acquireInstanceLock, releaseInstanceLock } from './instance.js'
import { runBackfill } from './backfill.js'
import { mountPromptSection, mountVoicePromptSection } from './prompt.js'

// 插件名 = 裸包名，必须和 package.json 的 name、cordis.patch.yml 里的 name、
// 以及**插件目录名**三者一致。
// DSH 按目录名去 node_modules 里找包（nearestPackage），并且会校验
// package.json 的 name 等于目录名 —— 对不上就跳过这个包，
// 浏览器侧拿不到 client bundle，设置页的「QQ 桥接」入口直接消失。
export const name = 'dsh-onebot-channel'
// 必须声明 inject：cordis 里没 inject 的服务，读 ctx.agents / ctx.tools 会直接抛
// "cannot get property X without inject"（上一版就是这么坏的）。
// sessions 是核心服务（dsh-session 提供），不声明的话 ctx.get('sessions') 会抛，
// 表现就是设置页「0 个可选会话」。
//
// 2026-11-02 补 agentPresets：
//   sessions.js 的 composeSetup 要它来把会话记录的 preset 重新挂到冷启动的 agent 上。
//   之前没声明 → serviceOf 取不到 → composeSetup 静默返回空 setup →
//   resume 出来的 agent **没有 preset**，工具只剩「全局插件」那一层
//   （qq_* / soul_* / screen_* / session_* 都在，但 read/write/glob/grep/pwsh 全没了）。
//   症状像插件坏了，其实只是冷启动时少挂了一个 preset，日志里还一个字都没有。
//
// 2026-11-09 补回 sessionTitle：
//   它在 0.18.8 就声明过（那次修的是「绑定会话下拉显示 #id 而不是会话名」），
//   但 0.21.x 那次合并远端 index.js 时被覆盖丢失了 ——
//   `serviceOf(ctx,'sessionTitle')` 直接抛 "cannot get property ... without inject"，
//   被上层 catch 吞成空串，表现就是下拉里**又变回 #xxxx**。
//   ⚠️ 这是「合并覆盖」的典型残留：功能代码在别的模块里好好的，
//      只有这一行声明没了，所以 `node --check` 和大部分单测都发现不了。
export const inject = [
  'agents', 'tools', 'webServer', 'llm', 'sessions', 'attachments', 'agentPresets',
  'sessionTitle'
]

note('module', `loaded pid=${process.pid} node=${process.version}`)

export function apply(ctx) {
  note('apply', `started pid=${process.pid}`)

  // 配置先加载（含旧路由迁移），状态随后（自洁要靠配置里的监听集合）
  loadConfig()
  loadState()
  resetRecoveredWindows()
  const config = getConfig()

  // ---- 捕获「启动时生效的语音模式」（0.21.4 补回调用）----
  // 设置页要同时显示「当前已选」和「启动时真正生效的那个」，两者不一致时提示
  // 「重启 DSH 后才会换成…」—— 因为语音四档的注册发生在 apply 里，改配置必须重启。
  //
  // ⚠️ 这一行是 0.21.x 合并远端 index.js 时丢的：`captureBootVoiceMode` 一直在
  //    import 里（所以 `node --check` 和 lint 都看不出问题），但**没有任何地方调用它**。
  //    后果：/state 的 runtime.activeVoiceMode 永远是空串，前端拿不到对比值，
  //    「已选择 vs 已生效」那整块 UI 静默失效（不报错、不崩，就是永远不显示）。
  //    必须紧跟在 loadConfig() 之后调 —— 再晚就取不到「启动那一刻」的值了。
  captureBootVoiceMode(config)

  // API 先注册：配置不全或被禁用时，设置页也得能打开来改
  try {
    registerApi(ctx)
  } catch (error) {
    note('api', `register threw ${error instanceof Error ? error.message : error}`)
  }

  try {
    if (!config.enabled) return note('apply', 'disabled by config')
    // 就绪闸门只校验「协议端连通所必需」的东西（2026-11-06 修）。
    //
    // ⚠️ 以前这里还要求 `Number(config.peerUin) > 0`，那是个**过时的条件**：
    //    `peerUin` 早就从「唯一私聊目标」退化成可选别名了 ——
    //      · state.js:63     私聊监听集合 = routes.private ∪ peerUin(>0 才加)
    //      · allowlist.js:63 出站白名单私聊 = peerUin ∪ ownerUin ∪ routes.private
    //      · config.js        ownerUin 没配时才拿 peerUin 兜底
    //    所以「只配 routes、不填 peerUin」是完全合法的配置。
    //
    //    但闸门没跟着改 → 这种合法配置被判成 config incomplete → **整个入站通路不启动**
    //    （私聊轮询、群轮询、WS 推送全都没有），而且日志只有一行语焉不详的
    //    「config incomplete」，一个字都不提它挡掉了什么。
    //    真实故障：用户 WS 参数配得完全正确，状态页却永远「推送未连（轮询兜底）」，
    //    因为 startWs() 在 return 之后，根本没人走到读它那里。
    //
    // 现在只查 token。群监听和 WS 推送都不依赖 peerUin。
    if (config.token === '') {
      // 说清挡掉了什么：只写「config incomplete」等于让人自己去猜后果
      return note('apply', 'config incomplete (token) → 未启动轮询/WS')
    }

    const timers = []
    // 各循环的停止函数。自调度循环的停止函数：setInterval 把间隔写死了，改设置页里的
    // pollMs 不生效，所以改成「跑完再排下一次」，每轮重新读配置。
    const stopFns = []
    // dispose 可能发生在「等 OneBot 就绪」这段异步等待里 —— 用它挡住等待结束后再起循环，
    // 否则插件已经被卸载了，循环却又被拉起来，变成没人管的野循环。
    let disposed = false
    const toolRegistration = new AbortController()

    // 一次性诊断：把 agent 注册表和每个会话是否「活着」写进日志，省得靠猜。
    try {
      const agents = serviceOf(ctx, 'agents')
      const keys = agents !== undefined && agents !== null && typeof agents.keys === 'function' ? Array.from(agents.keys()) : []
      note('diag', `agents=${agents === undefined || agents === null ? 'missing' : typeof agents} keys=[${keys.join(',')}]`)
      const sessions = serviceOf(ctx, 'sessions')
      const list = sessions !== undefined && sessions !== null && typeof sessions.list === 'function' ? sessions.list() ?? [] : []
      for (const session of list) {
        const id = String(session?.header?.id ?? session?.id ?? '')
        if (id === '') continue
        let live = false
        try {
          live = agents !== undefined && agents !== null && typeof agents.get === 'function' && Boolean(agents.get(id))
        } catch (error) {
          live = false
        }
        note('diag', `${id} live=${live} cwd=${session?.header?.cwd ?? ''}`)
      }
    } catch (error) {
      note('diag', `failed ${error instanceof Error ? error.message : error}`)
    }

    // ---------------- 常驻提示：长任务先出声（2026-11-03）----------------
    // 「她埋头干几分钟活、QQ 那头一片安静」的根因不是她懒，是她看不到对面在干等。
    // 这段系统段落每次组装提示词时渲染一次，不进会话历史，重启后也在 ——
    // 所以不用每开一个新会话手动贴 QQ对话说明.md。
    // 拿不到 systemPrompt 服务时它自己跳过：少这一段提示，收发主链路完全不受影响。
    try {
      mountPromptSection(ctx)
    } catch (error) {
      note('prompt', `挂载常驻段落失败（不影响收发）：${error instanceof Error ? error.message : error}`)
    }

    // ---------------- 常驻提示：语音档位（0.19.0）----------------
    // 四档的语义**只能靠提示词落实** —— 「这句话适不适合用语音」是语义问题，
    // 代码判不了（见 docs/开发提示词-语音合成双引擎.md §2.1）。
    // 所以这里按 voiceMode 注册一段不同的段落：「禁用」档整段不注册，
    // 其余三档各说自己那一档该怎么做。
    //
    // ⚠️ 和上面那段一样，拿不到 systemPrompt 服务时自己跳过 ——
    //    少一段提示不影响收发，但不能因此让整个 apply 抛错。
    try {
      mountVoicePromptSection(ctx, config)
    } catch (error) {
      note('prompt', `挂载语音段落失败（不影响收发）：${error instanceof Error ? error.message : error}`)
    }

    // ---------------- 工具注册（不等探活）----------------
    // 工具是**出站**能力：qq_send 往 QQ 发消息、qq_emoji_search 查表情……
    // 它们不依赖 QQ 那边先登录好，端点通不通都能注册。
    // 反过来，如果把它们也押在探活后面，QQ 迟迟不登录时 agent 就一个工具都看不到，
    // 会误判成「插件没装上」。所以先注册。
    //
    // ⚠️ 必须**按 features 分档注册**（0.21.4 补回）：
    //   0.21.x 合并远端 index.js 时，这一段退化成了「全部无条件注册」——
    //   `deriveToolFeatures` 还在 import 里（所以静态检查看不出问题），
    //   但没有任何地方调用它，于是设置页「工具箱」里关掉的档**依然会注册工具**。
    //   后果不是报错，而是：关掉表情包档，agent 照样看得到 qq_emoji_search / qq_face_pick，
    //   每回合白烧那份 schema 的 token —— 而那正是这个开关存在的唯一理由。
    //   ⚠️ 别在这里写 `if (features.emoji)` 之外的重复判断：真身只有这一份。
    const features = deriveToolFeatures(config)
    note(
      'tool',
      `工具箱档位：沉默权=${features.silence ? 'on' : 'off'} 表情包=${features.emoji ? 'on' : 'off'}`
      + ` 语音识别=${features.voiceIn ? 'on' : 'off'} 发送语音=${features.voiceOut ? 'on' : 'off'}`
      + ` 戳一戳=${features.poke ? 'on' : 'off'}`
    )
    // qq_send 永远注册 —— 它是唯一的出站工具，关掉整只插件就没意义了。
    // features 也要传给它：voice / custom_emoji 等参数按档从 schema 里摘掉。
    void registerSendTool(ctx, toolRegistration.signal, { features })
    if (features.emoji) {
      void registerEmojiSearchTool(ctx, toolRegistration.signal)
    }
    // 2026-10-31 按树树要求下线三个工具（省每轮 token）：qq_msg_history / qq_qzone_post / qq_remember。
    // 2026-11-01 树树要求恢复 qq_qzone_post（发说说），另两个继续关着。
    // 函数定义仍留在 tool.js，需要时把对应行取消注释 + 重启 DSH 即可恢复。
    // void registerHistoryTool(ctx)
    void registerQzoneTool(ctx, toolRegistration.signal)
    if (features.emoji) {
      void registerCollectTool(ctx, toolRegistration.signal)
      void registerFacePreviewTool(ctx, toolRegistration.signal)
      void registerFacePickTool(ctx, toolRegistration.signal)
      void registerFaceRenameTool(ctx, toolRegistration.signal)
    }
    // 戳一戳（0.19.x）：独立一档，默认关
    if (features.poke) void registerPokeTool(ctx, toolRegistration.signal)
    // 语音识别（转录语音条）与发送语音（qq_tts）是两档，各管各的。
    if (features.voiceIn) void registerVoiceTool(ctx, toolRegistration.signal)
    // ⚠️ qq_tts 的最终判定折进**一个变量**，然后 `if (voiceEnabled)` 直接注册。
    //    为什么不用 `if (voiceEnabled && features.voiceOut)`：判定散在两处时，
    //    以后谁再补一个条件就容易漏掉，而「禁用档不注册 qq_tts」是这个功能最核心的一条。
    //
    //    两个条件：
    //      ① `voiceMode !== 'off'` —— 「禁用」档是**硬闸**：哪怕 toolFeatures.voiceOut
    //         被手工改成 true，禁用档下也不许有 qq_tts（否则模型会去调一个该档明说不许用的工具）；
    //      ② `features.voiceOut` —— 工具箱开关仍然说了算。
    //
    //    ⚠️ 必须是「条件注册」，不是「注册了再在调用时拒绝」——
    //       后者白白把这份 schema 塞进每回合的提示词里（正是这个开关存在的理由）。
    const voiceEnabled = String(config.voiceMode ?? 'off') !== 'off' && features.voiceOut === true
    if (voiceEnabled) void registerTtsTool(ctx, toolRegistration.signal)
    // 节奏三件套（2026-10-29 加）：等 / 划走 / 收尾 —— 把「什么时候说话」还给她
    // ⚠️ 三件套属于「沉默权」档：整档关掉时一个都不注册（否则 agent 会去调
    //    qq_pass 拿到 UNKNOWN_TOOL，反而更烧 token，见 proactive.js 的注释）。
    if (features.silence) {
      void registerWaitTool(ctx, toolRegistration.signal)
      void registerPassTool(ctx, toolRegistration.signal)
      void registerSkipTool(ctx, toolRegistration.signal)
      void registerCloseTool(ctx, toolRegistration.signal)
    }
    // void registerRememberTool(ctx)
    // AI 主动发消息的本地接口，跟收发主链路互不影响
    startSendApi(stopFns)

    // ---- 转发循环（0.20.2 起**无条件启动**）----
    //
    // 为什么不再挂在 autoForward 开关上：
    //   这条每秒一次的循环不只搬正文，它还负责**回合故障播报**（[系统] 通知：
    //   出错 / 中断 / 等满 TTL 没等到 turn/end）和队列清理。投递那边已经改成
    //   「一律入队、发送那一刻才按渠道判定发不发」（见 deliver.js），
    //   所以这里要是还按开关跳过，两个渠道都关掉时队列就再也没人消化 ——
    //   条目越积越多、故障也从此没人说，等于把 0.19.5「不让人干等」悄悄回滚了。
    //   循环本身在队列为空时是一次空转，开销可以忽略。
    timers.push(setInterval(() => { void flushOutbound() }, 1000))
    note(
      'out',
      `回复转发已启动（private=${config.autoForwardPrivate !== false ? 'on' : 'off'}`
      + ` group=${config.autoForwardGroup === true ? 'on' : 'off'}）`
    )

    // ---------------- 入站通路（等 OneBot 就绪）----------------
    // 轮询与 WS 都往协议端要数据。协议端在 QQ 登录完成之前根本不 listen，
    // 这时候硬启就是对着没开的门敲 —— 满屏 timeout 和 1006 断连，
    // 真正出问题时反而没法在日志里找。
    //
    // 所以先探活，等端点真的能应答了再放行入站。
    // 探活超时（默认 150s，覆盖实测的 ~2 分钟登录窗口）也照样放行：
    // 与其让桥接彻底不动，不如让它在轮询里自己重试（错误分级保证不吵）。
    void (async () => {
      const ready = await waitForOneBotReady({ timeoutMs: 150000 })
      if (disposed) {
        note('apply', 'disposed during probe，未启动入站通路')
        return
      }
      if (!ready) note('apply', 'OneBot 未就绪仍启动入站通路，交给轮询重试')

      // ---------------- 单实例锁（2026-10-28）----------------
      // 两个 DSH 各加载一份插件时，会各跑一套轮询 + WS，共享同一个 state 文件：
      // 游标被来回覆盖、同一条消息投两次、回复发两遍，而且日志里看不出来。
      // 抢不到锁的实例降级成「只出站」：工具和设置页照常（人还能改配置、还能让她发消息），
      // 只是不启动入站收发 —— 入站交给抢到锁的那个实例。
      const lock = acquireInstanceLock()
      if (!lock.ok) {
        note(
          'apply',
          `另一个实例已在收发（pid=${lock.otherPid}，起于 ${lock.at}）→ 本实例只注册工具与设置页，不启动轮询/WS`
        )
        return
      }

      // ---------------- 上线补历史（2026-10-28）----------------
      // 轮询每轮只拉 10 条，掉线期间攒的消息超过 10 条就会永久丢，而且游标直接跳过。
      // 所以先翻一遍「游标之后」的窗口，再交给常规轮询。
      // 失败不影响主链路：补历史是「尽量多捞」，捞不到就按老行为继续。
      if (config.backfillOnStart !== false) {
        try {
          await runBackfill(ctx)
        } catch (error) {
          note('backfill', `失败（不影响收发）：${error instanceof Error ? error.message : error}`)
        }
        if (disposed) {
          note('apply', 'disposed during backfill，未启动入站通路')
          return
        }
      }

      // ---------------- 私聊 ----------------
      // 无条件启动（每轮先看配置）：设置页新绑一个好友，保存后立刻开始轮询，不用重启 DSH。
      stopFns.push(startPrivateLoop(ctx))

      // ---------------- 群聊（仅 @） ----------------
      stopFns.push(startGroupLoop(ctx))

      // ---------------- WS 事件推送 ----------------
      // 放在轮询之后起：WS 断了还有轮询兜底（反过来就不行了）。
      // 没配到 wsUrl/wsToken 时它自己跳过，退回纯轮询模式，不影响收发。
      stopFns.push(startWs((event) => { void handleWsEvent(ctx, event) }))

      // ---------------- 主动搭话（0.9.0）----------------
      // 必须放在单实例锁之后：两个实例各跑一个钟，会各主动说一遍（同一条冷启动重复）。
      // 开关在配置里（默认关），关着的时候只是个每 60 秒看一眼的定时器，不发任何消息。
      stopFns.push(startWindowLoop(ctx, deliverWindowBatch))
      stopFns.push(startProactive(ctx))

      // ---------------- 兴趣点（0.23.0）----------------
      // 放在最后：它是纯旁路（触发器已经在 poll.js 里挂好，这里只管
      // 「等满 N 分钟 → 判定 → 私聊通知」那一段定时器）。
      //
      // ⚠️ 单实例锁之后起，理由同主动搭话：两个实例各跑一个循环，
      //    同一个任务会被判两遍、通知两遍。
      // ⚠️ 关着的时候（interestEnabled=false）它自己每 30 秒看一眼配置就返回，
      //    不发任何请求、也不建任何任务。
      // ⚠️ 启动时 loadInterests() 会把盘上**已经过期**的任务接回来立刻判 ——
      //    这正是「重启不丢通知」的全部实现，别把它挪到锁外面去。
      stopFns.push(startInterestLoop(ctx))
    })()

    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        disposed = true
        toolRegistration.abort()
        for (const stop of stopFns) {
          try {
            stop()
          } catch {}
        }
        for (const timer of timers) clearInterval(timer)
        // 池子里攒着还没放行的消息：这时候不能投（ctx 正在卸载），记一条日志再丢
        try {
          drainMerge()
        } catch {}
        // 主动搭话的状态有写节流（30s），卸载前 flush 一次防丢
        try {
          flushProactivePersist()
        } catch {}
        // 关系卡同理
        try {
          flushMemoryPersist()
        } catch {}
        // 让出实例锁：下一个实例（或重载后的自己）能立刻接管收发
        releaseInstanceLock()
        note('apply', 'disposed')
      })
    } else {
      for (const timer of timers) if (typeof timer.unref === 'function') timer.unref()
    }
  } catch (error) {
    note('apply', `THREW ${error instanceof Error ? error.stack ?? error.message : error}`)
  }
}
