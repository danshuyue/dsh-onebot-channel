/**
 * 收藏表情的选择与降级（0.16.14）。
 *
 * 钉住的缺陷：「她从来不发收藏表情」。
 * 实测真实收藏夹 22 个，summary 协议端根本不返回（靠 desc 兜底），
 * 22 个里 21 个备注是**具体句子**（「穷光蛋思考中」「问号呆脸」「拿棒球棍打死，对付油腻男用」），
 * 按「委屈 / 撒娇 / 无语 / 好笑」这种情绪词去搜 —— 8 次里 6 次落空。
 *
 * 而旧代码在落空时 `throw`，等于「表情没搜到 → 整句话都发不出去」。
 * 模型学到的不是「换个词」，而是「别碰 custom_emoji」。这就是负向强化的来路。
 *
 * 所以这个测试守三件事：
 *   1. 降级：表情没匹配上，文字必须照发（核心回归）
 *   2. 可观测：日志 + 返回值 + render 三处都要说「表情没发出去」，不能静默
 *   3. 能看见：qq_face_pick 能让模型按情绪列出候选，且不抛错
 *
 * 隔离：整个测试跑在临时 HOME 里，不碰真的 ~/.dsh。
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SANDBOX_HOME = join(HERE, '..', '..', '.tmp-test', `face-pick-${process.pid}`)
const SANDBOX_DATA = join(SANDBOX_HOME, '.dsh')
mkdirSync(SANDBOX_DATA, { recursive: true })
process.env.USERPROFILE = SANDBOX_HOME
process.env.HOME = SANDBOX_HOME
process.on('exit', () => {
  try { rmSync(SANDBOX_HOME, { recursive: true, force: true }) } catch { /* 清不掉不算失败 */ }
})

const GROUP = '975663147'
const PEER = '3472302240'
const SELF = '3655191092'
const SESSION = 'session-face-pick-test'

writeFileSync(join(SANDBOX_DATA, 'qq-bridge.config.json'), JSON.stringify({
  enabled: true,
  selfUin: SELF,
  peerUin: PEER,
  ownerUin: PEER,
  onebotHttp: 'http://127.0.0.1:3000/',
  token: 'test-token',
  mergeWindowMs: 0,
  replyQuietMs: 0,
  splitReply: false,
  autoForwardReply: false,
  backfillOnStart: false,
  memoryEnabled: false,
  proactiveEnabled: false,
  allowSendToAny: true,
  routes: { private: {}, group: { [GROUP]: { sessionId: SESSION } } }
}, null, 2), 'utf8')
writeFileSync(join(SANDBOX_DATA, 'qq-bridge-state.json'), JSON.stringify({
  lastId: 0, lastSeq: 0, lastTime: 0, privates: {}, groups: {}
}, null, 2), 'utf8')

// ---- 假协议端 ----
// 采集到的每个 action，用来断言「到底发了什么」
let calls = []
let customFaceList = []
let sendFails = false
globalThis.fetch = async (_url, init) => {
  const payload = JSON.parse(init.body)
  calls.push(payload)
  if (payload.action === 'fetch_custom_face_detail') {
    // ⚠️ 协议端真实形状：只有 emoji_id / url / desc，**没有 summary**
    return {
      ok: true,
      json: async () => ({
        retcode: 0,
        data: customFaceList.map((item) => ({ emoji_id: item.emojiId, url: '', desc: item.desc }))
      })
    }
  }
  if (payload.action === 'send_custom_face') {
    if (sendFails) return { ok: true, json: async () => ({ retcode: 100, message: 'boom' }) }
    return { ok: true, json: async () => ({ retcode: 0, data: { message_id: 777 } }) }
  }
  if (payload.action === 'send_group_msg' || payload.action === 'send_private_msg') {
    return { ok: true, json: async () => ({ retcode: 0, data: { message_id: 888 } }) }
  }
  return { ok: true, json: async () => ({ retcode: 0, data: null }) }
}

const { loadConfig, getConfig } = await import('../lib/config.js')
const { loadState, getState } = await import('../lib/state.js')
const { rankCustomFaces, findCustomFace } = await import('../lib/custom-faces.js')
const { registerSendTool, registerFacePickTool, registerFaceRenameTool } = await import('../lib/tool.js')
const { FACE_PICK_MAX_LIMIT } = await import('../lib/custom-faces.js')

