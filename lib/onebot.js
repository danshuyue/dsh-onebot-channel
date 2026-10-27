/**
 * onebot.js —— OneBot HTTP 调用 + 消息段解析。
 */
import { getConfig } from './config.js'
import { note } from './env.js'

export async function callOneBot(payload) {
  const config = getConfig()
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
          return '[表情]'
        case 'reply':
          return ''
        default:
          return `[${segment?.type ?? '未知段'}]`
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
