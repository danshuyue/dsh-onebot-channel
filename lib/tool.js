/**
 * tool.js —— 注册 qq_send 工具（AI 在会话里就能主动发 QQ 消息）。
 */
import { note, waitForTools } from './env.js'
import { getConfig } from './config.js'
import { sendToQQ } from './outbound.js'
import { targetKey, suppress, clampLimit, recentDelivery, noteTurnHandled, wasTurnHandled, noteCloseRefusedTurn, noteSkipTurn, waitBudgetLeft, chargeWaitBudget } from './rhythm.js'
import { remember, loadMemory } from './memory.js'
import { assessClosure, describeClosure, saveClosing, describeClosureLine } from './closure.js'
import { faceNameList } from './emoticons.js'
import { resolveFaceIdSafe } from './face-resolve.js'
import { findCustomFace, rankCustomFaces, FACE_PICK_DEFAULT_LIMIT, FACE_PICK_MAX_LIMIT } from './custom-faces.js'
import { searchSysFaces, fetchSysFacePacks } from './sys-faces.js'
import { getHistory } from './history.js'
// 历史消息里的图片也要让模型真的看见（0.12.0）：
// 入站投递早就走 buildImageBlocks 了，唯独 qq_msg_history 这条路只取 item.text，
// 而 textOf() 对图片段是写死的 '[图片]' —— 模型翻历史时看不见图。
import { buildImageBlocks, imageSegmentsOf } from './images.js'
import { sendQzoneMsg, QZONE_VISIBILITY } from './qzone.js'
import { collectFace, recentList, listImageDir, deleteCustomFace, renameCustomFace } from './collect.js'
import { pickPreviews, attachPreviews } from './preview.js'
import { listCustomFaces } from './custom-faces.js'
import { notePass, closeWindow, noteReply, noteCloseRefused, clearCloseRefusals } from './window.js'
import { sendPoke } from './poke.js'
import { transcribeVoice } from './voice.js'
import { sendVoiceToQQ } from './voiceout.js'

/** 工具描述里给 agent 看的常用表情清单（太长会稀释注意力，只列高频的）。 */
const COMMON_EMOJI = '呲牙、微笑、开心、大笑、笑哭、偷笑、憨笑、可爱、害羞、闭嘴、'
  + '流泪、大哭、难过、委屈、无语、白眼、傲慢、吐、困、惊讶、疑问、晕、'
  + 'OK、点赞、鼓掌、抱拳、比心、加油、庆祝、点赞、爱心、亲亲、无奈、拍桌、飞吻'