loadConfig()
loadState()
const cfg = getConfig()
Object.assign(cfg, { allowSendToAny: true })

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.error(`  ✗ ${name}`) }
}
function eq(actual, expected, name) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, `${name}${same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`)
}

/** 把工具注册进假 registry，拿到可调用的 execute / render。 */
const regs = new Map()
const toolCtx = {
  get: (name) => (name === 'tools'
    ? { register: (t) => { regs.set(t.name, t); return () => {} } }
    : (name === 'attachments' ? { saveImages: async () => [] } : undefined)),
  effect: () => {}
}
await registerSendTool(toolCtx)
await registerFacePickTool(toolCtx)
await registerFaceRenameTool(toolCtx)

ok(regs.has('qq_send') && regs.has('qq_face_pick') && regs.has('qq_face_rename'), '三个工具都注册上了')

const textOfOutput = (rendered) => (Array.isArray(rendered) ? rendered : [])
  .map((block) => (block?.type === 'text' ? String(block.text ?? '') : '')).join('\n')

// ---------------------------------------------------------------------------
// 1. 真实收藏夹的形状：desc 是句子，情绪词搜不到
// ---------------------------------------------------------------------------
console.log('rankCustomFaces（按真实收藏夹的形状）：')
{
  // 这就是本机实测的 22 个里挑出来的代表，**没有一个情绪词**
  customFaceList = [
    { emojiId: 'A_0_0_0_1', desc: '穷光蛋思考中' },
    { emojiId: 'A_0_0_0_2', desc: '问号呆脸' },
    { emojiId: 'A_0_0_0_3', desc: '橘猫歪头疑惑' },
    { emojiId: 'A_0_0_0_4', desc: '呜嘿嘿坏笑' },
    { emojiId: 'A_0_0_0_5', desc: '荧·脸红满足 | 得意 满足 害羞' }
  ]

  // 关键词能命中句子里的词 → 有候选
  const hit = await rankCustomFaces('疑惑')
  ok(hit.length === 1 && hit[0].item.desc === '橘猫歪头疑惑', '关键词命中备注里的词就能找到')
  ok(typeof hit[0].score === 'number' && hit[0].score > 0, '命中的项 score > 0')

  // ⚠️ 本测试的核心事实：情绪词搜不到，且**不能返回一堆不相关的**（score 0 必须滤掉）
  const miss = await rankCustomFaces('委屈 撒娇')
  eq(miss, [], '按情绪词搜不到时返回空数组（而不是一堆 score 0 的无关候选）')

  // 逗号分隔也要能拆（模型常写「得意，害羞」）
  const multi = await rankCustomFaces('得意，害羞')
  ok(multi.length >= 1, '逗号分隔的多关键词能拆开逐个匹配')
}

console.log('rankCustomFaces（排序与上限）：')
{
  customFaceList = [
    { emojiId: 'B_0_0_0_1', desc: '委屈小猫 | 委屈' },
    { emojiId: 'B_0_0_0_2', desc: '委屈柴犬 | 委屈 难过 求安慰' },
    { emojiId: 'B_0_0_0_3', desc: '开心小猫 | 开心 撒娇' }
  ]
  const ranked = await rankCustomFaces('委屈，求安慰')
  ok(ranked.length >= 2, '多个候选都返回（不是只给第一名）')
  ok(ranked[0].item.desc.includes('柴犬'), '多个词都命中的排在只命中一个的前面')
  ok(ranked.every((entry) => entry.score > 0), '返回的每一项 score 都 > 0')

  // 完全不相关的不该混进来
  ok(!ranked.some((entry) => entry.item.desc.includes('开心')), '一个词都没命中的表情不会混进候选')

  // 完全相等 → 10000 分
  customFaceList = [
    { emojiId: 'C_0_0_0_1', desc: '坏笑' },
    { emojiId: 'C_0_0_0_2', desc: '呜嘿嘿坏笑' }
  ]
  const exact = await rankCustomFaces('坏笑')
  ok(exact[0].item.desc === '坏笑', '精确相等的排第一')
  ok(exact[0].score === 10000, `精确相等拿 10000 分（实际 ${exact[0].score}）`)

  // limit 生效且被夹住
  customFaceList = Array.from({ length: 20 }, (_, i) => ({ emojiId: `D_0_0_0_${i}`, desc: `测试词 ${i}` }))
  eq((await rankCustomFaces('测试词', 3)).length, 3, 'limit 生效')
  eq((await rankCustomFaces('测试词', 999)).length, FACE_PICK_MAX_LIMIT, `limit 被夹到上限 ${FACE_PICK_MAX_LIMIT}`)

  // 空收藏夹不抛
  customFaceList = []
  eq(await rankCustomFaces('委屈'), [], '空收藏夹返回 []，不抛错')
  ok((await findCustomFace('委屈')) === null, 'findCustomFace 空收藏夹仍返回 null（行为未变）')
}

