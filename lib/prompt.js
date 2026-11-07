/**
 * prompt.js —— 一段常驻的系统提示：**长任务先出声**。
 *
 * 为什么需要（2026-11-03 用户提出）：
 *   QQ 那头的人发一句「帮我看看这个」，她如果直接埋头干活（读文件、跑命令、
 *   多步推进），这几分钟里 QQ 上是**一片安静**——对面以为消息没送到、或者人不在。
 *   真人的做法是先回一句「在弄了，等我一会儿」，再去做。
 *   这不是她能自己学会的事：她看不到「对面在干等」这件事，只知道手里的活。
 *
 * 为什么做成**系统段落**而不是拼进正文：
 *   · 拼正文 = 每条 QQ 消息后面都挂一段说明，长会话里重复几百遍（纯烧 token），
 *     而且混在用户原话后面，她分不清哪句是用户说的、哪句是插件塞的
 *     —— poll.js 里已经因为同一件事删掉过一段「表情标记说明」。
 *   · 系统段落每次组装提示词时才渲染一次，不进会话历史，重启后也在。
 *
 * ⚠️ 三条硬约束（改文案前先读）：
 *   1. **必须 `interpolate: false`**。不然正文里万一出现 `{{某某}}`，
 *      宿主渲染时会当成变量引用去查表，查不到就**抛错**——
 *      而它抛在提示词组装路径上，等于让每个回合都开不了口。
 *   2. **注册在插件（全局）作用域，所有会话都会看到**，包括跟 QQ 无关的会话。
 *      所以文案必须把自己限定在「带 QQ 前缀的消息」上，对别的会话必须是空话。
 *   3. **只写纪律，不写台词**。docs/待办.md §6 红线：绝不硬拼文案。
 *      这里只能规定「先开口说一句」，说什么仍然是她自己判断。
 *
 * 服务取用：systemPrompt 是核心服务，但它不在本插件的 inject 名单里
 * （为一个可选增强去扩大 inject，会让整个插件在缺少该服务时加载失败）。
 * 所以走 `ctx.inject(['systemPrompt'], …)`：拿不到就只少这一段落，
 * 主链路（收发/工具/设置页）完全不受影响。
 */
import { note, serviceOf } from './env.js'
import { getConfig } from './config.js'

/** 段落名。带插件前缀，避免和宿主的 harness:/deployment: 段落撞名。 */
export const PROMPT_SECTION_NAME = 'qq-channel:long-task'

/**
 * 排序位。宿主 `SECTION_ORDERS` 里 10100 = WEB_SURFACE、10200 = 部署人设尾巴。
 * 放 10150：在「说话方式」之后、「人设收尾」之前 —— 人设永远保留最后一句话。
 */
export const PROMPT_SECTION_ORDER = 10150

/**
 * 正文。**每条消息都会带上它**，所以每多一个字都是每回合的固定成本。
 * 写成给她看的第二人称，不出现「插件」「桥接」这类实现细节。
 */
export const LONG_TASK_SECTION_TEXT = [
  '【QQ 通道 · 长任务先出声】',
  '带「（QQ 私聊…」或「（QQ群 …」前缀的消息，是 QQ 那头的人在等你的回话；没有前缀的话与 QQ 无关，别往 QQ 发。',
  '先判断这一条要不要长时间作业（要调工具、读文件、查资料、跑命令、多步推进，明显不止一两句问答）：',
  '要的话，**先 qq_send 一句很短的话**让对方知道你收到了、正在做，再开始干活。',
  '说什么由你自己定（按你平时的口气，别套模板），重点是「收到 + 在弄了 + 大概要等」。',
  '干活途中有了阶段结果，可以再 qq_send 一句；干完了把结论发出去。',
  '不需要长作业的普通对话**别**这么做 —— 每句话都先「稍等我看看」只会显得啰嗦。'
].join('\n')

/**
 * 挂上这段提示。返回是否真的挂上了（挂不上只记日志，不抛）。
 *
 * @param {object} ctx 插件上下文
 * @returns {boolean} true = 已注册
 */
export function mountPromptSection(ctx) {
  return registerSection(ctx, {
    name: PROMPT_SECTION_NAME,
    order: PROMPT_SECTION_ORDER,
    // 见文件头约束 1：绝不能开插值
    interpolate: false,
    text: LONG_TASK_SECTION_TEXT
  })
}

