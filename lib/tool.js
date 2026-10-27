/**
 * tool.js —— 注册 qq_send 工具（AI 在会话里就能主动发 QQ 消息）。
 */
import { note, serviceOf } from './env.js'
import { sendToQQ } from './outbound.js'

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
          '把一段纯文本发到 QQ。默认发给主人的私聊；传 user_id 发给指定好友，传 group_id 则发到对应群。回复从 QQ 转进来的消息时用它，正文直接写要说的话。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', description: '要发送的纯文本内容。' },
            user_id: { type: 'string', description: '可选；好友 QQ 号。发给某个人时必填，不填会落到默认私聊对象（主人本人）。' },
            group_id: { type: 'string', description: '可选；群号。留空表示私聊。' }
          },
          required: ['text']
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
          const result = await sendToQQ(target, String(args?.text ?? ''))
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
