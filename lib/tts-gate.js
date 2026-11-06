/**
 * tts-gate.js —— 语音的三道闸（2026-11-07，0.19.0）。
 *
 * 和 tts.js 的分工：
 *   tts.js       「怎么合成」（纯技术，不关心该不该做）
 *   tts-gate.js  「能不能合成」（策略：档位 / 名单 / 额度）
 *
 * 为什么拆开：`tts.js` 要能被单测直接调用（给一段字就出文件），
 * 而闸门要读配置、要记账、要跟设置页交互。混在一起会让「测合成」变成
 * 「先造一份完整配置」—— 本仓库已经在 state/window 那几处吃过这个亏。
 *
 * ## 三道闸的顺序很重要
 *
 *   ① 档位（voiceMode）—— 最便宜，纯读配置，先拦
 *   ② 名单（voiceTargetsPrivate / voiceTargetsGroup）—— 纯读配置
 *   ③ 额度（voiceDailyChars）—— 只有 breeze 才算，且**必须在调 API 之前**
 *
 * ⚠️ 额度闸的位置不能挪到合成之后：那时钱已经花了，「拒绝」只是拒了一个
 *    已经扣过费的请求。测试 `tts-quota-sim` 专门断言这条（超额度时
 *    **没有发生网络请求**）。
 */

import { getConfig, VOICE_MODE_LABELS } from './config.js'
import { note } from './env.js'
import { synthesize, fetchBreezeAccount } from './tts.js'

// ==================== ① 档位 ====================

/** 当前档位能不能发语音。`off` 是唯一的「不能」。 */
export function modeAllowsVoice(config = getConfig()) {
  return String(config?.voiceMode ?? 'off') !== 'off'
}

/**
 * 给她看的「现在为什么不能发语音」。
 *
 * ⚠️ 文案要**指路到设置页**，而不是只说「不允许」—— 模型看到「不允许」会
 *    换个说法再试（正是 tool.js 文件头警告的那种烧 token 方式）。
 */
export function modeRefusal(config = getConfig()) {
  const mode = String(config?.voiceMode ?? 'off')
  if (mode !== 'off') return null
  return '现在没开语音功能（设置 → 对话节奏 → 语音模式 → 选一个不是「禁用」的档），暂时发不了语音。'
}

// ==================== ② 名单 ====================

/**
 * 把一个目标规整成名单里的 key。
 *
 * 格式与 `proactiveTargets` 一致：`private:<uin>` / `group:<gid>`。
 * 认不出来返回 null（**不猜**：猜错等于放行错的人）。
 *
 * @param {{kind:'private'|'group', id:string|number}} target
 */
export function targetKey(target) {
  const kind = target?.kind
  if (kind !== 'private' && kind !== 'group') return null
  const id = String(target?.id ?? '').trim()
  if (id === '') return null
  return `${kind}:${id}`
}

/**
 * 这个目标在不在名单里。
 *
 * **空名单 = 全部放行** —— 和「主动搭话」的语义保持一致：默认不限，
 * 用户想限的时候才去勾。
 *
 * ⚠️ 但 `off` 档不受这条影响：档位是总闸，名单只是第二道。
 */
/**
 * 这个目标在不在名单里。
 *
 * ## 语义：**空名单 = 谁都不能用**（2026-11-07 用户要求反转）
 *
 * 原来是「空 = 全部放行」，理由是与「主动搭话」的白名单保持一致。
 * 但用户指出这不符合直觉：
 *
 * > 「一个都不勾 = 全都不能用」这样更符合直觉
 *
 * 他是对的 —— 这张卡的名字是**「能使用语音的对象」**，
 * 一份空名单按字面意思就是「没有人」。而且语音会花钱（Breeze 按字计费），
 * 默认放行所有人是**危险的那一侧**：用户没配 → 群里谁都能触发付费合成。
 *
 * 所以改成：**必须显式勾选**，一个都没勾 = 谁都不行。
 * 迁移：老配置里 `[]` 的人会被自动补成「当前已绑的全部对象」，
 * 免得升级后语音突然全哑（见 config.js 的 migrateVoiceTargets）。
 */
