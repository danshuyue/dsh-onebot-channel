/**
 * tool.js —— 注册 qq_send 工具（AI 在会话里就能主动发 QQ 消息）。
 */
import { note, serviceOf } from './env.js'
import { getConfig } from './config.js'
import { sendToQQ } from './outbound.js'
import { targetKey, suppress, clampLimit, recentDelivery } from './rhythm.js'
import { remember, loadMemory } from './memory.js'
import { assessClosure, describeClosure, saveClosing } from './closure.js'
import { faceNameList } from './emoticons.js'
import { resolveFaceIdSafe } from './face-resolve.js'
import { findCustomFace } from './custom-faces.js'
import { searchSysFaces, fetchSysFacePacks } from './sys-faces.js'
import { getHistory } from './history.js'
import { sendQzoneMsg, QZONE_VISIBILITY } from './qzone.js'
import { collectFace, recentList, listImageDir, deleteCustomFace } from './collect.js'
import { pickPreviews, attachPreviews } from './preview.js'
import { listCustomFaces } from './custom-faces.js'

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
          '开口说话 —— 这是你在 QQ 上唯一出声的地方，text 里直接写你想说的话，'
          + '默认发给用户本人的私聊；传 user_id 发给本人之外的好友，传 group_id 则发到群里。'
          + '\n\n你不一定非得开口。下面三种「不说」都是完整、体面的回合结局：'
          + '\n· 没话接、不想接 —— 什么都不调用就行，别凑一句场面话，也别解释你为什么沉默。'
          + '\n· 对方明显还没说完（「我跟你说」「等下」「还有」）—— 先 qq_wait 等完再决定。'
          + '\n· 这段聊到头了 —— 用 qq_pass 划走，对方不会看到任何东西。'
          + '\n反过来：**只有调了这个工具，消息才会出去**。你自言自语的正文永远停在会话里。'
          + '\n\n⚠️ 只能发给「插件正在服务的对象」（已绑定的好友/群 + 用户本人）。'
          + '发给范围外的号会被拒绝 —— 这是硬闸，不是靠你自觉。被拒就说明这个号没被放过，'
          + '不要换个写法重试，直接告诉用户「这个目标不在允许范围内」。'
          + '\n\n想自己决定分几条，就传 segments —— 每个元素发成一条独立消息、按顺序发出，'
          + '中间带真人式的停顿。不传就按句末标点自动切。'
          + '\n\n可以顺便发表情：传 emoji 参数（QQ 经典表情的中文名或编号），'
          + `表情会附在最后一句话的后面。常用表情：${COMMON_EMOJI}。`
          + '\n也可以传 custom_emoji 参数发收藏夹里的商城大表情（给关键词，如「猫」），'
          + '收藏表情在 QQ 上是单独一条消息，跟在文字后面。'
          + '\n\n正文里直接写 [表情:呲牙] 这样的标记也行（中文名或编号，如 [表情:OK]、[表情:13]），'
          + '会自动变成真表情、标记本身不会出现在 QQ 上，一个或多个都行，'
          + '表情会附在它前面那句话的后面。不确定表情叫什么就先调 qq_emoji_search 查一下。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', description: '要发送的纯文本内容。可以为空 —— 只发表情时不用填。' },
            segments: {
              type: 'array',
              items: { type: 'string' },
              description: '可选；自己决定的分段：每个元素发成一条独立消息，按顺序发出并带停顿。'
                + '给这个参数时 text 被忽略。想一句话分三条就写三个元素。'
            },
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
          const segments = Array.isArray(args?.segments)
            ? args.segments.map((item) => String(item ?? ''))
            : []
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

          const result = await sendToQQ(target, text, { faceSegment, customEmojiId, segments })
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
          '想想手头有哪些表情能用 —— 搜 QQ 官方系统表情，返回表情编号和名字。'
          + '不确定的时候才查；脑子里已经有就直接用，别为了查而查。'
          + '也可以传 all=true 把整套官方表情目录翻一遍（按表情包分组，约 400 条，会比较长）。',
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
 * 注册 qq_face_preview —— **看**「收到的图片」里的表情包。
 *
 * 为什么需要（2026-10-27）：
 *   树树在教 DSH 认表情包，QQ 发过来的表情包文件名全是 MD5 哈希，没法直接起名。
 *   但收藏进 QQ 收藏夹要写备注（desc），备注才是以后按名字找回它的唯一线索。
 *   所以糖糖得**先看见图**，才能起名 —— 这个工具就是把图直接送进她的视野。
 *
 * 结果里带 image 块，模型能真的看到图（不是文字描述）。
 */
