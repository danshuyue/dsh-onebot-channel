/**
 * tts-breeze-sim.mjs —— Breeze 请求形状（0.19.0）。
 *
 * 守的是什么：**请求发出去的那几个字节**。
 * 这里最容易犯的错是「看着对但服务端拒」：
 *   · `output_format` 写进 body → 422 extra_forbidden（实测过）
 *   · voice_id 写到 body 里 → 服务端当成缺 voice_id
 *   · 忘了 `xi-api-key`
 * 这些错误**本地跑不出任何异常**，只有真打 API 才会炸 —— 而那时已经在线上花过钱了。
 * 所以用假 fetch 把出站请求整个抓下来逐字段断言。
 *
 * ⚠️ 本测试**不打网络**：fetch 被替换成了记录器。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'
import { useIsolatedHome } from './isolated-home.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// 隔离 HOME：直接单跑本文件时也不会碰真实的 ~/.dsh。
// 为什么不用 mkdtemp(tmpdir())：见 tests/isolated-home.mjs 的注释（本机沙箱只有
// 工作区根下的 .tmp-test 能建目录）。
useIsolatedHome('tts-breeze-')
// 语音产物目录：`voiceOutputRoot()` 在「默认位置」分支会自己建，
// 但这里显式建一次更稳（`~/.dsh/voice` 的父目录 .dsh 必须先存在）。
mkdirSync(join(process.env.HOME, '.dsh', 'voice'), { recursive: true })

let pass = 0
let fail = 0
const ok = (cond, label) => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) } else { fail += 1; console.log(`  ✗ ${label}`) }
}

// ---- 假 fetch：记录每次调用，返回一段合法 WAV ----
function makeWav() {
  // 最小合法 RIFF/WAVE：44 字节头 + 一小段静音
  const data = Buffer.alloc(16, 0)
  const buf = Buffer.alloc(44 + data.length)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + data.length, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)          // PCM
  buf.writeUInt16LE(1, 22)          // mono
  buf.writeUInt32LE(24000, 24)      // sample rate
  buf.writeUInt32LE(48000, 28)      // byte rate
  buf.writeUInt16LE(2, 32)          // block align
  buf.writeUInt16LE(16, 34)         // bits
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(data.length, 40)
  data.copy(buf, 44)
  return buf
}

const calls = []
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init })
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'audio/wav' },
    arrayBuffer: async () => makeWav().buffer.slice(makeWav().byteOffset, makeWav().byteOffset + makeWav().byteLength),
    text: async () => ''
  }
}

const tts = await import('../lib/tts.js')

console.log('\n1. 请求形状：output_format 必须在 query，不在 body：')
{
  calls.length = 0
  const result = await tts.synthesizeBreeze({
    text: '你好呀',
    config: { voiceBreezeKey: 'brz_testkey', voiceBreezeVoice: 'voc_abc', voiceBreezeFormat: 'wav' }
  })
  ok(result.ok === true, '合成成功')
  ok(calls.length === 1, '只发了一次请求')

  const call = calls[0]
  const url = new URL(call.url)
  const body = JSON.parse(call.init.body)

  ok(url.pathname === '/v1/text-to-speech/voc_abc', 'voice_id 在 URL 路径里', url.pathname)
  ok(url.searchParams.get('output_format') === 'wav', 'output_format 在 query 里', url.searchParams.get('output_format'))
  ok(!Object.prototype.hasOwnProperty.call(body, 'output_format'),
    '⚠️ body 里**没有** output_format（写进去会被 422 extra_forbidden 拒）')
  ok(call.init.headers['xi-api-key'] === 'brz_testkey', 'xi-api-key 头正确')
  ok(call.init.headers['content-type'] === 'application/json', 'content-type 正确')
  ok(body.text === '你好呀', 'body.text 正确')
  ok(body.language_code === 'zh', 'language_code 是 zh')
  ok(!Object.prototype.hasOwnProperty.call(body, 'model_id'), '没配模型时不传 model_id（服务端按语言自动选）')
  ok(!Object.prototype.hasOwnProperty.call(body, 'voice_id'), '⚠️ body 里没有 voice_id（它在 URL 里）')
}

console.log('\n2. 配了模型时要传 model_id：')
{
  calls.length = 0
  await tts.synthesizeBreeze({
    text: 'x',
    config: { voiceBreezeKey: 'k', voiceBreezeVoice: 'v', voiceBreezeFormat: 'mp3', voiceBreezeModel: 'breeze-tts-2' }
  })
  const body = JSON.parse(calls[0].init.body)
  ok(body.model_id === 'breeze-tts-2', 'model_id 传了')
  ok(new URL(calls[0].url).searchParams.get('output_format') === 'mp3', '格式跟着配置走')
}

console.log('\n3. 超长文本本地就拒，不打网络：')
{
  calls.length = 0
  const long = '啊'.repeat(tts.BREEZE_MAX_CHARS + 1)
  const result = await tts.synthesizeBreeze({
    text: long,
    config: { voiceBreezeKey: 'k', voiceBreezeVoice: 'v' }
  })
  ok(result.ok === false, '被拒')
  ok(calls.length === 0, '⚠️ 没有发生网络请求（省了一次 422 往返）')
  ok(String(result.error).includes(String(tts.BREEZE_MAX_CHARS)), '错误里写了上限数字', result.error)
}

console.log('\n4. 缺 key / 缺音色时也说清楚，不打网络：')
{
  calls.length = 0
  const noKey = await tts.synthesizeBreeze({ text: 'x', config: { voiceBreezeVoice: 'v' } })
  ok(noKey.ok === false && String(noKey.error).includes('key'), '没 key 时提示 key')
  const noVoice = await tts.synthesizeBreeze({ text: 'x', config: { voiceBreezeKey: 'k' } })
  ok(noVoice.ok === false && String(noVoice.error).includes('音色'), '没音色时提示音色')
  ok(calls.length === 0, '两种都没打网络')
}

console.log('\n5. 落盘文件名（真的合成一次看产物）：')
{
  const result = await tts.synthesize('你好', {
    // ⚠️ 必须显式给 engine：不传时它读 config.voiceEngine，而这份假配置里没有
    //    那个字段 → 回落到 gptsovits → 报「没配服务地址」。
    //    这正是「测试要盯住被测行为」的一条：这里要测的是 Breeze 落盘，不是默认引擎选择。
    engine: 'breeze',
    config: { voiceBreezeKey: 'k', voiceBreezeVoice: 'v', voiceBreezeFormat: 'wav' }
  })
  ok(result.ok === true, '合成成功')
  if (result.ok === true) {
    const name = result.path.split(/[/\\]/).pop() || ''
    // ⚠️ 这条是被真机烟测抓出来的：最初用 toISOString().slice 拼时间戳，
    //    毫秒那个句点被切进了文件名（`tts_20261106180834._b89bd8.wav`）。
    ok(/^tts_\d{14}_[0-9a-f]{6}\.wav$/.test(name), '文件名是 tts_<14位时间戳>_<6位随机>.wav', name)
    ok(!/\d\./.test(name.replace(/\.wav$/, '')), '⚠️ 时间戳里没有混进小数点')
  }
}

console.log(`\n结果：${pass} 过 / ${fail} 败`)
process.exitCode = fail === 0 ? 0 : 1
