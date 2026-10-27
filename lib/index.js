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
 * 5. 轮询先起、工具后注册，任何一处失败都不影响主链路。
 */
import { note, serviceOf } from './env.js'
import { getConfig, loadConfig } from './config.js'
import { loadState } from './state.js'
import { registerApi } from './api.js'
import { startGroupLoop, startPrivateLoop, handleWsEvent } from './poll.js'
import { flushOutbound } from './outbound.js'
import { startWs } from './ws.js'
import { registerSendTool, registerEmojiSearchTool, registerHistoryTool, registerQzoneTool } from './tool.js'
import { startSendApi } from './sendapi.js'

// 插件名 = 裸包名，必须和 package.json 的 name、以及 cordis.patch.yml 里的 name 三者一致。
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

    // ---------------- 私聊 ----------------
    // 无条件启动（每轮先看配置）：设置页新绑一个好友，保存后立刻开始轮询，不用重启 DSH。
    stopFns.push(startPrivateLoop(ctx))

    // ---------------- 群聊（仅 @） ----------------
    stopFns.push(startGroupLoop(ctx))

    // ---------------- WS 事件推送 ----------------
    // 放在轮询之后起：WS 断了还有轮询兜底（反过来就不行了）。
    // 没配到 wsUrl/wsToken 时它自己跳过，退回纯轮询模式，不影响收发。
    stopFns.push(startWs((event) => { void handleWsEvent(ctx, event) }))

    if (config.autoForwardReply !== false) {
      timers.push(setInterval(() => { void flushOutbound() }, 1000))
      note('out', '回复转发已启动')
    }

    void registerSendTool(ctx)
    void registerEmojiSearchTool(ctx)
    void registerHistoryTool(ctx)
    void registerQzoneTool(ctx)
    // AI 主动发消息的本地接口，跟收发主链路互不影响
    startSendApi(stopFns)

    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
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