/** 注册 qq_send：不传 group_id 发私聊，传了就发群。 */
export async function registerSendTool(ctx, signal) {
  try {
    const tools = await waitForTools(ctx, 'qq_tool', signal)
    if (tools === null) return
    // 不 import @deepseek-ai/dsh-tools（解析不到），直接把工具对象交给 tools.register。
    // 注意：register 只认编译好的 JSON Schema，不是 defineTool 那套 DSL（required 写在属性里）。
    // 而且必须给 output.render，否则直接抛 must declare output。
    const disposeTool = tools.register(
      {
        name: 'qq_send',
        description:
          '开口说话 —— 这是你在 QQ 上唯一出声的地方，text 里直接写你想说的话，'
          + '默认发给用户本人的私聊；传 user_id 发给本人之外的好友，传 group_id 则发到群里。'
          + '\n\n你不一定非得开口。下面这些「不说」都是完整、体面的回合结局：'
          + '\n· 没话接、不想接 —— 什么都不用凑，别为了接而接。'
          + '\n· **这条不该有回复**（话题已收尾、对方在自言自语、只是表情/通知）—— 调 qq_skip。'
          + '\n· 对方明显还没说完（「我跟你说」「等下」「还有」）—— 先 qq_wait 等完再决定。'
          + '\n· 这段聊到头了 —— 用 qq_close 收摊，或者 qq_pass 划走。'
          + '\n\n⚠️ **最重要的一条：判断「这条不用回」时，直接调 qq_skip，不要在正文里写下你的判断。**'
          + '\n你的正文会成为发到 QQ 上的内容。写「这条不用回了」「这段聊完了」「对方想结束」'
          + '这类话，对方看到的就是你在自言自语地分析对话——对端是 AI 时还会顺着它继续回，'
          + '话题反而停不下来。**想结束，就别产出文字。**'
          + '\n\n⚠️ 发到 QQ 上的到底是哪些字（这一条要看懂，别想当然）：'
          + '\n· **调了这个工具**的回合 → 按 text / segments / 表情 / custom_emoji 里的内容发；'
          + '  这时你写在别处的正文不会再被转发一遍。'
          + '\n· **没调这个工具**的回合 → 你最后一段正文会被**自动转发**到 QQ。'
          + '  也就是说「我随手写点分析，反正不会发出去」是错的 —— 它会被发出去。'
          + '\n· 想什么都不发：调 qq_skip（或 qq_pass）。'
          + '\n· 整条只有动作描写（「（顿了顿）」）在普通聊天里也会被转发；'
          + '主动搭话回合和 qq_pass 回合才算沉默。'
          + '\n\n⚠️ 只能发给「插件正在服务的对象」（已绑定的好友/群 + 用户本人）。'
          + '发给范围外的号会被拒绝 —— 这是硬闸，不是靠你自觉。被拒就说明这个号没被放过，'
          + '不要换个写法重试，直接告诉用户「这个目标不在允许范围内」。'
          + '\n\n想自己决定分几条，就传 segments —— 每个元素发成一条独立消息、按顺序发出，'
          + '中间带真人式的停顿。不传就按句末标点自动切。'
          + '\n\n表情：真人聊天会发表情。这句话带着明显情绪时（好笑、无奈、委屈、得意、无语、'
          + '被逗到、想怼人、看戏），或对方刚发了个表情包你想回一个 —— 先调 qq_face_pick，'
          + '按情绪看一眼收藏夹里有什么，挑一个传给 custom_emoji。'
          + '\n不要为了用表情而用表情：没合适的、或者这条本来就该正经说事，就纯文字。'
          + '\n⚠️ 表情填错不会连累文字：匹配不上时只跳过表情、话照发（返回值里会说一声）。'
          + '所以想配就大胆试，失败一次也不该让你以后不敢用。'
          + '\n经典小表情（emoji 参数或正文里的 [表情:呲牙]）是另一条路，收藏里没有合适的时可用；'
          + `常用：${COMMON_EMOJI}。不确定叫什么就先调 qq_emoji_search 查一下。`
          + '\n通常只选一种，不要叠加装饰。'
          + '\n\n⚠️ 收藏表情的备注就是它的搜索标签。碰到「搜不到」的老收藏，'
          + '用 qq_face_rename 看图起名、改成「名称 | 2-4 个情绪词」—— 改一次，以后就找得到了。'
          + '\n\n引用回复：QQ 消息正文里会有 [#数字] 这样的标记（如 [#-2123597213]），那是那条消息的编号。'
          + '想明确引用某一条，就把它填进 reply_to；不填则自动引用「触发这次回复的那条」。'
          + '引用只挂在第一条消息上（分条发送时后面几条不带引用，跟 QQ 原生行为一致）。',
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
            custom_emoji: { type: 'string', description: '可选；收藏夹里的商城大表情。按备注关键词匹配，可给一个短描述或多个关键词（如「委屈 撒娇 求安慰」）；会作为单独一条消息发出去。' },
            user_id: { type: 'string', description: '可选；好友 QQ 号。发给某个人时必填，不填会落到默认私聊对象（用户本人）。' },
            group_id: { type: 'string', description: '可选；群号。留空表示私聊。' },
            reply_to: {
              type: 'string',
              description: '可选；要引用哪一条消息。填正文里 [#数字] 那个数字（例如正文写着 [#-2123597213] 就填 -2123597213）。'
                + '引用只挂在第一条消息上 —— 分条发送时后面几条不带引用，这是 QQ 的原生行为。'
                + '不填就按「触发这次回复的那条」自动引用。'
            },
            voice: {
              type: 'string',
              description: '可选；发一条**语音**。填本机音频文件的绝对路径，但必须位于设置的「语音产物目录」内（留空未配置时禁止发送）。协议端会自己转成 QQ 语音。用 text 说词、用这个说声音 —— 两者可以同时给，那就先发文字再发语音。'
                + '\n⚠️ 语音内容不会被出站审计检查文字敏感词，所以只允许从专用 TTS 成品目录读取；不要把其他文件放进该目录。'
                + '\n⚠️ 文件读不到或不在允许目录会明确报错，不会静默失败。'
            },
            at: {
              type: 'string',
              description: '可选；在群里 @ 某个人的 QQ 号。只有群聊有效，私聊会忽略。'
                + '**只在第一条消息上 @ 一次**（分条发送时后面几条不带 @），避免连点同一个人。'
                + '不填时：被 @ 的那条消息会自动 @ 回去，其余情况不 @。'
            }
          }
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              message_id: { type: 'number' },
              // 收藏表情没匹配上时才有值。必须在 schema 里声明 ——
              // additionalProperties:false 会把多出来的字段判成 ToolOutputError，
              // 于是「降级成功」反而变成「工具调用失败」。
              custom_emoji_missed: { type: 'string' },
              // 发了语音时为 true（不声明同样会被判 ToolOutputError）
              voice_sent: { type: 'boolean' }
            },
            required: ['message_id']
          },
          render: (args, value) => {
            const missed = String(value?.custom_emoji_missed ?? '').trim()
            const base = `已发到 QQ，message_id=${Number(value?.message_id ?? 0)}`
            const voice = value?.voice_sent === true ? '（含一条语音）' : ''
            // ⚠️ 这句是给模型看的系统提示，不是聊天内容 —— 加 [系统] 前缀，
            //   否则它可能把「表情没匹配上」当成一句话复述出去。
            return missed === ''
              ? [{ type: 'text', text: `${base}${voice}` }]
              : [{
                  type: 'text',
                  text: `${base}${voice}\n[系统] 收藏表情「${missed}」没匹配上，已跳过表情、文字照发。`
                    + '要配表情就先调 qq_face_pick 看收藏夹里有什么（按情绪挑，别盲猜关键词）。'
                }]
          }
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

          // 收藏表情：关键词 → emoji_id。
          //
          // ⚠️ 匹配不上**不能抛错**（0.16.14）：这条原来是 throw，于是「文字 + 表情」
          //   只要表情没搜到，整句话都发不出去 —— 模型精心写的话就这么没了。
          //   它学到的不是「换一个词」，而是「别碰 custom_emoji」，这就是
          //   「从来没有发收藏表情的倾向」的真正来路（负向强化）。
          //   所以改成：跳过表情、文字照发，但从日志和返回值两处都让它看得见。
          //   实测背景：真实收藏夹 22 个里 21 个备注是具体句子
          //   （「穷光蛋思考中」「问号呆脸」），按「委屈/撒娇/无语」去搜必然落空。
          let customEmojiId = ''
          let customEmojiMissed = ''
          if (customEmojiName !== '') {
            const found = await findCustomFace(customEmojiName)
            if (found === null) {
              customEmojiMissed = customEmojiName
              note('tool', `收藏表情「${customEmojiName}」没匹配到，跳过表情只发文字`)
            } else {
              customEmojiId = found.emojiId
            }
          }
          // 只有表情、没有文字，而表情又没匹配上 → 真的没东西可发，这时候要报错。
          // 不能静默「成功」：那会让模型以为发出去了（静默降级是本仓库的典型事故来源）。
          const voicePath = String(args?.voice ?? '').trim()
          if (customEmojiMissed !== '' && text.trim() === '' && segments.length === 0 && faceSegment === null && voicePath === '') {
            throw new Error(
              `只有收藏表情要发，但收藏夹里没找到含「${customEmojiMissed}」的表情，这次什么也没发出去。`
              + '先调 qq_face_pick 看看收藏夹里有哪些（按情绪挑），别再盲猜关键词。'
            )
          }

          // 文字部分：给了 voice 但一个字都没有时跳过 —— sendToQQ 对「空内容」是抛错的，
          // 那条防线不能因为多了语音就漏掉（否则「只发表情没匹配上」会静默成功）。
          const hasTextPart = text.trim() !== '' || segments.length > 0 || faceSegment !== null || customEmojiId !== ''
          let result = null
          let messageId = 0
          if (hasTextPart) {
            result = await sendToQQ(target, text, {
              faceSegment,
              customEmojiId,
              segments,
              replyTo: String(args?.reply_to ?? '').trim(),
              atUin: String(args?.at ?? '').trim(),
               atRateKey: getConfig().windowEnabled !== false ? 'tool' : undefined
            })
            messageId = Number(result?.data?.message_id ?? 0)
          } else if (voicePath === '') {
            // 既没文字、也没语音 → 真的没东西可发（原来靠 sendToQQ 抛「要发送的内容是空的」）
            throw new Error('要发送的内容是空的 —— text / segments / 表情 / voice 至少要给一样。')
          }

          // 语音：在文字之后单独发一条（QQ 语音是一条独立消息，没法跟文字挤在同一条里）
          let voiceSent = false
          if (voicePath !== '') {
            const voiceResult = await sendVoiceToQQ(target, voicePath)
            messageId = Number(voiceResult?.data?.message_id ?? messageId)
            voiceSent = true
          }

          const messageIds = Array.isArray(result?.data?.message_ids) ? result.data.message_ids : messageId
          // 旁路记账：这一回合她说过话（qq_close 撞上 openQuestion 时据此放行关窗）
          noteTurnHandled(targetKey(target))
          if (target.kind === 'group' && (Array.isArray(result?.data?.message_ids) ? result.data.message_ids.length > 0 : Number.isFinite(messageId) && messageId !== 0)) {
            noteReply(String(target.id), Array.isArray(result?.data?.message_ids) ? result.data.message_ids : messageId)
          }
          // voice_sent 只在实际发了语音时出现 —— 没给 voice 的回合输出形状跟以前一模一样
          if (customEmojiMissed !== '') {
            return voiceSent
              ? { message_id: messageId, custom_emoji_missed: customEmojiMissed, voice_sent: true }
              : { message_id: messageId, custom_emoji_missed: customEmojiMissed }
          }
          return voiceSent ? { message_id: messageId, voice_sent: true } : { message_id: messageId }
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
export async function registerEmojiSearchTool(ctx, signal) {
  try {
    const tools = await waitForTools(ctx, 'qq_tool', signal)
    if (tools === null) return
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
 * 注册 qq_face_pick —— 按情绪/场景**挑**收藏表情（只查不发）。
 *
 * 为什么要单独给一个工具（0.16.14）：
 *   模型要配表情，得先知道**有哪些**。原来唯一的列举入口是 `qq_collect_face` 的
 *   `list: true` —— 但模型想「挑一个表情发出去」时，不会想到去调一个叫「收藏表情」的工具。
 *   于是它只能**盲猜关键词**；实测真实收藏夹 22 个里 21 个备注是具体句子
 *   （「穷光蛋思考中」「问号呆脸」「拿棒球棍打死，对付油腻男用」），
 *   按「委屈/撒娇/无语」去搜 8 次里 6 次落空 → 旧代码 throw → 整句发不出去。
 *
 *   这个工具把「想一想」变成「查一下」：给情绪词，返回能用的候选，
 *   **不抛错**（查询不是命令），让模型挑完再传给 qq_send 的 custom_emoji。
 */
export async function registerFacePickTool(ctx, signal) {
  try {
    const tools = await waitForTools(ctx, 'qq_tool', signal)
    if (tools === null) return
    const disposeTool = tools.register({
      name: 'qq_face_pick',
      description:
        '挑一个收藏表情 —— 按情绪/场景从 QQ 收藏夹里找几张合适的图，只列候选，不发送。'
        + '\n\n什么时候用：这句话带着明显情绪（好笑、无奈、委屈、得意、无语），'
        + '或对方刚发了个表情包你想回一个。别硬凑 —— 本来该正经说事的时候不用。'
        + '\n\n用法：给一个短描述或 2-4 个关键词（如「无语」「好笑 看戏」），'
        + '它会把收藏夹里最像的几个列出来；你挑一个名字再传给 qq_send 的 custom_emoji。'
        + '\n不给 query 就列出收藏夹里的全部（最多 30 个），适合先扫一眼有货没。'
        + '\n\n⚠️ 它只查不发。收藏备注如果是「穷光蛋思考中」这种句子，按「委屈」搜是搜不到的 ——'
        + '搜不到就换个更接近备注的说法，或者干脆不发表情。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: '可选；情绪/场景关键词，空格分隔（如「无语 看戏」）。留空则列出全部收藏。' },
          limit: { type: 'number', description: `可选；最多返回几个，默认 ${FACE_PICK_DEFAULT_LIMIT}，上限 ${FACE_PICK_MAX_LIMIT}。` }
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            count: { type: 'number' },
            faces: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string' },
                  emoji_id: { type: 'string' },
                  score: { type: 'number' }
                }
              }
            },
            message: { type: 'string' }
          }
        },
        render: (args, value) => {
          const faces = Array.isArray(value?.faces) ? value.faces : []
          if (faces.length === 0) {
            return [{ type: 'text', text: String(value?.message ?? '收藏夹里没有匹配的表情。') }]
          }
          const lines = faces.map((f) => `- ${f.name}（${f.emoji_id}）`)
          return [{
            type: 'text',
            text: `收藏夹里有这 ${faces.length} 个可以挑：\n${lines.join('\n')}\n`
              + '选中哪个，就把它的名字传给 qq_send 的 custom_emoji。'
          }]
        }
      },
      execute: async (args) => {
        const query = String(args?.query ?? '').trim()
        const limit = args?.limit === undefined ? undefined : Number(args.limit)
        const ranked = await rankCustomFaces(query, limit)
        // 「名字」优先用备注（summary 由 desc 兜底）：模型拿到的名字要能回传给
        // findCustomFace 搜得到，否则它挑中了也发不出去。
        const faces = ranked.map((entry) => ({
          name: entry.item.summary || entry.item.desc || entry.item.emojiId,
          emoji_id: entry.item.emojiId,
          score: Number(entry.score) || 0
        }))
        let message = ''
        if (faces.length === 0) {
          message = query === ''
            ? '收藏夹是空的 —— 需要先在 QQ 里收藏表情包，或者用 emoji 参数发经典小表情。'
            : `收藏夹里没有匹配「${query}」的表情。换个更接近备注的说法再试，或者用 emoji 参数发经典小表情。`
        }
        return { ok: true, count: faces.length, faces, message }
      }
    })
    if (typeof disposeTool === 'function') ctx.effect(() => disposeTool, 'dsh-onebot-channel: qq_face_pick tool')
    note('tool', 'qq_face_pick registered')
  } catch (error) {
    note('tool', `qq_face_pick register failed: ${error instanceof Error ? error.message : error}`)
  }
}