export async function registerFacePreviewTool(ctx) {
  try {
    const tools = serviceOf(ctx, 'tools')
    if (tools === undefined || tools === null || typeof tools.register !== 'function') return note('tool', 'no tools service')
    const disposeTool = tools.register({
      name: 'qq_face_preview',
        description:
          '眯眼看清楚别人发的图 —— 结果会直接把图送到你眼前，你能真的看见它。'
          + '别人丢来一张图/一个表情包，想接话就得先知道上面是什么：先看清楚，再说话。'
          + '想把它据为己有（收藏）也得先看图起名，看完再去 qq_collect_face。'
          + '\n\n用法：'
        + '\n   - index=N：看第 N 张（1 = 最早收到的那张，先用 qq_collect_face 的 dir=true 查清单）'
        + '\n   - from=N & count=M：从第 N 张开始连看 M 张（一次最多 6 张）'
        + '\n   - 什么都不传：看最早的几张',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'number', description: '可选；看第几张（1 = 最早收到的那张）。' },
          from: { type: 'number', description: '可选；从第几张开始连着看。' },
          count: { type: 'number', description: '可选；连看几张（最多 6 张）。' }
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            dir: { type: 'string' },
            total: { type: 'number' },
            message: { type: 'string' },
            // image 块本身不进 schema（schema 只描述文字部分），图片靠 render 附上
            previews: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  index: { type: 'number' },
                  label: { type: 'string' },
                  mediaType: { type: 'string' },
                  bytes: { type: 'number' }
                }
              }
            },
            // 图片块靠它传出去。attachment 是 DSH 附件库的引用，
            // 字段名跟 ImageAttachmentRef 一致（attachmentId/mediaType/bytes/width/height/name）。
            images: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  ref: {
                    type: 'object',
                    // 附件引用字段随宿主版本变（还有 originalDimensions 之类），这里不锁死
                    additionalProperties: true,
                    properties: {
                      attachmentId: { type: 'string' },
                      mediaType: { type: 'string' },
                      bytes: { type: 'number' },
                      width: { type: 'number' },
                      height: { type: 'number' },
                      name: { type: 'string' }
                    }
                  }
                }
              }
            }
          }
        },
        render: (args, value) => {
          const previews = Array.isArray(value?.previews) ? value.previews : []
          const blocks = []
          if (previews.length === 0) {
            return [{ type: 'text', text: value?.message ?? '没有可预览的图片' }]
          }
          // 图片按序号顺序附在文字后面 —— 模型看到的顺序和「收到的图片」目录序号一致
          for (const item of value.images ?? []) {
            blocks.push({ type: 'image', attachment: item.ref })
          }
          const lines = previews.map((p) => `#${p.index} ${p.label}（${p.mediaType}，${p.bytes} 字节）`)
          blocks.unshift({
            type: 'text',
            text: `「收到的图片」里这 ${previews.length} 张（目录共 ${value.total ?? '?'} 张）：\n${lines.join('\n')}\n`
              + '看图后给每张起个名字（用 desc 参数传给 qq_collect_face 收藏）。'
          })
          return blocks
        }
      },
      execute: async (args) => {
        const picked = pickPreviews({ index: args?.index, from: args?.from, count: args?.count })
        const attached = await attachPreviews(ctx, picked.items)
        return {
          ok: true,
          dir: picked.dir,
          total: picked.total,
          message: `预览 ${attached.length} 张`,
          previews: attached.map((a) => ({
            index: a.index,
            label: a.label,
            mediaType: a.mediaType,
            bytes: a.bytes
          })),
          // 图片块要靠这个传出去（schema 里没有这个字段，宿主会按 unknown 处理）
          images: attached.map((a) => ({ ref: a.ref }))
        }
      }
    })
    if (typeof disposeTool === 'function') ctx.effect(() => disposeTool, 'dsh-onebot-channel: qq_face_preview tool')
    note('tool', 'qq_face_preview registered')
  } catch (error) {
    note('tool', `qq_face_preview register failed: ${error instanceof Error ? error.message : error}`)
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
          '翻翻之前聊过什么 —— 传 group_id 翻群里的旧账，传 user_id 翻某个人的私聊前情。'
          + '默认最近 20 条。可以传 before_message_id 再往前倒（上限 100）。'
          + '只有当上下文里缺了什么、或者想确认某句原话时才翻；'
          + '刚刚发生的事你眼前就有，别为了确认而确认。',
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
        '在自己的 QQ 空间发条说说 —— 这是对外发布，发出去大家都看得见，'
        + '而且插件没有删说说这条路（接口已封禁），所以只在他明确说「发个说说」时才做。'
        + '\n\n⚠️ 必须传 confirm=true 才会真的发出去（第一次调用不带 confirm 会被拒绝，'
        + '这是故意的：逼你确认「用户确实说了要发」，而不是凭猜测发）。'
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
          },
          confirm: {
            type: 'boolean',
            description: '必填 true。表示「用户明确要求发这条说说」已经得到确认。不带或 false 会被拒绝。'
          }
        },
        required: ['content', 'confirm']
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
          targetUins: Array.isArray(args?.target_uins) ? args.target_uins : [],
          confirm: args?.confirm === true
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
        '把有意思的图偷进自己的表情包 —— 攒着自己的库存，以后 qq_send 能直接甩出去。三种用法：'
        + '\n\n① 藏图（最常用）：别人发的图觉得好，收进 QQ 收藏夹。'
        + '先用 qq_face_preview 看清是什么，再给 desc 起个好找的名字（名字就是它的代号）。'
        + '\n   - index=N：按「收到的图片」目录里的序号收藏（先 dir=true 查序号）'
        + '\n   - recent=N：收藏最近收到的那张图（recent=1 是最新那张）'
        + '\n   - file=：直接给本地文件路径或 http(s) 图片直链'
        + '\n   - desc=：给表情起个名字（备注），起了名才能按名字找它'
        + '\n\n② dir=true：列出「收到的图片」目录里的所有图片（按收到顺序）。'
        + '要批量收藏一批表情包时，先列出来看序号，再逐个收藏。'
        + '\n\n③ delete=：删掉收藏夹里的某个表情（传 emoji_id）。这是不可逆的。'
        + '\n\n注意：QQ 收藏夹**不会自动收图**，收到图片必须显式调这个工具存进去。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'number', description: '可选；按「收到的图片」目录里的序号收藏（1 = 最早收到的那张）。' },
          recent: { type: 'number', description: '可选；收藏最近收到的那张图，1 = 最新那张。' },
          file: { type: 'string', description: '可选；本地文件路径或 http(s) 图片直链。' },
          desc: { type: 'string', description: '可选；给这个表情起个名字（备注）。起了名以后才能按名字找它。' },
          dir: { type: 'boolean', description: '可选；true 时列出「收到的图片」目录里的所有图，不执行收藏。' },
          list: { type: 'boolean', description: '可选；true 时列出收藏夹里已有的表情。' },
          delete: { type: 'string', description: '可选；要删除的收藏表情的 emoji_id。不可逆。' }
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
            message: { type: 'string' },
            files: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  index: { type: 'number' },
                  name: { type: 'string' },
                  label: { type: 'string' },
                  path: { type: 'string' }
                }
              }
            },
            faces: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  emoji_id: { type: 'string' },
                  name: { type: 'string' }
                }
              }
            }
          }
        },
        render: (args, value) => {
          const files = Array.isArray(value?.files) ? value.files : []
          if (files.length > 0) {
            const lines = files.map((f) => `#${f.index} ${f.label}（${f.name}）`)
            return [{ type: 'text', text: `「收到的图片」目录，共 ${files.length} 张：\n${lines.join('\n')}` }]
          }
          const faces = Array.isArray(value?.faces) ? value.faces : []
          if (faces.length > 0) {
            const lines = faces.map((f) => `- ${f.name}（${f.emoji_id}）`)
            return [{ type: 'text', text: `收藏夹里现有 ${faces.length} 个：\n${lines.join('\n')}` }]
          }
          return [{ type: 'text', text: value?.message ?? '完成' }]
        }
      },
      execute: async (args) => {
        // ① 列「收到的图片」目录
        if (args?.dir === true) {
          const result = listImageDir(Number(args?.limit ?? 100) || 100)
          return {
            ok: true,
            emoji_id: '',
            origin: result.dir,
            message: `目录 ${result.dir} 共 ${result.total} 张`,
            files: result.files.map((f) => ({ index: f.index, name: f.name, label: f.label, path: f.path })),
            faces: []
          }
        }
        // ② 列收藏夹
        if (args?.list === true) {
          const list = await listCustomFaces(100)
          return {
            ok: true,
            emoji_id: '',
            origin: '',
            message: `收藏夹里现有 ${list.length} 个`,
            files: [],
            faces: list.map((f) => ({ emoji_id: f.emojiId, name: f.summary || f.desc || f.emojiId }))
          }
        }
        // ③ 删除
        const deleteId = String(args?.delete ?? '').trim()
        if (deleteId !== '') {
          await deleteCustomFace(deleteId)
          return {
            ok: true,
            emoji_id: deleteId,
            origin: '',
            message: `已删除收藏表情 ${deleteId}`,
            files: [],
            faces: []
          }
        }
        // ④ 收藏
        const index = Number(args?.index ?? 0)
        const result = await collectFace({
          file: args?.file,
          recent: Number(args?.recent ?? 0),
          index: index > 0 ? index : 0,
          desc: args?.desc
        })
        return {
          ok: true,
          emoji_id: result.emojiId,
          origin: result.origin,
          // ⚠️ 返回字段必须跟上面 output.schema 对得上：
          //   schema 是 additionalProperties:false，多一个字段宿主就判 ToolOutputError，
          //   工具调用直接失败。schema 里没有 files/faces，这里也得给空数组。
          message: result.desc !== '' && result.desc !== undefined
            ? `已收藏 ${result.emojiId}（备注：${result.desc}）`
            : `已收藏 ${result.emojiId}`,
          files: [],
          faces: []
        }
      }
    })
    if (typeof disposeTool === 'function') ctx.effect(() => disposeTool, 'dsh-onebot-channel: qq_collect_face tool')
    note('tool', 'qq_collect_face registered')
  } catch (error) {
    note('tool', `qq_collect_face register failed: ${error instanceof Error ? error.message : error}`)
  }
}