export function targetAllowed(target, config = getConfig()) {
  const key = targetKey(target)
  if (key === null) return { ok: false, error: '不知道这条语音该发给谁（内部错误：目标不合法）' }

  const isGroup = target.kind === 'group'
  const raw = isGroup ? config?.voiceTargetsGroup : config?.voiceTargetsPrivate
  const list = Array.isArray(raw) ? raw.map((item) => String(item ?? '').trim()).filter((item) => item !== '') : []

  // 空 = 谁都不能用（必须显式勾选）
  if (list.length === 0) {
    return {
      ok: false,
      error: `语音对象名单是空的，谁都不能用（设置 → 主动搭话 → 能使用语音的对象里勾上要开语音的${isGroup ? '群' : '人'}）`
    }
  }

  if (list.includes(key)) return { ok: true }
  return {
    ok: false,
    error: `当前${isGroup ? '群' : '对话对象'}没开语音（设置 → 主动搭话 → 能使用语音的对象里勾上 TA），发不了`
  }
}

/**
 * 合并检查 ①②。返回 null = 放行。
 */
export function checkTarget(target, config = getConfig()) {
  const modeError = modeRefusal(config)
  if (modeError !== null) return modeError
  const allowed = targetAllowed(target, config)
  return allowed.ok === true ? null : allowed.error
}

// ==================== ③ 额度 ====================

/**
 * 计费字数怎么算。
 *
 * Breeze 的官方口径（实测文档 + 计费页）：
 *   CJK 字符（汉字、假名、谚文）= 2 units，其余 1 units，10 units = 1 credit。
 * 所以 1 credit = 5 个汉字。
 *
 * 额度按「汉字等价字数」记，也就是直接数字符 —— 用户填「1000 汉字/天」
 * 就是「1000 个字符/天」。不把拉丁字母折算成半个汉字：
 * 那种折算在配置项上没法解释，而用户要的只是「别把钱花超」。
 *
 * @returns {number} 计费字符数（不含空白 —— 空白不计费也不该占额度）
 */
export function billableChars(text) {
  const body = String(text ?? '')
  // Breeze 的 billable units 里「空格」是 1 unit，但它不是你说的「字」。
  // 这里去掉空白再数，宁可少算也不让「一堆空格」吃掉额度。
  return body.replace(/\s/g, '').length
}

