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
   ↓  按换行切条（她自己写几行就几条），带随机延时
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

装好之后 agent 有 10 个工具：

| 工具 | 干什么 | 参数 |
|---|---|---|
| `qq_send` | 发消息、发表情；想自己决定分几条就传 `segments` | `text` `segments` `emoji` `custom_emoji` `user_id` `group_id` |
| `qq_emoji_search` | 搜 QQ 官方表情目录 | `query` `all` |
| `qq_msg_history` | 查群 / 好友历史消息 | `group_id` `user_id` `count` `before_message_id` |
| `qq_collect_face` | 把收到的表情包存进 QQ 收藏夹 | `index` `recent` `file` `desc` `dir` `list` `delete` |
| `qq_face_preview` | **看**收到的表情包（结果直接带图片） | `index` `from` `count` |
| `qq_qzone_post` | 发表 QQ 空间说说（**必须带 `confirm: true`**） | `content` `visibility` `target_uins` `confirm` |
| `qq_wait` | 等他把话说完，返回这期间新到的消息（默认 8s，上限 60s） | `timeout` |
| `qq_pass` | 划走：这一回合不开口（正文里已经写了真话的，仍然会发出去 —— 写了就算说出口） | — |
| `qq_close` | 收摊：双方都收尾时结束会话，记下聊到哪儿、下次怎么接 | `summary` |
| `qq_remember` | 记住关于他的一件事 / 一个称呼，下次还认得 | `fact` `nick` `user_id` `group_id` |

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

### 你不一定非要回话（沉默权）

QQ 桥接和真人聊天，最不像的地方是「真人会不回、会晾着、会说完了就走」。0.7.1 给模型补上了这三种**不说话**的出口，让对话有节奏、不粘人：

| 场景 | 怎么做 | 工具 |
|---|---|---|
| 对方明显还没说完（「我跟你说」「等下」「还有」） | 等一会儿，看下文再说 | `qq_wait` |
| 没话说 / 不想接 / 话题翻篇了 | 划走 —— 这一回合什么都不发 | `qq_pass` |
| 双方都收尾了（嗯 / 好 / 哈哈 / 晚安），再补一句就多余 | 收摊，记下聊到哪儿、下次怎么接 | `qq_close` |

**划走 ≠ 删掉刚写的话**（0.9.3 修正）：模型经常「先写一句正文 → 再觉得太催了 → 调 qq_pass」，
早先的实现会把正文一起吞掉，于是会话里她明明说了一句话、QQ 上却什么都没有（用户报的「她发消息了我没收到」）。
现在：正文里有真话就照发，只有纯动作（「（尾巴摆了摆）」）或纯标点时 `qq_pass` 才真的按下不发。

`qq_close` 有硬约束：如果对方还有提问没回答，桥接会拒绝收摊，逼模型先把话接完再走。`qq_close` 写下的「下次怎么接」会在下次开场时自动带回，避免冷启动尬聊。

更细的判断逻辑（收尾评分、节奏底座、自动静默）见 [docs/QQ对话说明.md](docs/QQ对话说明.md)。

### 分几条，也由她定

不传 `segments` 时按句末标点自动切（老行为）；传了就按她给的分段原样发 —— 真人会自己决定「这句分三条还是一条说完」，而不是被标点机械切开。

```jsonc
// 一句话拆成三条，逐条发出、中间带停顿
{ "segments": ["我跟你说", "那个事搞定了", "不过还差一点"] }
```

传 `segments` 时 `text` 被忽略；空字符串段自动丢掉；段内的 `[表情:呲牙]` 挂在该段末尾。

### 她记得你是谁（关系持久化）

称呼和「关于他的几条事实」落在 `~/.dsh/qq-bridge-memory.json`，**重启不丢**：入站自动记昵称和活跃度，模型也能用 `qq_remember` 主动记（「他喜欢猫」「别叫他全名」）。下次被叫醒时，这些会以一小段 `（关于他：称呼：…；记得：…）` 带进正文，所以她不会每次都从零认识你。

