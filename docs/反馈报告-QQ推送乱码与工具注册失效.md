# 反馈报告：QQ 定时推送中文变乱码 + `qq_send` 不可用

| 项 | 内容 |
|---|---|
| 报告时间 | 2026-11-02 00:15（Asia/Shanghai） |
| 插件 | `dsh-onebot-channel` |
| 运行副本版本 | **0.15.0**（`~/.dsh/profiles/desktop/node_modules/dsh-onebot-channel`） |
| 源码目录版本 | **0.16.1**（`D:\Yansunsky\Desktop\project\DSHPlugins\dsh-onebot-channel`） |
| 协议端 | SnowLuma / OneBot11，`http://192.168.79.128:3003/`，登录号 3566906627（睿智的大肥鱼），`get_status` → `online:true, good:true` |
| 触发场景 | 任务看板定时规则（cron `0 20 * * *`，Asia/Shanghai）到点执行，需给 `user_id=1321833118` 发一条私聊 |
| 严重级别 | 中（消息已投递但内容永久损坏；同时暴露工具注册/端口常驻两类静默失效） |

---

## 一、现象

定时任务要求发出一条私聊：「八点了，政治 1000 题跟练时间到。」

- 协议端返回 **成功**：`{"status":"ok","retcode":0,"data":{"message_id":1045859125}}`
- QQ 客户端实际收到的是乱码：

```
?ˣ?????? 1000 ?????h?鑈??
```

即：**发送链路报成功，正文已经坏掉**，用户侧不可读。这类“成功但坏”的失败比报错更危险——上层不会重试，也不会告警。

---

## 二、根因判定：字节是对的（GBK），编码声明是错的（UTF-8）

### 2.1 回读线上消息

```
POST http://192.168.79.128:3003/get_msg
{"message_id":1045859125}
```

返回 `message[0].data.text` 中已含 **U+FFFD 替换字符**，说明协议端按 UTF-8 解码失败后做了全局替换，**坏数据已落入消息库，不可逆**。

### 2.2 抓取真实线上字节

本地回显服务捕获同一条 payload 的原始字节：

```
线上的 message 字段 HEX：
b0cb b5e3 c1cb a3ac d5fe d6ce 20 31303030 20 cce2 b8fa c1b7 cab1 bce4 b5bd a1a3
```

两种解码方式的对照：

| 解码方式 | 结果 |
|---|---|
| 按 **GBK** 解码 | `八点了，政治 1000 题跟练时间到。` ✅ 完全正确 |
| 按 **UTF-8** 解码 | `�˵��ˣ����� 1000 ...` ❌ 与截图完全一致 |

正确的 UTF-8 字节本应是：`e585ab e782b9 e4ba86 efbc8c e694bf e6b2bb ...`

**结论：请求体被按系统 ANSI 代码页（`chcp` = 936 / GBK）编码，但 HTTP 头声明的是 `Content-Type: application/json`（默认 UTF-8）。协议端按 UTF-8 解码 → 全部替换为 U+FFFD。**

---

## 三、GBK 字节的来源（已用受控实验定位）

在 `MSYS2 bash` 环境下，把同一条 payload 用三种方式发给回显服务，抓原始字节：

| 发送方式 | 线上 HEX | 结果 |
|---|---|---|
| `curl -d '{"message":"八点了"}'`（中文**内联在命令行参数**里） | `b0cb b5e3 c1cb` | ❌ **GBK** |
| `curl --data-binary @p.json`（payload 写在 UTF-8 文件里） | `e585ab e782b9 e4ba86` | ✅ UTF-8 |
| `node -e "fetch(url,{body:JSON.stringify(...)})"` | `e585ab e782b9 e4ba86` | ✅ UTF-8 |

同一字符串经 `printf` / `echo` / `node process.stdout` 输出都是正确的 UTF-8 字节：

```
$ printf '%s' '八点了' | od -An -tx1
 e5 85 ab e7 82 b9 e4 ba 86
```

**定位：坏在 `bash(MSYS2) → 原生 curl.exe` 的 argv 边界**——参数被按代码页 936 转成 ANSI 字节；bash 内部的管道和文件写入都是 UTF-8，所以同样的字串走文件/管道不会坏。

**因此：本次事故的直接成因是“执行侧用命令行内联中文调 curl”，不是插件代码路径。** 已验证插件的 `lib/onebot.js` 走 `fetch + JSON.stringify`：

```js
// lib/onebot.js:24-27（0.15.0 与 0.16.1 一致）
const response = await fetch(config.onebotHttp, {
  method: 'POST',
  headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),   // ← UTF-8，安全
  signal: AbortSignal.timeout(timeoutMs)
})
```

这条路径的字节永远正确。**但仍建议加一道防线，见 §6.1。**

---

## 四、为什么必须“绕开插件直连协议端”（这才是要修的部分）

定时任务本应调用插件的 `qq_send`，但该工具在本次会话里**根本不存在**；退而求其次的本地接口 `sendapi` 也**没在监听**。两条正路都断，才被迫自己拼 OneBot HTTP——而拼法踩了 §3 的坑。

