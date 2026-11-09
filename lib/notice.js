/**
 * notice.js —— 回合中断时替插件说一句人话（**不是她说的**）。
 *
 * 为什么需要（2026-11-03 用户提出）：
 *   「模型出现报错等中断就不会发送任何消息，这会导致 QQ 侧用户迟迟收不到相应。」
 *   一个回合失败（接口报错 / 上下文超限 / 回合丢了）时，插件现在的处理只有一行日志，
 *   QQ 那头**一片安静** —— 对面以为自己被无视了，或者以为消息没发出去。
 *   这跟「她不回话」在用户眼里是同一件事，但性质完全不同：
 *   前者是故障，后者是她的选择（qq_pass / qq_skip）。故障必须说出来。
 *
 * ⚠️ 三条纪律：
 *   1. **绝不冒充她说话**。docs/待办.md §6 红线「绝不硬拼文案」说的是
 *      「她说什么」必须由模型决定；这里发的是插件自己的系统通知，
 *      所以统一带 `[系统]` 前缀，一眼能看出不是她的口气。
 *   2. **用户自己点停止不算故障**。`turn/end` 的 reason.kind === 'aborted'
 *      一律静默（见 `noticeKindOf` 的注释）—— 否则他手动掐一个回合，
 *      QQ 那边会收到一条「她出错了」，那才是真的莫名其妙。
 *   3. **默认发到「这条对话正在用的渠道」**，但 0.20.0 起可配：
 *      待转发队列的条目（outbound.js 的 entry.target）本来就是**这次投递的那个
 *      私聊号或群**，多绑几个会话也不会发错人。这正是「原路回传」的口径，
 *      也是 `notifyTarget` 的默认档；另两档（全回传私聊 / 不回传）见 `noticeRouteOf`。
 *
 * 出口只有一个：`sendOneToQQ` → `callOneBot`。
 * 所以白名单 / 封禁清单照旧生效，不会因为「这是系统通知」就绕过闸门。
 */
import { getConfig, normalizeNotifyTarget } from './config.js'
import { loadMemory } from './memory.js'
import { note } from './env.js'

/**
 * ⚠️ `outbound.js` 要 import 本模块（它在 flushOutbound 里调用通知），
 * 所以这里**不能**顶层 import 回去 —— 那是一个真实的循环依赖。
 * 用函数内动态 import：只在真的要发通知时才解析一次，之后走模块缓存。
 * （本插件已经因为 window.js ↔ poll.js 的循环依赖踩过一次，别再写第二遍。）
 */
async function senderOf() {
  const { sendOneToQQ } = await import('./outbound.js')
  return sendOneToQQ
}

/**
 * 同一个目标两条通知之间的最小间隔。
 *
 * 为什么需要：一次接口故障往往连着打好几个回合（重试、下一条消息、主动搭话），
 * 每个回合都发一条「出错了」，对面看到的就是刷屏。
 * 一分钟一条，足够让对面知道情况，又不会变成噪音。
 */
export const NOTICE_COOLDOWN_MS = 60000

/**
 * 三种情形，三种说法。**都不带她的口气**，也不承诺具体时间。
 *
 * 用词规矩：
 *   · 说清楚「能不能补救」——「可以再发一条」，别让人干等；
 *   · 不暴露实现细节（模型名、错误码、插件名），那对面看不懂也不需要知道；
 *   · 不催、不道歉式堆砌，一句话说完。
 */
export const NOTICE_TEXT = {
  /** 回合以 reason.kind === 'error' 收尾：接口报错、超限、解析失败。 */
  error: '[系统] 这一回合出错了，她的回复没能发出来。可以再发一条，或者稍后再试。',
  /** 有 turn/end，但 kind === 'interrupted'（DSH 崩溃后补的合成收尾）。 */
  interrupted: '[系统] 上一回合被中断了，她的回复没能发出来。可以再发一条。',
  /** 等满 TTL 也没有 turn/end，而且 agent 已经不在跑了 —— 这一回合真的丢了。 */
  lost: '[系统] 这一回合中断了，她的回复没能发出来。可以再发一条，或者稍后再试。',
  /** 等满 TTL 也没有 turn/end，但 agent 还在跑 —— 只是在闷头做，说一句别让人干等。 */
  stalled: '[系统] 她还在处理这条，暂时没有新进展。有结果会发给你。'
}

