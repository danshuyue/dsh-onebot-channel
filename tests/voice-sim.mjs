/**
 * voice-sim.mjs —— 语音转文字（qq_voice / lib/voice.js）的离线模拟。
 *
 * 钉住的东西：
 *   1. 正常：fetch_ptt_text 返回文字 → transcribeVoice 交回同一段文字
 *   2. 参数：message_id 必须是整数串，且必须以**数字**发给协议端（schema 是 integer）
 *   3. 失败不抛：retcode≠0、空文本、请求抛错，三种都返回 {ok:false} 而不是 throw
 *   4. 超时预算比协议端内部的 20 秒更长（否则两边同时超时，日志分不清是谁断的）
 *   5. 工具层：注册名 / 参数 / render 文案 —— 失败时不许引导模型重试
 *
 * 隔离：临时 HOME，不碰真 ~/.dsh，也不碰真协议端（fetch 被替换）。
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SANDBOX_HOME = join(HERE, '..', '..', '.tmp-test', `voice-${process.pid}`)
const SANDBOX_DATA = join(SANDBOX_HOME, '.dsh')
mkdirSync(SANDBOX_DATA, { recursive: true })
process.env.USERPROFILE = SANDBOX_HOME
process.env.HOME = SANDBOX_HOME
process.on('exit', () => {
  try { rmSync(SANDBOX_HOME, { recursive: true, force: true }) } catch {}
})

writeFileSync(join(SANDBOX_DATA, 'qq-bridge.config.json'), JSON.stringify({
  enabled: true,
  selfUin: '3566906627',
  peerUin: '1321833118',
  ownerUin: '1321833118',
  onebotHttp: 'http://127.0.0.1:9/',
  token: 'test-token'
}, null, 2), 'utf8')

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.error(`  ✗ ${name}`) }
}

// ---- 假协议端 ----
const calls = []
/** 下一次 fetch_ptt_text 的作答；'throw' = 让 fetch 直接抛 */
let nextAnswer = { retcode: 0, data: { text: '这是一段测试语音。' } }

globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init?.body ?? '{}')
  calls.push({ action: body.action, params: body.params })
  if (nextAnswer === 'throw') throw new Error('fetch failed')
  return { ok: true, json: async () => nextAnswer }
}

const { loadConfig } = await import('../lib/config.js')
const voice = await import('../lib/voice.js')
loadConfig()

console.log('1. 正常转写：')
{
  calls.length = 0
  nextAnswer = { retcode: 0, data: { text: '  这是一段测试语音。  ' } }
  const result = await voice.transcribeVoice('59984604')
  ok(result.ok === true, '返回 ok')
  ok(result.text === '这是一段测试语音。', `文字原样交回且去掉首尾空白（实际「${result.text}」）`)
  ok(calls.length === 1, `只发了一次请求（实际 ${calls.length}）`)
  ok(calls[0].action === 'fetch_ptt_text', '调的是 fetch_ptt_text')
  ok(calls[0].params.message_id === 59984604, `message_id 以数字发出（实际 ${typeof calls[0].params.message_id}）`)
}

console.log('\n2. 负数 message_id 原样保留（SnowLuma 合法值，不许 Number 往返丢精度）：')
{
  calls.length = 0
  nextAnswer = { retcode: 0, data: { text: '嗯' } }
  const result = await voice.transcribeVoice('-2123597213')
  ok(result.ok === true, '负数能转')
  ok(calls[0].params.message_id === -2123597213, `负号保留（实际 ${calls[0].params.message_id}）`)
}

console.log('\n3. 非法 message_id 直接拒，不发请求：')
{
  for (const bad of ['', '0', '-0', 'abc', '12.5', '9007199254740992', '-9007199254740992']) {
    calls.length = 0
    const result = await voice.transcribeVoice(bad)
    ok(result.ok === false, `「${bad}」被拒`)
    ok(calls.length === 0, `「${bad}」没有发请求`)
  }
}

console.log('\n4. 失败一律不抛，只报原因：')
{
  // 4a. retcode≠0（真人刚发、还没转出来时就是这样）
  nextAnswer = { retcode: 100, wording: 'ptt translate failed: error=9' }
  let result = await voice.transcribeVoice('59984604')
  ok(result.ok === false, 'retcode≠0 → ok:false')
  ok(result.error.includes('error=9'), `原因原样带出（实际「${result.error}」）`)

  // 4b. 超时那条文案（协议端的原话就是「未收到结果推送」）
  nextAnswer = { retcode: 100, wording: '语音转文字超时（未收到结果推送）' }
  result = await voice.transcribeVoice('59984604')
  ok(result.ok === false && result.error.includes('超时'), '超时文案带出')

  // 4c. 成功但空文本 → 也算失败，不能把空串当「内容是没有」
  nextAnswer = { retcode: 0, data: { text: '   ' } }
  result = await voice.transcribeVoice('59984604')
  ok(result.ok === false, '空文本 → ok:false')
  ok(String(result.error).includes('空文本'), `说清了是空文本（实际「${result.error}」）`)

  // 4d. 请求本身抛错（协议端不可达）
  nextAnswer = 'throw'
  result = await voice.transcribeVoice('59984604')
  ok(result.ok === false, '网络抛错 → ok:false（不向上抛）')
  ok(String(result.error).length > 0, '给了原因')
}

console.log('\n5. 超时预算必须比协议端内部的 20 秒更长：')
{
  ok(voice.VOICE_TIMEOUT_MS > 20000, `VOICE_TIMEOUT_MS=${voice.VOICE_TIMEOUT_MS} > 20000`)
}

console.log('\n6. 工具层接好了：')
{
  const { registerVoiceTool } = await import('../lib/tool.js')
  const regs = []
  const ctx = {
    get: (name) => (name === 'tools' ? { register: (t) => { regs.push(t); return () => {} } } : undefined),
    effect: () => {}
  }
  await registerVoiceTool(ctx)
  ok(regs.length === 1, `注册了 1 个工具（实际 ${regs.length}）`)
  const tool = regs[0] ?? {}
  ok(tool.name === 'qq_voice', `工具名 qq_voice（实际 ${tool.name}）`)
  const paramNames = Object.keys(tool.parameters?.properties ?? {})
  ok(JSON.stringify(paramNames) === '["message_id"]', `只有一个参数 message_id（实际 ${paramNames.join('/')}）`)
  ok(Array.isArray(tool.parameters?.required) && tool.parameters.required.includes('message_id'), 'message_id 是必填')

  // 成功：render 要把文字原样说出来
  nextAnswer = { retcode: 0, data: { text: '今晚八点老地方' } }
  const good = await tool.execute({ message_id: '59984604' })
  ok(good.ok === true && good.text === '今晚八点老地方', 'execute 透传文字')
  const goodRender = tool.output.render({}, good).map((b) => b.text).join('')
  ok(goodRender.includes('今晚八点老地方'), 'render 里能看到内容')

  // 失败：文案必须明说「别重试」—— 转不出来是常事，反复重试只会烧时间
  nextAnswer = { retcode: 100, wording: 'ptt translate failed: error=9' }
  const bad = await tool.execute({ message_id: '59984604' })
  ok(bad.ok === false, '失败时 ok:false')
  const badRender = tool.output.render({}, bad).map((b) => b.text).join('')
  ok(badRender.includes('没转出文字'), '文案说清「没转出文字」')
  ok(badRender.includes('别重试'), '文案明确叫它别重试')
  ok(!badRender.includes('重试一下'), '没有反向引导它重试')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed > 0 ? 1 : 0)
