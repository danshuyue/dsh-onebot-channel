/**
 * 语音卡「改完即存」与提示词导入导出的行为测试：node tests/voice-autosave-sim.mjs，退出码 0 = 全过。
 *
 * ## 为什么必须有这个文件
 *
 * 0.19.5 把「语音合成」那张卡改成了改完即存 —— 控件一动就 `POST /save` 一个**只含那几格**的
 * 小载荷（不重发整包，否则会把「绑定」页正在编辑的草稿一起提交）。
 *
 * 这里守三件事，全都是「静默失效」类的坑：
 *
 *   ① **前端自动保存的键，后端必须真的收。** 只要有一个键不在 `applyTunables` 的
 *      数字/字符串/布尔/枚举/数组任何一张表里，用户改了它 → POST 成功 → 值没变 →
 *      下次重进设置页又变回原样。这正是 0.19.2 那两个 bug 的形状（保存了但没存上）。
 *      ⇒ 所以这里**跑真正的 applyTunables**，逐个键验「值真的落进 config 了吗」。
 *   ② **注册/推广链接只放行 http/https。** 它会变成设置页里的 `<a href>`，
 *      配置文件又是明文、会被用户互相分享 —— 手改进去一个 `javascript:` 不能原样送到前端。
 *   ③ **前端那份变量说明必须和后端一致。** `client.js` 里的 `PROMPT_VAR_DOC` 是
 *      浏览器 bundle 里的硬编码副本（拿不到 `lib/prompttext.js` 的模块），
 *      两边一旦漂移，界面就会教用户写一个保存时才被拒的变量名。
 */
let passed = 0
let failed = 0
function ok(condition, name, detail) {
  if (condition) { passed += 1; console.log(`  ✓ ${name}${detail ? `　${detail}` : ''}`) }
  else { failed += 1; console.error(`  ✗ ${name}${detail ? `　${detail}` : ''}`) }
}
function eq(actual, expected, name) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, `${name}${same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`)
}

import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { useIsolatedHome } from './isolated-home.mjs'

// 隔离的 HOME：这个测试会往 ~/.dsh 写配置文件，绝不能碰真实的那个
// （真实的那个里有用户正在用的 key 和绑定表）。
useIsolatedHome('voice-autosave-')

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = join(process.env.HOME || homedir(), '.dsh')
const CONFIG = join(DATA, 'qq-bridge.config.json')
const STATE = join(DATA, 'qq-bridge-state.json')

// 隔离目录里没有旧配置可备份，直接写一份最小的就行（不存在就跳过读）
let configBackup = null
try { configBackup = readFileSync(CONFIG, 'utf8') } catch { configBackup = null }
let stateBackup = null
try { stateBackup = readFileSync(STATE, 'utf8') } catch { stateBackup = null }
process.on('exit', () => {
  if (configBackup !== null) writeFileSync(CONFIG, configBackup, 'utf8')
  else rmSync(CONFIG, { force: true })
  if (stateBackup !== null) writeFileSync(STATE, stateBackup, 'utf8')
  else rmSync(STATE, { force: true })
})

writeFileSync(CONFIG, JSON.stringify({ enabled: true, selfUin: 1000000002, peerUin: 1000000001 }, null, 2), 'utf8')
writeFileSync(STATE, JSON.stringify({ lastId: 0, lastSeq: 0, lastTime: 1, groups: {} }, null, 2), 'utf8')

const api = await import('../lib/api.js')
const config = await import('../lib/config.js')
const prompttext = await import('../lib/prompttext.js')

const clientSrc = readFileSync(join(PLUGIN, 'lib', 'client.js'), 'utf8')

/** 从 `var X = [` 开始做**括号配对**取整段（注释里可能有方括号，不能 indexOf）。 */
function arrayLiteralOf(src, marker) {
  const at = src.indexOf(marker)
  if (at < 0) return ''
  let depth = 0
  for (let i = at; i < src.length; i += 1) {
    const ch = src[i]
    if (ch === '[') depth += 1
    else if (ch === ']') {
      depth -= 1
      if (depth === 0) return src.slice(at, i + 1)
    }
  }
  return ''
}

