/**
 * onebot.js —— OneBot HTTP 调用 + 消息段解析。
 */
import { getConfig } from './config.js'
import { note } from './env.js'
import { emojiTextOf } from './emoticons.js'
import { assertNotBlocked } from './blocked.js'
import { assertSendAllowed } from './allowlist.js'

export async function callOneBot(payload) {
  const config = getConfig()
  // 封禁检查放在最前面，在发 HTTP 之前 —— 这是所有协议端调用的唯一出口，
  // 放这里才能保证「不管谁调、调几次」都绕不过去。
  assertNotBlocked(payload?.action)
  // 出站目标白名单，同样挂在唯一出口上（2026-10-28）：
  //   qq_send 的 user_id / group_id 是 agent 随便填的，只有在这一层拦，
  //   才能覆盖 qq_send / 自动转发 / sendapi / 收藏表情所有路径。
  //   不合法直接抛错 → 上层翻成工具错误给 agent 看，HTTP 根本不会发出去。
  assertSendAllowed(payload?.action, payload?.params)
  // 必须带超时：SnowLuma 的历史接口会突然挂死（实测 >20 秒不回），
  // 没有超时的话轮询会永久卡在这一句，后面永远不再拉消息。
  const timeoutMs = Math.max(1000, Number(config.requestTimeoutMs) || 8000)
  const response = await fetch(config.onebotHttp, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!response.ok) throw new Error(`OneBot HTTP ${response.status}`)
  return await response.json()
}

/** 拉好友或群列表（拿昵称/群名，用于 UI 显示和自动命名）。 */
export async function oneBotList(action, idKey, nameKey) {
  try {
    const result = await callOneBot({ action })
    if (result?.retcode !== 0) return []
    return (result.data ?? [])
      .map((item) => ({ id: String(item?.[idKey] ?? ''), name: String(item?.[nameKey] ?? '') }))
      .filter((item) => item.id !== '')
  } catch (error) {
    note('api', `${action} failed: ${error instanceof Error ? error.message : error}`)
    return []
  }
}

/**
 * 没专门处理的段类型，给个中文标签。
 * 直接渲染原始类型名（[forward]、[record]）的话，agent 看到的是协议字段不是人话；
 * 但也别瞎猜内容 —— 只做类型翻译，内容一概不展开。
 */
const SEGMENT_LABELS = {
  forward: '[转发消息]',
  record: '[语音]',
  video: '[视频]',
  file: '[文件]',
  location: '[位置]',
  json: '[卡片消息]',
  xml: '[卡片消息]',
  share: '[分享链接]',
  contact: '[名片]',
  music: '[音乐]',
  poke: '[戳一戳]',
  gift: '[礼物]',
  markdown: '',
  node: '',
  grayTip: ''
}

function segmentTypeName(type) {
  const key = String(type ?? '')
  if (key === '') return '[未知段]'
  if (key in SEGMENT_LABELS) return SEGMENT_LABELS[key]
  return `[${key}]`
}

/** message 段数组 → 纯文本；@ 保留成 @qq，方便我在会话里看出是谁被叫。 */
export function textOf(message) {
  if (typeof message === 'string') return message
  if (!Array.isArray(message)) return ''
  return message
    .map((segment) => {
      switch (segment?.type) {
        case 'text':
          return String(segment?.data?.text ?? '')
        case 'at': {
          const qq = String(segment?.data?.qq ?? '')
          return qq === 'all' ? '@全体成员' : `@${qq}`
        }
        case 'image':
          return '[图片]'
        case 'face':
        case 'mface':
          // 表情交给 emoticons.js 渲染：经典表情查中文名，商城大表情报 summary。
          // 不在 switch 里直接写死，是因为 mface 的字段名和 face 完全不同。
          return emojiTextOf(segment)
        case 'reply':
          return ''
        default:
          return segmentTypeName(segment?.type)
      }
    })
    .join('')
    .trim()
}

/** 这条群消息有没有 @ 到本号。 */
export function isAtMe(message, selfUin) {
  if (!Array.isArray(message)) return false
  return message.some((segment) => segment?.type === 'at' && String(segment?.data?.qq ?? '') === String(selfUin))
}

export function seqOf(message) {
  const value = Number(message?.message_seq)
  return Number.isFinite(value) ? value : null
}

export function timeOf(message) {
  return Number(message?.time) || 0
}
