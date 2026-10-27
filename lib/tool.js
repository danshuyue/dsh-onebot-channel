/**
 * tool.js —— 注册 qq_send 工具（AI 在会话里就能主动发 QQ 消息）。
 */
import { note, serviceOf } from './env.js'
import { sendToQQ } from './outbound.js'
import { faceNameList } from './emoticons.js'
import { resolveFaceIdSafe } from './face-resolve.js'
import { findCustomFace } from './custom-faces.js'
import { searchSysFaces, fetchSysFacePacks } from './sys-faces.js'
import { getHistory } from './history.js'
import { sendQzoneMsg, QZONE_VISIBILITY } from './qzone.js'
import { collectFace, recentList } from './collect.js'

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
          // 反查顺序：QQ 官方表情目录优先，内置表兜底（resolveFaceSegment 内部处理）。
          // 经典表情：中文名/编号 → face 段。
          // 反查顺序：QQ 官方表情目录优先，内置表兜底（resolveFaceSegment 内部处理）。
          //
          // ⚠️ 用安全版：表情解析不出来就**跳过这个表情**，不抛错。
          //   协议端遇到无效 face id 会把整条消息搞没（OIDB 报错），
          //   所以宁可少发一个表情，也不能让文字发不出去。
          let faceSegment = null
          if (emojiName !== '') {
            const id = await resolveFaceIdSafe(emojiName)
            if (id === null) {
              note('tool', `表情「${emojiName}」发不出去（无效编号），已跳过，只发文字`)
            } else {
              faceSegment = { type: 'face', data: { id: String(id) } }
            }
          }

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

/**
 * 注册 qq_emoji_search —— 查 QQ 官方表情目录。
 *
 * 为什么要单独给 agent 一个搜索工具：
 *   内置表只有 0~348，且名字是社区习惯叫法（"呲牙""憨笑"），
 *   官方目录是 QQ 自己的一套（含新表情、官方写法）。
 *   agent 想发表情但不确定叫什么/id 时，先搜一下最靠谱。
 */
export async function registerEmojiSearchTool(ctx) {
  try {
    const tools = serviceOf(ctx, 'tools')
    if (tools === undefined || tools === null || typeof tools.register !== 'function') return note('tool', 'no tools service')
    const disposeTool = tools.register({
      name: 'qq_emoji_search',
      description:
        '搜索 QQ 官方系统表情，返回表情编号（q_sid）和名字。'
        + '发经典小表情时如果不确定表情叫什么或编号是多少，先用这个查。'
        + '也可以传 all=true 列出全部官方表情目录（按表情包分组）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '要搜的表情名，如「比心」「打call」。留空且 all=true 时列出全部。' },
          all: { type: 'boolean', description: '可选；true 时列出全部官方表情目录（内容较多，约 400 条）。' }
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            faces: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: { id: { type: 'number' }, name: { type: 'string' } }
              }
            },
            packs: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  packName: { type: 'string' },
                  count: { type: 'number' }
                }
              }
            }
          }
        },
        render: (args, value) => {
          const faces = Array.isArray(value?.faces) ? value.faces : []
          const packs = Array.isArray(value?.packs) ? value.packs : []
          if (packs.length > 0) {
            const lines = packs.map((p) => `- ${p.packName}（${p.count} 个）`)
            return [{ type: 'text', text: `官方表情目录：\n${lines.join('\n')}` }]
          }
          if (faces.length === 0) return [{ type: 'text', text: '没找到匹配的表情。' }]
          const lines = faces.map((f) => `- ${f.name}（编号 ${f.id}）`)
          return [{ type: 'text', text: `找到 ${faces.length} 个表情：\n${lines.join('\n')}` }]
        }
      },
      execute: async (args) => {
        const wantAll = args?.all === true
        const query = String(args?.query ?? '').trim()
        if (wantAll && query === '') {
          const packs = await fetchSysFacePacks()
          return {
            packs: packs.map((pack) => ({ packName: pack.packName, count: pack.faces.length })),
            faces: []
          }
        }
        const list = await searchSysFaces(query, 30)
        return {
          faces: list.map((item) => ({ id: Number(item.id), name: item.name })),
          packs: []
        }
      }
    })
    if (typeof disposeTool === 'function') ctx.effect(() => disposeTool, 'dsh-onebot-channel: qq_emoji_search tool')
    note('tool', 'qq_emoji_search registered')
  } catch (error) {
    note('tool', `qq_emoji_search register failed: ${error instanceof Error ? error.message : error}`)
  }
}