一张卡最多 8 条事实、注入正文约 180 字上限 —— 它是**每回合常驻**的，不控长度就是烧 token。不想要这段就设 `memoryEnabled: false`。

### 先记账，再决定什么时候回（标记已读的中间态）

原来 WS 通路是「来一条投一条」：对方连发三句，就开三个回合、被连问三遍。
`replyQuietMs` 治不了这个 —— 它只是把**每一个回合**各推迟一遍，三条消息仍然是三个回合。

现在私聊多了一层合并窗口（`mergeWindowMs`，默认 2500，设 `0` 关闭）：

```
来信 → 立刻记账（markSeen + 游标推进，等于「已读」）→ 入池攒着
     → 窗口到点（或攒够 mergeMaxMessages / 到达 mergeMaxWaitMs）→ 一批放行 → 一个回合
```

- 「已读」指的是**内部记账**，不是推给 QQ 的回执（OneBot 没有已读回执接口）。
  它的作用是不让轮询把同一条再拎一遍，同时保证「攒着没回」这件事在状态里是明确的。
- 投递失败会把记账撤回去（`mergeSnapshots`），轮询或下一批还能重试 —— 不是静默丢消息。
  唯一的代价：进程在窗口内被强杀（不是正常卸载）时，那一两条「已读」记账已经落盘，会丢掉。
  窗口只有 2.5 秒，正常卸载会记日志并保留痕迹。
- 只作用于私聊。群里是 @ 才投递，一条 @ 就是一件事，攒起来反而怪。
- 跟 `replyQuietMs` 会叠加（2.5s 窗口 + 5s 静默 = 7.5s），两个都想开时建议只留一个。

### 没人叫她，她自己想起来找你（主动搭话）

默认**关**（`proactiveEnabled`）。打开后每 60 秒看一次该不该开口，
真正开口还要过四道闸：

| 闸 | 默认 | 配置 |
|---|---|---|
| 静默时段 | 23:00–08:00 不打扰 | `proactiveQuietFrom` / `proactiveQuietTo` |
| 空闲够久 | 6 小时 | `proactiveIdleHours` |
| 当日配额 | 1 次 | `proactiveDailyMax` |
| 没被回应的退避 | 2ⁿ 倍，封顶 4 倍 | `proactiveBackoffMax` |

关键点：这一层**不自己写文案**。它只是往同一个会话里投一条内部来信：

```
（主动搭话：距上次说话已经 7 小时。上次聊到「…」，可以从「…」接着聊。
想说什么就说……但这事你自己定：没什么想说的就 qq_pass，不用硬找话。）
```

于是「说」还是「不说」仍然由模型判断，转发 / 分条 / 抑制标记全部复用原链路。
硬拼一句「在吗」发出去，就退化成定时问候机器人了 —— 这是这条设计的红线。

状态落在 `~/.dsh/qq-bridge-proactive.json`（重启不丢，否则每次重启都重新「攒够 6 小时」或把日配额清零）。
设置页有「现在试一次」，跳过所有闸立刻投一次（开关关着也能试）。

**对谁开口**：`proactiveTargets` 是白名单，元素形如 `private:1000000001`。

- **空数组 = 所有已绑会话的私聊**（默认，也是升级上来的老行为）；
- 非空 = 只对名单里的人算，名单外的连「该不该说」都不判；
- 只认私聊，群里不主动（`candidates()` 只取 `routes.private`，且必须有 sessionId）。

设置页里是「所有已绑私聊 / 只对勾选的人」两选一 + 每人一行勾选框。从「所有人」取消一个人会自动展开成显式名单 ——
因为空数组的语义是「全员」，直接把「取消某个人」写成空数组会得到完全相反的结果。
每行还有「对TA试一次」（`POST /proactive-now {only}`），可以只对某个人手动开一次口，不用来回改名单。