/** 目标 → 上次通知的时间。按 `group:123` / `private:456` 记。 */
const lastNoticeAt = new Map()

/**
 * 这个 reason 该不该惊动对面。
 *
 * @param {object|undefined} reason `turn/end` 的 `data.reason`
 * @returns {'error'|'interrupted'|''} 该发的通知类型；空串 = 什么都不发
 */
export function noticeKindOf(reason) {
  const kind = String(reason?.kind ?? '')
  if (kind === 'error') return 'error'
  // 崩溃恢复补的合成收尾（dsh-session/repair.js 的 openTurnClosers）。
  // 它**不会**带 error 字段，所以只按 kind 认。
  if (kind === 'interrupted') return 'interrupted'
  // ⚠️ 这里**故意**把 'aborted' 连同它的父子因一起吞掉：
  //     user      = 用户自己点了停止（他当然知道自己在停）
  //     disposed  = DSH 正在卸载/重启（插件自己都要走了，发出去也没人接手）
  //     parent    = 上层编排取消
  //     hook      = 钩子取消
  //   全都属于「有意为之的沉默」，不是故障。宁可少发一条，也不要把「我按了停止」
  //   播报成「她出错了」。
  return ''
}

/** 目标键（和 rhythm.js 的 targetKey 同构，这里不 import 免得绕一圈）。 */
function keyOf(target) {
  const kind = String(target?.kind ?? '').trim()
  const id = String(target?.id ?? '').trim()
  if (kind === '' || id === '') return ''
  return `${kind}:${id}`
}

/**
 * 群的显示名（拿不到就空串）。
 *
 * 为什么从关系卡里取而不是再请求一次 `get_group_info`：
 *   ① 入站每投递一条群消息就 `touchPeer('group:xxx', { nick: groupName })`，
 *      关系卡里**本来就有**群名 —— 再发一次网络请求纯属浪费；
 *   ② 通知是故障路径，这时候协议端很可能正不健康（正是它出错才要发通知）——
 *      再叠一个必失败的请求，只会把「发通知」也拖慢。
 *   ③ notice.js ← outbound.js ← poll.js 已经是链条了，顶层 import poll.js 会成环。
 */
function groupLabelOf(groupId) {
  const key = `group:${String(groupId ?? '').trim()}`
  if (key === 'group:') return ''
  try {
    const card = loadMemory(key)
    const nick = String(card?.nick ?? '').trim()
    return nick !== '' ? nick : `群 ${String(groupId)}`
  } catch {
    // 关系卡读坏了不该让通知发不出去
    return `群 ${String(groupId)}`
  }
}

/**
 * 群显示名（导出版）。
 *
 * 0.21.4：`outbound.js` 把群里那段「本该进群」的正文改投私聊时，要加同样的
 * `【群聊 …】` 前缀 —— 两边各写一份必然漂移（一边改了名字来源、另一边不知道）。
 * 所以这里只做一次「函数提升可见性」，不复制实现。
 */
export function groupLabelFor(groupId) {
  return groupLabelOf(groupId)
}

/** 「回传私聊」的目标：ownerUin 优先，其次 peerUin；取不到返回 null。 */
export function privateRouteTarget() {
  const config = getConfig() ?? {}
  const uin = Number(config.ownerUin) > 0 ? Number(config.ownerUin) : Number(config.peerUin)
  if (!(uin > 0)) return null
  return { kind: 'private', id: String(uin) }
}

/**
 * 系统消息该发到哪（0.20.0 三选一）。
 *
 * @param {object} target 这条对话本身的目标（`group:123` / `private:456`）
 * @returns {{target: object, prefix: string} | null} null = 不发（off 档）
 */
export function noticeRouteOf(target) {
  const config = getConfig() ?? {}
  const mode = normalizeNotifyTarget(config.notifyTarget)
  if (mode === 'off') return null
  if (mode !== 'private') return { target, prefix: '' }

  // 全回传私聊：群里的故障也进私聊，但要让人一眼看出「这是哪个群的事」。
  const uin = Number(config.ownerUin) > 0
    ? Number(config.ownerUin)
    : Number(config.peerUin)
  if (!(uin > 0)) {
    // 没配私聊对象 → **退回原路**，不能把通知丢掉（「配错了」不等于「别发了」）
    note('notice', 'notifyTarget=private 但没配 ownerUin/peerUin，本次退回原路')
    return { target, prefix: '' }
  }
  const prefix = String(target?.kind ?? '') === 'group'
    ? `【${groupLabelOf(target?.id)}】`
    : ''
  return { target: { kind: 'private', id: String(uin) }, prefix }
}