/**
 * 注册 qq_msg_history —— 查历史消息。
 *
 * 范围：只读历史。没有群信息检索、没有撤回、没有表情回应（C 档，用户明确排除）。
 */
export async function registerHistoryTool(ctx) {
  try {
    const tools = serviceOf(ctx, 'tools')
    if (tools === undefined || tools === null || typeof tools.register !== 'function') return note('tool', 'no tools service')
    const disposeTool = tools.register({
      name: 'qq_msg_history',
      description:
        '查 QQ 的历史消息。传 group_id 查某个群的历史，传 user_id 查某个好友的私聊历史。'
        + '默认取最近 20 条。可以用 before_message_id 指定从哪条之后往前翻。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          group_id: { type: 'string', description: '可选；群号。查群历史时填。' },
          user_id: { type: 'string', description: '可选；好友 QQ 号。查私聊历史时填。' },
          count: { type: 'number', description: '可选；要几条，默认 20，上限 100。' },
          before_message_id: { type: 'number', description: '可选；锚点，从这条消息之前往前翻。默认 0 表示取最新。' }
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            count: { type: 'number' },
            messages: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  time: { type: 'number' },
                  nickname: { type: 'string' },
                  text: { type: 'string' }
                }
              }
            }
          },
          required: ['count', 'messages']
        },
        render: (args, value) => {
          const list = Array.isArray(value?.messages) ? value.messages : []
          if (list.length === 0) return [{ type: 'text', text: '没查到历史消息。' }]
          const lines = list.map(
            (m) => `[${new Date(Number(m.time ?? 0) * 1000).toLocaleString('zh-CN')}] ${m.nickname}：${m.text}`
          )
          return [{ type: 'text', text: `查到 ${list.length} 条：\n${lines.join('\n')}` }]
        }
      },
      execute: async (args) => {
        const groupId = String(args?.group_id ?? '').trim()
        const userId = String(args?.user_id ?? '').trim()
        if (groupId === '' && userId === '') throw new Error('要查历史，得给 group_id（查群）或 user_id（查好友）')
        const target = groupId !== '' ? { kind: 'group', id: groupId } : { kind: 'private', id: userId }
        const list = await getHistory(target, Number(args?.count ?? 20) || 20, Number(args?.before_message_id ?? 0) || 0)
        return {
          count: list.length,
          messages: list.map((item) => ({
            time: item.time,
            nickname: item.nickname || item.card || item.userId,
            text: item.text
          }))
        }
      }
    })
    if (typeof disposeTool === 'function') ctx.effect(() => disposeTool, 'dsh-onebot-channel: qq_msg_history tool')
    note('tool', 'qq_msg_history registered')
  } catch (error) {
    note('tool', `qq_msg_history register failed: ${error instanceof Error ? error.message : error}`)
  }
}

/**
 * 注册 qq_qzone_post —— 发表 QQ 空间说说。
 *
 * ⚠️ 这是对外发布：发出去别人就看得到，而且**删说说的接口已被封禁**（C 档），
 *   所以发之前必须有明确的用户指令，不能凭猜测发。
 */
export async function registerQzoneTool(ctx) {
  try {
    const tools = serviceOf(ctx, 'tools')
    if (tools === undefined || tools === null || typeof tools.register !== 'function') return note('tool', 'no tools service')
    const rights = Object.entries(QZONE_VISIBILITY).map(([k, v]) => `${k}=${v}`).join('，')
    const disposeTool = tools.register({
      name: 'qq_qzone_post',
      description:
        '在自己的 QQ 空间发表一条说说（动态）。这是对外发布动作，发出去所有人都能看到，'
        + '而且插件不提供删除说说的能力（已封禁），所以只在用户明确要求「发说说」时才用。'
        + `\n可见性参数 visibility：${rights}。默认 1（所有人可见）。`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string', description: '要发表的正文，不能为空。' },
          visibility: { type: 'number', description: `可选；可见性。${rights}。默认 1。` },
          target_uins: {
            type: 'array',
            items: { type: 'number' },
            description: '可选；指定好友可见（visibility=64）时的好友 QQ 号列表。'
          }
        },
        required: ['content']
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean' }, detail: { type: 'string' } }
        },
        render: (args, value) => [
          { type: 'text', text: value?.ok === true ? '说说已发布。' : `说说发布失败：${value?.detail ?? '未知原因'}` }
        ]
      },
      execute: async (args) => {
        const result = await sendQzoneMsg({
          content: String(args?.content ?? ''),
          visibility: Number(args?.visibility ?? 1),
          targetUins: Array.isArray(args?.target_uins) ? args.target_uins : []
        })
        return { ok: true, detail: JSON.stringify(result?.data ?? {}).slice(0, 200) }
      }
    })
    if (typeof disposeTool === 'function') ctx.effect(() => disposeTool, 'dsh-onebot-channel: qq_qzone_post tool')
    note('tool', 'qq_qzone_post registered')
  } catch (error) {
    note('tool', `qq_qzone_post register failed: ${error instanceof Error ? error.message : error}`)
  }
}

