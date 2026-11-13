/**
 * env.js —— 数据目录、日志、宿主服务取用。
 *
 * 数据目录放在 ~/.dsh/，不放在插件目录里。
 * 插件是用 file: 依赖装进 profile 的 node_modules 的副本，pnpm 重装会覆盖插件目录，
 * 配置和状态写进去会被冲掉（路由表一丢就得重新配）。dsh-fish-memory 也是这么放的。
 */
import { appendFileSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { types } from 'node:util'
import { recordTool } from './diaglog.js'

export const DATA_DIR = join(homedir(), '.dsh')
export const CONFIG_FILE = join(DATA_DIR, 'qq-bridge.config.json')
export const STATE_FILE = join(DATA_DIR, 'qq-bridge-state.json')
export const LOAD_LOG = join(DATA_DIR, 'qq-bridge-load.log')
/**
 * 兴趣点任务队列（0.23.0）。
 *
 * 为什么必须落盘、而且必须单独一个文件：
 *   任务的生命周期是「命中 → 等 N 分钟 → 取材 → 判定 → 下发」。
 *   那 N 分钟里可能热重载、协议端断线、DSH 重启 —— 任务丢了的话，
 *   用户那次「帮我盯着这个事」就**静默失效**，而且没有任何人会发现
 *   （他不会知道「本来该有一条通知」，也就不会来问）。
 *
 * 为什么不塞进 state.json：那个文件被 `loadState()` 做白名单过滤，
 *   顶层只认固定的几个键，加东西重启后会静默消失（这个坑踩过一次）。
 *   单独一份文件还让「删掉它就清空所有待办」成为一件明确的事。
 */
export const INTEREST_FILE = join(DATA_DIR, 'qq-bridge-interests.json')

/**
 * 日志轮转阈值：超过 8 MB 时保留尾部 2 MB，防止无限增长。
 *
 * ⚠️ 原来是 2 MB / 256 KB，2026-11-08 实测不够（用户导出的日志只有「协议端断连 + 未配置会话」，
 *    真正要看的转发现场全被轮转截掉了）。真实日志 18,254 行里：
 *      ws 逐事件 9,740 行 / OneBot HTTP 502 4,889 行 / 未配置会话 4,243 行 —— 97% 是噪音，
 *    一次 502 风暴（4,889 行 ≈ 250 KB）就能把一整天的现场推出窗口。
 *    阈值放大 + 配合 noteCoalesced 降噪，导出的日志才有东西可看。
 */
const LOG_ROTATE_BYTES = 8 * 1024 * 1024
const LOG_KEEP_BYTES = 2 * 1024 * 1024
/** 每 256 条 note 查一次大小：note 是事件驱动的低频路径，查太频也没意义。 */
const ROTATE_CHECK_EVERY = 256
let noteCount = 0

/**
 * 同类日志合并的账本：`key → { at, count }`。
 *
 * 只记「最近一次真的写出去的时刻」和「这之后又被压掉了多少次」。
 * 不挂定时器 —— 定时器会让进程多活一会儿（测试退出变慢甚至挂住），
 * 而「下一次同类日志到来时把攒下的次数带出来」已经够用：
 * 这些被合并的都是**会反复发生**的噪音，下一次很快就会来。
 */
const coalesced = new Map()

/** 账本上限：超出就整表清空（只影响计数准确度，不影响日志内容）。 */
const COALESCE_MAX_KEYS = 512

/**
 * 同类日志合并：第一条立刻写，窗口内重复只计数，窗口外再写时把攒的次数带出来。
 *
 * 为什么需要（2026-11-08）：用户要「导出日志」是为了取证，而日志里 97% 是同一个
 * 事情反复刷屏（每条 WS 事件一行、每个未配置的群每条消息一行、协议端 502 每轮一行）。
 * 噪音把现场挤没了 —— 导出按钮点了，拿到的是一份看不出问题的日志。
 *
 * ⚠️ **第一条必须立刻写**，不能延迟：取证要的是「这件事发生过」，
 *    合并只该减少重复，不该让事实消失。所以窗口内的第一条永远原样落盘。
 *
 * ⚠️ 合并掉的那些**不能静默丢弃**：窗口过期后第一次再发生时，
 *    会先补一行「（此前同类日志 N 次未逐条记录）」，再把新的这条写出去。
 *    这样「发生了 5,000 次」这个事实仍然留在日志里。
 *
 * @param {string} tag    日志标签（与 note 一致）
 * @param {string} key    合并键：同一件事必须给同一个 key（如 `msg:group:975663147`）
 * @param {string} message 这一条的内容
 * @param {number} [windowMs] 合并窗口，默认 60 秒
 */
export function noteCoalesced(tag, key, message, windowMs = 60000) {
  const now = Date.now()
  const entry = coalesced.get(key)
  if (entry !== undefined) {
    const age = now - entry.at
    if (age >= 0 && age < Number(windowMs)) {
      entry.count += 1
      return
    }
    // 窗口已过：先把「这段时间压掉了多少条」补一行，再写这一条
    const suppressed = entry.count
    coalesced.delete(key)
    if (suppressed > 0) {
      note(tag, `（窗口内的同类日志另有 ${suppressed} 次未逐条记录）`)
    }
  }
  if (coalesced.size >= COALESCE_MAX_KEYS) coalesced.clear()
  coalesced.set(key, { at: now, count: 0 })
  note(tag, message)
}

/** 测试用：清空合并账本（否则上一个用例的计数会漏到下一个）。 */
export function resetCoalesce() {
  coalesced.clear()
}

/**
 * 写一条日志。出问题先看 qq-bridge-load.log。
 * 轮转用「截尾重写」：旧内容从中间截断，时间顺序不变，最近的日志永远在文件末尾。
 */
export function note(tag, message) {
  try {
    noteCount += 1
    if (noteCount % ROTATE_CHECK_EVERY === 0) {
      try {
        const size = statSync(LOAD_LOG).size
        if (size > LOG_ROTATE_BYTES) {
          const tail = readFileSync(LOAD_LOG).subarray(size - LOG_KEEP_BYTES)
          // 从第一个换行开始截，避免半行
          const nl = tail.indexOf(0x0a)
          writeFileSync(LOAD_LOG, nl >= 0 ? tail.subarray(nl + 1) : tail)
          appendFileSync(LOAD_LOG, `${new Date().toISOString()} [log] 已轮转：原 ${size} 字节，保留尾部 ${LOG_KEEP_BYTES}\n`, 'utf8')
        }
      } catch {
        /* 轮转失败不影响记日志 */
      }
    }
    appendFileSync(LOAD_LOG, `${new Date().toISOString()} [${tag}] ${message}\n`, 'utf8')
  } catch {
    /* 记日志失败不该制造新故障 */
  }
}

/**
 * 取宿主服务：DSH 里两套并存——注册过的服务走 ctx.get(name)，
 * 内建服务（tools、systemPrompt 等）是 ctx 上的属性，get 取不到。
 */
export function serviceOf(ctx, key) {
  if (typeof ctx.get === 'function') {
    const registered = ctx.get(key)
    if (registered !== undefined && registered !== null) return registered
  }
  return ctx[key]
}

/** Wait briefly for the built-in tool service, which may appear after apply. */
export async function waitForTools(ctx, toolName, signal, timeoutMs = 10000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs
  while (!signal?.aborted) {
    try {
      const tools = serviceOf(ctx, 'tools')
      if (tools !== undefined && tools !== null && typeof tools.register === 'function') {
        // 诊断流水：给 register 包一层，**一次覆盖全部工具**（2026-11-09，0.21.0）。
        //
        // 为什么包在这里而不是逐个改 execute：全仓库有 15 处 `tools.register(...)`，
        // 逐个改既容易漏，又会让「以后新增的工具默认不记录」—— 那种洞不会有人发现。
        // 这里是所有工具注册的**唯一入口**，包一层就自动覆盖现在和将来。
        //
        // ⚠️ 三条纪律：
        //   ① 在 register/execute 函数上用跨模块 Symbol 标记，避免服务代理换壳或热重载后套娃；
        //   ② 包装失败（宿主对象不可扩展、register 是只读属性…）一律**退回原样**，
        //      绝不让诊断能力把工具注册搞挂；
        //   ③ 只在真正拿到 tools 服务时包，返回的仍是同一个对象（引用不变），
        //      调用方不需要改任何代码。
        return wrapToolsForDiag(tools)
      }
    } catch {
      // The injected service may not be available yet.
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await new Promise((resolve) => {
      let timer
      const finish = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', finish)
        resolve()
      }
      timer = setTimeout(finish, Math.min(intervalMs, remaining))
      signal?.addEventListener('abort', finish, { once: true })
    })
  }
  if (!signal?.aborted) note('tool', `FAILED no tools service after ${timeoutMs}ms: ${toolName}`)
  return null
}

/** 函数随服务代理共享，Symbol.for 随模块重载共享；不能只标记 tools 外壳。 */
const DIAG_REGISTER = Symbol.for('dsh-onebot-channel.diag.register.v1')
const DIAG_EXECUTE = Symbol.for('dsh-onebot-channel.diag.execute.v1')

/**
 * 给 tools.register 包一层，把每次真实调用记录一次；不按时间或参数合并调用。
 * 包装/记录失败均退回主业务，保留 this、所有实参、同步返回和原异常。
 */
function wrapToolsForDiag(tools) {
  try {
    const original = tools.register
    if (typeof original !== 'function') return tools
    if (original[DIAG_REGISTER]) {
      original[DIAG_REGISTER].record = recordTool
      return tools
    }
    const diag = { record: recordTool }
    const wrapped = function register(...registerArgs) {
      try {
        const def = registerArgs[0]
        if (def !== null && typeof def === 'object' && typeof def.execute === 'function') {
          const inner = def.execute
          if (!inner[DIAG_EXECUTE]) {
            // 第二个参数携带 exec.agent.session，第三个及以后也必须原样透传。
            const execute = function executeWithDiag(...callArgs) {
              let identity = {}
              try {
                identity = { callId: randomUUID(), startedAt: Date.now() }
                const exec = callArgs[1]
                const session = exec?.agent?.session
                identity.sessionId = String(exec?.sessionId
                  ?? (typeof session === 'string' ? session : session?.header?.id ?? session?.id) ?? '')
              } catch { /* 取不到身份不影响调用 */ }
              const finish = (result, isError = false) => {
                try {
                  diag.record({
                    ...identity, tool: String(def.name ?? ''), args: callArgs[0],
                    result: isError ? (result instanceof Error ? result.message : String(result)) : result,
                    isError, durationMs: Date.now() - identity.startedAt
                  })
                } catch { /* 诊断异常绝不能替换业务结果或异常 */ }
              }
              let value
              try {
                value = inner.apply(this, callArgs)
              } catch (error) {
                finish(error, true)
                throw error
              }
              try {
                if (types.isPromise(value)) {
                  // 包含跨 realm 原生 Promise；不主动消费自定义 thenable（可能触发第二次业务）。
                  // 旁听而不替换原返回，且不依赖可被覆写的 value.then。
                  void Promise.prototype.then.call(value, result => finish(result), error => finish(error, true))
                } else {
                  finish(value)
                }
              } catch { /* 旁听失败也返回原值 */ }
              return value
            }
            Object.defineProperty(execute, DIAG_EXECUTE, { value: true })
            def.execute = execute
          }
        }
      } catch { /* 包不上就原样注册 */ }
      return original.apply(this, registerArgs)
    }
    Object.defineProperty(wrapped, DIAG_REGISTER, { value: diag })
    tools.register = wrapped
  } catch { /* 宿主服务只读时原样返回 */ }
  return tools
}