// ---------------------------------------------------------------------------
// 2. qq_face_pick：能看见收藏夹，且永不抛错
// ---------------------------------------------------------------------------
console.log('qq_face_pick：')
{
  const pick = regs.get('qq_face_pick')
  customFaceList = [
    { emojiId: 'A_0_0_0_3', desc: '橘猫歪头疑惑' },
    { emojiId: 'A_0_0_0_4', desc: '呜嘿嘿坏笑' }
  ]
  const found = await pick.execute({ query: '疑惑' })
  ok(found.ok === true, 'ok=true')
  ok(found.count === 1, `命中 1 个（实际 ${found.count}）`)
  ok(found.faces[0].name === '橘猫歪头疑惑', '每项有 name')
  ok(found.faces[0].emoji_id === 'A_0_0_0_3', '每项有 emoji_id')
  ok(typeof found.faces[0].score === 'number', '每项有 score')

  // ⚠️ 挑中的名字必须能回传给 qq_send 搜得到，否则「挑中了也发不出去」
  const back = await findCustomFace(found.faces[0].name)
  ok(back !== null && back.emojiId === 'A_0_0_0_3', '挑出来的名字能回传给 qq_send 用（往返一致）')

  // 不给关键词 → 列全部（≤ 30）
  const all = await pick.execute({})
  ok(all.ok === true && all.count === 2, `不给关键词列出全部（实际 ${all.count}）`)

  // 搜不到：ok=true + count=0 + 有说明，**不抛**
  let threw = false
  let missResult = null
  try {
    missResult = await pick.execute({ query: '委屈' })
  } catch (error) {
    threw = true
  }
  ok(!threw, '搜不到时【不抛错】（查询不是命令）')
  ok(missResult?.ok === true && missResult?.count === 0, '搜不到时 ok=true count=0')
  ok(String(missResult?.message ?? '').includes('没有匹配'), '搜不到时的 message 说明了情况')

  // 收藏夹为空：不崩
  customFaceList = []
  const empty = await pick.execute({})
  ok(empty.ok === true && empty.count === 0, '收藏夹为空时 ok=true count=0')
  ok(String(empty.message ?? '').includes('空的'), '收藏夹为空时 message 说明是空的')
  const emptyQuery = await pick.execute({ query: '无语' })
  ok(emptyQuery.ok === true && emptyQuery.count === 0, '空收藏夹 + 带关键词也不崩')
  ok(String(emptyQuery.message ?? '').includes('没有匹配'), '空收藏夹 + 带关键词时说的是「没有匹配」')

  // 协议端不支持 fetch_custom_face_detail（retcode != 0）→ 当成空，不崩
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ retcode: 1404, message: 'unsupported' }) })
  let crash = false
  let unsupported = null
  try {
    unsupported = await pick.execute({ query: '卖萌' })
  } catch (error) {
    crash = true
  }
  globalThis.fetch = realFetch
  ok(!crash, '协议端不支持 fetch_custom_face_detail 时不崩')
  ok(unsupported?.ok === true && unsupported?.count === 0, '协议端不支持时返回 count=0')

  // render 要把候选和「怎么发」说清楚
  customFaceList = [{ emojiId: 'A_0_0_0_4', desc: '呜嘿嘿坏笑' }]
  const rendered = textOfOutput(pick.output.render({ query: '坏笑' }, await pick.execute({ query: '坏笑' })))
  ok(rendered.includes('呜嘿嘿坏笑'), 'render 里列出了候选名字')
  ok(rendered.includes('custom_emoji'), 'render 告诉模型怎么把它发出去')
}