// ---------------------------------------------------------------------------
// 节奏三件套：等 / 划走 / 收尾
//
// 这三个工具干的是同一件事 —— 把「什么时候说话」还给她。
// 灵感来自 github.com/Mieksido/surfcore 的 reserved2 模式（MIT）：
//   它的核心不是让模型更会说话，而是**让文本不再自动发出去**，
//   于是「不说话」才第一次成为一种可能的回合结局。
// 这里不能直接照搬它那套「抬眼/划走/潜水」的未读水位（那要重构整条投递链），
// 所以用三个独立工具把同样的主动权拆出来，尽量不动原有转发逻辑。
// ---------------------------------------------------------------------------

/** 目标 → 给 getHistory 用的 target 对象。 */
function targetOf(args) {
  const groupId = String(args?.group_id ?? '').trim()
  const userId = String(args?.user_id ?? '').trim()
  if (groupId !== '') return { kind: 'group', id: groupId }
  if (userId !== '') return { kind: 'private', id: userId }
  // 没给号时优先「这一回合刚投给谁」。
  // 以前一律退回 config.peerUin —— 多号并行时那是错的：在 B 的回合里 qq_pass 会去抑制 A，
  // 于是 B 照旧把话发出去、A 的下一条回复被吃掉。日志里只有一句 key=private:A，跟当前对话对不上。
  const recent = recentDelivery()
  if (recent !== null) return recent
  const config = getConfig()
  if (Number(config?.peerUin) > 0) return { kind: 'private', id: String(config.peerUin) }
  return null
}