console.log('1. 前端自动保存的每个键，后端都真的收（0.19.2 那类「保存了但没存上」）：')
{
  const block = arrayLiteralOf(clientSrc, 'var VOICE_AUTOSAVE_KEYS = [')
  ok(block !== '', '能解析出 VOICE_AUTOSAVE_KEYS')
  const keys = [...block.matchAll(/'([A-Za-z][A-Za-z0-9]*)'/g)].map((m) => m[1])
  // 精确比对，防止解析退化成假绿（少解析出几个键会让下面的循环空转还「全过」）
  ok(keys.length >= 25, `解析出 ${keys.length} 个自动保存键（应覆盖语音卡全部字段）`)
  ok(keys.includes('voiceBreezeKey'), '包含 API Key（用户明确要求「API 配置」也算）')
  ok(keys.includes('voiceBreezeVoice'), '包含音色（用户明确要求「音色选择」也算）')
  ok(keys.includes('voiceEngine'), '包含引擎选择')
  ok(keys.includes('voiceTestText'), '包含测试语句')

  // 每个键给一个**与当前值不同**的合法值，跑 applyTunables，看 config 是否真的变了。
  // ⚠️ 用「变没变」而不是「有没有报错」—— applyTunables 对不认识的键是**静默跳过**的，
  //    它永远不报错，这正是这个 bug 难被发现的原因。
  const samples = {
    voiceEngine: 'breeze',
    voiceGptsovitsUrl: 'http://127.0.0.1:9999',
    voiceGptsovitsRef: 'D:\\ref\\sample.wav',
    voiceGptsovitsRefText: '这是参考台词',
    voiceGptsovitsLang: '日文',
    voiceGptsovitsSpeed: 1.25,
    voiceGptsovitsTopK: 9,
    voiceGptsovitsTopP: 0.75,
    voiceGptsovitsTemperature: 0.8,
    voiceGptsovitsSplit: '不切',
    voiceGptsovitsBatchSize: 7,
    voiceGptsovitsFragmentInterval: 0.5,
    voiceGptsovitsSeed: 42,
    voiceGptsovitsRepetitionPenalty: 1.2,
    voiceGptsovitsSampleSteps: '16',
    voiceGptsovitsCfgRate: 0.5,
    voiceBreezeVoice: 'voc_test000000',
    voiceBreezeFormat: 'mp3',
    voiceBreezeModel: 'breeze-tts-2-multilingual',
    voiceBreezeSpeed: 1.15,
    voiceBreezeGuidanceScale: 2,
    voiceBreezeVolume: 0.8,
    voiceBreezeSpeakerBoost: true,
    voiceDailyChars: 4321,
    voiceTestText: '自动保存测试句',
  }
  const missingSample = keys.filter((k) => k !== 'voiceBreezeKey' && samples[k] === undefined)
  ok(missingSample.length === 0, `每个自动保存键都有样本值${missingSample.length ? '，缺：' + missingSample.join(',') : ''}`)

  for (const key of keys) {
    if (key === 'voiceBreezeKey') continue
    const before = JSON.stringify(config.getConfig()[key])
    api.applyTunables({ [key]: samples[key] })
    const after = JSON.stringify(config.getConfig()[key])
    ok(before !== after, `applyTunables 真的写进了 ${key}`, `（${before} → ${after}）`)
  }

  // voiceBreezeKey 不在 STRING_FIELDS（留空 = 保持原样），它由 /save 的专门分支处理。
  // 这里只确认「它不被 applyTunables 写」—— 那条专门分支的逻辑由 sensitive-breeze-sim 守。
  api.applyTunables({ voiceBreezeKey: 'brz_should_not_land_here' })
  ok(config.getConfig().voiceBreezeKey !== 'brz_should_not_land_here',
    'voiceBreezeKey 不走 applyTunables（必须走 /save 的「非空才写」分支）')
}