/**
 * 发一条系统通知。同一目标在冷却期内只发一次。
 *
 * 失败一律吞掉：通知本身发不出去时，**最坏的结局是「跟没加这个功能一样」**，
 * 绝不能反过来让它在 flushOutbound 的循环里抛错、把别的会话的转发也带崩。
 *
 * @param {object} target `{ kind:'group'|'private', id }`
 * @param {keyof typeof NOTICE_TEXT} kind
 * @param {string} [why] 只进日志，不发给任何人
 * @returns {Promise<boolean>} 真的发出去了？
 */
export async function notifyTurn(target, kind, why = '') {
  // ⚠️ 两个开关都看：notifyTarget 是 0.20.0 的主开关（三选一），
  //    notifyTurnFailures 是 0.19.x 的存量布尔（loadConfig 会把它迁进 notifyTarget，
  //    但用户也可能手改配置文件又把旧键写回来）。任一关掉就是不发。
  if (getConfig()?.notifyTurnFailures === false) return false
  const text = NOTICE_TEXT[kind]
  if (text === undefined) return false
  const key = keyOf(target)
  if (key === '') {
    note('notice', `没有目标，通知发不出去（${kind}）${why === '' ? '' : `：${why}`}`)
    return false
  }
  const route = noticeRouteOf(target)
  if (route === null) {
    note('notice', `notifyTarget=off，不发「${kind}」通知 key=${key}`)
    return false
  }
  const now = Date.now()
  const previous = lastNoticeAt.get(key)
  if (previous !== undefined && now - Number(previous) < NOTICE_COOLDOWN_MS) {
    note('notice', `冷却中，跳过「${kind}」通知 key=${key}`)
    return false
  }
  // 先记账再发：发送失败也照冷却走，否则协议端挂掉时每一轮 flush 都会重试一次
  lastNoticeAt.set(key, now)
  try {
    const sendOneToQQ = await senderOf()
    // 前缀只加在 'private' 档的群来源上（`【群聊 名】`）——
    // 落到私聊以后，没有前缀就分不清「这是哪个群出的故障」。
    await sendOneToQQ(route.target, `${route.prefix}${text}`)
    note('notice', `已发出「${kind}」通知 -> ${key}${route.prefix === '' ? '' : `（改投 ${keyOf(route.target)}，带前缀）`}${why === '' ? '' : `（${why}）`}`)
    return true
  } catch (error) {
    note('notice', `「${kind}」通知发送失败 key=${key}：${error instanceof Error ? error.message : error}`)
    return false
  }
}

/**
 * 按条目打一次通知 —— 同一条目同一类型只打一次。
 *
 * 为什么要按条目去重（而不只靠时间冷却）：
 *   TTL 那条路径会**保留条目**继续等（见 outbound.js 的注释），
 *   每过一个 TTL 就会再走到这里一次。只靠 60 秒冷却的话，
 *   一个跑了 10 分钟的长任务会收到 10 条「她还在处理」。
 *
 * @param {object} entry outbound 队列条目
 * @param {keyof typeof NOTICE_TEXT} kind
 * @param {string} [why]
 */
export async function notifyEntryOnce(entry, kind, why = '') {
  const marks = entry?.noticeSent
  if (marks !== null && typeof marks === 'object' && marks[kind] === true) return false
  const sent = await notifyTurn(entry?.target, kind, why)
  if (sent && entry !== null && entry !== undefined) {
    // 只有真发出去才记账：被冷却挡掉的那次不算数，下一个 TTL 还有机会
    if (typeof entry.noticeSent !== 'object' || entry.noticeSent === null) entry.noticeSent = {}
    entry.noticeSent[kind] = true
  }
  return sent
}

/** 测试用：清掉冷却账本。 */
export function clearNoticeState() {
  lastNoticeAt.clear()
}