/**
 * qq_wait —— 等他把话说完。
 *
 * 为什么要有这么一个「什么都不发、只消耗时间」的工具：
 *   真人看到「我跟你说」「等下」「还有」的时候，会**停手等下文**。
 *   没有这个工具，模型只能在「立刻回」和「干脆不回」之间二选一，
 *   于是常见的结果是抢答一半，或者干脆装死。等，是第三种选择。
 */
export async function registerWaitTool(ctx) {
  try {
    const tools = serviceOf(ctx, 'tools')
    if (tools === undefined || tools === null || typeof tools.register !== 'function') return note('tool', 'no tools service')
    const disposeTool = tools.register({
      name: 'qq_wait',
      description:
        '等他一会儿 —— 按兵不动，什么都不发，看看这段时间里对方有没有把话说完。'
        + '\n\n什么时候用它：'
        + '\n· 对方明显还没说完（「我跟你说」「等下」「还有」「那个…」），等完再回，别抢答。'
        + '\n· 你刚发了一句，想看看他的反应再决定要不要补。'
        + '\n· 你觉得这句其实可以不接，但不确定他会不会自己接上 —— 等一等就知道了。'
        + '\n\n返回这段时间内**新到的话**（没有就告诉你「没人接话」）。'
        + '默认等 8 秒，最多 60 秒。等人的时候你什么都不用做，也不要说话。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ms: { type: 'number', description: '可选；等多久，毫秒。默认 8000（8 秒），上限 60000。' },
          group_id: { type: 'string', description: '可选；等哪个群的新消息。' },
          user_id: { type: 'string', description: '可选；等哪个好友的新消息。留空且没给群号时等默认私聊对象。' }
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            waitedMs: { type: 'number' },
            newCount: { type: 'number' },
            newMessages: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  who: { type: 'string' },
                  text: { type: 'string' }
                }
              }
            },
            hint: { type: 'string' }
          }
        },
        render: (args, value) => {
          const list = Array.isArray(value?.newMessages) ? value.newMessages : []
          if (list.length === 0) return [{ type: 'text', text: `等了 ${value?.waitedMs ?? 0}ms，这段时间没人说话。` }]
          const lines = list.map((m) => `- ${m.who}：${m.text}`)
          return [{ type: 'text', text: `等了 ${value?.waitedMs ?? 0}ms，来了 ${list.length} 条：\n${lines.join('\n')}` }]
        }
      },
      execute: async (args) => {
        const target = targetOf(args)
        if (target === null) throw new Error('不知道要等谁：给 group_id 或 user_id，或在配置里设好默认私聊对象。')

        const config = getConfig()
        const wanted = clampLimit(args?.ms, 8000, 0, 60000)
        const cap = clampLimit(config?.waitMaxMs, 60000, 0, 300000)
        const ms = Math.min(wanted, cap)

        // 等之前先看一眼最新到哪了，等完才认得出哪些是新的
        const before = await getHistory(target, 20).catch(() => [])
        const seenIds = new Set(before.map((m) => Number(m.messageId)))
        const startedAt = Date.now()
        await new Promise((resolve) => { setTimeout(resolve, ms) })
        const waitedMs = Date.now() - startedAt

        const after = await getHistory(target, 20).catch(() => [])
        const self = String(config?.selfUin ?? '').trim()
        const fresh = []
        for (const item of after) {
          if (seenIds.has(Number(item.messageId))) continue
          if (self !== '' && String(item.userId) === self) continue // 自己发的不用提示
          fresh.push({
            who: String(item.card || item.nickname || item.userId || '对方').trim(),
            text: String(item.text ?? '').slice(0, 200)
          })
        }

        return {
          waitedMs,
          newCount: fresh.length,
          newMessages: fresh,
          hint: fresh.length === 0
            ? '没人接话。可以开口，也可以什么都不做 —— 这段本来就没什么要回的。'
            : '先看这些新话，再决定要不要接、或者要不要再等一会儿。'
        }
      }
    })
    if (typeof disposeTool === 'function') ctx.effect(() => disposeTool, 'dsh-onebot-channel: qq_wait tool')
    note('tool', 'qq_wait registered')
  } catch (error) {
    note('tool', `qq_wait register failed: ${error instanceof Error ? error.message : error}`)
  }
}

