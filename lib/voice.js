/**
 * voice.js —— 语音转文字（走 SnowLuma 的 fetch_ptt_text）。
 *
 * 为什么是「工具」而不是「入站自动转写」（2026-11-04 实测定的）：
 *   fetch_ptt_text 是**同步等结果**的接口，内部要等 QQ 服务端推送，
 *   转不出来时每条要卡满 20 秒才返回失败（实测：真人语音 109ms 成功，
 *   转不出来的那条 20s 超时 × 无数次）。而入站投递是一条**串行链**
 *   （forwardTimeoutMs 那次踩的就是这个坑），一条语音就能把整个群的投递停摆。
 *   所以做成按需工具：模型看见 [语音] 想听再调，没兴趣就不花这笔钱。
 *
 * ⚠️ 实测出来的两个边界（别当成 bug 去修）：
 *   1. **机器人自己发的语音永远转不出来**（error=9 / error=4294966146 / 超时）。
 *      别拿自造样本测这条链路，只会得到假的「坏了」结论。
 *   2. 真人刚发的语音可能前几秒还转不出来，过一会儿再调就好了。
 *      所以失败不是「这条语音没内容」，只是「这次没转出来」——文案必须这么说。
 */
import { callOneBot } from './onebot.js'
import { note } from './env.js'

/**
 * 等多久算超时。
 *
 * SnowLuma 自己内部等 15 秒才判「未收到结果推送」，返回又花了 20 秒，
 * 所以这里的超时**必须**比它长，否则会同时出现两个超时、日志里分不清是谁断的。
 * 25 秒 = 它那 20 秒 + 余量。
 */
export const VOICE_TIMEOUT_MS = 25000

/** message_id 只认整数串（可负）。负数在 SnowLuma 是合法的，别 Number 往返。 */
export function isValidMessageId(value) {
  const text = String(value ?? '').trim()
  return /^-?\d+$/.test(text) && text !== '0' && text !== '-0'
}

/**
 * 把一条语音消息转成文字。
 *
 * @param {string|number} messageId 消息编号（正文里的 [#数字]）
 * @returns {Promise<{ok:true, text:string} | {ok:false, error:string}>}
 *   失败**不抛**：调用方是工具，要把原因原样说给模型听，
 *   抛错会被宿主翻成一条没有上下文的 ToolError。
 */
export async function transcribeVoice(messageId) {
  const raw = String(messageId ?? '').trim()
  if (!isValidMessageId(raw)) return { ok: false, error: `message_id 不合法：${raw === '' ? '（空）' : raw}` }

  let result
  try {
    result = await callOneBot({
      action: 'fetch_ptt_text',
      // 必须是数字：协议端 schema 标的是 integer，字符串会被判参数错误
      params: { message_id: Number(raw) },
      timeoutMs: VOICE_TIMEOUT_MS
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    note('voice', `fetch_ptt_text 调用失败 id=${raw}：${message}`)
    return { ok: false, error: `协议端没响应（${message}）` }
  }

  if (result?.retcode !== 0) {
    const why = String(result?.wording ?? result?.message ?? '').trim()
    note('voice', `fetch_ptt_text 失败 id=${raw} retcode=${result?.retcode ?? '?'} ${why}`)
    return { ok: false, error: why === '' ? `retcode=${result?.retcode ?? '?'}` : why }
  }

  const text = String(result?.data?.text ?? '').trim()
  if (text === '') {
    note('voice', `fetch_ptt_text 成功但没文字 id=${raw}`)
    return { ok: false, error: '协议端返回了空文本（这条可能没人说话或太短）' }
  }
  note('voice', `转写成功 id=${raw} ${text.length} 字`)
  return { ok: true, text }
}