**手动触发会轮转**：候选按「最久没被主动过」排序（从没主动过的排最前），
所以连点「现在试一次」会依次换人，不会三次都砸在同一个人身上（0.9.2 修的就是这个：
之前固定打候选列表第一个，另一个人永远轮不到）。按钮旁边会写明这次轮到谁。

**只回动作 = 沉默**：主动搭话回合里，如果她只回了「（尾巴摆了摆）」这类纯动作描写，
转发链会把它当沉默丢掉（日志记一笔），不会真的发到他手机上 ——
普通聊天里「（笑）好呀」这种带真话的照常发。

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
| 分条由她决定 | **正文换行 = 另起一条**（`splitMode: paragraph`，0.10.0 默认）；想回「一句一条」切成 `sentence`。带随机延时，模型也能用 `segments` 直接指定 |
| 连发合并 | 私聊连发几条先攒一会儿再一起回（`mergeWindowMs`，0 = 关），不再被连问三遍 |
| 主动搭话 | 没人叫她时自己想起来找你（默认关，四道闸 + 退避；可选只对指定的人开口；设置页可「现在试一次」/「对TA试一次」） |
| 设置页 UI | 设置 → **QQ 桥接**：顶部一排功能分区（概览 / 绑定 / 对话节奏 / 主动搭话 / 关系记忆 / 推送 / 高级），点进去只看那一块 |

### 设置页能调什么

顶上一排是功能分区，一次只显示一块；「保存」和「重新载入」始终在右上角。

| 分区 | 内容 |
|---|---|
| **概览** | 连接状态 + 统计块（私聊/群绑定、今天主动几次、记住几个人、待合并条数、推送是否连通），以及「现在在跑什么」的自然语言摘要；数字都可点进对应分区 |

「现在在跑什么」第一行是**这版代码的版本号 + 进程 pid + 启动时间**（0.10.1 补）。
改完代码发现行为没变，先看一眼这行：版本没涨、启动时间还是上午 —— 说明主进程仍在跑旧代码，重启即可，不用怀疑改错了。
| 绑定 | 私聊 / 群聊各自一行：QQ 号、名字、绑定会话、正文前缀 |
| **对话节奏** | `replyQuietMs` 回复前静默、`mergeWindowMs` 合并窗口（+ 上限 / 条数）、`waitMaxMs` 等待上限、`closureEnabled` 允许判断收尾、`autoForwardReply` 自动转发、`backfillOnStart` 上线补历史（+ 页数 / 投递条数） |
| **主动搭话** | 上卡：`proactiveEnabled` 开关、`proactiveIdleHours` 空闲门槛、`proactiveDailyMax` 日上限、静默时段、退避上限。下卡「对谁开口」：所有人 / 只对勾选的人 + 每人上次主动时间与「为什么现在还不说」 |
| **关系记忆** | `memoryEnabled` 开关、记住了谁（称呼 / 事实条数 / 说过几句）、一键清空 |
| **推送** | `wsEnabled`、WS 地址与 token、自动发现（读 SnowLuma 配置） |
| **高级** | 分条字数与间隔、轮询间隔、群上下文条数、正文前缀、图片目录、对外发布确认等 |
| **关系记忆** | `memoryEnabled` 开关、记住了谁（称呼 / 记了几条 / 说过几句）、一键清空 |
| 推送 | WS 开关、地址、token（留空 = 保持原样）、自动发现 |
| 高级设置 | 分条（字数 / 条数 / 碎片阈值 / 间隔）、轮询间隔、补漏间隔、正文前缀、图片副本目录、只在 @ 时响应、冷启动会话、说说必须带 `confirm` |
| 对话节奏（续） | `splitMode` **怎么分条**：按换行（她自己决定说几条）/ 按句末标点（一句一条） |

