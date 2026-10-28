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
 * 1. 游标用 message_seq（同一会话内单调递增），绝不用 message_id ——
 *    SnowLuma 给的 message_id 可能是负数，比大小会全部漏掉；
 * 2. 宿主包一律动态 import 并带兜底，静态 import 失败会让整个插件加载不了；
 * 3. 必须声明 cordis inject（agents / tools / webServer / llm / sessions）：
 *    没声明的服务，ctx.get 会抛 "without inject"，表现就是设置页 0 个可选会话；
 * 4. 每一步都写 qq-bridge-load.log，出问题先看日志；
 * 5. 工具先注册、入站后启动：工具是出站能力，跟 QQ 登录无关，早点给 agent；
 *    入站（轮询 + WS）要等 OneBot 端点真的能应答了再起，否则满屏 timeout 噪音。
 */
import { note, serviceOf } from './env.js'
import { getConfig, loadConfig } from './config.js'
import { loadState } from './state.js'
import { registerApi } from './api.js'
import { startGroupLoop, startPrivateLoop, handleWsEvent } from './poll.js'
import { flushOutbound } from './outbound.js'
import { startWs } from './ws.js'
import { waitForOneBotReady } from './health.js'
import { registerSendTool, registerEmojiSearchTool, registerHistoryTool, registerQzoneTool, registerCollectTool, registerFacePreviewTool } from './tool.js'
import { startSendApi } from './sendapi.js'

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
export const inject = ['agents', 'tools', 'webServer', 'llm', 'sessions', 'attachments']

note('module', `loaded pid=${process.pid} node=${process.version}`)

export function apply(ctx) {
  note('apply', `started pid=${process.pid}`)

  // 配置先加载（含旧路由迁移），状态随后（自洁要靠配置里的监听集合）
  loadConfig()
  loadState()
  const config = getConfig()

  // API 先注册：配置不全或被禁用时，设置页也得能打开来改
  try {
    registerApi(ctx)
  } catch (error) {
    note('api', `register threw ${error instanceof Error ? error.message : error}`)
  }

  try {
    if (!config.enabled) return note('apply', 'disabled by config')
    if (config.token === '' || Number(config.peerUin) <= 0) return note('apply', 'config incomplete (token/peerUin)')

    const timers = []
    // 各循环的停止函数。自调度循环的停止函数：setInterval 把间隔写死了，改设置页里的
    // pollMs 不生效，所以改成「跑完再排下一次」，每轮重新读配置。
    const stopFns = []
    // dispose 可能发生在「等 OneBot 就绪」这段异步等待里 —— 用它挡住等待结束后再起循环，
    // 否则插件已经被卸载了，循环却又被拉起来，变成没人管的野循环。
    let disposed = false

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

    // ---------------- 工具注册（不等探活）----------------
    // 工具是**出站**能力：qq_send 往 QQ 发消息、qq_emoji_search 查表情……
    // 它们不依赖 QQ 那边先登录好，端点通不通都能注册。
    // 反过来，如果把它们也押在探活后面，QQ 迟迟不登录时 agent 就一个工具都看不到，
    // 会误判成「插件没装上」。所以先注册。
    void registerSendTool(ctx)
    void registerEmojiSearchTool(ctx)
    void registerHistoryTool(ctx)
    void registerQzoneTool(ctx)
    void registerCollectTool(ctx)
    void registerFacePreviewTool(ctx)
    // AI 主动发消息的本地接口，跟收发主链路互不影响
    startSendApi(stopFns)

    if (config.autoForwardReply !== false) {
      timers.push(setInterval(() => { void flushOutbound() }, 1000))
      note('out', '回复转发已启动')
    }

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

      // ---------------- 私聊 ----------------
      // 无条件启动（每轮先看配置）：设置页新绑一个好友，保存后立刻开始轮询，不用重启 DSH。
      stopFns.push(startPrivateLoop(ctx))

      // ---------------- 群聊（仅 @） ----------------
      stopFns.push(startGroupLoop(ctx))

      // ---------------- WS 事件推送 ----------------
      // 放在轮询之后起：WS 断了还有轮询兜底（反过来就不行了）。
      // 没配到 wsUrl/wsToken 时它自己跳过，退回纯轮询模式，不影响收发。
      stopFns.push(startWs((event) => { void handleWsEvent(ctx, event) }))
    })()

    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        disposed = true
        for (const stop of stopFns) {
          try {
            stop()
          } catch {}
        }
        for (const timer of timers) clearInterval(timer)
        note('apply', 'disposed')
      })
    } else {
      for (const timer of timers) if (typeof timer.unref === 'function') timer.unref()
    }
  } catch (error) {
    note('apply', `THREW ${error instanceof Error ? error.stack ?? error.message : error}`)
  }
}