/**
 * 注册 qq_collect_face —— 把收到的表情包存进 QQ 收藏夹。
 *
 * 为什么需要（2026-10-27）：树树在教 DSH 认表情包。
 *   协议端**没有**「收到图片自动收藏」的逻辑，收藏夹必须显式写入才有东西 ——
 *   不写的话，custom_emoji（发收藏表情）那条路永远是空的。
 *
 * 受控设计：不暴露裸 action，只允许「收藏插件自己收到过的图」或「给一个本地路径」。
 */
export async function registerCollectTool(ctx) {
  try {
    const tools = serviceOf(ctx, 'tools')
    if (tools === undefined || tools === null || typeof tools.register !== 'function') return note('tool', 'no tools service')
    const disposeTool = tools.register({
      name: 'qq_collect_face',
      description:
        '把一张表情包图片存进 QQ 收藏夹（QQ 自己的表情收藏列表）。'
        + '收到对方发来的表情包后调用它，就能把那张图存起来，以后可以用 custom_emoji 发出去。'
        + '\n\n两种给法：'
        + '\n- recent=1（默认）：收藏最近收到的那张图；recent=2 是倒数第二张，以此类推'
        + '\n- file=：直接给本地文件路径或 http(s) 图片直链'
        + '\n\n存之前可以先调 list=true 看看最近收到哪些图。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          recent: { type: 'number', description: '可选；收藏最近收到的第几张图，1 = 最近一张。默认 1。' },
          file: { type: 'string', description: '可选；本地文件路径或 http(s) 图片直链。跟 recent 二选一。' },
          desc: { type: 'string', description: '可选；给这个表情起个名字（备注）。起了名以后才能按名字找它。' },
          list: { type: 'boolean', description: '可选；true 时只列出最近收到的图片，不执行收藏。' }
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            emoji_id: { type: 'string' },
            origin: { type: 'string' },
            recent: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  index: { type: 'number' },
                  name: { type: 'string' },
                  uin: { type: 'string' }
                }
              }
            }
          }
        },
        render: (args, value) => {
          const list = Array.isArray(value?.recent) ? value.recent : []
          if (list.length > 0) {
            const lines = list.map((r) => `- #${r.index} ${r.name}（来自 QQ ${r.uin}）`)
            return [{ type: 'text', text: `最近收到的图片：\n${lines.join('\n')}` }]
          }
          return [
            {
              type: 'text',
              text: value?.ok === true
                ? `已存进收藏夹，emoji_id=${value?.emoji_id ?? ''}`
                : `收藏失败：${value?.emoji_id ?? '未知原因'}`
            }
          ]
        }
      },
      execute: async (args) => {
        if (args?.list === true) {
          const recent = recentList(10)
          return {
            ok: true,
            emoji_id: '',
            origin: '',
            recent: recent.map((item) => ({ index: item.index, name: item.name, uin: item.uin }))
          }
        }
        const result = await collectFace({ file: args?.file, recent: Number(args?.recent ?? 1), desc: args?.desc })
        return {
          ok: true,
          emoji_id: result.emojiId,
          origin: result.origin,
          recent: []
        }
      }
    })
    if (typeof disposeTool === 'function') ctx.effect(() => disposeTool, 'dsh-onebot-channel: qq_collect_face tool')
    note('tool', 'qq_collect_face registered')
  } catch (error) {
    note('tool', `qq_collect_face register failed: ${error instanceof Error ? error.message : error}`)
  }
}

/** 全部经典表情名清单，给别处（比如提示词）用。 */
export { faceNameList }