**不给控件的**：`token` / `wsToken`（凭据）、`onebotHttp`（装机配置）、`fallbackToLiveSession`（会绕过路由表）、
`allowSendToAny`（安全逃生阀）、`enabled`（只在加载时读一次，放按钮会误导成即时生效 —— 页面只在它为 `false` 时显示告警）。
这批「故意不给控件」的字段在 `tests/ui-wiring.mjs` 里有白名单和理由，新加配置忘了接 UI 会直接测试失败。

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
  "fallbackToLiveSession": false,               // 首选会话没 agent 时改投别的会话
                                                 // ⚠️ 这会绕过路由表，默认关着
  "agentOptions": { "provider": "deepseek-account", "model": "deepseek-flash" },

  // ---- 分条发送 ----
  "splitReply": true,
  "splitMode": "paragraph",            // paragraph = 换行分条（默认）/ sentence = 按句末标点
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

**出站两道闸门（2026-10-28）** —— 都挂在 `callOneBot()` 这个唯一出口上，绕不过去：

| 闸门 | 管什么 | 实现 | 拦住了什么 |
|---|---|---|---|
| 目标白名单 | **发给谁** | `lib/allowlist.js` | `qq_send` 的 `user_id`/`group_id` 是 agent 随便填的 → 群里一句 prompt injection 就能让她往任意 QQ 号发消息 |
| 内容审计 | **发什么** | `lib/sensitive.js` | 回复里顺嘴写出 `C:\Users\...`、`token=xxx` → 本机路径和凭据直接进群 |

白名单从**已有的配置**派生，不新增一份（避免两处漂移）：
私聊 = `peerUin` ∪ `ownerUin` ∪ `routes.private` 的键；群 = `groupUins` ∪ `routes.group` 的键。
自动转发的目标全部来自路由表，所以永远不会被误伤。

- 想临时放开：`allowSendToAny: true`（⚠️ 等于把上面那个风险还回去，只在排障时开）。
- 白名单**全空**时（还没配 `peerUin`）不拦，只记一条警告 ——
  闸门的语义是「限制已配置的服务范围」，不是「没配好就把插件锁死」。
- 内容审计**故意不匹配**裸的 32 位十六进制串：表情包文件名就是 MD5，
  加了这条会把正常表情和消息整条拦掉。详见 `lib/sensitive.js` 的注释。

**发说说确认闸** —— `qq_qzone_post` 必须传 `confirm: true` 才真的发。
说说是对外发布，而 `delete_qzone_msg` 在封禁清单里（发得出去、删不掉），
所以这道闸不是防恶意，是逼 agent 在发之前把「这是对外发布」过一遍脑子。
关掉用 `qzoneRequireConfirm: false`（不推荐）。

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

**撞到白名单** —— 工具报「出站被白名单拦截：好友 xxx 不在允许范围内」：

```bash
grep "\[allow\]" ~/.dsh/qq-bridge-load.log | tail -3   # 白名单为空时会有警告
```

这是**硬闸，不是 bug**：`qq_send` 只能发给「插件正在服务的对象」
（`routes` 里的好友/群 + `peerUin`/`ownerUin` + `groupUins`）。
要么把目标加进设置页的会话绑定，要么临时 `allowSendToAny: true`（不推荐）。

**日志里写着「收到消息事件」但会话里没动静** —— 看下一行是不是「重复消息（已处理），跳过」。
这是去重误杀：旧版本拿私聊的 `message_seq` 判新旧，但私聊的 seq 是两套编号混着的
（自己发的 71xx 连续、对方发的 50xxx/20xxx 跳号且不单调），会把新消息当成旧消息丢掉。
0.6.1 起私聊改用时间戳判新旧（群聊仍用 seq），这个问题不会再有。

```bash
grep "收到消息事件" ~/.dsh/qq-bridge-load.log | tail -3   # 消息进来了吗
grep "重复消息"     ~/.dsh/qq-bridge-load.log | tail -3   # 被去重误杀了吗
```

**群里没反应**：① 监听列表里有这个群吗（日志 `[poll] group loop started, watching [...]`）
② `groupOnlyWhenAt` 开着的话必须先 @ ③ 首次启动会 seed，启动前发的消息不会被回复，再 @ 一次

