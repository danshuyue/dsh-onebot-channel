# Breeze 网络与诊断维护要点

## 先定位阶段，不先改音色或 key

`tts.js` 的网络 catch 表示初始 fetch 未返回可用 Response，不能用一句 `fetch failed` 判定 DNS、代理、TLS、远端计费或 key 有效性。约 10 秒失败不等于插件 30 秒总超时。`breeze-net.js` 提取有界的 cause / AggregateError 错误码，不记录原始 message、stack、请求头、文本或代理 URL。日志使用请求 ID 串起 request → response / 网络失败 → audio-body / complete；HTTP 状态、路由来源和耗时分开记录。

合成 POST 不自动重试，失败不能证明远端没收到请求。本地字数退还只修改每日额度，不是商业账户退款。余额 GET 原有的一次超时重试可以保留；但若已收到 401/402/429，即使读取 body 超时也必须保留 HTTP 状态、不能当可重试的网络超时。音色不存在按 HTTP 状态判断，不能在错误字符串里搜索 404（请求 ID 也可能包含 404）。

## 网络路由

- 只为 Breeze 的 POST 与账户/音色 GET 传入独立 dispatcher，绝不能 setGlobalDispatcher 或 setGlobalProxyFromEnv 改宿主网络。
- 显式 `HTTPS_PROXY` / `HTTP_PROXY` 优先，小写变量优先，保留 `NO_PROXY`；Windows 无显式代理时只读取已启用的静态 HTTP(S) 系统代理。PAC / SOCKS 不猜、不执行，不硬编码本机端口。
- `127.0.0.1` 属于运行 DSH 的那台机器；云主机/虚拟机不能照搬开发机的代理端口。
- 使用 Undici 7.x 与 Node 22/24 内置 fetch 的 dispatcher 协议兼容。实测 Undici 8 在 Node 24 返回 `invalid onRequestStart method`；只测假 fetch 抓不到，必须跑回环代理集成测试。
- Breeze 请求低频，每次拥有独立 Agent，fetch 结算后 graceful close；已派发响应的 body 可继续读取。这样配置切换不会提前关闭其他调用已经取得的路由。
- 浏览器可打开网页不代表 Node 走相同代理；无密钥 HTTP 探测只证明网络可达，不证明音色/key/合成可用，不做付费合成烟测。

## 工具流水不能按条数推断计费

`env.js` 的 register/execute 包装以函数上的 `Symbol.for` 标记幂等，而不是仅用模块 WeakSet 标记临时服务外壳。服务换壳、同定义重复注册、模块重载均需回归。保留 this、全部参数、同步返回/抛错与原 Promise，诊断失败不得影响业务。

每次执行带独立 `callId`、`startedAt`、已知 `sessionId`；`isError` 仅表示 throw，`ok:false` 标为 `outcome:failure`。跨 realm 原生 Promise 用 `node:util.types.isPromise` 识别；不要主动消费自定义 thenable（可能触发第二次业务）。不能按时间/参数去重真实并发调用。旧导出没有调用 ID，同毫秒的重复记录不能当成多次网络请求，也不能断言已查明历史重包装来源。

## 最小回归与发布

```sh
node tests/run-isolated.mjs tests/breeze-network-sim.mjs tests/diag-wrap-sim.mjs tests/tts-breeze-sim.mjs tests/balance-timeout-sim.mjs tests/diaglog-sim.mjs tests/tool-retry-sim.mjs tests/voiceout-sim.mjs
node tests/breeze-network-mutation.mjs # 仅在临时副本证伪；需保留修复前提交 c4db0d5
```

新网络测试必须验真实回环代理接线、NO_PROXY、全局 dispatcher 不变、合成不重放和日志不含测试密钥；旧实现证伪只在临时副本，不能改坏真实源码后再恢复。原始配置/诊断包不提交，不打入部署包。新增运行依赖后必须通过包管理器安装部署包，不能只复制 lib 目录。全量隔离测试通过后，从提交树导出打包，逐文件比对包内容、版本、字节数和 SHA-256。
