/**
 * instance.js —— 单实例锁（防止两套收发循环同时跑）。
 *
 * 为什么需要（2026-10-28）：
 *   插件本身是 in-process 的，正常情况下 DSH 只有一个进程。但现实里有两种多实例场景：
 *
 *   ① **开了两个 DSH**（不同 workspace 各开一个）→ 两个进程各加载一份插件，
 *      各跑一套轮询和 WS，共享同一个 `qq-bridge-state.json`；
 *   ② **插件热重载没停干净**（旧 apply 的循环还在跑，新 apply 又起一套）。
 *
 *   两者后果一样，而且都很难查：
 *     · 两个循环同时写游标文件 → 后写的覆盖先写的，游标会来回跳，消息重复投递；
 *     · 同一条 QQ 消息被投进两个会话 → agent 被问两遍，回复发两遍；
 *     · WS 两条连接 → OneBot 侧看起来正常，插件侧 seenIds 各自独立。
 *
 *   所以抢一把锁：只有抢到的实例启动收发，其它实例只注册工具和设置页
 *   （出站能力照常可用，人能通过设置页改配置），并在日志里说清楚发生了什么。
 *
 * 锁的健壮性：
 *   · 锁文件里存 pid。启动时用 `process.kill(pid, 0)` 探活 ——
 *     上一个 DSH 崩溃留下的残锁会被自动抢占，不需要人工删文件。
 *   · 只认 pid，不认启动时间：Windows 上 pid 复用概率很低，且这里只影响
 *     「要不要启动收发」，抢错了顶多是降级成只出站模式，重启就好。
 */
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR, note } from './env.js'

const LOCK_FILE = join(DATA_DIR, 'qq-bridge-instance.lock')

/** pid 还活着吗（Windows / POSIX 都能用）。 */
function pidAlive(pid) {
  const num = Number(pid)
  if (!Number.isSafeInteger(num) || num <= 0) return false
  try {
    // signal 0 = 只探活，不真的发信号
    process.kill(num, 0)
    return true
  } catch (error) {
    // EPERM = 进程存在但没权限（Windows 上常见）→ 仍算活着
    return error?.code === 'EPERM'
  }
}

/** 读锁文件（坏文件当没有）。 */
function readLock() {
  try {
    if (!existsSync(LOCK_FILE)) return null
    const data = JSON.parse(readFileSync(LOCK_FILE, 'utf8'))
    return {
      pid: Number(data?.pid ?? 0),
      at: String(data?.at ?? ''),
      version: String(data?.version ?? '')
    }
  } catch {
    return null
  }
}

/**
 * 抢实例锁。
 *
 * @returns {{ok:true} | {ok:false, otherPid:number, at:string}}
 */
export function acquireInstanceLock() {
  const me = process.pid
  const existing = readLock()

  if (existing !== null && existing.pid !== me && pidAlive(existing.pid)) {
    return { ok: false, otherPid: existing.pid, at: existing.at }
  }
  if (existing !== null && existing.pid !== me && !pidAlive(existing.pid)) {
    note('instance', `发现残留锁（pid=${existing.pid} 已退出，${existing.at}），抢占`)
  }

  try {
    writeFileSync(LOCK_FILE, JSON.stringify({ pid: me, at: new Date().toISOString() }, null, 2), 'utf8')
    return { ok: true }
  } catch (error) {
    // 写不了锁文件（权限/磁盘满）不该阻断插件 —— 降级成「当自己拿到了」
    note('instance', `锁文件写入失败（${error instanceof Error ? error.message : error}），跳过单实例检查`)
    return { ok: true }
  }
}

/** 释放自己那把锁（不是自己的锁不动，避免误删别人的）。 */
export function releaseInstanceLock() {
  const existing = readLock()
  if (existing === null) return
  if (existing.pid !== process.pid) return
  try {
    rmSync(LOCK_FILE, { force: true })
  } catch {
    /* 删不掉不算错误 */
  }
}

/** 当前锁的持有者（排障用）。 */
export function lockHolder() {
  return readLock()
}