/**
 * 「直取 / inject 两步走」的注册器。**两个段落共用这一份**。
 *
 * 为什么抽出来：语音段落（0.19.0）和长任务段落必须用**完全相同**的服务获取顺序。
 * 复制一份看着省事，但这两条路每一条都带着「拿不到服务时只少一段提示、绝不抛」
 * 的纪律 —— 抄的时候漏掉一个 try，插件加载就会因为一段可选的提示而整体失败。
 *
 * 三步各有理由（照抄 mountPromptSection 原本的形状，只是参数化）：
 *   ① 直取：服务现在就取得到时最省事，也不用额外 inject 声明；
 *   ② inject：cordis 的服务可能晚于 apply 出现，等它来了再注册；
 *   ③ 全程吞错：段落是**可选增强**，它的失败不该影响收发主链路。
 *
 * @param {object} ctx 插件上下文
 * @param {{name:string, order:number, interpolate:false, text:string}} section
 * @returns {boolean} true = 已注册（inject 分支算「已安排」，也返回 true）
 */
function registerSection(ctx, section) {
  // 快路径：服务现在就取得到（宿主已注册，本插件也不需要额外 inject 声明）。
  // 取不到会抛 "without inject" —— 那是正常情况，落到下面的 inject 路径。
  let direct = null
  try {
    direct = serviceOf(ctx, 'systemPrompt')
  } catch {
    direct = null
  }
  if (direct !== null && direct !== undefined && typeof direct.section === 'function') {
    try {
      direct.section(section)
      note('prompt', `已注册常驻段落 ${section.name}（直取）`)
      return true
    } catch (error) {
      note('prompt', `直取注册失败（${section.name}）：${error instanceof Error ? error.message : error}`)
    }
  }

  // 慢路径：走 cordis 的 inject（dsh-ops 也是这么拿 systemPrompt 的）。
  // 服务迟迟不来时回调不会执行 —— 只是少这一段提示，不影响任何收发。
  if (typeof ctx.inject !== 'function') {
    note('prompt', `没有 systemPrompt 服务，也没法 inject：本版不带 ${section.name} 段落`)
    return false
  }
  try {
    ctx.inject(['systemPrompt'], (sub) => {
      try {
        const systemPrompt = serviceOf(sub, 'systemPrompt')
        if (systemPrompt === null || systemPrompt === undefined || typeof systemPrompt.section !== 'function') {
          note('prompt', 'systemPrompt 服务形状不对，跳过常驻段落')
          return
        }
        systemPrompt.section(section)
        note('prompt', `已注册常驻段落 ${section.name}（inject）`)
      } catch (error) {
        note('prompt', `inject 注册失败（${section.name}）：${error instanceof Error ? error.message : error}`)
      }
    })
    return true
  } catch (error) {
    note('prompt', `ctx.inject 抛错：${error instanceof Error ? error.message : error}`)
    return false
  }
}

// ==================== 语音段落（0.19.0）====================

/** 语音段落的段落名。与长任务段落并列，各自独立启停。 */
export const VOICE_SECTION_NAME = 'qq-channel:voice'

/**
 * 语音段落的排序位 = 长任务段落 + 1。
 *
 * 为什么不复用同一个 order：宿主按 order 排序，「紧跟长任务之后」正是想要的
 * 位置关系（先讲「什么时候开口」，再讲「用什么方式开口」）。
 * 直接写 `PROMPT_SECTION_ORDER + 1` 而不是 10151 是为了让这层关系在代码里看得见 ——
 * 哪天有人调整长任务的位置，语音段落自动跟着走，不会悄悄跑到别处去。
 */
export const VOICE_SECTION_ORDER = PROMPT_SECTION_ORDER + 1

/**
 * 各档位的正文（§8.2 逐字）。
 *
 * 四档语义的定义在 `config.js` 的 `VOICE_MODE_HELP` —— 那里是**给用户看的**，
 * 这里是**给她看的**。同一件事两种口吻，不是重复：用户要的是「这个模式干什么」，
 * 她要的是「这一回合我该怎么选」。
 *
 * ⚠️ 三份文案都不提「引擎」「API」「额度」这类实现细节 —— 那属于设置页。
 *    唯一例外是 breeze 那笔计费（见 VOICE_BILLED_NOTE），因为它直接影响
 *    她的决策：会花钱的东西不该和免费的用同一套语气去用。
 */
