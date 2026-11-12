/**
 * tts-mode-sim.mjs —— 语音四档的语义（0.19.0）。
 *
 * 守的是什么：**「禁用」档必须让 qq_tts 整个不注册**。
 *
 * 为什么这条特别重要（tool.js 文件头那段警告）：
 *   本仓库踩过「留着参数、调用时报错」——模型看到 UNKNOWN_TOOL 会换个写法再试，
 *   白烧 token。所以「关掉」的正确含义是**schema 压根不生成**，
 *   而不是「注册了再拒绝」。这个区别用文本断言很容易写假：
 *   光查 `if (voiceMode !== 'off')` 出现过，改坏了照样绿 —— 所以要查**完整表达式**。
 *
 * 另外守：四档的文案必须清楚区分「禁用 / 被动 / 智能选择 / 主动」的行为边界。
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}${extra ? '　' + extra : ''}`) }
  else { fail += 1; console.log(`  ✗ ${label}${extra ? '　' + extra : ''}`) }
}

const configSrc = read('lib/config.js')
const indexSrc = read('lib/index.js')
const clientSrc = read('lib/client.js')
const toolSrc = read('lib/tool.js')
const { deriveToolFeatures } = await import('../lib/config.js')

console.log('\n1. 四档的定义（config.js）：')
{
  ok(/export const VOICE_MODES = \['off', 'passive', 'free', 'active'\]/.test(configSrc),
    'VOICE_MODES 就是这四个，顺序一致')
  ok(/voiceMode: 'off'/.test(configSrc), '默认是 off（等于升级前的 voiceOut=false）')
  ok(/export function normalizeVoiceMode/.test(configSrc), '有归一化函数')
  ok(/VOICE_MODES\.includes\(raw\) \? raw : 'off'/.test(configSrc),
    '⚠️ 认不出来的值落 off（往安全那边倒，不会静默变成「主动」开始花钱）')

  const helps = [
    '这个模式下ai无语音工具调用权限，无法发语音',
    '默认只打字；只有你明确要求发语音时才会发',
    'ai会按聊天情境判断；默认打字，只有语音明显更合适时才发',
    '普通文字回复尽可能发语音；公式、代码、链接等不适合朗读的内容改用文字'
  ]
  for (const text of helps) {
    ok(configSrc.includes(text), `文案逐字存在：${text.slice(0, 18)}…`)
  }
}

console.log('\n2. 「禁用」档不注册 qq_tts（最核心的一条）：')
{
  // 完整表达式，不是裸标识符 —— 查 `voiceMode !== 'off'` 出现没出现过是假绿（坑 29）
  ok(/const voiceEnabled = String\(config\.voiceMode \?\? 'off'\) !== 'off'/.test(indexSrc),
    '⚠️ index.js 用完整表达式算出 voiceEnabled')
  ok(/if \(voiceEnabled\) void registerTtsTool\(/.test(indexSrc),
    '⚠️ 是**条件注册**，不是「注册了再拒绝」')
  // 反过来：不许出现「无条件注册 qq_tts」
  ok(!/void registerTtsTool\(ctx, toolRegistration\.signal\)$/.test(
    indexSrc.split('if (voiceEnabled)')[0].split('\n').slice(-3).join('\n')
  ), '注册那一行前面确实有 if 挡着')
}

console.log('\n3. qq_send 的 voice 参数由四档推导（单向）：')
{
  ok(/export function deriveToolFeatures/.test(configSrc), '有 deriveToolFeatures')
  const block = configSrc.slice(configSrc.indexOf('export function deriveToolFeatures'), configSrc.indexOf('export function normalizeVoiceMode'))
  ok(/base\.voiceOut = String\(config\?\.voiceMode \?\? 'off'\) !== 'off'/.test(block),
    '⚠️ voiceMode → voiceOut 的推导表达式完整存在')
  ok(!/config\.voiceMode\s*=/.test(block), '不反向写回 voiceMode（单向）')
  ok(/const features = deriveToolFeatures\(config\)/.test(indexSrc),
    'index.js 用的就是推导结果（不是 config.toolFeatures 原样）')
  ok(deriveToolFeatures({ voiceMode: 'active', toolFeatures: { voiceOut: false } }).voiceOut === true,
    '旧配置残留 voiceOut=false 不会覆盖主动档语音权限')
  ok(deriveToolFeatures({ voiceMode: 'off', toolFeatures: { voiceOut: true } }).voiceOut === false,
    '禁用档会覆盖旧配置残留的 voiceOut=true')
}

console.log('\n4. 设置页四档是 radio，且四个都在：')
{
  ok(clientSrc.includes('function renderVoiceModeCard'), '有四档卡片')
  ok(/name: 'qqb-voice-mode'/.test(clientSrc), 'radio 组名正确')
  ok(!/selectField\('voiceMode'/.test(clientSrc),
    '⚠️ 没用 select —— option 里塞不下四句定义，且 title 悬浮在 option 上不生效')
  for (const mode of ['off', 'passive', 'free', 'active']) {
    ok(new RegExp(`\\['${mode}', '[^']+',`).test(clientSrc), `四档里包含 ${mode}`)
  }
  ok(clientSrc.includes("['free', '智能选择', 'ai按聊天情境判断；默认打字，只有语音明显更合适时才发']"),
    '设置页把 free 命名为智能选择，并说明默认文字')
  ok(clientSrc.includes('被动 = 你明确要求才发；智能选择 = 默认文字、语音明显更合适时才发；主动 = 适合朗读的普通回复优先语音'),
    '设置页总览直观区分三档')
  ok(clientSrc.includes('qqb-voice-mode'), '四档接进了 pane')
}

console.log('\n5. 提示词按档位分叉（prompt.js）：')
{
  const promptSrc = read('lib/prompt.js')
  ok(promptSrc.includes('默认打字；只有当语音能明显改善表达时才用，例如传达语气、情绪或陪伴感。'),
    '智能选择提示词以文字为默认，只在语音更有表达价值时切换')
  ok(promptSrc.includes('普通、适合朗读的回复默认优先使用语音'), '主动档仅对获准的 QQ 目标优先使用语音')
  ok(promptSrc.includes('公式、数学符号、代码、路径、列表、链接、需要精确复制的内容'),
    '主动档提示词明确排除公式等不适合朗读的内容')
  ok(promptSrc.includes('对方明确要求打字；或者这句话不适合念出来'), '主动档保留用户要求文字的优先权')
  ok(promptSrc.includes('export function voiceTurnHint'), '提供逐回合语音提示函数')
  ok(/targetAllowed\(target, config\)/.test(promptSrc), '逐回合提示复用目标白名单')
  ok(/voiceTurnHint\(target, config\)/.test(read('lib/deliver.js')), '逐回合提示进入真实 QQ 投递链路')
  ok(!toolSrc.includes('一两句能说完的事打字更合适'), 'qq_tts 不再跨档建议短回复打字')
  ok(/export const VOICE_SECTION_NAME = 'qq-channel:voice'/.test(promptSrc), '段落名带插件前缀')
  ok(/interpolate: false/.test(promptSrc), '⚠️ interpolate:false（正文含 {{}} 会让提示词组装抛错）')
  ok(/export function mountVoicePromptSection/.test(promptSrc), '导出挂载函数')
  ok(/export const VOICE_BILLED_NOTE/.test(promptSrc), '有计费句常量')
  // 计费句只能挂在 breeze 上
  const mountBlock = promptSrc.slice(promptSrc.indexOf('export function voiceSectionText'), promptSrc.indexOf('export function mountVoicePromptSection'))
  ok(/billed/.test(mountBlock) || /voiceEngine === 'breeze'/.test(promptSrc),
    '⚠️ 计费句只在 breeze 引擎下追加（给免费引擎说「计费」是撒谎）')
}

console.log('\n6. 工具本身没有 engine 参数（用户要求「模型无感」）：')
{
  const ttsToolBlock = toolSrc.slice(toolSrc.indexOf('export async function registerTtsTool'), toolSrc.indexOf('export async function runVoiceSelfTest'))
  ok(!/engine:\s*\{/.test(ttsToolBlock), '⚠️ schema 里**没有** engine 参数')
  ok(/text:\s*\{/.test(ttsToolBlock), '有 text 参数')
  ok(/name: 'qq_tts'/.test(ttsToolBlock), '工具名是 qq_tts')
}

console.log(`\n结果：${pass} 过 / ${fail} 败`)
process.exitCode = fail === 0 ? 0 : 1