// ---------------------------------------------------------------------------
// 3. qq_send 的降级：这是本次的核心回归
// ---------------------------------------------------------------------------
console.log('qq_send 的表情降级（核心）：')
{
  const send = regs.get('qq_send')
  customFaceList = [{ emojiId: 'A_0_0_0_1', desc: '穷光蛋思考中' }]

  // ---- 3a. 表情匹配不上 → 文字必须照发 ----
  calls = []
  let threw = false
  let result = null
  try {
    result = await send.execute({ group_id: GROUP, text: '这句话必须发出去', custom_emoji: '委屈' })
  } catch (error) {
    threw = true
    console.error(`    （抛了：${error.message}）`)
  }
  ok(!threw, '表情匹配不上时【不抛错】（旧行为是整句失败）')
  const sentText = calls.filter((c) => c.action === 'send_group_msg')
  ok(sentText.length > 0, '文字仍然发出去了（这是本次最重要的回归）')
  const textBody = JSON.stringify(sentText[0]?.params ?? {})
  ok(textBody.includes('这句话必须发出去'), '发出去的就是模型写的那句话')
  ok(!calls.some((c) => c.action === 'send_custom_face'), '没匹配上就不发那个表情')

  // ---- 3b. 三处可观测：返回值 / render / 日志 ----
  eq(result?.custom_emoji_missed, '委屈', '返回值里 custom_emoji_missed 有值')
  const rendered = textOfOutput(send.output.render({}, result))
  ok(rendered.includes('委屈'), 'render 说明了是哪个表情没匹配上')
  ok(rendered.includes('[系统]'), 'render 用 [系统] 前缀，避免被当成聊天内容复述')
  ok(rendered.includes('qq_face_pick'), 'render 引导模型下次先查收藏夹')

  // ---- 3c. 匹配上时行为与改动前一致：表情单独一条 ----
  calls = []
  const hitResult = await send.execute({ group_id: GROUP, text: '配个表情', custom_emoji: '穷光蛋' })
  ok(calls.some((c) => c.action === 'send_custom_face'), '匹配上时发了收藏表情')
  const faceCall = calls.find((c) => c.action === 'send_custom_face')
  eq(faceCall?.params?.emoji_id, 'A_0_0_0_1', '发的是匹配到的那个 emoji_id')
  ok((hitResult?.custom_emoji_missed ?? '') === '', '匹配上时返回值里没有 custom_emoji_missed')
  const okRendered = textOfOutput(send.output.render({}, hitResult))
  ok(!okRendered.includes('[系统]'), '匹配上时 render 不加系统提示（与改动前一致）')

  // ---- 3d. 只有表情没有文字 + 表情也没匹配上 → 必须报错（不能静默成功）----
  calls = []
  let emptyThrew = false
  try {
    await send.execute({ group_id: GROUP, custom_emoji: '委屈' })
  } catch (error) {
    emptyThrew = true
    ok(error.message.includes('qq_face_pick'), '「没东西可发」时的报错引导模型先查收藏夹')
  }
  ok(emptyThrew, '只有表情、表情又没匹配上时报错（不能静默「成功」）')
  ok(!calls.some((c) => c.action === 'send_group_msg'), '这种情况什么都没发出去')

  // ---- 3e. 只有表情、匹配上了 → 正常只发表情 ----
  calls = []
  await send.execute({ group_id: GROUP, custom_emoji: '穷光蛋' })
  ok(calls.some((c) => c.action === 'send_custom_face'), '只有表情且匹配上时正常发送')

  // ---- 3f. 完全不传 custom_emoji → 一切照旧 ----
  calls = []
  const plain = await send.execute({ group_id: GROUP, text: '普通一句话' })
  ok(!calls.some((c) => c.action === 'send_custom_face'), '不传 custom_emoji 时不碰收藏表情')
  ok((plain?.custom_emoji_missed ?? '') === '', '不传 custom_emoji 时返回值没有该字段')
}