/**
 * qq_pass —— 划走。
 *
 * 「我看完了，但我这次不说话。」这跟失败、跟掉线、跟没答案都不同：
 * 它是**有意为之**的沉默。在原来的链路里这种状态根本不存在，
 * 因为回合结束就一定会把最后一句转发出去。
 */
export async function registerPassTool(ctx) {
  try {
    const tools = serviceOf(ctx, 'tools')
    if (tools === undefined || tools === null || typeof tools.register !== 'function') return note('tool', 'no tools service')
    const disposeTool = tools.register({
      name: 'qq_pass',
      description:
        '划走 —— 这条我看完了，但这次不说话。'
        + '\n\n什么时候用：'
        + '\n· 没话说、不想接、接了也是敷衍。'
        + '\n· 这是转给别人看的笑话/接龙，轮不到我。'
        + '\n· 话题已经翻篇了，硬接只会显得没眼力见。'
        + '\n\n⚠️ 它管的是「我这次不开口」，不是「把我刚写的话删掉」：'
        + '如果你已经在正文里写了要跟他说的话，那话照样会发出去（写了就算说出口）。'
        + '\n真不想让他看到任何东西，就别写正文、只调它 —— 只在心里想的那些不必写进正文。'
        + '\n该开口时别用它：对方明确在问你、在求你办事，先答了再说。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          group_id: { type: 'string', description: '可选；划走哪个群。' },
          user_id: { type: 'string', description: '可选；划走哪个好友。留空且没给群号时指默认私聊对象。' },
          why: { type: 'string', description: '可选；给自己留个理由（只进日志，不会发给任何人）。' }
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            note: { type: 'string' }
          }
        },
        render: (args, value) => [{ type: 'text', text: String(value?.note ?? '已划走') }]
      },
      execute: async (args) => {
        const target = targetOf(args)
        if (target === null) throw new Error('不知道要划走谁：给 group_id 或 user_id，或在配置里设好默认私聊对象。')
        const key = targetKey(target)
        const why = String(args?.why ?? '').trim()
        suppress(key, why === '' ? 'qq_pass' : `qq_pass: ${why}`)
        return { ok: true, note: '划走了。这次什么都不发了。' }
      }
    })
    if (typeof disposeTool === 'function') ctx.effect(() => disposeTool, 'dsh-onebot-channel: qq_pass tool')
    note('tool', 'qq_pass registered')
  } catch (error) {
    note('tool', `qq_pass register failed: ${error instanceof Error ? error.message : error}`)
  }
}