export const VOICE_SECTION_TEXTS = {
  /** 被动：默认不打语音，只有明确要求才用。 */
  passive: [
    '【QQ 通道 · 语音】',
    '你能把文字合成为语音发出去（qq_tts → qq_send 的 voice 参数），但现在默认**不要**这样做。',
    '只有对方明确要求你说出来（「发条语音」「用声音说」）时才用。',
    '其余情况一律打字 —— 语音在群里是「冒头」的动作，滥用会烦人。'
  ].join('\n'),

  /** 自由：判断权交给她，并给出「什么时候不该用」的判据。 */
  free: [
    '【QQ 通道 · 语音】',
    '你能把文字合成为语音发出去（qq_tts → qq_send 的 voice 参数）。',
    '该不该用由你判断：一句话能说清的事打字更合适；',
    '句子长、有情绪、或者你想让人「听见」而不是「读到」的时候，可以用语音。',
    '多数时候你其实不需要它 —— 别为了用而用。'
  ].join('\n'),

  /** 主动：默认用语音，并列出「别念出来」的边界。 */
  active: [
    '【QQ 通道 · 语音】',
    '你能把文字合成为语音发出去。**默认就用语音**，这是这个会话的设定。',
    '',
    '具体怎么做（两步，别跳过第一步）：',
    '1. 调 `qq_tts`，把要说的话填进 `text`，拿到一个音频文件路径；',
    '2. 再调 `qq_send`，把这个路径填进 `voice` 参数 —— 语音才会真的发出去。',
    '',
    '**只调 qq_send 不带 voice，发出去的就是文字** —— 那是没按设定做。',
    '什么时候可以只用文字：对方明确要求打字；或者这句话不适合念出来',
    '（代码、路径、列表、链接、需要精确复制的东西）；或者你要发的是表情/图片。',
    '除此以外都用语音。'
  ].join('\n')
}

/**
 * breeze 追加的那一句。
 *
 * ⚠️ **只在 breeze 引擎下出现**。GPT-SoVITS 是本机算力、免费 ——
 *    给免费引擎写「按字计费」是撒谎，而且会让她无谓地吝惜一个不要钱的能力。
 */
export const VOICE_BILLED_NOTE = '（用的是商业接口，按字数计费 —— 有每日额度，别浪费。）'

/**
 * 按当前档位和引擎拼出语音段落的正文。
 *
 * 导出是为了让测试能直接断言四档各自的产物，不必起一个 systemPrompt 服务。
 *
 * @param {object} [config] 配置（默认取单例）
 * @returns {string|null} null = 这一档不注册段落（off）
 */
export function voiceSectionText(config = getConfig()) {
  const mode = String(config?.voiceMode ?? 'off')
  // off 档整段不注册：模型不需要知道有这回事。
  // 只写「别用」还不够 —— 提了「你能发语音」就等于给了她一个念头，
  // 而在 off 档下 qq_tts 根本不注册、qq_send 的 voice 参数也从 schema 里摘掉了，
  // 说了她也做不到，只会多烧 token 外加一次 UNKNOWN_TOOL。
  const body = VOICE_SECTION_TEXTS[mode]
  if (typeof body !== 'string' || body === '') return null

  const billed = String(config?.voiceEngine ?? '') === 'breeze'
  return billed ? `${body}\n${VOICE_BILLED_NOTE}` : body
}

/**
 * 挂上语音段落。返回是否真的挂上了（挂不上只记日志，不抛）。
 *
 * 与 `mountPromptSection` 的区别只有两处：段落名/order 不同，
 * 以及 `off` 档下**什么都不注册**（返回 false）。
 *
 * @param {object} ctx 插件上下文
 * @param {object} [config] 配置（默认取单例；测试可注入）
 * @returns {boolean} true = 已注册
 */
export function mountVoicePromptSection(ctx, config = getConfig()) {
  const text = voiceSectionText(config)
  if (text === null) {
    note('prompt', `语音段落跳过：voiceMode=${String(config?.voiceMode ?? 'off')}（off 档不注册）`)
    return false
  }
  return registerSection(ctx, {
    name: VOICE_SECTION_NAME,
    order: VOICE_SECTION_ORDER,
    // 见文件头约束 1：绝不能开插值（正文含 `**` 之类，且未来文案可能带花括号）
    interpolate: false,
    text
  })
}