**同一条回复连着发了好几遍**：日志里搜「已转发过，跳过重复发送」。
这是「没等她发完就发下一条」触发的 —— agent 跑回合期间 `session.seq` 不推进，
两条消息拿到同一个游标 → 认到同一个回合 → 同一条回复发两遍。0.6.2 起按
「属于我自己的那条 user/message」定位回合，同一个回合只发一次。

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
node tests/ui-wiring.mjs              # 设置页 ↔ 配置项一致性（死配置 / 漏接 UI / 过时文案）
node tests/merge-sim.mjs              # 合并窗口（窗口内合并 / 上限截断 / 失败回滚接线）
node tests/proactive-sim.mjs          # 主动搭话的四道闸（静默 / 空闲 / 配额 / 退避）+ 白名单选人
node tests/client-render.mjs          # 设置页真渲染（每个分区都过一遍，含选人名单）
node tests/pass-forward-sim.mjs       # qq_pass 但有真话 → 照发（沙箱 HOME，不碰真实 ~/.dsh）
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

31 个模块，按职责分四层（数据流单向：QQ → 消息处理 → 投递 → 会话 → 出站 → QQ）：

| 层 | 模块 |
|---|---|
| 入口 | `index.js`（装配各模块） |
| 基础设施 | `env.js`（数据目录/日志/宿主服务） `config.js`（配置） `state.js`（游标） `onebot.js`（协议调用） `health.js`（探活门控 + 错误分级） |
| 消息处理 | `poll.js`（轮询 + WS 事件入口） `ws.js`（WS 客户端） `merge.js`（私聊合并窗口） `snowluma.js`（WS 自动发现） `images.js`（图片入库） `emoticons.js`（表情段渲染） `emoji-mark.js`（正文表情标记） |
| 投递与出站 | `deliver.js`（路由 + 投递） `sessions.js`（会话列表 + 冷启动） `outbound.js`（回发队列） `split.js`（分条） `title.js`（会话标题） `history.js`（消息历史检索） |
| 能力与 UI | `tool.js`（10 个工具注册，含沉默权三件套 `qq_wait`/`qq_pass`/`qq_close` 与 `qq_remember`） `api.js`（设置页 API） `client.js`（设置页前端） `sendapi.js`（主动发消息接口） `closure.js`（收尾评分） `rhythm.js`（节奏底座 + 自动静默） `memory.js`（关系卡落盘） `proactive.js`（主动搭话的钟 + 四道闸） |
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

## 启动顺序：为什么入站要等一等

SnowLuma 的 OneBot 端口（HTTP 3000 / WS 3001）是**等 QQ 登录成功之后才 listen 的**。
而 DSH 常常比 QQ 先起来（开机自启的典型顺序），中间会差上 1~2 分钟。

这段窗口里如果直接起轮询和 WS，就是对着没开的门反复敲 —— 满屏 `timeout` 和 `1006` 断连，
真正出问题时反而在日志里找不到线索。

所以插件的启动分成两段：

| 阶段 | 时机 | 做什么 |
|---|---|---|
| 立即 | 插件加载时 | 注册 10 个工具、设置页 API、主动发消息接口、回复转发队列 |
| 延后 | OneBot 探活通过后 | 启动私聊/群聊轮询、WS 事件推送、主动搭话的钟 |

- **工具先注册**：工具是出站能力，跟 QQ 登录无关。早给 agent，QQ 迟迟不登录时它也不至于「一个工具都看不到」。
- **探活用 `get_login_info`**：它要真的进了 QQ 才应答，是「能干活了」的准信儿。退避 1s→5s，总超时 150s。
- **超时就照样启动**：与其让桥接彻底不动，不如让轮询自己重试（错误分级保证不吵）。
- **错误分级**：`ECONNREFUSED` / `fetch failed` / 超时这类「门还没开」的错误，
  不写 `state.lastError`（设置页那个字段是给「插件坏了」看的）、不逐条刷日志，只在状态翻转时记一条；
  `retcode` 不对、HTTP 5xx 这类真问题照旧上报。

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

*最后更新：2026-10-29 · v0.10.1*