// ---------------------------------------------------------------------------
// 4. qq_face_rename：她自己看图起名
//
// 这是「让标签能被搜到」的正解：问题不在搜索算法，在**标签本身**。
// 实测 22 个收藏里 21 个备注是句子，自动切词/套模板都不准 —— 图长什么样只有看得见的人知道。
// ---------------------------------------------------------------------------
console.log('qq_face_rename：')
{
  const rename = regs.get('qq_face_rename')
  customFaceList = [
    { emojiId: 'R_0_0_0_1', desc: '穷光蛋思考中' },
    { emojiId: 'R_0_0_0_2', desc: '问号呆脸' }
  ]

  // 1) 只看图（不带 desc）：必须把图交出去，否则她只能瞎起名
  const looked = await rename.execute({ emoji_id: 'R_0_0_0_2' })
  ok(looked.ok === true, '只看图时 ok=true')
  ok(looked.desc === '问号呆脸', '只看图时把当前备注带回来')
  ok(!calls.some((c) => c.action === 'modify_custom_face'), '只看图时【不改名】（分两步，别跳第一步）')
  const lookedRendered = rename.output.render({}, looked)
  ok(Array.isArray(lookedRendered) && lookedRendered.length >= 1, '看图模式的 render 有内容')
  ok(String(looked.message).includes('问号呆脸'), '看图模式说明里带上当前备注')

  // 2) 格式校验：没有 | 就拒绝，别让脏标签继续堆
  let noPipe = false
  try {
    await rename.execute({ emoji_id: 'R_0_0_0_2', desc: '就是一个问号脸' })
  } catch (error) {
    noPipe = true
    ok(error.message.includes('|'), '缺 | 时的报错说清了格式')
    ok(error.message.includes('问号呆脸 |'), '报错里给了可照抄的例子')
  }
  ok(noPipe, 'desc 不含 | 时拒绝写入')

  // 3) | 后面空的也要拒
  let emptyKw = false
  try {
    await rename.execute({ emoji_id: 'R_0_0_0_2', desc: '问号呆脸 |' })
  } catch { emptyKw = true }
  ok(emptyKw, '| 后面没有关键词时拒绝')

  // 4) 关键词超过 4 个也要拒（词越多越搜不准）
  let tooMany = false
  try {
    await rename.execute({ emoji_id: 'R_0_0_0_2', desc: '问号呆脸 | 疑惑 懵逼 无语 问号 呆滞' })
  } catch { tooMany = true }
  ok(tooMany, '关键词超过 4 个时拒绝')

  // 5) 合法格式 → 真的写进去
  calls = []
  const renamed = await rename.execute({ emoji_id: 'R_0_0_0_2', desc: '问号呆脸 | 疑惑 懵逼 无语' })
  const modifyCall = calls.find((c) => c.action === 'modify_custom_face')
  ok(modifyCall !== undefined, '合法格式时真的调了 modify_custom_face')
  eq(modifyCall?.params?.emoji_id, 'R_0_0_0_2', '改的是指定的那个')
  eq(modifyCall?.params?.desc, '问号呆脸 | 疑惑 懵逼 无语', '写入的是新标签')
  eq(renamed.old_desc, '问号呆脸', '返回值带改前')
  eq(renamed.desc, '问号呆脸 | 疑惑 懵逼 无语', '返回值带改后')

  // 6) 改完之后**按情绪搜得到**了 —— 这才是整件事的目的
  customFaceList = customFaceList.map((item) => (
    item.emojiId === 'R_0_0_0_2' ? { ...item, desc: '问号呆脸 | 疑惑 懵逼 无语' } : item
  ))
  const afterRename = await rankCustomFaces('无语')
  ok(afterRename.some((entry) => entry.item.emojiId === 'R_0_0_0_2'), '改名后按情绪词就能搜到了')
  const beforeRename = await findCustomFace('无语')
  ok(beforeRename !== null, 'findCustomFace 也能按新标签找到（qq_send 那条路通了）')

  // 7) 不存在的 emoji_id 要报错（这是显式命令，不能静默成功）
  let missing = false
  try {
    await rename.execute({ emoji_id: '不存在的id', desc: 'x | y z' })
  } catch { missing = true }
  ok(missing, 'emoji_id 不存在时报错')

  // 8) 空 emoji_id 要报错并指路
  let noId = false
  try {
    await rename.execute({ desc: 'x | y z' })
  } catch (error) {
    noId = true
    ok(error.message.includes('qq_face_pick'), '缺 emoji_id 时引导先列收藏夹')
  }
  ok(noId, 'emoji_id 为空时报错')

  // 9) 协议端拒绝写备注（retcode != 0）→ 必须抛错，不能报「改好了」
  const realFetch2 = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body)
    if (payload.action === 'fetch_custom_face_detail') {
      return { ok: true, json: async () => ({ retcode: 0, data: [{ emoji_id: 'R_0_0_0_1', url: '', desc: '穷光蛋思考中' }] }) }
    }
    if (payload.action === 'modify_custom_face') {
      return { ok: true, json: async () => ({ retcode: 100, wording: 'invalid emoji_id' }) }
    }
    return { ok: true, json: async () => ({ retcode: 0, data: null }) }
  }
  let rejected = false
  try {
    await rename.execute({ emoji_id: 'R_0_0_0_1', desc: '思考 | 疑惑 穷' })
  } catch { rejected = true }
  globalThis.fetch = realFetch2
  ok(rejected, '协议端拒绝写备注时抛错（不谎报成功）')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