### 4.1 问题 A：`qq_send` 在多数实例里注册失败（静默）

`lib/tool.js:33-34` 是**一次性早退、无重试**：

```js
const tools = serviceOf(ctx, 'tools')
if (tools === undefined || tools === null || typeof tools.register !== 'function')
  return note('tool', 'no tools service')   // ← 只打一行日志，工具从此缺失
```

日志统计（`~/.dsh/qq-bridge-load.log`，1.04 MB）：

| 事件 | 次数 |
|---|---|
| `[apply] started` | 22 |
| `qq_send registered` | 25 |
| **`[tool] no tools service`** | **130** |
| `[apply] disposed` | 9 |
| `[sendapi] listen failed ... EADDRINUSE` | 9 |
| `另一个实例已在收发 → 本实例只注册工具与设置页` | 9 |
| `ws 连接断开 code=1006` | 17 |

`[tool] no tools service` 最早出现在 `2026-10-31T12:13:07.113Z`，**首次出现**就说明不是偶发。130 次失败分散在多次 `apply` 里；同期 `inject` 已声明 `'tools'`（`lib/index.js:69`），所以不是 inject 漏写，而是**按服务取用时机太早**：`tools` 服务在该插件 `apply` 阶段尚未就绪，`serviceOf` 返回 `undefined` 后代码直接放弃。

**后果**：agent 侧看不到 `qq_send`，`ops_discover_tools` 搜 `qq_send` 也匹配不到；插件表面“装着”，实际能力缺失，且只有翻日志才知道。

### 4.2 问题 B：`sendapi`（127.0.0.1:39273）未监听

```
$ curl -s --max-time 4 http://127.0.0.1:39273/health
# exit code 7（connection refused）
```

日志末尾：

```
[sendapi] listen failed listen EADDRINUSE: address already in use 127.0.0.1:39273   (共 9 次)
[apply] 另一个实例已在收发（pid=20420，起于 2026-11-01T05:32:43.400Z）→ 本实例只注册工具与设置页
2026-11-01T09:03:08.097Z [apply] disposed
```

即：多实例抢端口 → 本实例放弃监听；随后主实例 `disposed`，**之后再无新的 `[apply] started`** → 39273 变成没人占的空位。`sendapi.js` 对 `EADDRINUSE` 也只 `note()` 一行，不重试、不退避、不升级为错误。

### 4.3 问题 C：多实例并存 + 配置互相覆盖

9 次出现“另一个实例已在收发”，且不同实例加载到**不同配置**：

```
[config] ok peer=1321833118 owner=1321833118 groups=["975663147"] routes.private=2 routes.group=1
[config] ok peer=3472302240 owner=3472302240 groups=["975663147"] routes.private=1 routes.group=0
[config] ok peer=1321833118 owner=1321833118 groups=["123456"]     routes.private=2 routes.group=1   ← 脏数据
```

- `peer/owner` 在两个号之间来回翻转（1321833118 / 3472302240）
- `groups=["123456"]` 明显是测试残留，写进了真实配置
- 单实例锁在 `disposed` 后未清理，旧 pid=20420 的占位长期存在

### 4.4 问题 D：WS 地址三处不一致且连不上

| 来源 | 地址 |
|---|---|
| 配置文件 `onebotHttp` | `http://192.168.79.128:3003/` |
| 配置 `ws=`（日志打印） | `ws://192.168.79.128:3002/` |
| 实际连接（日志） | `ws://127.0.0.1:3001/` |

实际连接反复 `code=1006 reason=dropped`（17 次），**WS 实时推送从未真正建立**，入站全靠轮询兜底。三处地址不同源，`snowluma.js` 自动发现的端口（`wsServers`/`httpServers`）与配置文件里的值没有对齐机制。

### 4.5 问题 E：运行副本与源码代不同步

```
运行副本：0.15.0（10 个 lib 文件与源码不同）
源码目录：0.16.1（多了 lib/window.js，运行副本缺失）
```

运行副本里 `lib/tool.js` 无 `window.js` 相关逻辑，而源码 `tool.js:23` 已 `import { notePass, closeWindow, noteReply } from './window.js'`。说明运行的是**旧模块代**，且没有版本防漂移检查——排障时很容易把源码行为当成线上行为。

---

## 五、最小复现步骤

```bash
TOKEN=$(node -e "console.log(require(process.env.HOME+'/.dsh/qq-bridge.config.json').token)")

# ① 坏的（等价于本次事故：中文内联进 curl 参数 → GBK）
curl -s -X POST http://192.168.79.128:3003/send_private_msg \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"user_id":1321833118,"message":"八点了"}'
# → retcode:0，但 QQ 收到乱码

# ② 回读验证（关键：retcode 0 不代表内容正确）
curl -s -X POST http://192.168.79.128:3003/get_msg \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"message_id":<上一步返回的 message_id>}'
# → message[0].data.text 含 \ufffd 即为损坏

# ③ 正确的（payload 走 UTF-8 文件）
printf '%s' '{"user_id":1321833118,"message":"八点了"}' > /tmp/p.json
curl -s -X POST http://192.168.79.128:3003/send_private_msg \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data-binary @/tmp/p.json
```

