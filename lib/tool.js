/**
 * tool.js —— 注册 qq_send 工具（AI 在会话里就能主动发 QQ 消息）。
 */
import { note, serviceOf } from './env.js'
import { sendToQQ } from './outbound.js'
import { faceSegmentOf, faceNameList } from './emoticons.js'
import { findCustomFace } from './custom-faces.js'

/** 工具描述里给 agent 看的常用表情清单（太长会稀释注意力，只列高频的）。 */
const COMMON_EMOJI = '呲牙、微笑、开心、大笑、笑哭、偷笑、憨笑、可爱、害羞、闭嘴、'
  + '流泪、大哭、难过、委屈、无语、白眼、傲慢、吐、困、惊讶、疑问、晕、'
  + 'OK、点赞、鼓掌、抱拳、比心、加油、庆祝、点赞、爱心、亲亲、无奈、拍桌、飞吻'

/** 注册 qq_send：不传 group_id 发私聊，传了就发群。 */
export async function registerSendTool(ctx) {
  try {
    const tools = serviceOf(ctx, 'tools')
    if (tools === undefined || tools === null || typeof tools.register !== 'function') return note('tool', 'no tools service')
    // 不 import @deepseek-ai/dsh-tools（解析不到），直接把工具对象交给 tools.register。
    // 注意：register 只认编译好的 JSON Schema，不是 defineTool 那套 DSL（required 写在属性里）。
    // 而且必须给 output.render，否则直接抛 must declare output。
    const disposeTool = tools.register(
      {
        name: 'qq_send',
        description:
          '把一段纯文本发到 QQ。默认发给用户本人的私聊；传 user_id 发给指定好友，传 group_id 则发到对应群。'
          + '回复从 QQ 转进来的消息时用它，正文直接写要说的话。'
          + '\n\n可以顺便发表情：传 emoji 参数（QQ 经典表情的中文名或编号），'
          + `表情会附在最后一句话的后面。常用表情：${COMMON_EMOJI}。`
          + '\n也可以传 custom_emoji 参数发收藏夹里的商城大表情（给关键词，如「猫」），'
          + '收藏表情在 QQ 上是单独一条消息，跟在文字后面。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', description: '要发送的纯文本内容。可以为空 —— 只发表情时不用填。' },
            emoji: { type: 'string', description: `可选；QQ 经典表情。给中文名（如「呲牙」）或编号（如 13）。常用：${COMMON_EMOJI}。` },
            custom_emoji: { type: 'string', description: '可选；收藏夹里的商城大表情，给关键词或表情名（如「猫」）。会作为单独一条消息发出去。' },
            user_id: { type: 'string', description: '可选；好友 QQ 号。发给某个人时必填，不填会落到默认私聊对象（用户本人）。' },
            group_id: { type: 'string', description: '可选；群号。留空表示私聊。' }
          }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { message_id: { type: 'number' } },
            required: ['message_id']
          },
          render: (args, value) => [
            { type: 'text', text: `已发到 QQ，message_id=${Number(value?.message_id ?? 0)}` }
          ]
        },
        execute: async (args) => {
          const groupId = String(args?.group_id ?? '').trim()
          const userId = String(args?.user_id ?? '').trim()
          // 群优先：传了 group_id 就发群；否则私聊走 user_id，没给才退化到默认私聊对象
          const target = groupId !== ''
            ? { kind: 'group', id: groupId }
            : (userId !== '' ? { kind: 'private', id: userId } : { kind: 'private' })

          const text = String(args?.text ?? '')
          const emojiName = String(args?.emoji ?? '').trim()
          const customEmojiName = String(args?.custom_emoji ?? '').trim()

          // 经典表情：中文名/编号 → face 段。认不出来直接抛错，别发空表情。
          const faceSegment = emojiName !== '' ? faceSegmentOf(emojiName) : null

          // 收藏表情：关键词 → emoji_id。收藏夹是空的或没匹配到就报清楚，别静默吞掉。
          let customEmojiId = ''
          if (customEmojiName !== '') {
            const found = await findCustomFace(customEmojiName)
            if (found === null) {
              throw new Error(
                `收藏夹里没找到含「${customEmojiName}」的表情。`
                + '（收藏夹可能是空的 —— 需要先在 QQ 里收藏表情包；也可以改用 emoji 参数发经典小表情）'
              )
            }
            customEmojiId = found.emojiId
          }

          const result = await sendToQQ(target, text, { faceSegment, customEmojiId })
          return { message_id: Number(result?.data?.message_id ?? 0) }
        }
      }
    )
    if (typeof disposeTool === 'function') ctx.effect(() => disposeTool, 'dsh-onebot-channel: qq_send tool')
    note('tool', 'qq_send registered')
  } catch (error) {
    note('tool', `register failed: ${error instanceof Error ? error.message : error}`)
  }
}

/** 全部经典表情名清单，给别处（比如提示词）用。 */
export { faceNameList }
