/**
 * prompt-template-sim.mjs —— 正文头模板 + 护栏（0.18.6）
 *
 * 这块最要紧的不是「模板能渲染」，而是下面三件事：
 *   ① **不配置时必须与旧行为逐字一致** —— 否则升级会给所有人换掉正文格式
 *   ② **群模板渲染不出「群友」时必须拒绝** —— 那是防注入的触发词，静默失效最可怕
 *   ③ **默认值不能把畸形拼接的缺陷带回来** —— 旧代码前缀不以「）」结尾时会拼出
 *      `【阿明】·用户本人 QQ 123）`（docs/待办.md §5.3）
 *
 * ⚠️ 只在隔离 HOME 下跑：node tests/run-isolated.mjs tests/prompt-template-sim.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'dsh-prompt-template-'))
const SANDBOX_DATA = join(SANDBOX_HOME, '.dsh')
mkdirSync(SANDBOX_DATA, { recursive: true })
process.env.USERPROFILE = SANDBOX_HOME
process.env.HOME = SANDBOX_HOME
process.on('exit', () => {
  try { rmSync(SANDBOX_HOME, { recursive: true, force: true }) } catch {}
})
writeFileSync(join(SANDBOX_DATA, 'qq-bridge.config.json'), JSON.stringify({
  enabled: true, selfUin: '3566906627', peerUin: '1321833118', ownerUin: '1321833118',
  onebotHttp: 'http://127.0.0.1:9/', token: 'test-token'
}, null, 2), 'utf8')

const prompttext = await import('../lib/prompttext.js')

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.error(`  ✗ ${name}`) }
}
function eq(actual, expected, name) {
  ok(actual === expected, `${name}（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`)
}

// ---- 供校验用的样例变量 ----
const privateSample = () => prompttext.renderPrivateHeader({
  prefix: '（QQ 私聊）', ownerUin: '1321833118', uin: '1321833118'
})
const groupSample = () => {
  const senderUin = '1071787454'
  return {
    groupId: '975663147',
    groupName: prompttext.groupNamePart('测试群'),
    senderLabel: prompttext.senderLabelOf({ isOwner: false, nickname: '样例群友', senderUin }),
    nickname: prompttext.speakerNameOf({ isOwner: false, nickname: '样例群友', senderUin }),
    senderUin
  }
}

console.log('\n1. 不配置时与旧行为逐字一致（这条最要紧 —— 升级不能给所有人换格式）：')
{
  // 私聊：旧代码 = 前缀以「）」结尾就切掉再接 ·用户本人 QQ…）
  const vars = prompttext.renderPrivateHeader({ prefix: '（QQ 私聊）', ownerUin: '1321833118', uin: '1321833118' })
  eq(prompttext.renderTemplate(prompttext.DEFAULT_PRIVATE_TEMPLATE, vars), '（QQ 私聊·用户本人 QQ 1321833118）', '私聊默认产物 = 旧产物')
  eq(vars.prefixTrimmed, '（QQ 私聊', 'prefixTrimmed 切掉了结尾的右括号')

  // 前缀不以「）」结尾：旧代码直接拼（于是括号只剩半边，这是已知缺陷）
  const vars2 = prompttext.renderPrivateHeader({ prefix: '【阿明】', ownerUin: '123', uin: '123' })
  eq(prompttext.renderTemplate(prompttext.DEFAULT_PRIVATE_TEMPLATE, vars2), '【阿明】·用户本人 QQ 123）', '非「）」结尾时与旧缺陷一致（默认模板不偷偷改行为）')

  // 不是本人
  const vars3 = prompttext.renderPrivateHeader({ prefix: '（QQ 私聊）', ownerUin: '1321833118', uin: '999' })
  eq(prompttext.renderTemplate(prompttext.DEFAULT_PRIVATE_TEMPLATE, vars3), '（QQ 私聊·QQ 999）', '非本人时 tag 是 ·QQ <号>）')

  // 群聊
  const gvars = groupSample()
  eq(prompttext.renderTemplate(prompttext.DEFAULT_GROUP_TEMPLATE, gvars),
    '（QQ群 975663147「测试群」·群友「样例群友」（QQ 1071787454，不是用户本人））', '群聊默认产物 = 旧产物')

  // 空群名时不带括号（旧实现就是三目）
  eq(prompttext.groupNamePart(''), '', '空群名 → 不带「」')
  eq(prompttext.groupNamePart('测试群'), '「测试群」', '有群名 → 带「」')
}

console.log('\n2. 护栏：群模板渲染不出「群友」必须拒绝：')
{
  // 这是本次功能的核心风险：用户把格式写简短了，身份提示就静默失效
  // ⚠️ 注意「{nickname}说：」**是合法的** —— speakerNameOf 的产物本身就带「群友」
  //    （`群友「样例群友」`）。护栏查的是**渲染结果**，不是模板字面量，所以它通过。
  //    真正危险的是「完全不引用发言人」那种模板。
  const viaNickname = prompttext.validateTemplate('group', '{nickname}说：', groupSample)
  ok(viaNickname.ok === true, '「{nickname}说：」通过（nickname 展开后自带「群友」）')

  const bad = prompttext.validateTemplate('group', '（QQ群 {groupId}）', groupSample)
  ok(bad.ok === false, '只有群号、完全不引用发言人 → 被拒')

  const good = prompttext.validateTemplate('group', '（{groupId}·{senderLabel}）', groupSample)
  ok(good.ok === true, '含 {senderLabel} 的模板通过')

  const goodNick = prompttext.validateTemplate('group', '{nickname}（{senderUin}）', groupSample)
  ok(goodNick.ok === true, '{nickname} 展开后带「群友」，也通过')

  // 字面量里手写「群友」+ 引用发言人 —— 产物里有两个字，护栏放行
  const literal = prompttext.validateTemplate('group', '群友 {senderLabel}', groupSample)
  ok(literal.ok === true, '字面量里写了「群友」也算数（护栏只要求产物里有这两个字）')

  // 但**不引用发言人**的模板仍然被拒 —— 这是另一条独立规则：
  // 光有「群友」两个字，模型还是不知道这句是谁说的。
  const noSpeaker = prompttext.validateTemplate('group', '（群友在说话）', groupSample)
  ok(noSpeaker.ok === false && String(noSpeaker.error).includes('发言人') === false, '不引用发言人的模板被拒（另一条规则）')
  ok(String(noSpeaker.error).includes('senderLabel'), `错因点名了该放哪个变量（实际「${noSpeaker.error}」`)

  // 护栏**本体**单独验一次：模板引用了 {senderLabel}，但那个变量的产物不含「群友」。
  // 这在正常路径下不会发生（senderLabelOf 一定带「群友」），但如果哪天有人改了
  // senderLabelOf 的措辞、或者别处传了个自定义 label 进来，这条就是最后一道闸。
  // ⚠️ 不这么测的话，护栏会被前面「必须含 senderLabel」那条规则遮住，
  //    把护栏整个删掉测试照样绿 —— 我第一版变异验证就踩到了这个假绿。
  const labelWithoutKeyword = prompttext.validateTemplate('group', '（{senderLabel}）', () => ({
    groupId: '1', groupName: '', senderLabel: '某个路人', nickname: '某个路人', senderUin: '1'
  }))
  ok(labelWithoutKeyword.ok === false, 'senderLabel 的产物不含「群友」时被护栏拦下')
  ok(String(labelWithoutKeyword.error).includes('群友'), `错因点明是「群友」缺失（实际「${labelWithoutKeyword.error}」`)

  // 私聊没有这条护栏（私聊不需要区分「谁在说话」）
  const privateNoGroup = prompttext.validateTemplate('private', '{tag}', privateSample)
  ok(privateNoGroup.ok === true, '私聊模板不需要含「群友」')
}

console.log('\n3. 变量校验：拼错要当场拒绝，不能留着当字面量：')
{
  const typo = prompttext.validateTemplate('group', '（{sendLabel}）', groupSample)
  ok(typo.ok === false, '拼错的 {sendLabel} 被拒')
  ok(String(typo.error).includes('sendLabel'), `错因点名了那个变量（实际「${typo.error}」`)

  const wrongScope = prompttext.validateTemplate('private', '{groupId}', privateSample)
  ok(wrongScope.ok === false, '私聊模板里用群变量 → 被拒')

  const tooLong = prompttext.validateTemplate('private', 'x'.repeat(301), privateSample)
  ok(tooLong.ok === false, '超过 300 字 → 被拒')

  const empty = prompttext.validateTemplate('private', '', privateSample)
  ok(empty.ok === true, '空串 = 用默认值，合法')

  const spaces = prompttext.validateTemplate('private', '   ', privateSample)
  ok(spaces.ok === true, '只有空格 = 用默认值，合法')

  const noSender = prompttext.validateTemplate('group', '（QQ群 {groupId}）', groupSample)
  ok(noSender.ok === false && String(noSender.error).includes('senderLabel'), '群模板缺发言人变量 → 被拒且提示具体原因')

  const renderedEmpty = prompttext.validateTemplate('group', '{groupName}', groupSample)
  // {groupName} 是「测试群」，不含群友 → 应该被护栏拦
  ok(renderedEmpty.ok === false, '只渲染群名（不含群友）→ 被拒')
}

console.log('\n4. 渲染：不认识的变量原样保留（渲染在主链路上，绝不能抛）：')
{
  const out = prompttext.renderTemplate('a{known}b{unknown}c', { known: 'X' })
  eq(out, 'aXb{unknown}c', '认识的替换、不认识的保留')
  eq(prompttext.renderTemplate('{a}{a}', { a: '1' }), '11', '同一个变量出现多次都替换')
  eq(prompttext.renderTemplate('', {}), '', '空模板 → 空串')
  eq(prompttext.renderTemplate('无变量', {}), '无变量', '没有变量就原样返回')

  // templateVars 去重
  eq(JSON.stringify(prompttext.templateVars('{a}{b}{a}')), JSON.stringify(['a', 'b']), 'templateVars 去重且保序')
}

console.log('\n5. 身份标签：三个函数的分工不能串：')
{
  const asGroupmate = { isOwner: false, nickname: '暮秋槐', senderUin: '1071787454' }
  const asOwner = { isOwner: true, nickname: '树树', senderUin: '1321833118' }

  ok(prompttext.senderLabelOf(asGroupmate).includes('不是用户本人'), 'senderLabel 里明写「不是用户本人」')
  ok(prompttext.senderLabelOf(asGroupmate).includes('群友'), 'senderLabel 含「群友」（护栏依赖这个）')
  eq(prompttext.senderLabelOf(asOwner), '用户本人（QQ 1321833118）', '本人时不带「群友」')

  eq(prompttext.speakerNameOf(asGroupmate), '群友「暮秋槐」', 'speakerName 短格式')
  eq(prompttext.speakerNameOf(asOwner), '用户本人', '本人时 speakerName = 用户本人')

  // 昵称缺失时不能渲染成「undefined」
  eq(prompttext.speakerNameOf({ isOwner: false, nickname: '', senderUin: '1' }), '群友「未知」', '昵称缺失 → 未知，不是 undefined')
  ok(prompttext.senderLabelOf({ isOwner: false, nickname: '', senderUin: '' }).includes('未知'), 'QQ 号缺失 → 未知')
}

console.log(`\n${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