---

## 六、修复建议（按优先级）

### 6.1 【必做】出站编码自证 + 乱码闸门

`lib/onebot.js` 的 `callOneBot` 是唯一出口，在这里加两道：

1. **显式声明 charset**：`'Content-Type': 'application/json; charset=utf-8'`（消除默认值歧义）
2. **发送前字节自检**：`Buffer.from(body,'utf8')` 后回解，若 `text` 含 `U+FFFD` 直接拒发并抛错——脏字符不该进 QQ
3. **可选（强烈建议）发送后回读校验**：`send_*` 成功后取 `message_id` 调 `get_msg`，比对解码文本；不一致就 `note('onebot','ENCODING CORRUPTED ...')` 并向上报错。这是唯一能在“retcode 0 但内容坏”的情况下自我发现的机制

### 6.2 【必做】工具注册改为可重试

`lib/tool.js` 每个 `register*Tool` 都是同样的早退。建议统一改成：

```js
const tools = await waitForService(ctx, 'tools', { timeoutMs: 10000, intervalMs: 200 })
if (tools === undefined) return note('tool', 'FAILED no tools service after 10s')  // 升级日志级别
```

理由：`tools` 就绪晚于插件 `apply` 是常态，一次性采样必然间歇性丢工具；且失败日志必须能被人看见（当前 130 条 `no tools service` 混在 1 MB 日志里没人发现）。

### 6.3 【必做】`sendapi` 端口冲突退避重试

`sendapi.js` 的 `server.on('error')` 目前只 `note()`。建议：`EADDRINUSE` 时按 1s/2s/4s/8s 退避重试（上限 60s），仍失败才记 ERROR；并在 `/api/qq-bridge/state` 里暴露 `sendApiListening` 布尔，让设置页能直接看到“接口没起来”。

### 6.4 【建议】单实例锁与 `disposed` 后重锚

- `disposed` 时清理 `qq-bridge-instance.lock`（含 pid 存活校验，pid 已死则视为过期）
- 主实例 `disposed` 后，剩余实例应自动“升级”为收发实例，重新接管轮询/WS/`sendapi`，而不是集体停留在“只注册工具与设置页”的半残状态

### 6.5 【建议】配置写保护 + 三处 WS/HTTP 地址对齐

- `groupUins` 里的 `["123456"]` 这类值应在保存时做格式/合理性校验（群号明显不合法直接拒绝）
- `snowluma.js` 自动发现的端口与配置文件值不一致时，**以发现结果为准并回写**，或至少打 WARN 指明哪一处被忽略；当前是静默改连 `127.0.0.1:3001`，排障时极易误判

### 6.6 【建议】运行副本版本防漂移

启动日志已打印 `[module] loaded pid=... node=...`，但没打印**插件版本**。补一行 `[module] version=0.15.0`，并在源码版本与运行版本不一致时 WARN。本次排障就是先花了时间才确认运行的是 0.15.0 而非 0.16.1。

---

## 七、给开发同学的一句话摘要

> 定时推送返回成功但内容全是乱码。根因是执行侧把中文内联进 `curl` 参数被转成 GBK 字节，而请求头声明 UTF-8（插件的 `fetch + JSON.stringify` 路径本身没问题）。**真正需要修的是两条正路都断了**：`qq_send` 因 `tools` 服务就绪时序不佳而注册失败（日志里 130 次 `no tools service`、无重试），`sendapi` 因多实例抢 39273 端口后主实例 `disposed` 而长期不监听。建议在唯一出口 `callOneBot` 上加编码自检/回读校验，把工具注册改成可重试，端口冲突退避重试，并修掉单实例锁残留与配置脏数据。

---

## 附：证据清单

| 项 | 值 / 位置 |
|---|---|
| 损坏消息 `message_id` | `1045859125`（私聊 → 1321833118） |
| 损坏文本的 UTF-8 字节 | `b0cb b5e3 c1cb a3ac d5fe d6ce 20 31303030 ...` |
| 正确 UTF-8 字节 | `e585ab e782b9 e4ba86 efbc8c e694bf e6b2bb ...` |
| 插件日志 | `~/.dsh/qq-bridge-load.log`（1,041,140 bytes） |
| 插件配置 | `~/.dsh/qq-bridge.config.json` |
| 首次 `no tools service` | `2026-10-31T12:13:07.113Z` |
| 最后一次 `disposed` | `2026-11-01T09:03:08.097Z`（此后无新 apply） |
| 运行副本 | `~/.dsh/profiles/desktop/node_modules/dsh-onebot-channel` = **0.15.0** |
| 源码 | `D:\Yansunsky\Desktop\project\DSHPlugins\dsh-onebot-channel` = **0.16.1** |
| 协议端状态 | `get_status` → `online:true, good:true`；`get_login_info` → 3566906627 |