console.log('\n2. 注册/推广链接：只放行 http/https（它会变成 <a href>）：')
{
  api.applyTunables({ voiceSignupUrl: 'https://breezeblue.ai/auth/login?ref=abc' })
  eq(config.getConfig().voiceSignupUrl, 'https://breezeblue.ai/auth/login?ref=abc', 'https 能存住')

  api.applyTunables({ voiceSignupUrl: 'http://example.com/x' })
  eq(config.getConfig().voiceSignupUrl, 'http://example.com/x', 'http 也能存住')

  api.applyTunables({ voiceSignupUrl: 'javascript:alert(1)' })
  eq(config.getConfig().voiceSignupUrl, '', 'javascript: 被清空（XSS 口子）')

  api.applyTunables({ voiceSignupUrl: 'data:text/html,<script>alert(1)</script>' })
  eq(config.getConfig().voiceSignupUrl, '', 'data: 被清空')

  api.applyTunables({ voiceSignupUrl: 'file:///C:/Windows/win.ini' })
  eq(config.getConfig().voiceSignupUrl, '', 'file: 被清空')

  api.applyTunables({ voiceSignupUrl: 'https://ok.example/' + 'a'.repeat(600) })
  eq(config.getConfig().voiceSignupUrl, '', '超长链接被清空')

  api.applyTunables({ voiceSignupUrl: '' })
  eq(config.getConfig().voiceSignupUrl, '', '空串能存住（= 用内置的官方登录页）')

  // 读出去也要过一遍（配置文件是明文的，手改进去的脏值不能被原样送到前端）
  config.getConfig().voiceSignupUrl = 'javascript:alert(2)'
  eq(api.publicConfig(config.getConfig()).voiceSignupUrl, '', 'publicConfig 吐出来前也会清一遍')
  config.getConfig().voiceSignupUrl = 'https://breezeblue.ai/'
  eq(api.publicConfig(config.getConfig()).voiceSignupUrl, 'https://breezeblue.ai/', '干净的 https 原样透出')
}