/**
 * qq_close —— 收尾。
 *
 * 「结束」不等于「消失」。记下这次停在哪、下次怎么接，
 * 下次她再被叫醒就不是从零开场 —— 这是比「多聊两句」更像真人的地方：
 * 真人记得上次聊到哪儿。
 */
export async function registerCloseTool(ctx) {
  try {
    const tools = serviceOf(ctx, 'tools')
    if (tools === undefined || tools === null || typeof tools.register !== 'function') return note('tool', 'no tools service')
    const disposeTool = tools.register({
      name: 'qq_close',
      description:
        '收摊 —— 记下这段聊到哪儿了，以及下次可以怎么接。'
        + '\n\n什么时候用：'
        + '\n· 双方都说了收尾式的话（嗯/好/哈哈/晚安），再补一句就多余。'
        + '\n· 话题闭环了（事办完、问题答完、约定说定）。'
        + '\n· 双方越回越短，节奏明显疲了。'
        + '\n\n不用它的情况：**对方还在问你、还在求你办事** —— 这时候先回答，'
        + '桥接会直接拒绝这次收尾（不是信你，是替你把门）。'
        + '\n\n⚠️ 收尾不会阻止你说话：想留最后一句话就先用 qq_send 说完再收。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', description: '可选；这次聊到哪儿收的（一句话）。' },
          next: { type: 'string', description: '可选；下次可以从哪儿接（一句话）。' },
          group_id: { type: 'string', description: '可选；收哪个群。' },
          user_id: { type: 'string', description: '可选；收哪个好友。留空且没给群号时指默认私聊对象。' }
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            closed: { type: 'boolean' },
            verdict: { type: 'string' },
            score: { type: 'number' },
            reasons: { type: 'array', items: { type: 'string' } }
          }
        },
        render: (args, value) => {
          const reasons = Array.isArray(value?.reasons) ? value.reasons : []
          return [{
            type: 'text',
            text: `${value?.verdict ?? ''}${reasons.length > 0 ? `（${reasons.join('；')}）` : ''}`
          }]
        }
      },
      execute: async (args) => {
        const target = targetOf(args)
        if (target === null) throw new Error('不知道要收哪个会话：给 group_id 或 user_id，或在配置里设好默认私聊对象。')
        const key = targetKey(target)

        const summary = String(args?.summary ?? '').trim()
        const next = String(args?.next ?? '').trim()

        // 没开这个开关就直接放行（保持老行为，不新增 surprising 的拒绝）
        const config = getConfig()
        if (config?.closureEnabled === false) {
          saveClosing(key, { summary, next })
          return { ok: true, closed: true, verdict: '已记下这次停在哪（收尾判断关着，没做校验）', score: 0, reasons: [] }
        }

        // 取最近几条，分出「最后一句我说的」和「最后一句他说的」再判
        const config2 = getConfig()
        const self = String(config2?.selfUin ?? '').trim()
        const recent = await getHistory(target, 8).catch(() => [])
        let mine = ''
        let theirs = ''
        for (const item of recent) {
          const isMine = self !== '' && String(item.userId) === self
          if (isMine) mine = String(item.text ?? '')
          else theirs = String(item.text ?? '')
        }

        const verdictResult = assessClosure({ mine, theirs })
        if (verdictResult.openQuestion) {
          return {
            ok: false,
            closed: false,
            verdict: '对方还在问/还在求，这会儿不能收摊 —— 先把话说完再说',
            score: verdictResult.score,
            reasons: verdictResult.reasons
          }
        }
        saveClosing(key, { summary, next })
        return {
          ok: true,
          closed: true,
          verdict: describeClosure(verdictResult),
          score: verdictResult.score,
          reasons: verdictResult.reasons
        }
      }
    })
    if (typeof disposeTool === 'function') ctx.effect(() => disposeTool, 'dsh-onebot-channel: qq_close tool')
    note('tool', 'qq_close registered')
  } catch (error) {
    note('tool', `qq_close register failed: ${error instanceof Error ? error.message : error}`)
  }
}