/** 某天（本地自然日）的 key。跨自然日重置靠它。 */
export function dayKey(now = Date.now()) {
  const date = new Date(now)
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/**
 * 额度账本。
 *
 * 为什么放模块级而不是落盘：这是一天的量，进程重启丢一次是可以接受的
 * 代价远小于「多写一个状态文件」—— 而状态文件要处理并发写、损坏、
 * 迁移，本仓库已经在 state.js 上花过一次学费。
 * ⚠️ 代价说清楚：**重启 DSH 会重置当天额度**。这在设计上可接受
 *    （重启是用户主动行为，不是攻击面），但设置页的说明里要提一句。
 */
let quota = { day: '', used: 0 }

/** 仅测试用。 */
export function resetQuota() {
  quota = { day: '', used: 0 }
}

/** 读当前用量（设置页显示用）。 */
export function quotaStatus(config = getConfig(), now = Date.now()) {
  const day = dayKey(now)
  const used = quota.day === day ? quota.used : 0
  const limit = Number(config?.voiceDailyChars ?? 0)
  const cap = Number.isFinite(limit) && limit > 0 ? limit : 0
  return {
    day,
    used,
    limit: cap,
    remaining: cap === 0 ? Infinity : Math.max(0, cap - used),
    unlimited: cap === 0
  }
}

/**
 * 预扣额度。**必须在调 API 之前调**。
 *
 * @returns {{ok:true, chars:number} | {ok:false, error:string}}
 */
export function chargeQuota(chars, config = getConfig(), now = Date.now()) {
  const day = dayKey(now)
  if (quota.day !== day) quota = { day, used: 0 }

  const limit = Number(config?.voiceDailyChars ?? 0)
  const cap = Number.isFinite(limit) && limit > 0 ? limit : 0
  if (cap === 0) return { ok: true, chars: 0 }        // 0 = 不限

  if (quota.used + chars > cap) {
    const left = Math.max(0, cap - quota.used)
    return {
      ok: false,
      error: `今天 Breeze 的语音额度快用完了（剩 ${left} 字 / 共 ${cap} 字）。`
        + '可以改用本机引擎（免费），或者等明天 —— 别为了凑字数去缩短句子'
    }
  }
  quota.used += chars
  return { ok: true, chars }
}

/**
 * 合成失败时把预扣的额度退回去。
 *
 * ⚠️ 为什么要退：额度是**预扣**的（调 API 前扣），而 API 可能失败。
 *    不退的话「失败一次就白扣一次」，用户看到额度掉了却没拿到音频。
 * ⚠️ 退回要**钳到 0**：并发下可能出现「扣 A、退 B」的交错，
 *    不钳的话 used 会变成负数，之后所有请求都被放行。
 */
export function refundQuota(chars, now = Date.now()) {
  const day = dayKey(now)
  if (quota.day !== day) return          // 跨天了，旧账本来就不该再动
  quota.used = Math.max(0, quota.used - Math.max(0, Number(chars) || 0))
}

// ==================== gptsobits 用的假计费 ====================

/**
 * 这一单要不要计费。
 *
 * **只有 breeze 计费**。GPT-SoVITS 是本机算力，免费 —— 给它记额度
 * 会让「1000 字/天」变成「本机也不让用」，那不是用户要的。
 */
export function chargesQuota(engine) {
  return String(engine ?? '') === 'breeze'
}

// ==================== 对外主入口 ====================

/**
 * 带全部闸门的合成。
 *
 * 顺序：档位 → 名单 → 引擎判定 → （breeze 时）额度预扣 → 排队合成
 *       → 失败退款。
 *
 * @param {string} text
 * @param {{kind:'private'|'group', id:string|number}} target
 * @param {{config?:object}} [options]
 * @returns {Promise<{ok:true, path:string, engine:string, chars:number, ms:number, bytes:number}
 *                 | {ok:false, error:string}>}
 */
export async function synthesizeForTarget(text, target, options = {}) {
  const config = options.config ?? getConfig()

  // ① 档位
  const modeError = modeRefusal(config)
  if (modeError !== null) return { ok: false, error: modeError }

  // ② 名单
  const allowed = targetAllowed(target, config)
  if (allowed.ok !== true) return { ok: false, error: allowed.error }

  // 内容审计在 synthesize 里（它先于一切网络调用），这里不用重复

  const engine = String(config?.voiceEngine ?? '') === 'breeze' ? 'breeze' : 'gptsovits'
  const chars = billableChars(text)

  // ③ 额度：**只有 breeze 计费**，且必须在调 API 之前
  let charged = 0
  if (chargesQuota(engine)) {
    const chargedResult = chargeQuota(chars, config)
    if (chargedResult.ok !== true) {
      note('tts', `额度不足，拒绝合成：需要 ${chars} 字，剩 ${quotaStatus(config).remaining}`)
      return { ok: false, error: chargedResult.error }
    }
    charged = chargedResult.chars
  }

  let result
  try {
    result = await synthesize(text, { config, engine })
  } catch (error) {
    // synthesize 本身不抛，但排队队列会抛（队列太长）
    if (charged > 0) refundQuota(charged)
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: message }
  }

  if (result.ok !== true) {
    // 失败了就把预扣的额度退回去 —— 用户没拿到音频，不该算钱
    if (charged > 0) {
      refundQuota(charged)
      note('tts', `合成失败，退还 ${charged} 字额度`)
    }
    return result
  }
  return result
}

/**
 * Breeze 账户体检（设置页「测一下」和余额卡用）。
 *
 * 没填 key 时返回 ok:false 而不是抛 —— 设置页要能安静地显示「未配置」。
 */
export async function breezeAccount(config = getConfig()) {
  const key = String(config?.voiceBreezeKey ?? '').trim()
  if (key === '') return { ok: false, error: '还没填 Breeze 的 API key' }
  return fetchBreezeAccount(key)
}

/** 档位的中文名（日志/UI 共用）。 */
export function modeLabel(config = getConfig()) {
  const mode = String(config?.voiceMode ?? 'off')
  return VOICE_MODE_LABELS[mode] ?? mode
}
