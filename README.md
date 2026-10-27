# dsh-onebot-channel

> 把 QQ 私聊与群聊接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 会话。
> 基于 [OneBot 11](https://github.com/botuniverse/onebot-11) 协议，入站走 WebSocket 事件推送，出站用 `qq_send` 工具回话。

[![npm](https://img.shields.io/npm/v/dsh-onebot-channel.svg)](https://www.npmjs.com/package/dsh-onebot-channel)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.19-green.svg)](https://nodejs.org)

让「在 QQ 里发消息」变成一个 DSH 会话里的回合，让会话里的 agent 直接回话。

```
QQ 客户端
   ↓  OneBot 11 协议端（如 SnowLuma、LLOneBot）
OneBot HTTP  127.0.0.1:3000   +   OneBot 正向 WebSocket  127.0.0.1:3001
   ↓  本插件：WS 事件推送为主，HTTP 轮询为兜底
查路由表 → 这个 QQ 号 / 群绑的是哪个 DSH 会话
   ↓  agent.followup(带 id 的用户消息)  唤醒该会话
DSH 会话跑一个回合（agent 看到「（QQ 私聊·主人本人 QQ …）…」或「（QQ群 …·主人本人/群友 …）」）
   ↓  agent 调用 qq_send 工具
OneBot send_private_msg / send_group_msg
   ↓  按标点切成分条，带随机延时逐条发
回到 QQ
```

## 安装

```bash
# 装到指定 profile（把 desktop 换成你的 profile 名）
dsh plugin --profile desktop add dsh-onebot-channel

# 确认插件层进到了配置树里
dsh --profile desktop --dump-config
```

> 装完去 **设置 → QQ 桥接** 填协议端地址和 token，绑 QQ 号 / 群到会话。
> 配置存在 `~/.dsh/qq-bridge.config.json`，**不在插件目录里**，重装不会丢。

**依赖**：需要先跑一个 OneBot 11 协议端（如 SnowLuma、LLOneBot 等），
并把本插件的 `onebotHttp` / `token` 指过去。插件不读你的 QQ 密码，只跟协议端说话。

## 能力速览

| | |
|---|---|
| 私聊 / 群聊投递 | ✅ 每个号各绑一个会话 |
| WebSocket 实时推送 | ✅ 延迟接近 0，断线自动退回轮询 |
| 区分本人与群友 | ✅ 逐条打标，agent 不会把群友当本人 |
| 群聊带上下文 | ✅ 只带上次投递之后的未读消息 |
| 按标点分条发送 | ✅ 带随机延时，更像真人 |
| 设置页 UI | ✅ 设置 → QQ 桥接 |

## 为什么能成

DSH 的插件跑在宿主进程内，可以拿到 `ctx.get('agents').get(sessionId)` 这个活着的 agent，
对它调 `agent.followup(message)` —— 这是 DSH 官方给「塞一条用户消息并唤醒」用的公开路径，
不是 hack。

---

## 一、能力与限制

| 能力 | 状态 | 说明 |
|---|---|---|
| 私聊投递 | ✅ | **多好友**，每个 QQ 号各绑一个会话（`routes.private`） |
| 群聊投递 | ✅ | 多个群（`groupUins` 列表），群里只在 @ 到本号时投递 |
| 每个号绑不同会话 | ✅ | 路由表 `routes.private` / `routes.group` |
| 没绑定的号 | ✅ 忽略 | 标记已读但不投递，**不会兜底投到别的会话** |
| 群聊带上下文 | ✅ | 被 @ 时只附带**上次投递之后**的未读群消息，最多 `groupContextCount` 条 |
| **区分本人与群友** | ✅ | 每条都标「主人本人（QQ …）」或「群友「昵称」（不是主人本人）」，上下文逐条打标 |
| 按标点分条发送 | ✅ | 私聊/群聊都支持 |
| 设置页 UI | ✅ | 设置 → **QQ 桥接**，可绑会话、调高级参数 |
| ~~自动建会话~~ | 已移除 | 觉得别扭，改为「在 DSH 里自己建、回来选」 |
| **WebSocket 实时推送** | ✅ | OneBot 正向 WS 事件推送，延迟从约 1 秒降到接近 0；断线自动退回轮询 |

---

## 二、工作流程

### 入站

**两条通路并存**：

| | HTTP 轮询 | WS 事件推送 |
|---|---|---|
| 触发 | 每 `pollMs`（默认 2 秒）拉一次历史 | OneBot 推来即处理 |
| 延迟 | 平均约 1 秒 | 接近 0 |
| 作用 | 兜底、防漏 | 主通路 |

- **WS 通着的时候**，轮询自动降频到 `wsFallbackPollMs`（默认 30 秒）只做补漏；
  **WS 一断**，轮询立刻回到全速（2 秒）。所以 WS 挂了不会导致收不到消息。
- 两条路都走同一批 `handle*` 函数，重复投递由 **seenIds（message_id 相等）+
  seq 游标**双重拦截（OneBot 实现给的 message_id 可能是负数，只能用「相等」判断）。
- WS 的地址和 token **自动从协议端配置里发现**
  （`<协议端安装目录>\config\onebot_<uin>.json` → `networks.wsServers[0]`），
  找不到就退回纯轮询模式。设置页里也能手动填 / 重新发现。
- ⚠️ **WS 的 token 跟 HTTP 的不是同一个**：HTTP token 拿去连 WS 会被拒（握手非 101）。

### 入站处理流程

1. 每 `pollMs`（默认 2000ms）拉一次 `get_friend_msg_history`；群聊用 `groupPollMs`（默认 3000ms）
2. 用游标（`lastSeq` / `lastTime`）过滤新消息，`seedOnFirstRun` 保证首次启动不回放历史
3. 积压的多条**合并成一条**投递，避免「离线一会儿回来被连问三遍」
4. 查路由表 → 拿 `sessionId`
   - 查不到 → **标记已读、跳过**（日志 `skip ... 未配置会话`）
   - 查到 → 唤醒会话
5. 会话没开着时，用 `agents.resume()` 冷启动（`resumeColdSession`）

### 出站

agent 回复时调 `qq_send` 工具：

```
qq_send(text)                  → 发到 peerUin 的私聊
qq_send(text, group_id="123")  → 发到指定群
```

`splitReply` 打开时，长回复按标点切段，逐条发送、带随机延时。

**另外还有一条兜底**：`autoForwardReply`（默认开）会在回合结束后把该回合最后一条助手正文
自动发回 QQ —— 给「模型忘了调 `qq_send`」的场合兜住。

**两者互斥**：本回合只要用过 `qq_send`（且调用没报错），自动转发就**不再动作**，
否则群里会同时收到「工具正文」和「助手这一轮的整段正文」（实测踩过，见踩坑记录）。
只有 `qq_send` 调用失败时，自动转发才作为兜底顶上。

---

## 三、配置文件

`~/.dsh/qq-bridge.config.json`（UTF-8 无 BOM）。改完**不用重启**，下一轮轮询就生效。
也可以在设置页改。

> 配置和状态存在 `~/.dsh/`，**不在插件目录里**。因为插件是用 `file:` 依赖装进
> profile 的 `node_modules` 的副本，pnpm 重装会覆盖插件目录，配置写进去会被冲掉。

```jsonc
{
  "enabled": true,

  // ---- 连接 ----
  "onebotHttp": "http://127.0.0.1:3000/",   // 协议端的 HTTP 端口
  "token": "…",                              // 协议端 config/onebot_<QQ号>.json 里的 httpServers.accessToken
  "selfUin": 1000000002,                     // 机器人自己的 QQ 号

  // ---- WebSocket 事件推送（主通路）----
  "wsEnabled": true,                         // 关掉就退回纯 HTTP 轮询
  "wsUrl": "ws://127.0.0.1:3001",            // 留空 = 自动去协议端配置里发现
  "wsToken": "…",                            // ⚠️ 与上面的 http token 是两套，不能混用
  "snowlumaConfigDir": "",                             // 自动发现的搜索目录，留空 = 常见安装位置
  "wsFallbackPollMs": 30000,                 // WS 通着时，轮询降频到多少毫秒一次
  "wsPrivateMergeMs": 250,                   // 私聊 WS 消息的合并窗口（毫秒）

  // ---- 私聊 ----
  "peerUin": 1000000001,                     // ⚠️ 只监听这一个好友
  "ownerUin": 1000000001,                    // 主人本人的 QQ（留 0 = 用 peerUin）。群聊靠它区分本人和群友
  "pollMs": 2000,
  "textPrefix": "（QQ 私聊）",                // 路由没自定义前缀时的兜底

  // ---- 群聊 ----
  "groupUins": [],                           // 要监听的群号；绑群时自动同步（绑定即监听）
  "groupOnlyWhenAt": true,                   // 只在 @ 本号时投递
  "groupContextCount": 5,                    // 被 @ 时带几条「上次投递之后」的未读群消息
  "groupPollMs": 3000,

  // ---- 路由表（核心）----
  "routes": {
    "private": {
      "1000000001": { "sessionId": "…", "prefix": "（QQ 私聊·示例好友）" }
    },
    "group": {
      "2000000002": { "sessionId": "…", "prefix": "（QQ 群·某某群）", "onlyWhenAt": true }
    }
  },

  // ---- 会话 ----
  "workspaceCwd": "D:\\DSH workspace\\QQ对话",  // 设置页列哪些会话、新会话归到哪
  "resumeColdSession": true,                   // 会话没开着时冷启动它
  "fallbackToLiveSession": false,              // 首选会话没 agent 时改投别的（建议关，会绕过路由表）
  "agentOptions": { "provider": "deepseek-account", "model": "deepseek-flash" },

  // ---- 分条发送 ----
  "splitReply": true,
  "splitMaxChars": 120,
  "splitMinChars": 4,
  "splitMaxParts": 8,
  "splitDelayMinMs": 200,
  "splitDelayMaxMs": 700
}
```

### 兼容旧配置

没有 `routes` 时按老逻辑走：私聊用 `sessionId`、群聊用 `groupSessionId`。
**新配置建议只用 `routes`，把 `sessionId` / `groupSessionId` 留空。**

---

## 四、设置页

**设置 → QQ 桥接**（`settings.section`，order 47）

```
QQ 桥接  ● 1000000002「示例机器人」              [重新载入] [保存]
每个号绑定一个 DSH 会话。没绑定的消息一律忽略（不会乱投到别的会话）。

私聊                                     N 个可选会话
  1000000001   示例好友   [— 未绑定（忽略）— ▾]   [移除]
  [填 QQ 号]  [添加]

群聊
  （空时提示：还没有绑定任何群）
  [填群号]  [添加]

高级设置                                            改完点上面的「保存」
  群聊上下文      [5] 条     ← 被 @ 时附带前面几条群消息
  每段最多        [120] 字
  间隔最小        [200] ms
  间隔最大        [700] ms
  私聊轮询        [2000] ms
  群聊轮询        [3000] ms
  ☑ 群里只在 @ 时响应
  ☑ 分条发送
  ☑ 会话没打开时自动冷启动

会话来源工作区：D:\DSH workspace\QQ
```

- **头部徽章**显示机器人自己接入的 QQ 号与昵称，绿点 = OneBot 链路通（`get_login_info` 成功），红点 = 连不上 / 没登录
- **会话下拉**只列 `workspaceCwd` 这个工作区里的会话。**会话本身请在 DSH 里新建**，建好回来这里选中即可
- 会话列表由两处合并而成，**没打开过的对话也能选**：
  1. 宿主端 `sessions.list()`（只有活着的会话，但能问到标题）+ 扫 `~/.dsh/sessions/<编码后的工作区>/` 目录（全部会话）
  2. 浏览器端 `ctx.sessions.list`（更全，还带 `displayTitle`）
  两边按 id 去重，标题留有的那个。列表变化时下拉会自动刷新，不用重开设置页
- **标题从会话日志里读**：`session/title` 事件的 `data.title`（取最后一条），没有就退回首条用户消息的前半句；
  一行消息都没有的空壳会话标成「（空会话，没有消息）」并排到最后。按 `(size, mtime)` 缓存，
  首次约 14ms，之后 0ms
- **保存**：`POST /save`，路由和高级设置一起写盘，**立即生效不用重启**
- **移除**：只是从列表拿掉，保存后才写盘

### 高级设置各项的含义

| 项 | 对应配置 | 说明 |
|---|---|---|
| 群聊上下文 | `groupContextCount` | 被 @ 时带几条**未读**群消息（0 = 不带）。未读更多时只取最近这几条，并注明「未读 N 条，只带最近 M 条」 |
| 每段最多 | `splitMaxChars` | 分条发送时单条最多多少字 |
| 间隔最小 / 最大 | `splitDelayMinMs` / `splitDelayMaxMs` | 两条之间随机等多久，模拟打字 |
| 私聊轮询 | `pollMs` | 多久拉一次私聊消息（默认 2000ms，**保存即生效**） |
| 群聊轮询 | `groupPollMs` | 多久拉一次群消息（默认 3000ms，群里消息多，放慢点） |
| 单次请求超时 | `requestTimeoutMs` | 默认 8000ms。协议端偶发挂死，不设超时会永久卡住轮询 |
| 群里只在 @ 时响应 | `groupOnlyWhenAt` | 关掉后群里每条消息都会投递（会很吵） |
| 分条发送 | `splitReply` | 长回复按标点切成多条发 |
| 会话没打开时自动冷启动 | `resumeColdSession` | 关掉后只有已经打开着的会话才收消息 |

轮询是**自调度**的（跑完一轮再排下一轮），所以：

- 间隔改完保存立刻生效，不用重启；
- 天然不会重入 —— 协议端卡一下也不会堆一串请求上去；
- 每次请求都有超时，挂死 8 秒就放弃并写日志。

流量参考：单次私聊历史约 3.4 KB、群历史约 4 KB，**全部走 127.0.0.1 回环，不占公网流量**；
真公网流量是协议端 ↔ QQ 那条长连接，与轮询频率无关。

---

## 五、HTTP 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/qq-bridge/state` | 配置（不含 token）+ 路由表 + 会话列表 + 好友/群列表 + 机器人自身信息 |
| POST | `/api/qq-bridge/save` | 保存 `routes` 与高级设置 |

---

## 六、排障

### 日志与状态

```
~/.dsh/qq-bridge-load.log      ← 插件日志，所有 [tag] 都在这里
~/.dsh/qq-bridge-state.json    ← 游标（lastSeq / lastTime / groups）
~/.dsh/qq-bridge.config.json   ← 配置
```

常见日志：

| 日志 | 含义 |
|---|---|
| `delivered private x3 seq<=… -> <sessionId>` | 投递成功 |
| `skip private x1：QQ xxx 未配置会话` | 该号没绑会话，已忽略 |
| `会话 … 没有活着的 agent` | 会话没打开且冷启动失败 |
| `private error OneBot HTTP 401` | token 不对，去协议端的 config 核对 |
| `丢弃不在 groupUins 里的群游标 123456` | 自洁：这个群已不在监听列表，游标被清掉 |
| `sessions 服务取不到 list()` | `inject` 里少了 `sessions`，设置页会变成 0 个可选会话 |

### 常见问题

**设置页整块白屏 / 干脆不出现**

前端抛异常了。这个插件自带一个**真的**错误边界（class + `getDerivedStateFromError`），
一旦渲染出错会显示「QQ 桥接：页面渲染出错」并给出错误信息 —— 那句错误信息才是线索。

历史教训（都是踩过的坑）：

- 函数组件里 `throw` 是**接不住**的，异常会冒到最外层把整个设置面板干掉。要 class 边界。
- 在组件 / `useEffect` 里直接读 `ctx.sessions` 这类没 inject 的服务，cordis 会抛
  `cannot get property X without inject`。读这类服务必须整段包 try/catch，取不到就降级。

**历史加载失败：`stored session "…" is corrupt … event at seq N lacks an identified message`**

意思是会话日志里某条 `user/message` 没有 `id`。这个插件的早期版本投递消息时没带 id，就会写出这种事件，
DSH 加载时直接拒绝整条会话。

已修（现在 `ensureId()` 兜着，无论走哪条路都保证有 id），`tests/outbound-sim.mjs` 也会断言这件事。
**已经写坏的历史**用修表工具补 id（备份 + 逐帧重压，不动其他字节）：

```bash
node repair_session.mjs "<会话目录>/session.v4.jsonl.zstd"          # 只检查
node repair_session.mjs "<会话目录>/session.v4.jsonl.zstd" --write  # 备份后写回
```

工具在 `D:\workbuddy\scripts\repair_session.mjs`。

**收不到消息**

1. 协议端在跑吗？`get_login_info` 能不能通？
2. `selfUin` / `peerUin` 填对了吗？
3. 这个号在 `routes.private` 里吗？**没配就是忽略**，这是设计
4. 会话开着吗？没开着靠 `resumeColdSession` 冷启动，冷启动失败会一直丢

**消息串到别的会话**

不可能了 —— `pickSessionId` 只查路由表，查不到返回空，没有「找最近会话」的兜底。

**群里没反应**

按顺序查，前三步能盖住 99%：

1. **监听列表里有没有这个群**：日志找 `[poll] group loop started, watching [...]`。
   没有这个群号 = 根本没轮询。设置页里「绑定群」就等于「要听这个群」，保存时会自动把群号
   写进 `groupUins`（早先只写路由不写监听列表，绑了也白绑，已修）。
2. **`groupOnlyWhenAt` 打开时，必须先 @ 机器人**（默认开着，高级设置里能关）。
3. **首次启动会 seed**：日志 `[group] <群号> seeded at seq=N` 表示把历史里的消息标记成已读，
   避免一上来把旧消息全回一遍 —— 所以**启动前**发的消息不会得到回复，再 @ 一次就行。
4. 群游标已经走过这条消息了吗？看 `~/.dsh/qq-bridge-state.json` 里 `groups.<群号>.lastSeq`。
5. 绑定的会话是否被归档了？归档会话会被 `agent/pre-step` 门禁拦下，回合直接 `blocked`。

**重复收到同一条**

删掉 `qq-bridge-state.json` 会让游标归零，`seedOnFirstRun` 会重新对齐（不会重放）。

---

## 七、文件清单

```
plugins/dsh-onebot-channel/
├── package.json            插件声明（含 dsh.client 指向 UI）
├── cordis.patch.yml        bundle 挂载（id: onebot-channel）
├── sync.mjs                本地开发辅助：把源码推进 profile 的 node_modules 副本
├── lib/
│   ├── index.js            宿主端入口：装配各模块
│   ├── env.js              数据目录、日志（带轮转）、宿主服务取用
│   ├── config.js           配置加载 + 旧单路由字段的一次性迁移
│   ├── state.js            游标持久化（按 QQ 号 / 群各存一份）
│   ├── onebot.js           OneBot HTTP 调用 + 消息段解析
│   ├── split.js            按标点分条（纯函数）
│   ├── images.js           QQ 图片 → 附件库 + 人看的副本
│   ├── title.js            从落盘会话日志抠标题（zstd 多帧）
│   ├── sessions.js         会话列表 + 冷启动（AgentRegistry.resume）
│   ├── deliver.js          路由查询 + 投递（agent.followup）
│   ├── outbound.js         回复转发回 QQ（每会话一个待转发队列）
│   ├── poll.js             消息处理 + 轮询循环 + WS 事件入口
│   ├── ws.js               OneBot 正向 WebSocket 客户端（断线指数退避重连）
│   ├── snowluma.js         自动发现协议端的 WS 接入点
│   ├── api.js              设置页 API（/api/qq-bridge/*）
│   ├── tool.js             qq_send 工具注册
│   ├── sendapi.js          AI 主动发消息的本地 HTTP 接口
│   └── client.js           浏览器端：设置页「QQ 桥接」
├── tests/                  离线自测（assert 断言 / ws 模拟 / 群模拟 / 出站模拟 / state 接口 / 组件真渲染）
├── LICENSE
└── README.md
```

数据（不随插件重装丢失）：
~/.dsh/qq-bridge.config.json   配置
~/.dsh/qq-bridge-state.json    游标
~/.dsh/qq-bridge-load.log      日志（超 2 MB 自动截尾轮转）
```

---

## 八、开发

```bash
npm test      # 跑断言套件 + WS 模拟 + 前端渲染
```

跑单个脚本：

```bash
node tests/assert.mjs           # 断言套件，退出码 0 = 全过（split 分条 + 出站队列竞态 + 增量扫描范围 + 群缓冲）
node tests/ws-sim.mjs           # WS 推送专项（鉴权/事件分发/重连/去重/归一化，用假 WebSocket）
node tests/group-context-sim.mjs  # 群上下文 + 「不是 @ 我」的三态返回
node tests/identity-sim.mjs     # 身份标注（本人 vs 群友）
node tests/client-render.mjs    # 设置页组件真渲染（React 挂载）
node tests/*.mjs                # 各个离线模拟脚本
```

> ⚠️ 模拟脚本会临时借用真实的 `~/.dsh/qq-bridge.*`，退出时自动还原（`process.on('exit')`），
> **测试期间真实 DSH 别在跑**，否则两边会互相覆盖游标。

本地改了源码要推进 DSH 的 profile 副本时，用 `node sync.mjs`：
pnpm 的 `file:` 目录依赖是**硬链接**，新建的文件不会自动出现在副本里，
`sync.mjs` 会逐文件比对（目标不存在 → 补拷 / inode 不同 → 覆盖），
跑完日志里应看到「新同步 N 个文件」。

### 想知道 DSH 的 Session API 到底有什么

官方包打包在 `app.asar` 里，运行时没有 d.ts 可查。**把 `app.asar` 解出来 grep 类型定义，
比翻文档快得多** —— `snapshotEvents` / `firstLiveSeq` / `session.seq` 的真实签名都能直接看到。

> ⚠️ 界面上的 `Session.snapshotEvents(fromSeq = 0, toSeqExclusive = this.seq)` 里，
> 第二个参数**是开区间**。想知道上界该取什么，先搞清楚 `seq` 到底是
> 「最后一个已分配」还是「下一个待分配」—— 两者差一个事件，漏掉的往往正是 `turn/end`。

---

## 九、踩坑记录

**这张表每一条都是真踩过的**，不是理论风险。改这个插件之前先扫一遍，能省掉大半天。

### 运行时（会静默失效的那种）

| 现象 | 真因 | 修法 |
|---|---|---|
| 群里 @ 了也不回 | 设置页只写 `routes.group`，**从不写 `groupUins`**。监听列表空 → 群轮询压根没启动 | 绑定即监听：监听集合 = `groupUins ∪ routes.group`，每轮实时读 |
| 设置页改了轮询间隔没用 | `setInterval` 在 apply 时把间隔写死，改配置只动了文件 | 自调度：`poll().then(schedule)`，每轮重读 `config.pollMs` |
| 协议端一卡，桥接永久哑 | `callOneBot` **没有超时**，一次挂死就永久卡在 `await` | `AbortSignal.timeout(config.requestTimeoutMs ?? 8000)` |
| 协议端卡一次就雪崩 | `setInterval` 不等上一轮结束，请求一层层堆上去（实测同一毫秒 8 条 `fetch failed`） | 防重入 + 自调度（上一轮没完不排下一轮） |
| 热重载后接口 404 | `webServer.register()` 返回的 disposer 没接住，旧路由还在 → `duplicate prefix route` | `ctx.effect(() => dispose)` |
| 群里多收到一段「本不该发出去」的正文 | 模型调了 `qq_send` 发正文，自动转发**又把助手这一轮的整段正文发了一遍**（实测群里多出 2 条） | 同回合互斥：用过 `qq_send`（且没报错）就跳过自动转发，只有调用失败才兜底 |
| 插件装着但完全没反应 | 静态 `import '@deepseek-ai/dsh-tools'` 解析不到（官方包在 `app.asar` 里） | 一律走 `inject` 服务，不 import 官方包 |

### 会话与消息（会写坏数据的那种）

| 现象 | 真因 | 修法 |
|---|---|---|
| 历史加载失败：`lacks an identified message` | 手搓的消息对象漏了 `id`；而 `session.append` **只校验数据形状、不校验消息身份**，坏事件能安静落盘，直到下次读日志才炸 | `ensureId()` 强制兜底 + `outbound-sim` 断言「投递消息必须带 id」 |
| 设置页 0 个可选会话 | `inject` 少了 `sessions`，`ctx.get` 抛 `without inject` 被外层 catch 吞成 `[]`；而且 `sessions.list()` **只返回活着的会话** | `inject` 加 `sessions`；列表 = live ∪ 扫 `~/.dsh/sessions/<编码 cwd>/` |
| 会话标题显示成 `#xxxx` | 标题不是 header 字段，是日志里的 `session/title` 事件 | 逐帧解 zstd 取最后一条 `data.title`，退回首条用户消息 |
| 新建的会话在侧栏找不到 | `agents.create` 建的会话**从不登记进 `workspace.json` 的 `sessionIds`**，侧栏按注册表列，所以永远看不见 | 别在插件里建会话；在 DSH 里建好再回来绑 |
| 重启后第一次 @ 没反应 | `seedOnFirstRun` 把已有历史一次性标记成已读（防刷屏），启动前的消息被跳过 | 再 @ 一次；或把 `seedOnFirstRun` 关掉 |
| 群友被当成主人 | 消息里只给「昵称 + QQ 号」，**从没告诉过 agent 哪个号是主人** | `ownerUin` + 每条标「主人本人」/「群友…（不是主人本人）」 |

### 前端与工程

| 现象 | 真因 | 修法 |
|---|---|---|
| 设置页整块白屏、面板消失 | 函数组件里 `throw` **接不住**；原来的「错误边界」也是函数组件，异常冒到最外层 | 真边界：`class extends React.Component` + `getDerivedStateFromError` |
| 组件里一个异常干掉整个面板 | 直接读没 inject 的服务（`ctx.sessions`）会抛 | 读这类服务整段包 `try/catch`，取不到就降级 |
| 配置和路由表莫名被清 | 配置放在插件目录，`file:` 依赖重装会覆盖插件目录 | 数据全部搬到 `~/.dsh/qq-bridge.*` |
| 跑 `sync.mjs` 报 EPIPE | pnpm 对 `file:` 目录依赖是**硬链接**（同一 inode），整目录 cp 等于拷自己 | 先判 inode，相同就跳过；不同再逐文件覆盖 |

### 这轮重构新增的（模块化 + WS 推送，2026-10-27）

这一批全是「重构/加功能时自己造出来又当场抓回去」的坑，
**顺序很重要**：前三条如果没被模拟脚本挡住，会一路留到线上才炸。

| 现象 | 真因 | 修法 |
|---|---|---|
| 群里只有第一条 @ 被处理，后面全被跳过 | 「不是 @ 我」和「投递失败」都返回 `''`，轮询把「跳过」当「失败」→ 回滚游标 + `break` → 后面真 @ 的消息永远轮不到 | 三态返回 `{ status: 'skipped' \| 'delivered' \| 'failed' }`，只有 `failed` 才回滚游标 |
| 群消息上下文里少了上一条 | 上下文基准跟着「已投递的 seq」往前推，基准每条都在动 | 基准**钉死在本批开始值**（`baseDeliveredSeq`），一批之内不变 |
| 新模块文件改了但 DSH 里没生效 | pnpm 硬链接只对**已存在的文件**生效，新建文件在 profile 副本里根本不存在 | `sync.mjs` 改成**逐文件比对**（不存在→补拷 / inode 不同→覆盖），新增文件后必须跑一次 |
| WS 连上了但一条都不来 | HTTP 用的 `access_token` 和 **WS 用的 token 是两套独立的**，拿 HTTP 的那个去连 WS，握手直接不是 101 | 用 `networks.wsServers[0].accessToken`；找不到就跑 `/api/qq-bridge/detect-ws` 自动发现 |
| 找不到协议端的 WS 配置在哪 | 在源码目录里翻是白翻 | 实际路径：`<安装目录>/config/onebot_<uin>.json` → `networks.wsServers[0]`（url + accessToken） |
| 同一群消息被处理两次 | WS 路径和投递函数各记一次 `seenIds`，同一 id 存了两遍 → 去重窗口被悄悄缩短 | `markSeen` 内部去重；`loadState` 启动时自洁（去重 + 只留最近 100 条） |
| 回复内容突然少一段 / 发错人 | 出站用 `Map.set` 覆盖游标，两次投递互相盖；两个 QQ 号绑同一会话时还会把内容发到错的人 | 改成**每会话 FIFO 队列**，出队先于发送，失败也出队 |
| 增量扫描后回复不再转发（静默失效） | `snapshotEvents(from, to)` 的 `to` 是**开区间**，而 `session.seq` 到底是「最后一个已分配」还是「下一个待分配」差一个事件 —— 漏掉的正好是 `turn/end` | 上界取 `session.seq + 1`，两种语义都安全 |
| WS 一断就彻底哑了 | 只有 WS 没有兜底 | 双通道：WS 推送 + 轮询降级成 30 秒一次补漏；**WS 启动放在轮询之后**（反过来的话，WS 断的那 2 秒窗口没人接） |
| 前端 `onField is not defined` | 组件函数定义在 `renderAdvanced` 内部，`renderWs` 是平级函数引用不到 | 提到组件层作用域 |
| 设置页里 WS 的 token 填进去变 `NaN` | 文本框被统一的 `Number()` 转了一遍 | 文本框不再走数值转换 |

### 出问题先查这几行日志

```bash
grep "\[config\]" ~/.dsh/qq-bridge-load.log | tail -1   # owner= 有没有 → 新版加载了吗
grep "\[poll\]"   ~/.dsh/qq-bridge-load.log | tail -3   # 群在监听吗、watch 到哪些群
grep "\[group\]"  ~/.dsh/qq-bridge-load.log | tail -5   # skip (no at)? 未配置会话? seeded?
grep "error"      ~/.dsh/qq-bridge-load.log | tail -5   # fetch failed = 协议端挂了
```

**一条铁律**：日志里可能同时有 DSH 和本地测试的输出，
`[module] loaded pid=… node=…` 那行能分清是谁在说话 —— 别把测试进程的日志当成线上故障。

---

## 十、这轮重构的经验

坑是「哪一行错了」，经验是「下次该怎么开局」。这一节写的是 1638 行单文件拆成 15 个模块
+ 加一条 WS 通路的过程里，**改对了的部分**。

### 1. 先定义契约，再写实现

动手前先列清楚三件事，后面所有细节都从它们推出来：

- **模块边界**：谁负责拿消息、谁负责投递、谁负责发出去、谁负责存盘
- **状态归属**：每个可变状态只能有一个主人（游标归 `state.js`，配置归 `config.js`，
  出站队列归 `outbound.js`），别让两个模块都能写同一个 Map
- **数据流方向**：QQ → 消息处理 → 投递 → 会话 → 出站 → QQ，单向不回头

拆完之后 `index.js` 只剩 134 行的装配代码，一眼能看出谁调谁。

### 2. 「跳过」和「失败」必须分开

这是本轮改出真 bug 的根源，也是最通用的一条：
**任何返回值的语义都要穷举清楚，别用空值糊弄。**

`handleGroupMessage` 原来成功失败都返回 `''`，调用方无法区分「这条不该我管」和
「这条我管了但没送出去」，于是把前者当后者处理 → 回滚游标 → 后面的消息全被跳过。

改成三态之后 bug 自己消失了。**返回值语义模糊 = 迟早出 bug**，尤其是布尔值不够用的时候，
宁可多返回一个状态字段。

### 3. 失败必须能回滚，不能静默丢

投递失败时游标**不要前进**。前进 = 这条消息永远不会再被处理（静默丢失）；
不前进 = 下一轮重试。前者会让你在日志里什么都看不到。

代价是「毒消息会反复重试」，所以重试要有上限 / 要能标记，但**默认应该重试而不是丢弃**。

### 4. 双通道：快通道 + 兜底通道

WS 推送延迟接近 0，但它会断；HTTP 轮询慢，但几乎不会彻底断。
所以是 **WS 为主、轮询兜底**，而不是二选一。

关键细节：**启动顺序**。先起轮询再起 WS —— 反过来的话，WS 连接建立的那几秒里
正好有消息进来，没人接，等轮询起来时游标已经过去了。

轮询间隔也要跟着 WS 状态变：WS 连着时降到 30 秒，断了立刻回到 2 秒。

### 5. 去重要两条腿

- **序号游标**（`message_seq`）：防漏、且能知道处理到哪了
- **ID 集合**（`message_id`）：防重、且挡住乱序重发

单靠序号不够（同一 seq 可能有多个事件），单靠 ID 也不够（ID 可能为负，比大小不可靠）。
两条腿一起上，且**写入处要去重**（`markSeen` 内部判断），否则同一个 ID 被记两遍，
去重窗口会悄悄缩短一半。

### 6. 增量优于全量

`snapshotEvents()` 无参版本是「从 0 取到当前」，长会话几千个事件时每秒扫一遍纯浪费。
范围接口 `snapshotEvents(from, to)` 才是正解。

但**开区间的上界语义要先确认**，`session.seq + 1` 是唯一两种解释都安全的写法。
这属于「不确认清楚就等于埋雷」。

### 7. 并发写入要排队，不要覆盖

出站转发原来是 `Map.set(sessionId, {cursor, target})`，两次投递互相覆盖 →
上一回合的回复被吞、两个 QQ 号绑同会话时发错人。

改成每会话一个 **FIFO 队列**：入队不覆盖，出队先于发送（先发后删会有重复风险，
先删后发会有丢消息风险，正确顺序是**取出即标记，出队失败也不回滚**——
宁可丢一条也不重复两条）。

### 8. 探针先行

写教程/文档时最忌讳凭记忆编「运行结果」。这轮也是：
`node tests/ws-sim.mjs` 用假 WebSocket 先把鉴权头、重连退避、事件归一化、
去重全跑通，再接真协议端。

**先用假的东西把逻辑跑对，再接真的** —— 真环境联调一次的成本高得多。

### 9. 模拟脚本能挡住肉眼看不见的 bug

`identity-sim` 和 `group-context-sim` 就是为此写的：
三态返回、上下文基准钉死这两条，肉眼看代码根本看不出来，
是模拟脚本第一次跑就报红的。

模拟脚本会临时借用真实的 `~/.dsh/qq-bridge.*`，**测试期间真 DSH 别在跑**。

### 10. 拆文件要留可回滚的锚点

重构前先备份（这次备份已按要求删除，但流程保留），
每次改动都跑一遍 `sync.mjs` + 测试，再重启 DSH。
**一次只改一层，改完立刻验证** —— 这次 15 个模块是分批落地的，
每次都能立刻说清「现在坏在哪一层」。

---

## 十一、实现笔记

这一节记录**已经落地**的实现细节和当时踩的坑，写在文档里免得以后重新踩一遍。

1. **私聊多好友** —— 路由表 `routes.private` 写几个就监听几个，
   游标按 QQ 号各存一份（`state.privates[uin]`），互不干扰
2. **自动建会话已移除** —— 原来有「新建」按钮（`agents.create` + seed 标题），觉得交互别扭，改成在 DSH 里自己建会话再回来绑定。**而且插件建的会话不会进 `workspace.json`，侧栏列不出来**，这是它当初"建了找不到"的真正原因
3. **群聊已端到端验证** —— 实测：`@` → 投递（`at=true context=5`）→ 回合 →
   回复发回群里（`[out] 已转发回复 26 字 -> group`，含分条发送）。`groupOnlyWhenAt` 打开时仍需 @
4. **`fallbackToLiveSession`** 默认关着，它会绕过路由表
5. **入站已上 WebSocket 事件推送** —— OneBot 正向 WS（协议端的 `wsServers[0]`），
   延迟从「平均 1 秒」降到接近 0；HTTP 轮询降级成 30 秒一次的补漏。
   **实测**：消息进 → 投递进会话耗时 93 毫秒，全程没有 `[poll] delivered`（轮询没抢到）；
   事件流**带 `message_seq`**，所以去重的两条腿（message_id 相等 + seq 游标）都在。
   （原先记的遗留「群消息上下文仍要拉历史」已由第 7 条的环形缓冲解决）
6. **出站转发已改成增量扫描** —— 原来调 `snapshotEvents()` 无参版本，
   那是「从 0 取到当前」的全量快照，每秒扫一遍，长会话几千事件时纯浪费。
   现在用 DSH 的范围接口 `snapshotEvents(from, to)` 只取新事件，
   `maxEventSeq` 也直接读 `session.seq` getter，不再遍历。
   **踩过的坑**：`toSeqExclusive` 是开区间，`session.seq` 到底是「最后一个已分配」还是
   「下一个待分配」差一个事件 —— 漏掉的正好可能是 `turn/end`（回复就转发不出去了）。
   现在上界取 `session.seq + 1`，两种解释都安全。
7. **群消息上下文改用环形缓冲** —— WS 推来的每条群消息（哪怕没 @ 我）都进
   30 条的缓冲，上下文直接从缓冲挑「上次投递之后」的那几条，未读语义天然成立，
   不用每条 @ 都去 HTTP 拉一次历史。插件刚启动时缓冲是空的，拉一次历史兜底。
8. **`lastId` 游标已停写** —— 协议端给的 `message_id` 可能是负数，
   比大小不可靠，这个字段只对「没有 seq 的旧消息」有用；现在所有消息都带 seq，
   留着旧值只为兼容老 state 文件，不再更新

---

## 十二、许可证与致谢

[MIT](LICENSE) © 2026 单树见月

- 协议端不在本仓库范围内 —— 本插件只跟 [OneBot 11](https://github.com/botuniverse/onebot-11) 协议端说话，
  不读 QQ 密码、不注入 QQ 进程。
- 插件跑在 DSH 进程内，**拥有 DSH 能触及的一切权限** —— 安装前请自行审阅代码。

---

*最后更新：2026-10-27*
