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

export const DATA_DIR = join(homedir(), '.dsh')
export const CONFIG_FILE = join(DATA_DIR, 'qq-bridge.config.json')
export const STATE_FILE = join(DATA_DIR, 'qq-bridge-state.json')
export const LOAD_LOG = join(DATA_DIR, 'qq-bridge-load.log')

/** 日志轮转阈值：超过 2 MB 时保留尾部 256 KB，防止无限增长。 */
const LOG_ROTATE_BYTES = 2 * 1024 * 1024
const LOG_KEEP_BYTES = 256 * 1024
/** 每 256 条 note 查一次大小：note 是事件驱动的低频路径，查太频也没意义。 */
const ROTATE_CHECK_EVERY = 256
let noteCount = 0

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
