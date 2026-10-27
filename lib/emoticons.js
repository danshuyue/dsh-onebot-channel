/**
 * emoticons.js —— QQ 表情段（face / mface）→ 文本。
 *
 * OneBot 11 里「表情」有两种段，别混：
 *   face  —— QQ 自带的经典小表情，固定的一百来号图案。字段是 id / cid，
 *            没有图片链接，也没有可读名字，只有编号。
 *   mface —— QQ 表情商城的大表情（群聊里那种带文字的 GIF）。
 *            字段是 emoji_id / key / summary，还可能带 url / file / thumb 图片链接。
 *
 * 参考 Yuuyuko-uu/dsh-qq-bridge 的做法：mface 有图片就当图片看，
 * 没图片就退化成 [表情:summary]。但本插件是自用、不做图片下载，
 * 所以统一只渲染文本 —— 有 summary 就报出 summary，让 agent 看得出对方在发什么梗。
 */

/**
 * 经典表情 cid → 中文名。
 * 只收公认的 0~34 号那段（QQ 最早那批表情，编号各家协议端基本一致），
 * 往上编号在不同协议端里对不上，宁可原样报编号也不瞎猜名字。
 */
const FACE_NAMES = new Map([
  [0, '惊讶'],
  [1, '撇嘴'],
  [2, '色'],
  [3, '发呆'],
  [4, '得意'],
  [5, '流泪'],
  [6, '害羞'],
  [7, '闭嘴'],
  [8, '睡'],
  [9, '大哭'],
  [10, '尴尬'],
  [11, '发怒'],
  [12, '调皮'],
  [13, '呲牙'],
  [14, '微笑'],
  [15, '难过'],
  [16, '酷'],
  [17, '晕'],
  [18, '吐'],
  [19, '偷笑'],
  [20, '可爱'],
  [21, '白眼'],
  [22, '傲慢'],
  [23, '饥饿'],
  [24, '困'],
  [25, '惊恐'],
  [26, '流汗'],
  [27, '憨笑'],
  [28, '悠闲'],
  [29, '奋斗'],
  [30, '咒骂'],
  [31, '疑问'],
  [32, '嘘'],
  [33, '晕'],
  [34, '衰']
])

/** 掐短文本，表情名别把整行撑爆。 */
function clip(text, max = 20) {
  const value = String(text ?? '').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** 经典表情（face）：有 cid 就查中文名，查不到就把编号原样报出来。 */
export function faceTextOf(data) {
  const cid = String(data?.cid ?? data?.id ?? '').trim()
  if (cid === '') return '[表情]'
  const name = FACE_NAMES.get(Number(cid))
  return name !== undefined ? `[表情:${name}]` : `[表情:${cid}]`
}

/**
 * 商城大表情（mface）：优先用 summary（官方给的表情标题），其次 key / emoji_id。
 * 都没有就退回「[表情]」，别让 default 分支把它渲染成 [mface] 这种没人看得懂的原始类型名。
 */
export function mfaceTextOf(data) {
  const summary = clip(data?.summary ?? '')
  if (summary !== '') return `[表情:${summary}]`
  const key = clip(data?.key ?? '')
  if (key !== '') return `[表情:${key}]`
  const emojiId = clip(data?.emoji_id ?? '')
  if (emojiId !== '') return `[表情:${emojiId}]`
  return '[表情]'
}

/** 任意表情段 → 文本；不是表情段返回空串。 */
export function emojiTextOf(segment) {
  switch (segment?.type) {
    case 'face':
      return faceTextOf(segment?.data)
    case 'mface':
      return mfaceTextOf(segment?.data)
    default:
      return ''
  }
}