console.log('\n3. 前端变量说明必须和后端一致（client.js 里是硬编码副本）：')
{
  function docVars(blockName) {
    const at = clientSrc.indexOf(`${blockName}: [`)
    if (at < 0) return []
    // 从 `[` 起按方括号配对取整段
    let depth = 0
    for (let i = at + blockName.length + 1; i < clientSrc.length; i += 1) {
      const ch = clientSrc[i]
      if (ch === '[') depth += 1
      else if (ch === ']') {
        depth -= 1
        if (depth === 0) {
          const body = clientSrc.slice(at + blockName.length + 1, i + 1)
          return [...body.matchAll(/\['([A-Za-z][A-Za-z0-9]*)'/g)].map((m) => m[1])
        }
      }
    }
    return []
  }

  const privateDoc = docVars('private')
  const groupDoc = docVars('group')
  // ⚠️ 比对**集合**而不是顺序：界面上的排列可以为了好读而调整（把同类变量挨着放），
  //    要求的是「不多不少、名字一字不差」—— 那才是漂移会导致用户写错的点。
  const sorted = (list) => list.slice().sort()
  eq(sorted(privateDoc), sorted(prompttext.PRIVATE_VARS),
    '私聊变量说明与 prompttext.PRIVATE_VARS 是同一套（不多不少）')
  eq(sorted(groupDoc), sorted(prompttext.GROUP_VARS),
    '群聊变量说明与 prompttext.GROUP_VARS 是同一套（不多不少）')
  ok(privateDoc.length > 0 && groupDoc.length > 0, '两份变量说明都非空（解析没退化）')

  // 每个变量都得有解释 —— 光有名字用户猜不出 {senderLabel} 会渲染成一大串
  for (const name of [...privateDoc, ...groupDoc]) {
    const at = clientSrc.indexOf(`'${name}',`)
    ok(at >= 0, `变量 {${name}} 在说明里有条目`)
  }
}

console.log('\n4. 接线：三个不走 onField 的控件也必须真的排进保存队列：')
{
  // 光有 queueVoiceSave 这个函数没用 —— 没人调它就等于没做。
  // 这里按函数切片查，避免「整份源码里有这个词」这种假绿
  // （`queueVoiceSave(` 在定义处也出现一次）。
  const slice = (from, to) => {
    const at = clientSrc.indexOf(from)
    if (at < 0) return ''
    const end = clientSrc.indexOf(to, at + from.length)
    return end < 0 ? clientSrc.slice(at) : clientSrc.slice(at, end)
  }
  /**
   * 取出「真正排队那一句」并逐字比对守卫条件。
   *
   * ⚠️ 这里不能用 `/isVoiceAutosaveKey\(key\)[\s\S]{0,80}queueVoiceSave/` 这种模糊匹配：
   *    把守卫改成 `if (false && isVoiceAutosaveKey(key))` 之后**照样匹配得上**，
   *    等于这个测试抓不到「接线被短路」—— 变异验证时实测到过这个假绿。
   *    所以要求那一行的第一个判断必须就是 isVoiceAutosaveKey。
   */
  const guardLine = (src) => {
    const lines = src.split('\n')
    const hit = lines.find((line) => line.includes('queueVoiceSave(') && !line.includes('function queueVoiceSave'))
    return hit === undefined ? '' : hit.trim()
  }
  const onFieldGuard = guardLine(slice('function onField(key)', 'function onFeature('))
  ok(onFieldGuard.startsWith('if (isVoiceAutosaveKey(key))'),
    `onField 里的守卫原样生效（实际「${onFieldGuard}」）`)

  const cardSrc = slice('function renderVoiceEngineCard()', 'function renderMemory(')
  ok(cardSrc.includes('queueVoiceSave'), '语音卡里至少有一处排队调用')
  // vSelectField 的 onChange 不经过 onField —— 引擎/格式/模型/语速/语种/切句/采样步数全靠它
  const selectSrc = slice('function vSelectField(key, label, options, hint)', 'function engineRadio(')
  ok(/isVoiceAutosaveKey\(key\)[\s\S]{0,80}queueVoiceSave\(key, next\[key\]\)/.test(selectSrc),
    'vSelectField（下拉框）自己也排队了')
  // 引擎 radio 走的是 engineRadio，既不是 onField 也不是 vSelectField
  const radioSrc = slice('function engineRadio(value, label, hint)', 'var localBlock')
  ok(radioSrc.includes('queueVoiceSave(\'voiceEngine\''), 'engineRadio（引擎二选一）自己也排队了')
  // 音色结果列表的 radio 是手写的，同样不经过上面任何一条
  const voiceRowAt = cardSrc.indexOf("name: 'qqb-breeze-voice'")
  ok(voiceRowAt >= 0, '能找到音色结果列表的 radio')
  ok(voiceRowAt >= 0 && cardSrc.slice(voiceRowAt, voiceRowAt + 700).includes('queueVoiceSave(\'voiceBreezeVoice\''),
    '选中音色那一刻就排队保存（不用再点按钮）')
}

console.log('\n5. 版式：绑定行的第 1 列必须带像素下限，粘住的头必须自带背景：')
{
  // 这一节的断言只能用源码切片（CSS 没有可运行的断言面），所以每一条都要
  // **切到具体的那条规则**再查，不能全文 includes —— 全文 includes 抓不住
  // 「规则还在、值改回去了」这种回归。
  const rule = (selector) => {
    const at = clientSrc.indexOf(selector + '{')
    if (at < 0) return ''
    return clientSrc.slice(at, clientSrc.indexOf('}', at) + 1)
  }
  const row = rule("'.qqb-row")
  ok(row !== '', '能找到 .qqb-row 规则')
  // ⚠️ 这一条验的是「第 1 列有像素下限」，不是「写了某个字面量」。
  //    只验 minmax(0,1fr) 是**假绿**：审核实测 430px 面板下昵称宽度仍然是 0
  //    （行内容最小宽 ≈545px，唯一可压的那列就被压没了）。
  const firstCol = /grid-template-columns:([^;]+);/.exec(row)?.[1] ?? ''
  const floor = /^minmax\((\d+)px,/.exec(firstCol.trim())?.[1]
  ok(floor !== undefined, `第 1 列带像素下限（实际「${firstCol.split(' ')[0]}」）`)
  ok(floor !== undefined && Number(floor) >= 120,
    `下限至少 120px，昵称才不会被压没（实际 ${floor ?? '无'}px）`)
  ok(!/grid-template-columns:[^;]*?(?<![\w(])\b1fr\b/.test(row.replace(/minmax\([^)]*\)/g, 'X')),
    '⚠️ 没有残留裸 1fr 列（它会按内容 min-content 抢宽度）')

  const sticky = rule("'.qqb-sticky")
  ok(sticky !== '', '能找到 .qqb-sticky 规则')
  ok(sticky.includes('position:sticky'), '用 sticky（自套 overflow 会变成滚动条套滚动条）')
  ok(/background:/.test(sticky), '⚠️ 粘住的那层自带背景色（否则内容滚过来会叠着看）')
  ok(sticky.includes('z-index'), '有 z-index（不然会被下面的卡片盖住）')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed > 0 ? 1 : 0)
