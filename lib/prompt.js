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
  const section = {
    name: PROMPT_SECTION_NAME,
    order: PROMPT_SECTION_ORDER,
    // 见文件头约束 1：绝不能开插值
    interpolate: false,
    text: LONG_TASK_SECTION_TEXT
  }

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
      note('prompt', `已注册常驻段落 ${PROMPT_SECTION_NAME}（直取）`)
      return true
    } catch (error) {
      note('prompt', `直取注册失败：${error instanceof Error ? error.message : error}`)
    }
  }

  // 慢路径：走 cordis 的 inject（dsh-ops 也是这么拿 systemPrompt 的）。
  // 服务迟迟不来时回调不会执行 —— 只是少这一段提示，不影响任何收发。
  if (typeof ctx.inject !== 'function') {
    note('prompt', '没有 systemPrompt 服务，也没法 inject：本版不带「长任务先出声」提示')
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
        note('prompt', `已注册常驻段落 ${PROMPT_SECTION_NAME}（inject）`)
      } catch (error) {
        note('prompt', `inject 注册失败：${error instanceof Error ? error.message : error}`)
      }
    })
    return true
  } catch (error) {
    note('prompt', `ctx.inject 抛错：${error instanceof Error ? error.message : error}`)
    return false
  }
}
