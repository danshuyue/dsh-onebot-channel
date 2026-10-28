/**
 * qzone.js —— QQ 空间「发说说」。
 *
 * 范围说明：只做**发说说**（B 档里用户唯一点名要的一项）。
 *   - 不做发图片到空间（qq_send 发图片是 B 档另一项，用户没要）
 *   - 不做删说说（delete_qzone_msg —— C 档，已在 lib/blocked.js 物理封禁）
 *   - 不做拉黑（set_qzone_ban —— C 档，已封禁）
 *
 * 协议端参数（SnowLuma 2.2.0）：
 *   send_qzone_msg { content(必填), images?, ugc_right(默认1=所有人可见), target_uins? }
 *   ugc_right 取值：1=所有人可见  4=仅好友可见  16=仅私密（自己可见）  64=指定好友  128=分组可见
 *
 * ⚠️ 这是**对外发布**动作 —— 发出去别人就看得到，且没有撤销接口可用（删说说被封禁）。
 *   所以调用前必须有明确的用户指令，不能凭「我觉得这里该发一条」就发。
 */
import { callOneBot } from './onebot.js'
import { note } from './env.js'
import { getConfig } from './config.js'
import { assertClean } from './sensitive.js'

/** 可见性取值 → 中文说明。 */
export const QZONE_VISIBILITY = {
  1: '所有人可见',
  4: '仅好友可见',
  16: '仅自己可见',
  64: '指定好友可见',
  128: '分组可见'
}

/** 协议端接受的可见性取值。 */
const ALLOWED_RIGHTS = new Set([1, 4, 16, 64, 128])

/**
 * 发一条说说。
 *
 * @param {object} options
 * @param {string} options.content 正文（必填，不能为空）
 * @param {number} [options.visibility=1] 可见性，取值见 QZONE_VISIBILITY
 * @param {string[]} [options.targetUins] 指定好友可见时的 QQ 号列表
 * @param {boolean} [options.confirm=false] 显式确认（见下方确认闸）
 * @returns {object} 协议端返回结果
 */
export async function sendQzoneMsg(options = {}) {
  const content = String(options?.content ?? '').trim()
  if (content === '') throw new Error('说说正文是空的，不能发空说说')
  if (content.length > 1000) throw new Error('说说正文太长（超过 1000 字）')

  // ---- 确认闸（2026-10-28）----
  // 注释里一直写着「必须有明确用户指令」，但代码层面从来没强制过 ——
  // agent 想发就能发。而删说说的接口是封禁的，发出去就撤不回来。
  // 所以改成硬闸：必须显式传 confirm=true 才放行。
  // 这不是防"恶意"，是逼 agent 在发之前把「这是对外发布」这件事真的过一遍脑子。
  if (getConfig()?.qzoneRequireConfirm !== false && options?.confirm !== true) {
    throw new Error(
      '发说说需要显式确认：请把 confirm 传成 true 再调一次。'
      + '（说说是对外发布，且插件不提供删除能力，发出去撤不回来。'
      + '如果用户还没明确说「发说说」，就别发，先问他。）'
    )
  }

  // 内容审计：说说正文同样可能夹带本机路径 / 凭据
  assertClean(content, '说说')

  const right = Number(options?.visibility ?? 1)
  if (!ALLOWED_RIGHTS.has(right)) {
    throw new Error(`可见性取值不合法：${right}（可选 ${[...ALLOWED_RIGHTS].join(' / ')}）`)
  }

  const params = { content, ugc_right: right }
  const targets = Array.isArray(options?.targetUins)
    ? options.targetUins.map((item) => Number(item)).filter((item) => Number.isSafeInteger(item) && item > 0)
    : []
  if (targets.length > 0) params.target_uins = targets

  const result = await callOneBot({ action: 'send_qzone_msg', params })
  if (result?.retcode !== 0) {
    throw new Error(`发说说失败：retcode=${result?.retcode} ${result?.wording ?? result?.message ?? ''}`)
  }
  note('qzone', `已发表说（${QZONE_VISIBILITY[right] ?? right}），${content.length} 字`)
  return result
}