/**
 * qq_remember —— 记住关于他的一件事。
 *
 * 为什么单独给一个工具，而不是让记忆靠着「聊天记录自动积累」：
 *   聊天记录是流水账，记得越多越捞不出重点；而且会话一冷启动就接不上了。
 *   让模型自己判断「这件事值得记」，写进一张有几条上限的卡里 ——
 *   下次醒来，她对这个人的认识还在。
 */
export async function registerRememberTool(ctx) {
  try {
    const tools = serviceOf(ctx, 'tools')
    if (tools === undefined || tools === null || typeof tools.register !== 'function') return note('tool', 'no tools service')
    const disposeTool = tools.register({
      name: 'qq_remember',
      description:
        '记住关于他的一件事 —— 写进你对这个人的长期记忆，下次再聊还认得。'
        + '\n\n什么时候用：'
        + '\n· 他说了自己喜欢什么、讨厌什么、最近在忙什么、在意什么。'
        + '\n· 他纠正了你对他的称呼 —— 用 nick 记下来，以后就这么叫。'
        + '\n· 有件小事值得下次提起（「结果出来记得问他」）。'
        + '\n\n只记**对你俩关系有用**的，别把每句话都抄下来：'
        + '一张卡最多留 8 条，记得越碎，真正有用的越容易被挤掉。'
        + '\n⚠️ 这是你私下的记忆，不会发到 QQ，对方看不到。'
        + '\n（私聊和群各自一张卡；群里记的是这个群本身，不是某个群友。）',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          fact: { type: 'string', description: '要记住的一件事，一句话说清（最多 120 字）。' },
          nick: { type: 'string', description: '可选；以后怎么称呼他 / 这个群。' },
          user_id: { type: 'string', description: '可选；记哪个好友。留空且没给群号时记默认私聊对象。' },
          group_id: { type: 'string', description: '可选；记哪个群。' }
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            note: { type: 'string' },
            facts: { type: 'number' }
          }
        },
        render: (args, value) => [{ type: 'text', text: String(value?.note ?? '记住了') }]
      },
      execute: async (args) => {
        const target = targetOf(args)
        if (target === null) throw new Error('不知道要记谁：给 group_id 或 user_id，或在配置里设好默认私聊对象。')
        const key = targetKey(target)
        const fact = String(args?.fact ?? '').trim()
        const nick = String(args?.nick ?? '').trim()
        if (fact === '' && nick === '') throw new Error('至少给 fact 或 nick 一项。')
        remember(key, { fact, nick })
        const card = loadMemory(key)
        const count = Array.isArray(card?.facts) ? card.facts.length : 0
        return {
          ok: true,
          note: fact !== '' ? `记住了（这张卡现在有 ${count} 条）` : `以后就叫他「${nick}」`,
          facts: count
        }
      }
    })
    if (typeof disposeTool === 'function') ctx.effect(() => disposeTool, 'dsh-onebot-channel: qq_remember tool')
    note('tool', 'qq_remember registered')
  } catch (error) {
    note('tool', `qq_remember register failed: ${error instanceof Error ? error.message : error}`)
  }
}

/** 全部经典表情名清单，给别处（比如提示词）用。 */
export { faceNameList }
