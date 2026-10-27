# dsh-onebot-channel

> 把 QQ 私聊与群聊接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 会话。
> 基于 [OneBot 11](https://github.com/botuniverse/onebot-11) 协议：入站走 WebSocket 事件推送，出站用 `qq_send` 工具回话。

[![npm](https://img.shields.io/npm/v/dsh-onebot-channel.svg)](https://www.npmjs.com/package/dsh-onebot-channel)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.19-green.svg)](https://nodejs.org)

让「在 QQ 里发消息」变成 DSH 会话里的一个回合，agent 直接回话。

```
QQ 客户端
   ↓  OneBot 11 协议端（SnowLuma / LLOneBot 等）
   ↓  本插件：WS 事件推送为主，HTTP 轮询兜底
路由表：这个 QQ 号 / 群绑的是哪个会话
   ↓  agent.followup()  唤醒会话
会话跑一个回合（agent 看到「（QQ 私聊·用户本人 QQ …）…」）
   ↓  agent 调 qq_send 工具
OneBot send_private_msg / send_group_msg
   ↓  按标点切条，带随机延时
回到 QQ
```

## 安装

```bash
dsh plugin --profile desktop add dsh-onebot-channel
```

装完去 **设置 → QQ 桥接** 填协议端地址和 token，把 QQ 号 / 群绑到会话上。

> 配置存在 `~/.dsh/qq-bridge.config.json`，**不在插件目录里** —— 重装插件不会丢。

**前置条件**：需要先跑一个 OneBot 11 协议端，并把插件的 `onebotHttp` / `token` 指过去。
插件不读你的 QQ 密码，只跟协议端说话。

## 工具

装好之后 agent 有 6 个工具：

| 工具 | 干什么 | 参数 |
|---|---|---|
| `qq_send` | 发消息、发表情 | `text` `emoji` `custom_emoji` `user_id` `group_id` |
| `qq_emoji_search` | 搜 QQ 官方表情目录 | `query` `all` |
| `qq_msg_history` | 查群 / 好友历史消息 | `group_id` `user_id` `count` `before_message_id` |
| `qq_collect_face` | 把收到的表情包存进 QQ 收藏夹 | `index` `recent` `file` `desc` `dir` `list` `delete` |
| `qq_face_preview` | **看**收到的表情包（结果直接带图片） | `index` `from` `count` |
| `qq_qzone_post` | 发表 QQ 空间说说 | `content` `visibility` `target_uins` |

```jsonc
// 发消息 + 经典小表情
{ "text": "搞定了", "emoji": "OK" }

// 发收藏夹里的商城大表情
{ "text": "看这个", "custom_emoji": "猫" }

// 查官方表情目录
{ "query": "比心" }        // → 比心（编号 319）
{ "all": true }            // → 列出全部目录（398 个，10 个包）

// 查历史消息（默认 20 条，上限 100）
{ "group_id": "1046436553", "count": 20 }

// 看表情包 —— 文件名是 MD5 哈希，只有看图才起得了名
{ "index": 1 }

// 收藏表情包
{ "index": 1, "desc": "猫脑过载" }

// 发说说（对外发布）
{ "content": "今天天气不错", "visibility": 1 }
```

说说可见性：`1` 所有人 · `4` 仅好友 · `16` 仅自己 · `64` 指定好友 · `128` 分组。

## 能力

| 能力 | 说明 |
|---|---|
| 私聊 / 群聊投递 | 每个号各绑一个会话，没绑定的号**一律忽略**（不会乱投到别的会话） |
| WebSocket 实时推送 | 延迟接近 0；断线自动退回轮询补漏 |
| 区分本人与群友 | 逐条打标「用户本人」/「群友（不是用户本人）」，agent 不会张冠李戴 |
| 群聊带上下文 | 被 @ 时附带上次投递之后的未读群消息 |
| 发表情 | 正文写 `[表情:呲牙]`，或 `qq_send` 带 `emoji` |
| 商城大表情 | `qq_send` 带 `custom_emoji`（需先收藏进账号收藏夹） |
| 图片理解 | QQ 图片下载后进 DSH 附件库，作为 image 块投进会话 —— **模型真能看见图** |
| 按标点分条发送 | 带随机延时，更像真人 |
| 设置页 UI | 设置 → **QQ 桥接** |

**不接**：群信息检索、撤回消息、表情回应、发图片到空间。

## 发表情

两条路都通：

**① 正文里写标记**（推荐，一句话能带多个）

```
搞定了[表情:OK][表情:庆祝]
```

→ QQ 上收到的是 `搞定了` + 两个真表情（标记本身不出现）。支持中文名和编号，
表情**附在它前面那句话的后面**。这条路不依赖工具调用，**自动转发**也生效。

**② `qq_send` 的参数**

```json
{ "text": "搞定了", "emoji": "OK" }        // 经典小表情
{ "text": "看这个", "custom_emoji": "猫" } // 商城大表情
```

区别：经典小表情能跟文本**拼在同一条消息**里；商城大表情协议端只能**单独发一条**。

⚠️ 收藏表情走的是协议端扩展 action（SnowLuma 的 `send_custom_face`），**不是 OneBot 11 标准** ——
换协议端（NapCat / LLOneBot）可能没有，届时经典表情照常能用。

### 表情编号的坑

内置表情表共 **275 个**（编号 0~348），但它是 OneBot 生态的**社区通用编号**，不是 QQ 官方编号，
两者对不上（2026-10-27 实测）：

- 275 条里有 **109 条**在 QQ 官方目录（398 个）里查无此 id —— 「幽灵 id」
- 另有 **11 条**名字对得上但 id 错位（「晕」内置记 17、官方实际是 34）

拿幽灵 id 去发，协议端报 `OIDB error 11000: id N sysemojis cfg not found`，
**整条消息发不出去** —— 不是丢个表情，是连文字一起没。

所以出站做了三层防护：查 QQ 官方目录解析 → 校验 id 真的存在 → 校验不过就**跳过表情、文字照发** →
发送层再兜一层（带表情失败则去掉表情重发文字）。

**宁可少发一个表情，也不能让整条回复凭空消失。**

## 配置

`~/.dsh/qq-bridge.config.json`（UTF-8 无 BOM）。改完**不用重启**，下一轮轮询就生效。

```jsonc
{
  "enabled": true,

  // ---- 连接 ----
  "onebotHttp": "http://127.0.0.1:3000/",   // 协议端 HTTP 端口
  "token": "…",                              // config/onebot_<QQ号>.json 里的 httpServers.accessToken
  "selfUin": 1000000002,                     // 机器人自己的 QQ 号

  // ---- WebSocket（主通路）----
  "wsEnabled": true,                         // 关掉就退回纯 HTTP 轮询
  "wsUrl": "ws://127.0.0.1:3001",            // 留空 = 自动去协议端配置里发现
  "wsToken": "…",                            // ⚠️ 与上面的 http token 是两套，不能混用
  "wsFallbackPollMs": 30000,                 // WS 通着时，轮询降频到多少毫秒一次
  "wsPrivateMergeMs": 250,                   // 私聊 WS 消息的合并窗口

  // ---- 私聊 ----
  "peerUin": 1000000001,                     // 监听的好友 QQ 号
  "ownerUin": 1000000001,                    // 用户本人（留 0 = 用 peerUin）。群聊靠它区分本人和群友
  "pollMs": 2000,
  "textPrefix": "（QQ 私聊）",

  // ---- 群聊 ----
  "groupUins": [],                           // 监听哪些群；设置页绑群时自动同步
  "groupOnlyWhenAt": true,                   // 只在 @ 本号时投递
  "groupContextCount": 5,                    // 被 @ 时带几条未读群消息
  "groupPollMs": 3000,

  // ---- 路由表（核心）----
  "routes": {
    "private": { "1000000001": { "sessionId": "…" } },
    "group":   { "2000000002": { "sessionId": "…" } }
  },

  // ---- 会话 ----
  "workspaceCwd": "D:\\DSH workspace\\QQ对话",
  "resumeColdSession": true,                   // 会话没开着时冷启动它
  "fallbackToLiveSession": true,                // 首选会话没 agent 时改投「最近活跃且有 agent」的会话
                                                 // ⚠️ 这会绕过路由表 —— 建议改成 false
  "agentOptions": { "provider": "deepseek-account", "model": "deepseek-flash" },

  // ---- 分条发送 ----
  "splitReply": true,
  "splitMaxChars": 120,
  "splitMinChars": 4,
  "splitMaxParts": 8,
  "splitDelayMinMs": 200,
  "splitDelayMaxMs": 700,

  "requestTimeoutMs": 8000                    // 协议端挂死时的超时
}
```

没有 `routes` 时按旧逻辑走（私聊用 `sessionId`、群聊用 `groupSessionId`）。
**新配置建议只用 `routes`。**

## 安全边界

**13 个高风险 action 物理拦截** —— 拦截点在 `callOneBot()`，所有协议端调用的唯一出口。
不是「提示词里写别调用」，而是**调用即抛错、连 HTTP 都不发**。

| 类别 | action |
|---|---|
| 交出账号凭证 | `get_cookies` `get_credentials` `get_csrf_token` `get_clientkey` `get_rkey_server` `request_decrypt_key` |
| 踢下线 / 改状态 | `bot_exit` `set_online_status` `set_diy_online_status` `set_input_status` |
| 越权社交动作 | `send_like` `set_qzone_ban` |
| 删说说 | `delete_qzone_msg`（发说说允许，删不允许） |

清单在 `lib/blocked.js`，要放开哪项改那个集合 —— 但凭据那六项别动。

> `add_custom_face` 原先在封禁清单里，2026-10-27 放开了：
> 协议端**没有**「收到图片自动收藏」的逻辑，收藏夹不显式写就是空的，
> `custom_emoji` 那条路永远走不通。现在改成走受控工具 `qq_collect_face` ——
> 只允许收藏插件自己收到过的图。

## HTTP 接口

插件自带三个同源接口（设置页用的也是它们）：

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/qq-bridge/state` | 配置（不含 token）+ 路由表 + 会话列表 + 好友/群列表 + 机器人信息 |
| POST | `/api/qq-bridge/save` | 保存 `routes` 与高级设置 |
| POST | `/api/qq-bridge/detect-ws` | 自动发现协议端的 WS 接入点 |

另有一个独立的主动发消息接口（端口默认 39273），给 agent 之外的程序用：

```bash
curl -X POST http://127.0.0.1:39273/send \
     -H "Content-Type: application/json" \
     -d '{"text":"内容","user_id":"对方QQ号"}'
```

健康检查：`curl http://127.0.0.1:39273/health`

## 排障

```
~/.dsh/qq-bridge-load.log      插件日志（超 2 MB 自动轮转）
~/.dsh/qq-bridge-state.json    游标
~/.dsh/qq-bridge.config.json   配置
```

```bash
grep "\[config\]" ~/.dsh/qq-bridge-load.log | tail -1   # owner= 有没有 → 新版加载了吗
grep "\[poll\]"   ~/.dsh/qq-bridge-load.log | tail -3   # 群在监听吗
grep "\[group\]"  ~/.dsh/qq-bridge-load.log | tail -5   # skip (no at)? 未配置会话? seeded?
grep "error"      ~/.dsh/qq-bridge-load.log | tail -5   # fetch failed = 协议端挂了
```

**收不到消息**：① 协议端在跑吗 ② `selfUin` / `peerUin` 对吗 ③ 这个号在 `routes.private` 里吗
④ 会话开着吗（没开靠 `resumeColdSession` 冷启动）

**群里没反应**：① 监听列表里有这个群吗（日志 `[poll] group loop started, watching [...]`）
② `groupOnlyWhenAt` 开着的话必须先 @ ③ 首次启动会 seed，启动前发的消息不会被回复，再 @ 一次

**重复收到同一条**：删掉 `qq-bridge-state.json`，游标归零后会重新对齐（不会重放）。

### 设置页找不到「QQ 桥接」入口

服务端 API 和工具都正常、但设置页没入口 —— 通常是插件**没进 boot graph**，
浏览器侧拿不到 client bundle。

```bash
# DSH 的 web 端口（Electron，端口不固定）
Get-NetTCPConnection -State Listen | Where-Object { $pids -contains $_.OwningProcess }

# 拉 boot manifest —— 这条 SSE 直接吐出完整的插件清单
curl -s http://127.0.0.1:<port>/plugins/events | head -1
# → data: {"type":"graph","graph":{"entries":[{"id":"...",...}]}}
```

entries 里没有自己的插件 id = 没进 graph。常见原因是 `package.json` 的 `name`
跟插件的**安装目录名**不一致（DSH 按目录名找包，并校验 name 相等）。

## 开发

```bash
npm test                              # 跑全部离线自测
node tests/sync-sim.mjs               # 检查运行副本的模块完整性 + 工具注册 + 包名一致性
node tests/assert.mjs                 # 断言套件（分条 / 出站队列竞态 / 增量扫描 / 群缓冲）
```

模拟脚本会临时借用真实的 `~/.dsh/qq-bridge.*`，**测试期间真 DSH 别在跑**（两边会互相覆盖游标）。
想完全隔离：

```bash
mkdir -p /tmp/dsh-sandbox/.dsh && cp ~/.dsh/qq-bridge.config.json /tmp/dsh-sandbox/.dsh/
USERPROFILE=/tmp/dsh-sandbox node tests/identity-sim.mjs
```

⚠️ 模拟脚本**必须显式设置 `cfg.selfUin`**：群消息的 @ 段要跟 `selfUin` 比对，
继承真实配置的话 @ 认不出来，测试会「一条都没投递」。

### 模块划分

28 个模块，按职责分四层（数据流单向：QQ → 消息处理 → 投递 → 会话 → 出站 → QQ）：

| 层 | 模块 |
|---|---|
| 入口 | `index.js`（装配各模块） |
| 基础设施 | `env.js`（数据目录/日志/宿主服务） `config.js`（配置） `state.js`（游标） `onebot.js`（协议调用） |
| 消息处理 | `poll.js`（轮询 + WS 事件入口） `ws.js`（WS 客户端） `snowluma.js`（WS 自动发现） `images.js`（图片入库） `emoticons.js`（表情段渲染） `emoji-mark.js`（正文表情标记） |
| 投递与出站 | `deliver.js`（路由 + 投递） `sessions.js`（会话列表 + 冷启动） `outbound.js`（回发队列） `split.js`（分条） `title.js`（会话标题） `history.js`（消息历史检索） |
| 能力与 UI | `tool.js`（6 个工具注册） `api.js`（设置页 API） `client.js`（设置页前端） `sendapi.js`（主动发消息接口） |
| 表情与说说 | `sys-faces.js`（官方目录） `face-resolve.js`（id 解析） `custom-faces.js`（收藏表情） `collect.js`（收藏表情包） `preview.js`（看表情包） `qzone.js`（发说说） |
| 安全 | `blocked.js`（13 个 action 物理封禁） |

各模块的详细职责和踩坑见 [docs/开发笔记.md](docs/开发笔记.md)。

### 本地改了源码怎么推进 DSH

```bash
node sync.mjs
```

⚠️ **插件在 DSH 里有两份，`sync.mjs` 两个都要同步**：

| 目录 | 是什么 |
|---|---|
| `~/.dsh/plugins/dsh-onebot-channel/` | pnpm `file:` 依赖的**源**，重装时从这里取 |
| `~/.dsh/profiles/desktop/node_modules/dsh-onebot-channel/` | **DSH 运行时真正 import 的目录** |

之前只同步前者 → 运行副本一直是旧的 → 现象是「日志写着工具注册成功，agent 那边只有 `qq_send`」。

`sync.mjs` 还会**反向**把工作区里的说明文档拉回仓库 `docs/`（工作区那份才是 agent 真正读到的那份）。

跑完 **重启 DSH** 才生效 —— 插件是进程启动时加载的。

> ⚠️ 改 `package.json` 的 `name` 时必须跟**安装目录名**一致，否则设置页入口会消失。
> `sync.mjs` 会在同步前校验，对不上直接拒绝同步。

## 文档

- **[docs/QQ对话说明.md](docs/QQ对话说明.md)** —— 装好后发给 agent 的说明：
  她是谁、消息从哪来、哪些工具能干什么、什么做不了
- **[docs/踩坑记录.md](docs/踩坑记录.md)** —— 踩过的坑与真因，改这个插件前先扫一遍
- **[docs/开发笔记.md](docs/开发笔记.md)** —— 实现细节与工程经验

## 致谢与边界

[MIT](LICENSE) © 2026 单树见月

- 协议端不在本仓库范围内 —— 本插件只跟 OneBot 11 协议端说话，不读 QQ 密码、不注入 QQ 进程
- 插件跑在 DSH 进程内，**拥有 DSH 能触及的一切权限** —— 安装前请自行审阅代码

---

*最后更新：2026-10-27 · v0.5.0*
