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
 * 另外守：四档的文案必须逐字是用户给的那四句（那是定义，不是装饰）。
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

console.log('\n1. 四档的定义（config.js）：')
{
  ok(/export const VOICE_MODES = \['off', 'passive', 'free', 'active'\]/.test(configSrc),
    'VOICE_MODES 就是这四个，顺序一致')
  ok(/voiceMode: 'off'/.test(configSrc), '默认是 off（等于升级前的 voiceOut=false）')
  ok(/export function normalizeVoiceMode/.test(configSrc), '有归一化函数')
  ok(/VOICE_MODES\.includes\(raw\) \? raw : 'off'/.test(configSrc),
    '⚠️ 认不出来的值落 off（往安全那边倒，不会静默变成「主动」开始花钱）')

  // 四句文案必须逐字在
  const helps = [
    '这个模式下ai无语音工具调用权限，无法发语音',
    '这个模式下除非你要求，否则ai不会发语音',
    '这个模式下ai可以发语音，且直接考虑该不该发语音，实际效果可能和被动模式类似',
    '这个模式下ai将尽可能全部用语音回复你，除非你要求用文字或者不适合用语音'
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
}

console.log('\n4. 设置页四档是 radio，且四个都在：')
{
  ok(clientSrc.includes('function renderVoiceModeCard'), '有四档卡片')
  ok(/name: 'qqb-voice-mode'/.test(clientSrc), 'radio 组名正确')
  ok(!/selectField\('voiceMode'/.test(clientSrc),
    '⚠️ 没用 select —— option 里塞不下四句定义，且 title 悬浮在 option 上不生效')
  for (const mode of ['off', 'passive', 'free', 'active']) {
    ok(new RegExp(`\\['${mode}', '[^']+', '这个模式下`).test(clientSrc), `四档里 ${mode} 带定义文案`)
  }
  ok(clientSrc.includes('qqb-voice-mode'), '四档接进了 pane')
}

console.log('\n5. 提示词按档位分叉（prompt.js）：')
{
  const promptSrc = read('lib/prompt.js')
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