/**
 * 注册 qq_face_rename —— 给收藏表情**看图起名**（0.16.14）。
 *
 * 为什么需要「她自己起名」而不是自动规则：
 *   收藏备注是以后按情绪找到它的唯一线索，而实测本机 22 个里 21 个备注是**句子**：
 *   「穷光蛋思考中」「问号呆脸」「拿棒球棍打死，对付油腻男用」「这是你的私人癖好」。
 *   这种标签按「委屈 / 撒娇 / 无语」搜必然落空。
 *   自动把句子切词或套模板都不准 —— **图长什么样只有看得见的人知道**，
 *   所以把图直接送到她眼前，让她自己写「名称 | 情绪词」。
 *
 * 设计要点：
 *   · 不带 desc 时只**看图**（返回图片，不改名）—— 分两步走，她可以先看再决定
 *   · 带 desc 时先校验格式（必须含 | 且有 2-4 个关键词），不合格直接拒绝并说明
 *   · 这是**显式命令**，失败要抛错（不像 qq_face_pick 是查询）
 */
export async function registerFaceRenameTool(ctx, signal) {
  try {
    const tools = await waitForTools(ctx, 'qq_tool', signal)
    if (tools === null) return
    const disposeTool = tools.register({
      name: 'qq_face_rename',
      description:
        '给收藏表情改名 —— 把它现在那句「备注」改成「名称 | 2-4 个情绪词」，以后就能按情绪找到它。'
        + '\n\n为什么值得做：收藏备注是以后找回它的唯一线索。很多老收藏的备注是句子'
        + '（「穷光蛋思考中」「拿棒球棍打死，对付油腻男用」），按「委屈 / 无语 / 好笑」根本搜不到。'
        + '\n\n怎么用（两步，别跳第一步）：'
        + '\n1. 不带 desc 调一次 —— 会把那张图的**样子**直接送到你眼前，你看懂它是什么情绪。'
        + '\n   不知道 emoji_id 就先调 qq_face_pick（不给 query）列出收藏夹，拿到 emoji_id。'
        + '\n2. 看图之后，用 desc 写「简短名称 | 2-4 个关键词」，再调一次。'
        + '\n\n关键词写**情绪和适用场景**，不要写剧情：「委屈 撒娇 求安慰」比「被男友甩了那天」好搜。'
        + '\n已有像样的备注就别动它 —— 这只该用来修那些搜不到的。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          emoji_id: { type: 'string', description: '要改的收藏表情的 emoji_id（从 qq_face_pick 拿）。' },
          desc: {
            type: 'string',
            description: '可选；新的备注，格式「简短名称 | 2-4 个关键词」。**留空则只看图不改名**。'
          }
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            emoji_id: { type: 'string' },
            old_desc: { type: 'string' },
            desc: { type: 'string' },
            message: { type: 'string' },
            images: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  type: { type: 'string' },
                  text: { type: 'string' },
                  attachment: { type: 'object', additionalProperties: true, properties: {} }
                }
              }
            }
          }
        },
        render: (args, value) => {
          // 看图模式下把图**真的交出去**（否则她就看不到图，只能瞎起名）
          const images = Array.isArray(value?.images) ? value.images : []
          const blocks = images.filter((block) => block !== null && typeof block === 'object')
          const text = String(value?.message ?? '完成')
          return blocks.length > 0 ? [{ type: 'text', text }, ...blocks] : [{ type: 'text', text }]
        }
      },
      execute: async (args) => {
        const id = String(args?.emoji_id ?? '').trim()
        if (id === '') throw new Error('emoji_id 不能为空：先用 qq_face_pick 列一下收藏夹拿到它。')
        const next = String(args?.desc ?? '').trim()
        const list = await listCustomFaces(100)
        const target = list.find((item) => item.emojiId === id)
        if (target === undefined) {
          throw new Error(`收藏夹里没有这个 emoji_id：${id}。先用 qq_face_pick 列一下，确认号码对不对。`)
        }
        const oldDesc = target.summary || target.desc || ''
        // 只给 emoji_id 不给 desc：**看图**模式。把图送到她眼前，让她自己起名。
        if (next === '') {
          const blocks = await buildImageBlocks(ctx, [{
            sender: { user_id: '' },
            message: [{
              type: 'image',
              data: { url: target.url, file: `face-${id.slice(-8)}` }
            }]
          }], { remember: false })
          const shaped = Array.isArray(blocks) && blocks.length > 0
            ? blocks
            : [{ type: 'text', text: '[这张图没能取到，可能协议端没给 url]' }]
          return {
            ok: true,
            emoji_id: id,
            old_desc: oldDesc,
            desc: oldDesc,
            message: `（看到的是「${oldDesc || '无备注'}」这一张。想好它是什么情绪，'
              + '再用 desc 写「名称 | 2-4 个关键词」调一次。）`,
            images: shaped
          }
        }
        // 给了 desc：写入。格式不合格就拒绝，别让脏标签继续堆。
        if (!next.includes('|')) {
          throw new Error(
            `备注要写成「简短名称 | 2-4 个关键词」，用 | 分隔。`
            + `你给的是「${next}」—— 补上情绪词，例如「问号呆脸 | 疑惑 懵逼 无语」。`
          )
        }
        const keywordPart = next.split('|').slice(1).join('|').trim()
        const keywords = keywordPart.split(/[\s,，、]+/).filter(Boolean)
        if (keywords.length === 0) {
          throw new Error(`| 后面要有 2-4 个关键词，你给的是空的。例如「问号呆脸 | 疑惑 懵逼 无语」。`)
        }
        if (keywords.length > 4) {
          throw new Error(
            `关键词最多 4 个，你给了 ${keywords.length} 个。`
            + '挑最能概括这个表情的 2-4 个就够 —— 词越多越搜不准。'
          )
        }
        await renameCustomFace(id, next)
        return {
          ok: true,
          emoji_id: id,
          old_desc: oldDesc,
          desc: next,
          message: `改好了：「${oldDesc || '无备注'}」→「${next}」。以后按这些词就能找到它。`,
          images: []
        }
      }
    })
    if (typeof disposeTool === 'function') ctx.effect(() => disposeTool, 'dsh-onebot-channel: qq_face_rename tool')
    note('tool', 'qq_face_rename registered')
  } catch (error) {
    note('tool', `qq_face_rename register failed: ${error instanceof Error ? error.message : error}`)
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
export async function registerFacePreviewTool(ctx, signal) {
  try {
    const tools = await waitForTools(ctx, 'qq_tool', signal)
    if (tools === null) return
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
export async function registerHistoryTool(ctx, signal) {
  try {
    const tools = await waitForTools(ctx, 'qq_tool', signal)
    if (tools === null) return
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
            },
            // 历史消息里的图片（0.12.0）。
            // ⚠️ schema 是 additionalProperties:false，不在这里显式声明就会被宿主丢弃。
            //   ref 用 additionalProperties:true：附件引用的字段随宿主版本变
            //   （originalDimensions 之类），钉死字段名会在升级后变成 ToolOutputError。
            // order = 它在 messages 里的下标，render 靠它把图贴回所属那条消息。
            images: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  order: { type: 'number' },
                  ref: { type: 'object', additionalProperties: true }
                }
              }
            }
          },
          required: ['count', 'messages']
        },
        render: (args, value) => {
          const list = Array.isArray(value?.messages) ? value.messages : []
          if (list.length === 0) return [{ type: 'text', text: '没查到历史消息。' }]
          const images = Array.isArray(value?.images) ? value.images : []
          // order → 该条消息的图（一条消息可以有多张）
          const byOrder = new Map()
          for (const item of images) {
            const order = Number(item?.order)
            if (!Number.isFinite(order) || item?.ref === undefined || item.ref === null) continue
            const bucket = byOrder.get(order)
            if (bucket === undefined) byOrder.set(order, [item.ref])
            else bucket.push(item.ref)
          }
          const lines = list.map(
            (m) => `[${new Date(Number(m.time ?? 0) * 1000).toLocaleString('zh-CN')}] ${m.nickname}：${m.text}`
          )
          const blocks = [{ type: 'text', text: `查到 ${list.length} 条：\n${lines.join('\n')}` }]
          for (const [order, refs] of [...byOrder.entries()].sort((a, b) => a[0] - b[0])) {
            const at = list[order]
            if (refs.length > 0 && at !== undefined) {
              blocks.push({ type: 'text', text: `第 ${order + 1} 条（${at.nickname}）的图：` })
            }
            for (const ref of refs) blocks.push({ type: 'image', attachment: ref })
          }
          return blocks
        }
      },
      execute: async (args) => {
        const groupId = String(args?.group_id ?? '').trim()
        const userId = String(args?.user_id ?? '').trim()
        if (groupId === '' && userId === '') throw new Error('要查历史，得给 group_id（查群）或 user_id（查好友）')
        const target = groupId !== '' ? { kind: 'group', id: groupId } : { kind: 'private', id: userId }
        const list = await getHistory(target, Number(args?.count ?? 20) || 20, Number(args?.before_message_id ?? 0) || 0)
        // 只对「确实带图」的消息下载 —— 翻 100 条无图历史不该产生任何网络请求。
        // history.js 归一化后的字段是 segments / userId，而 buildImageBlocks 认
        // { sender.user_id, message:[段] }，这里做一次形状转换。
        const images = []
        for (let order = 0; order < list.length; order += 1) {
          const item = list[order]
          if (imageSegmentsOf(item?.segments).length === 0) continue
          const blocks = await buildImageBlocks(ctx, [{
            sender: { user_id: item.userId },
            message: item.segments
          }])
          for (const block of blocks) {
            if (block?.type === 'image' && block.attachment !== undefined) {
              images.push({ order, ref: block.attachment })
            }
          }
        }
        return {
          count: list.length,
          messages: list.map((item) => ({
            time: item.time,
            nickname: item.nickname || item.card || item.userId,
            text: item.text
          })),
          images
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
export async function registerQzoneTool(ctx, signal) {
  try {
    const tools = await waitForTools(ctx, 'qq_tool', signal)
    if (tools === null) return
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
export async function registerCollectTool(ctx, signal) {
  try {
    const tools = await waitForTools(ctx, 'qq_tool', signal)
    if (tools === null) return
    const disposeTool = tools.register({
      name: 'qq_collect_face',
      description:
        '把值得复用的表情包收进 QQ 收藏夹，之后 qq_send 优先从收藏里找语义合适的表情。'
        + '\n\n收藏判断（用户已允许你自主收藏，不必逐张询问）：'
        + '\n- 看到了 QQ 商城大表情 / 明确标记为「动画表情」的图，且值得以后复用时，可以直接收藏。'
        + '\n- 普通图片只有在你清楚看出它是可复用的梗图/反应图时才收藏；普通照片、截图、文件、聊天记录卡片和不确定的图不要收藏。'
        + '\n- 每条消息最多收一张最有代表性的图；如果收藏夹里已有同一张或同用途表情，不要重复收。'
        + '\n- 如果当前消息的图已经直接显示在上下文里，不必再调 qq_face_preview，直接用 message_id（正文中的 [#消息编号]）收藏；图没显示或张数不清时先预览。'
        + '\n- desc **必须**写成「简短名称 | 2-4 个情绪词」，例如「委屈小猫 | 委屈 撒娇 求安慰」。'
        + '\n  这是这条收藏以后被找到的**唯一线索** —— 写成剧情（「他甩了我那天」）就永远搜不到了。'
        + '\n  关键词写情绪和适用场景，不写故事：想被别人在什么心情下翻出来，就写那个心情。'
        + '\n\n参数：'
        + '\n   - message_id：从某条消息里收（填正文里 [#数字] 那个数字）。一条消息有多张图时用 image=N（默认 1）。'
        + '\n   - index=N：按「收到的图片」目录序号收藏（先 dir=true 查序号）'
        + '\n   - recent=N：收藏最近收到的第 N 张图；只有能确定对应目标时才用'
        + '\n   - file=：本地路径或 http(s) 图片直链'
        + '\n   - desc=：收藏备注，写名称和可搜索关键词'
        + '\n\ndir=true 列出收到的图片，list=true 列出收藏夹，delete= 删除收藏项（不可逆）。动图会保留原动画。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message_id: { type: 'string', description: '可选；从这条消息里收藏（填正文里 [#数字] 那个数字，可以带负号）。比 index/recent 更直接。' },
          image: { type: 'number', description: '可选；配合 message_id：那条消息里的第几张图（1 = 第一张，默认 1）。' },
          index: { type: 'number', description: '可选；按「收到的图片」目录里的序号收藏（1 = 最早收到的那张）。' },
          recent: { type: 'number', description: '可选；收藏最近收到的那张图，1 = 最新那张。' },
          file: { type: 'string', description: '可选；本地文件路径或 http(s) 图片直链。' },
          desc: { type: 'string', description: '可选；收藏备注，写「简短名称 | 2-4 个关键词」，例如「委屈小猫 | 委屈 撒娇 求安慰」。关键词用于 qq_send 的 custom_emoji 搜索。' },
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
            // 收藏结果的结构信息 —— 让 agent 能确认「收到的是不是真动图」
            media_type: { type: 'string' },
            bytes: { type: 'number' },
            frames: { type: 'number' },
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
            media_type: '',
            bytes: 0,
            frames: 0,
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
            media_type: '',
            bytes: 0,
            frames: 0,
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
            media_type: '',
            bytes: 0,
            frames: 0,
            files: [],
            faces: []
          }
        }
        // ④ 收藏
        const index = Number(args?.index ?? 0)
        const result = await collectFace({
          message_id: args?.message_id,
          image: Number(args?.image ?? 0),
          file: args?.file,
          recent: Number(args?.recent ?? 0),
          index: index > 0 ? index : 0,
          desc: args?.desc
        })
        const sizeText = `（${result.mediaType}${result.frames > 0 ? `，动图 ${result.frames} 帧` : ''}，${result.bytes} 字节）`
        return {
          ok: true,
          emoji_id: result.emojiId,
          origin: result.origin,
          // ⚠️ 返回字段必须跟上面 output.schema 对得上：
          //   schema 是 additionalProperties:false，多一个字段宿主就判 ToolOutputError，
          //   工具调用直接失败。schema 里没有 files/faces，这里也得给空数组。
          message: result.desc !== '' && result.desc !== undefined
            ? `已收藏 ${result.emojiId}${sizeText}（备注：${result.desc}）`
            : `已收藏 ${result.emojiId}${sizeText}`,
          media_type: result.mediaType,
          bytes: result.bytes,
          frames: result.frames,
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
export async function registerWaitTool(ctx, signal) {
  try {
    const tools = await waitForTools(ctx, 'qq_tool', signal)
    if (tools === null) return
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
            // 回合内等待账本（2026-11-03）。必须在 schema 里声明 ——
            // additionalProperties:false 会把多出来的字段判成 ToolOutputError，
            // 于是「额度用完了」这个正常结果反而变成工具调用失败。
            waitedThisTurn: { type: 'number' },
            /** 这一回合还剩多少等待额度；-1 = 没设上限。 */
            waitBudgetLeft: { type: 'number' },
            hint: { type: 'string' }
          }
        },
        render: (args, value) => {
          const list = Array.isArray(value?.newMessages) ? value.newMessages : []
          const left = Number(value?.waitBudgetLeft)
          const budgetLine = Number.isFinite(left) && left >= 0
            ? `\n[系统] 这一回合的等待额度还剩 ${Math.round(left / 1000)} 秒（已等 ${Math.round(Number(value?.waitedThisTurn ?? 0) / 1000)} 秒）。`
              + (left <= 0 ? '已经用完了，别再 qq_wait —— 现在开口，或者 qq_pass / qq_skip 收掉这一轮。' : '')
            : ''
          if (list.length === 0) return [{ type: 'text', text: `等了 ${value?.waitedMs ?? 0}ms，这段时间没人说话。${budgetLine}` }]
          const lines = list.map((m) => `- ${m.who}：${m.text}`)
          return [{ type: 'text', text: `等了 ${value?.waitedMs ?? 0}ms，来了 ${list.length} 条：\n${lines.join('\n')}${budgetLine}` }]
        }
      },
      execute: async (args) => {
        const target = targetOf(args)
        if (target === null) throw new Error('不知道要等谁：给 group_id 或 user_id，或在配置里设好默认私聊对象。')

        const config = getConfig()
        const wanted = clampLimit(args?.ms, 8000, 0, 60000)
        const cap = clampLimit(config?.waitMaxMs, 60000, 0, 300000)
        // ---- 回合内总时长闸（2026-11-03）----
        // 为什么要单独一道：waitMaxMs 只夹「一次」等多久，她可以连打四次 40 秒 ——
        // 回合照样拖到几分钟，这期间进来的消息全在排队（见 deliver.js 的 pushIntoAgent）。
        // 这里按 target 记「这一回合已经等了多久」，超了就**不再等**，直接回当前情况。
        // ⚠️ 超预算不是报错：报错会让她以为工具坏了、反复重试。返回一个正常结果，
        //   正文里说清楚「额度用完了」，她自然就转去说话或收尾。
        const budgetKey = targetKey(target)
        const turnCap = clampLimit(config?.waitTurnMaxMs, 60000, 0, 600000)
        const left = waitBudgetLeft(budgetKey, turnCap)
        const ms = Math.max(0, Math.min(wanted, cap, Number.isFinite(left) ? left : wanted))

        // 等之前先看一眼最新到哪了，等完才认得出哪些是新的
        const before = await getHistory(target, 20).catch(() => [])
        const seenIds = new Set(before.map((m) => Number(m.messageId)))
        const startedAt = Date.now()
        if (ms > 0) await new Promise((resolve) => { setTimeout(resolve, ms) })
        const waitedMs = Date.now() - startedAt
        const spentTotal = chargeWaitBudget(budgetKey, waitedMs)

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

        const exhausted = Number.isFinite(left) && waitedMs >= left
        return {
          waitedMs,
          newCount: fresh.length,
          newMessages: fresh,
          waitedThisTurn: spentTotal,
          waitBudgetLeft: Number.isFinite(left) ? Math.max(0, left - waitedMs) : -1,
          hint: fresh.length === 0
            ? (exhausted
                ? `这一回合的等待额度用完了（已等 ${Math.round(spentTotal / 1000)} 秒）。别再用 qq_wait 干等 —— 要么现在开口，要么用 qq_pass / qq_skip 收掉这一轮。`
                : '没人接话。可以开口，也可以什么都不做 —— 这段本来就没什么要回的。')
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
/**
 * 注册 qq_skip —— 「这条不该有回复」（0.16.16）。
 *
 * 为什么必须跟 `qq_pass` 分开成两个工具（用户实测的根因）：
 *   她判断出「这条不需要回」时，原来**没有无副作用的出口**：
 *     · 只调 `qq_pass` 但顺手写了正文 → 按既有语义「写了就算说出口」，正文照发；
 *     · 什么都不调、只写正文 → 自动转发把那段思考发到 QQ 上，聊天被强行续命。
 *   于是最省事的路变成「写一句解释我为什么不说」—— 这正是用户看到的
 *   「把该不该结束的判断念出来」。
 *
 *   `qq_pass` = 我看了，但这次先不开口（正文有真话仍照发，保护「说了却没收到的」）；
 *   `qq_skip` = 这条根本不该有回复（本回合正文一律不发）。
 *
 * ⚠️ 它**不**影响她已经用 `qq_send` 发出去的话 —— 那是真的说出口了。
 *   只压制「自动转发正文」这一条路。
 */
export async function registerSkipTool(ctx, signal) {
  try {
    const tools = await waitForTools(ctx, 'qq_tool', signal)
    if (tools === null) return
    const disposeTool = tools.register({
      name: 'qq_skip',
      description:
        '跳过 —— 这条我看过了，**它不该有回复**。这一回合就到此为止，什么都不会发出去。'
        + '\n\n什么时候用：'
        + '\n· 你判断这条不用回（话题已经收尾、对方在自言自语、只是发个表情/通知）。'
        + '\n· 你想说的其实只是「我为什么不说」—— 那就别写，直接调它。'
        + '\n\n⚠️ **判断不需要回时，直接调它，不要在正文里解释你为什么结束。**'
        + '\n你写下的任何文字都会成为要发出去的内容；解释了反而让话题又被续上。'
        + '\n\n和 qq_pass 的区别：qq_pass 是「我先不开口」（正文里的真话仍会发），'
        + '\nqq_skip 是「这条不该有回复」（正文一律不发）。判断不用回时用这个。'
        + '\n\n⚠️ 已经用 qq_send 发出去的话不受影响 —— 那是真说出口了。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          group_id: { type: 'string', description: '可选；跳过哪个群。' },
          user_id: { type: 'string', description: '可选；跳过哪个好友。留空且没给群号时指默认私聊对象。' },
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
        render: (args, value) => [{ type: 'text', text: String(value?.note ?? '已跳过') }]
      },
      execute: async (args) => {
        const target = targetOf(args)
        if (target === null) throw new Error('不知道要跳过哪个会话：给 group_id 或 user_id，或在配置里设好默认私聊对象。')
        const key = targetKey(target)
        const why = String(args?.why ?? '').trim()
        // 两条路都打：skip 管「正文一律不发」，turnHandled 让 qq_close 可以放行
        noteSkipTurn(key)
        noteTurnHandled(key)
        note('tool', `qq_skip key=${key}${why === '' ? '' : `（${why}）`}`)
        return { ok: true, note: '跳过了。这一回合什么都不发。' }
      }
    })
    if (typeof disposeTool === 'function') ctx.effect(() => disposeTool, 'dsh-onebot-channel: qq_skip tool')
    note('tool', 'qq_skip registered')
  } catch (error) {
    note('tool', `qq_skip register failed: ${error instanceof Error ? error.message : error}`)
  }
}

export async function registerPassTool(ctx, signal) {
  try {
    const tools = await waitForTools(ctx, 'qq_tool', signal)
    if (tools === null) return
    const disposeTool = tools.register({
      name: 'qq_pass',
      description:
        '划走 —— 这条我看完了，但这次不说话。'
        + '\n\n什么时候用：'
        + '\n· 没话说、不想接、接了也是敷衍。'
        + '\n· 这是转给别人看的笑话/接龙，轮不到我。'
        + '\n· 话题已经翻篇了，硬接只会显得没眼力见。'
        + '\n\n⚠️ 和 qq_skip 的区别（挑错了就等于没说）：'
        + '\n· **qq_skip** = 这条不该有回复 → 本回合正文一律不发。判断不用回时用它。'
        + '\n· **qq_pass** = 我看了，这次先不开口 → 但你正文里写的真话仍会发出去（写了就算说出口）。'
        + '\n所以如果你想说的是「我为什么不说」，用 qq_skip，别用这个；'
        + '如果你是真的想留一句话但不希望被当成回合开场，用这个。'
        + '\n\n⚠️ 它管的是「我这次不开口」，不是「把我刚写的话删掉」。'
        + '\n真不想让他看到任何东西：用 qq_skip，或者干脆什么正文都别写。'
        + '\n该开口时别用它：对方明确在问你、在求你办事，先答了再说。'
        + '\n\n想结束话题但拿不准该不该收尾时，用 qq_close；'
        + '\n纯粹判断「这条不用回」，用 qq_skip。',
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
        // 旁路记账：qq_close 撞上 openQuestion 时据此判断「她已经处理过了」
        noteTurnHandled(key)
        if (target.kind === 'group') notePass(target.id)
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
export async function registerCloseTool(ctx, signal) {
  try {
    const tools = await waitForTools(ctx, 'qq_tool', signal)
    if (tools === null) return
    const disposeTool = tools.register({
      name: 'qq_close',
      description:
        '收摊 —— 记下这段聊到哪儿了，以及下次可以怎么接。'
        + '\n\n什么时候用：'
        + '\n· 双方都说了收尾式的话（嗯/好/哈哈/晚安），再补一句就多余。'
        + '\n· 话题闭环了（事办完、问题答完、约定说定）。'
        + '\n· 双方越回越短，节奏明显疲了。'
        + '\n\n不用它的情况：**对方还在问你、还在求你办事** —— 这时候先回答。'
        + '\n工具会告诉你现在还不能收；**那是状态提示，不是要你说的话，别把它写进正文。**'
        + '\n\n⚠️ 收尾不会阻止你说话：想留最后一句话就先用 qq_send 说完再收。'
        + '\n⚠️ 如果你这一回合已经说过话、或 qq_pass / qq_skip 处理过了，收尾会直接放行。'
        + '\n连着被拒三次会强制收摊 —— 别在这儿反复试探，收不了就先说话。',
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
        render: (args, value) => [{
          type: 'text',
          text: describeClosureLine(value)
        }]
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
          if (target.kind === 'group') closeWindow(target.id, 'qq_close')
          // 状态码而不是一句话 —— 跟其它分支同一个契约（0.16.15）
          return { ok: true, closed: true, verdict: 'closed-no-check', score: 0, reasons: ['收尾判断关着，没做校验'] }
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
        // 「说完就走」的出口（0.16.15）：如果她这一回合已经说过话 / 划走过，
        // 说明她已经处理过对方那句了 —— 这时候允许关窗，只是不记 saveClosing
        // （不算真正闭环，下次不该带「上次聊到哪儿」）。
        // 用户实测的「结束不了话题」正是卡在这：openQuestion 本意是替她把门，
        // 但不该替她把自己锁在屋里。
        const handledThisTurn = wasTurnHandled(key)
        if (verdictResult.openQuestion && !handledThisTurn) {
          // ⚠️ 这里必须 return 一个**状态码**，不是一句话（0.16.15 的核心修复）。
          //   原来返回的是自然语言「对方还在问……先把话说完再说」，
          //   模型会把它当成「我该说的内容」写进正文，于是判断结论被发到 QQ 上。
          //   对方是 AI 时更糟：它顺着这段元讨论回应，两边互相不肯先停。
          const forced = noteCloseRefused(target.kind === 'group' ? target.id : key)
          // 防线二：这一回合 qq_close 被拒了 → 正文不转发（大概率是元话语）
          noteCloseRefusedTurn(key)
          return {
            ok: false,
            closed: forced,
            verdict: forced ? 'forced-closed' : 'open-question',
            score: verdictResult.score,
            // 强制收摊时把「对方还在问」那条理由换掉（0.16.16 审核建议）：
            //   留着它会让模型读到「对方还在问，不能丢下」+「已强制收摊」两个相反的信号，
            //   它很可能又去补一句话 —— 那正好抵消了强制收摊的意义。
            reasons: forced
              ? ['连续收尾被拒，已强制收摊；这一回合到此为止']
              : verdictResult.reasons
          }
        }
        // 同回合已处理过 → 关窗，但不记收尾（没闭环，不该说「上次聊到哪儿」）
        if (verdictResult.openQuestion && handledThisTurn) {
          note('tool', `qq_close 同回合已处理过对方的提问，放行关窗 key=${key}`)
          if (target.kind === 'group') closeWindow(target.id, 'qq_close-handled')
          clearCloseRefusals(target.kind === 'group' ? target.id : key)
          return {
            ok: true,
            closed: true,
            verdict: 'closed-no-check',
            score: verdictResult.score,
            reasons: [...verdictResult.reasons, '这一回合已经回应过对方']
          }
        }
        saveClosing(key, { summary, next })
        if (target.kind === 'group') {
          closeWindow(target.id, 'qq_close')
          clearCloseRefusals(target.id)
        } else {
          clearCloseRefusals(key)
        }
        return {
          ok: true,
          closed: true,
          verdict: 'closed',
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
export async function registerRememberTool(ctx, signal) {
  try {
    const tools = await waitForTools(ctx, 'qq_tool', signal)
    if (tools === null) return
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

/**
 * qq_poke —— 戳一戳（拍一拍）某个人。
 *
 * 为什么值得单独一个工具：戳一戳是 QQ 里**最轻**的一次「叫你一声」——
 * 比发消息轻得多，适合「嘿、看这里」「别装死」这种场合，
 * 也适合在不值得开一段对话时用来打招呼。发消息反而太重。
 *
 * 目标必须过白名单（走 callOneBot，闸门自然生效）——
 * 不然群里一句 prompt injection 就能让她去戳任意号，那是骚扰。
 */
export async function registerPokeTool(ctx, signal) {
  try {
    const tools = await waitForTools(ctx, 'qq_poke', signal)
    if (tools === null) return
    const disposeTool = tools.register({
      name: 'qq_poke',
      description:
        '戳一下某人（QQ 的「拍一拍」）—— 比发消息轻得多的「叫你一声」。'
        + '\n\n什么时候用：'
        + '\n· 想引起注意但没话要说（「嘿」「看这里」，发整条消息太重）'
        + '\n· 对方半天没回话，轻轻戳一下，不催'
        + '\n· 回应别人戳你 —— 但别自动「谁戳我我戳回去」，那样会互相戳到停不下来'
        + '\n\n⚠️ 戳一戳是个会亮出来的动作：对方手机会有提示。别拿它刷屏。'
        + 'QQ 对戳一戳有频率限制，连戳太多次会被拒。'
        + '\n\n只能戳「插件正在服务的对象」（已绑定的好友/群 + 用户本人）。'
        + '范围外的号会被拒绝 —— 不要换个写法重试。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          user_id: { type: 'string', description: '要戳谁的 QQ 号。' },
          group_id: { type: 'string', description: '可选；在哪个群戳。留空 = 私聊戳（好友拍一拍）。' }
        }
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            user_id: { type: 'string' },
            group_id: { type: 'string' },
            where: { type: 'string' }
          },
          required: ['ok']
        },
        render: (args, value) => [{
          type: 'text',
          text: value?.ok === true
            ? `戳了 ${value?.user_id ?? ''} 一下（${value?.where ?? ''}）`
            : '戳一戳没发出去'
        }]
      },
      execute: async (args) => {
        const config = getConfig()
        const groupId = String(args?.group_id ?? '').trim()
        const userUin = String(args?.user_id ?? '').trim()
        if (userUin === '') {
          throw new Error('要戳谁？给 user_id（QQ 号）。在群里戳就再带上 group_id。')
        }
        const result = await sendPoke({ userUin, groupId, selfUin: String(config.selfUin ?? '') })
        return {
          ok: true,
          user_id: result.userUin,
          group_id: result.groupId,
          where: result.groupId !== '' ? `群 ${result.groupId}` : '私聊'
        }
      }
    })
    if (typeof disposeTool === 'function') ctx.effect(() => disposeTool, 'dsh-onebot-channel: qq_poke tool')
    note('tool', 'qq_poke registered')
  } catch (error) {
    note('tool', `qq_poke register failed: ${error instanceof Error ? error.message : error}`)
  }
}

/**
 * qq_voice —— 把一条语音消息转成文字。
 *
 * 为什么按 message_id 取，而不是按「第几条」：
 *   正文里每条消息已经带了 `[#数字]` 锚点（refOf），那是唯一的、跨通路稳定的身份。
 *   按序号取会跟「收到的图片」目录那套一样，一重启/一刷新就对不上。
 *
 * 为什么不自动转写：见 lib/voice.js 文件头 —— 它转不出来时要卡满 20 秒，
 * 挂在入站投递链上就是整条链路停摆。
 */
export async function registerVoiceTool(ctx, signal) {
  try {
    const tools = await waitForTools(ctx, 'qq_tool', signal)
    if (tools === null) return
    const disposeTool = tools.register({
      name: 'qq_voice',
      description:
        '听清一条语音上说了什么 —— 把语音转成文字。'
        + '\n\nQQ 消息正文里的 `[语音]` 只是个占位，你看不到内容。'
        + '想知道他到底说了什么，就把那条消息正文里的 `[#数字]` 填进 message_id 调这里。'
        + '\n\n什么时候用：'
        + '\n· 他发了语音，而这条语音看起来是要接话的（不是随手发的）'
        + '\n· 语音后面跟了句「你听听」「我说完了」这类明显在等回应的话'
        + '\n\n⚠️ 转不出来是常事，不是这条语音不存在：'
        + '刚发的语音有时要过一会儿才转得出来，超时/失败时**别反复重试**，'
        + '直接跟他说「语音我没听清，再说一遍或者打字」。'
        + '\n⚠️ 一次调用要等几秒到二十几秒，只在真的需要知道内容时才调。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message_id: {
            type: 'string',
            description: '要转写哪条语音。填正文里 `[#数字]` 那个数字（例如正文写着 [#-2123597213] 就填 -2123597213）。'
          }
        },
        required: ['message_id']
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            text: { type: 'string' },
            error: { type: 'string' }
          },
          required: ['ok']
        },
        render: (args, value) => [{
          type: 'text',
          text: value?.ok === true
            ? `语音内容是：「${value?.text ?? ''}」`
            : `这条语音没转出文字（${value?.error ?? '原因不明'}）。`
              + '别重试，直接跟他说「语音我没听清，再说一遍或者打字」。'
        }]
      },
      execute: async (args) => {
        const result = await transcribeVoice(String(args?.message_id ?? '').trim())
        return result.ok === true
          ? { ok: true, text: result.text }
          : { ok: false, error: result.error }
      }
    })
    if (typeof disposeTool === 'function') ctx.effect(() => disposeTool, 'dsh-onebot-channel: qq_voice tool')
    note('tool', 'qq_voice registered')
  } catch (error) {
    note('tool', `qq_voice register failed: ${error instanceof Error ? error.message : error}`)
  }
}

/** 全部经典表情名清单，给别处（比如提示词）用。 */
export { faceNameList }
