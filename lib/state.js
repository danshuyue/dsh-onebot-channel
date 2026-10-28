/**
 * state.js —— 轮询游标的持久化。
 *
 * 模块持有单例 state；saveState(patch) 合并后全量写文件。
 * 写盘点说明：游标推进必须立即落盘（进程崩了不能重投/漏投），
 * 但「心跳」类的字段（lastSeenAt / lastError / privateMaxSeq）由调用方节流，
 * 别每轮轮询都写（原来是每分钟约 60 次同步写盘，纯浪费）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { STATE_FILE } from './env.js'
import { note } from './env.js'
import { getConfig } from './config.js'

let state = { lastId: 0, groups: {}, privates: {} }

export function getState() {
  return state
}

/**
 * 读入并自洁游标文件。
 *
 * 自洁：监听集合之外的群/私聊，游标留着没用，还会让人误以为在监听（测试遗留就是这么来的）。
 * 注意要跟「实际监听集合」一致：groupUins ∪ routes.group、peerUin ∪ routes.private，
 * 不然绑了群的游标每次重启都会被丢。
 *
 * 私聊游标按 QQ 号一人一份（privates[uin]）：多私聊之前游标只有一份（写在顶层 lastSeq），
 * 几个人共用会把彼此的位置踩掉。旧顶层游标是 peerUin 的，加载时搬过去，
 * 否则一升级就把他的历史重投一遍。
 *
 * seenIds：最近处理过的 message_id 列表（去重用）。
 * WS 推送和 HTTP 轮询可能同时看到同一条消息；OneBot 的 message_id 可能是负数，
 * 比大小不可靠，但「是否相等」是可靠的 —— 所以拿它做去重键。
 */
export function loadState() {
  try {
    if (existsSync(STATE_FILE)) {
      const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
      const config = getConfig()
      const groups = raw.groups !== null && typeof raw.groups === 'object' ? raw.groups : {}
      const keep = new Set()
      for (const value of config.groupUins ?? []) keep.add(String(value))
      for (const id of Object.keys(config.routes?.group ?? {})) keep.add(String(id))
      const pruned = {}
      for (const id of Object.keys(groups)) {
        if (keep.has(String(id))) pruned[id] = groups[id]
        else note('state', `丢弃不在 groupUins 里的群游标 ${id}`)
      }

      const privatesRaw = raw.privates !== null && typeof raw.privates === 'object' ? raw.privates : {}
      const keepPeers = new Set()
      if (Number(config.peerUin) > 0) keepPeers.add(String(config.peerUin))
      for (const id of Object.keys(config.routes?.private ?? {})) keepPeers.add(String(id))
      const prunedPeers = {}
      for (const id of Object.keys(privatesRaw)) {
        if (keepPeers.has(String(id))) prunedPeers[id] = privatesRaw[id]
        else note('state', `丢弃不在监听列表里的私聊游标 ${id}`)
      }
      if (Number(config.peerUin) > 0) {
        const peerKey = String(config.peerUin)
        if (prunedPeers[peerKey] === undefined && Number.isFinite(Number(raw.lastSeq))) {
          // ⚠️ lastTime 必须留成 undefined，不能写成 0：
          //   私聊的游标判断靠 lastTime（seq 因为两套编号混着已不可用），
          //   lastTime=0 会被当成「有个游标」，导致新消息全被当成旧消息丢掉。
          //   旧单路由时代只有 seq、没有时间戳，所以这里只能是 undefined，
          //   让轮询那边按「首次运行」重新播种。
          const migratedTime = Number(raw.lastTime)
          prunedPeers[peerKey] = {
            lastSeq: Number(raw.lastSeq),
            lastTime: Number.isFinite(migratedTime) && migratedTime > 0 ? migratedTime : undefined,
            lastId: Number(raw.lastId) || 0
          }
          note('state', `迁移顶层私聊游标到 privates[${peerKey}] seq=${raw.lastSeq}`)
        }
      }

      state = {
        lastId: Number(raw.lastId) || 0,
        lastSeq: Number.isFinite(Number(raw.lastSeq)) ? Number(raw.lastSeq) : undefined,
        lastTime: Number(raw.lastTime) || 0,
        privates: prunedPeers,
        groups: pruned
      }
      // seenIds 自洁：去掉重复项（老版本可能把同一个 id 记了多次），
      // 顺便裁掉超长的（上限跟 poll.js 的 SEEN_LIMIT 一致）
      for (const bucket of [...Object.values(state.privates), ...Object.values(state.groups)]) {
        if (!Array.isArray(bucket.seenIds)) continue
        const unique = [...new Set(bucket.seenIds.map((value) => Number(value)).filter((value) => Number.isFinite(value)))]
        bucket.seenIds = unique.slice(-100)
      }
    }
  } catch (error) {
    note('state', `read failed ${error instanceof Error ? error.message : error}`)
  }
  return state
}

export function saveState(patch) {
  Object.assign(state, patch)
  try {
    writeFileSync(STATE_FILE, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2), 'utf8')
  } catch (error) {
    note('state', `write failed ${error instanceof Error ? error.message : error}`)
  }
}
