/**
 * voiceout-sim.mjs —— 出站语音（lib/voiceout.js）的离线模拟。
 *
 * 钉住的东西：
 *   1. 两步上传：数据块 → 单独的 is_complete 请求（合并成一请求拿不到 file_path）
 *   2. 拿到的是**协议端那边的** file_path，本地路径直接填进 record 段会 ENOENT
 *   3. 只认音频扩展名；不是音频 / 文件不存在 / 空文件 / 超大，都在上传前拒掉
 *   4. 失败一律返回 {ok:false} 不抛；发送阶段失败才抛（那时已经上传成功）
 *   5. 群 / 私聊各自打到正确的 action 和参数字段
 *
 * 隔离：临时 HOME，fetch 被替换，不碰真 ~/.dsh、不碰真协议端。
 */
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'dsh-voiceout-test-'))
const SANDBOX_DATA = join(SANDBOX_HOME, '.dsh')
mkdirSync(SANDBOX_DATA, { recursive: true })
process.env.USERPROFILE = SANDBOX_HOME
process.env.HOME = SANDBOX_HOME
process.on('exit', () => {
  try { rmSync(SANDBOX_HOME, { recursive: true, force: true }) } catch {}
})

const AUDIO_DIR = join(SANDBOX_HOME, 'audio')
mkdirSync(AUDIO_DIR, { recursive: true })

writeFileSync(join(SANDBOX_DATA, 'qq-bridge.config.json'), JSON.stringify({
  enabled: true,
  selfUin: '3566906627',
  peerUin: '1321833118',
  ownerUin: '1321833118',
  // 群必须写进 groupUins，否则 allowlist 会把群语音拦下来（这是对的，不是 bug）
  groupUins: ['1103117551'],
  voiceOutputDir: AUDIO_DIR,
  onebotHttp: 'http://127.0.0.1:9/',
  token: 'test-token'
}, null, 2), 'utf8')

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.error(`  ✗ ${name}`) }
}

// ---- 假音频文件 ----
function wavBytes() {
  const bytes = Buffer.alloc(46)
  bytes.write('RIFF', 0, 'ascii')
  bytes.writeUInt32LE(38, 4)
  bytes.write('WAVEfmt ', 8, 'ascii')
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20) // PCM
  bytes.writeUInt16LE(1, 22) // mono
  bytes.writeUInt32LE(8000, 24)
  bytes.writeUInt32LE(16000, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36, 'ascii')
  bytes.writeUInt32LE(2, 40)
  return bytes
}
const WAV = join(AUDIO_DIR, 'voice.wav')
writeFileSync(WAV, wavBytes())
const AMR = join(AUDIO_DIR, 'voice.amr')
writeFileSync(AMR, Buffer.from('#!AMR\n\x00', 'binary'))
const AMR_WB = join(AUDIO_DIR, 'voice-wb.amr')
writeFileSync(AMR_WB, Buffer.from('#!AMR-WB\n\x00', 'binary'))
const FAKE_WAV = join(AUDIO_DIR, 'fake.wav')
writeFileSync(FAKE_WAV, Buffer.from('not a wav', 'ascii'))
const TXT = join(AUDIO_DIR, 'notes.txt')
writeFileSync(TXT, 'not audio', 'utf8')
const EMPTY = join(AUDIO_DIR, 'empty.wav')
writeFileSync(EMPTY, '', 'utf8')
const OUTSIDE = join(SANDBOX_HOME, 'outside.wav')
writeFileSync(OUTSIDE, wavBytes())
const OUTSIDE_DIR = join(SANDBOX_HOME, 'outside-audio')
mkdirSync(OUTSIDE_DIR, { recursive: true })
const OUTSIDE_DIR_WAV = join(OUTSIDE_DIR, 'outside.wav')
writeFileSync(OUTSIDE_DIR_WAV, wavBytes())
const ESCAPE_DIR = join(AUDIO_DIR, 'escape')
let symlinkAvailable = false
try {
  symlinkSync(OUTSIDE_DIR, ESCAPE_DIR, 'junction')
  symlinkAvailable = lstatSync(ESCAPE_DIR).isSymbolicLink()
} catch { /* 仅在不支持 junction 的环境跳过该用例 */ }

// ---- 假协议端 ----
const calls = []
/** 每次调用按 action 决定怎么答 */
let uploadStep1 = { retcode: 0, status: 'ok', data: { type: 'stream', status: 'chunk_received' } }
let uploadStep2 = { retcode: 0, status: 'ok', data: { type: 'response', status: 'file_complete', file_path: 'C:\\remote\\abc__voice.wav' } }
let sendReply = { retcode: 0, data: { message_id: -123456 } }

globalThis.fetch = async (_url, init) => {
  const body = JSON.parse(init?.body ?? '{}')
  calls.push({ action: body.action, params: body.params })
  if (body.action === 'upload_file_stream') {
    // 关键判别：带 is_complete 的才是第 2 步
    return { ok: true, json: async () => (body.params?.is_complete === true ? uploadStep2 : uploadStep1) }
  }
  return { ok: true, json: async () => sendReply }
}

const { loadConfig, getConfig } = await import('../lib/config.js')
const voiceout = await import('../lib/voiceout.js')
loadConfig()

const bytes = 213 // 上面那段 ascii 的长度不重要，只用来验证 base64 传的是同一份字节

console.log('1. 扩展名判断（只认音频）：')
{
  ok(voiceout.looksLikeAudio('a.wav') === true, 'a.wav 是音频')
  ok(voiceout.looksLikeAudio('A.WAV') === true, '大写扩展名也认')
  ok(voiceout.looksLikeAudio('a.mp3') === true, 'mp3 是音频')
  ok(voiceout.looksLikeAudio('a.txt') === false, 'txt 不是音频')
  ok(voiceout.looksLikeAudio('noext') === false, '没有扩展名不是音频')
  ok(voiceout.looksLikeAudio('') === false, '空串不是音频')
}

console.log('\n2. 两步上传（合并成一请求拿不到 file_path）：')
{
  calls.length = 0
  const result = await voiceout.uploadVoiceFile(WAV)
  ok(result.ok === true, '上传成功')
  ok(result.filePath === 'C:\\remote\\abc__voice.wav', `交回的是协议端那边的路径（实际 ${result.filePath}）`)
  ok(result.filePath !== WAV, '不是本地路径 —— 本地路径填进 record 段会 ENOENT')
  const uploads = calls.filter((c) => c.action === 'upload_file_stream')
  ok(uploads.length === 2, `upload_file_stream 调了 2 次（实际 ${uploads.length}）`)
  ok(uploads[0]?.params?.is_complete === undefined, '第 1 次只传数据，不带 is_complete')
  ok(uploads[1]?.params?.is_complete === true, '第 2 次单独请求完成')
  ok(uploads[1]?.params?.stream_id === uploads[0]?.params?.stream_id, '两次用同一个 stream_id')
  ok(typeof uploads[0]?.params?.chunk_data === 'string' && uploads[0].params.chunk_data.length > 0, 'chunk_data 是 base64 字符串')
  ok(uploads[0]?.params?.chunk_data !== WAV, 'chunk_data 传的是内容不是路径')
  ok(uploads[0]?.params?.total_chunks === 1, '单块上传（total_chunks=1）')
  ok(uploads[0]?.params?.filename === 'voice.wav', '带上了文件名')
}

console.log('\n2b. AMR / AMR-WB 的标准 LF 头：')
{
  for (const [path, label] of [[AMR, 'AMR'], [AMR_WB, 'AMR-WB']]) {
    calls.length = 0
    const result = await voiceout.uploadVoiceFile(path)
    ok(result.ok === true, `${label} 标准换行头通过校验（${result.error || 'ok'}）`)
    ok(calls.length === 2, `${label} 走完两步上传`)
  }
}

console.log('\n3. 非音频 / 坏文件在**上传前**就拒掉（不发请求）：')
{
  for (const [path, label, expect] of [
    [TXT, 'txt 文件', '不认识的音频格式'],
    [FAKE_WAV, '扩展名伪装的 WAV', 'WAV 文件头无效'],
    [OUTSIDE, 'TTS 目录外音频', '必须位于配置的 TTS 输出目录内'],
    ...(symlinkAvailable ? [[join(ESCAPE_DIR, 'outside.wav'), '目录 junction 指向外部', '必须位于配置的 TTS 输出目录内']] : []),
    [EMPTY, '空文件', '空的'],
    ['', '空路径', '没给文件路径'],
    [join(AUDIO_DIR, 'nope.wav'), '不存在的文件', '读不到']
  ]) {
    calls.length = 0
    const result = await voiceout.uploadVoiceFile(path)
    ok(result.ok === false, `${label} → ok:false`)
    ok(String(result.error).includes(expect), `${label} 的错因含「${expect}」（实际「${result.error}」）`)
    ok(calls.length === 0, `${label} 没有发出任何请求`)
  }
}

console.log('\n3b. 空的语音目录配置关闭本机读取：')
{
  const original = getConfig().voiceOutputDir
  calls.length = 0
  getConfig().voiceOutputDir = ''
  const result = await voiceout.uploadVoiceFile(WAV)
  ok(result.ok === false && String(result.error).includes('未配置语音输出目录'), '未配置输出目录时拒绝读取')
  ok(calls.length === 0, '未配置输出目录时不发请求')
  getConfig().voiceOutputDir = original
}

console.log('\n4. 上传各阶段失败都不抛：')
{
  calls.length = 0
  uploadStep1 = { retcode: 100, wording: 'stream quota exceeded' }
  let result = await voiceout.uploadVoiceFile(WAV)
  ok(result.ok === false, '第 1 步失败 → ok:false')
  ok(String(result.error).includes('stream quota'), `第 1 步错因带出（实际「${result.error}」）`)
  ok(calls.length === 1, `第 1 步失败就不再发第 2 步（实际 ${calls.length} 次请求）`)

  uploadStep1 = { retcode: 0, status: 'ok', data: { type: 'stream' } }
  uploadStep2 = { retcode: 100, wording: 'merge failed' }
  result = await voiceout.uploadVoiceFile(WAV)
  ok(result.ok === false, '第 2 步失败 → ok:false')
  ok(String(result.error).includes('merge failed'), `第 2 步错因带出（实际「${result.error}」）`)

  uploadStep2 = { retcode: 0, status: 'ok', data: { type: 'response', status: 'file_complete' } }
  result = await voiceout.uploadVoiceFile(WAV)
  ok(result.ok === false, '完成但没给 file_path → 也算失败')
  ok(String(result.error).includes('没返回文件路径'), `说清了原因（实际「${result.error}」）`)
}

console.log('\n5. 发语音：群 / 私聊打到正确的 action 和字段：')
{
  uploadStep1 = { retcode: 0, status: 'ok', data: { type: 'stream' } }
  uploadStep2 = { retcode: 0, status: 'ok', data: { type: 'response', status: 'file_complete', file_path: 'C:\\remote\\x.wav' } }

  // 私聊：显式 user_id
  calls.length = 0
  sendReply = { retcode: 0, data: { message_id: -111 } }
  await voiceout.sendVoiceToQQ({ kind: 'private', id: '1321833118' }, WAV)
  const priv = calls.find((c) => c.action === 'send_private_msg')
  ok(priv !== undefined, '私聊走 send_private_msg')
  ok(priv?.params?.user_id === 1321833118, `user_id 是数字（实际 ${typeof priv?.params?.user_id}）`)
  ok(priv?.params?.message?.[0]?.type === 'record', '段类型是 record')
  ok(priv?.params?.message?.[0]?.data?.file === 'C:\\remote\\x.wav', 'file 用的是协议端返回的路径')

  // 私聊：不给 id → 退到 peerUin
  calls.length = 0
  await voiceout.sendVoiceToQQ({ kind: 'private' }, WAV)
  const fallback = calls.find((c) => c.action === 'send_private_msg')
  ok(fallback?.params?.user_id === 1321833118, '没给 id 时退到 peerUin')

  // 群
  calls.length = 0
  await voiceout.sendVoiceToQQ({ kind: 'group', id: '1103117551' }, WAV)
  const grp = calls.find((c) => c.action === 'send_group_msg')
  ok(grp !== undefined, '群聊走 send_group_msg')
  ok(grp?.params?.group_id === 1103117551, 'group_id 是数字')
  ok(grp?.params?.message?.[0]?.type === 'record', '群里也是 record 段')
}

console.log('\n6. 发送阶段失败要抛（上传成功但没发出去 ≠ 成功）：')
{
  sendReply = { retcode: 100, wording: 'send failed' }
  let threw = false
  let message = ''
  try {
    await voiceout.sendVoiceToQQ({ kind: 'private', id: '1321833118' }, WAV)
  } catch (error) {
    threw = true
    message = error instanceof Error ? error.message : String(error)
  }
  ok(threw === true, '发送失败抛错（不静默成功）')
  ok(message.includes('语音没发出去'), `错因说得清（实际「${message}」）`)

  // 上传就失败时，sendVoiceToQQ 也要抛（不能当成发过了）
  uploadStep1 = { retcode: 100, wording: 'boom' }
  threw = false
  try {
    await voiceout.sendVoiceToQQ({ kind: 'private', id: '1321833118' }, WAV)
  } catch { threw = true }
  ok(threw === true, '上传失败时 sendVoiceToQQ 抛错')
  uploadStep1 = { retcode: 0, status: 'ok', data: { type: 'stream' } }
}

console.log('\n7. qq_send 的 voice 参数接好了：')
{
  voiceout.resetVoiceRateState()
  const { registerSendTool } = await import('../lib/tool.js')
  const regs = []
  const ctx = {
    get: (name) => (name === 'tools'
      ? { register: (t) => { regs.push(t); return () => {} } }
      : (name === 'attachments' ? { saveImages: async () => [] } : undefined)),
    effect: () => {}
  }
  await registerSendTool(ctx)
  const tool = regs[0] ?? {}
  ok(tool.name === 'qq_send', `注册的是 qq_send（实际 ${tool.name}）`)
  ok(Object.keys(tool.parameters?.properties ?? {}).includes('voice'), '参数表里有 voice')

  // ---- voice_sent 必须写进 output schema ----
  // additionalProperties:false 会把没声明的字段判成 ToolOutputError，
  // 于是「语音发成功了」反而变成「工具调用失败」。
  const outProps = Object.keys(tool.output?.schema?.properties ?? {})
  ok(outProps.includes('voice_sent'), `output schema 里声明了 voice_sent（实际 ${outProps.join('/')}）`)

  // ---- 只给 voice、不给 text：必须能发出去 ----
  // 这条挡的是 sendToQQ 里那句「要发送的内容是空的」提前抛错
  uploadStep1 = { retcode: 0, status: 'ok', data: { type: 'stream' } }
  uploadStep2 = { retcode: 0, status: 'ok', data: { type: 'response', status: 'file_complete', file_path: 'C:\\remote\\only.wav' } }
  sendReply = { retcode: 0, data: { message_id: -222 } }
  calls.length = 0
  let onlyVoice
  let onlyVoiceErr = ''
  try {
    onlyVoice = await tool.execute({ voice: WAV, user_id: '1321833118' })
  } catch (error) {
    onlyVoiceErr = error instanceof Error ? error.message : String(error)
  }
  ok(onlyVoiceErr === '', `只有语音也能发（报错：${onlyVoiceErr || '无'}）`)
  ok(onlyVoice?.voice_sent === true, '返回值标了 voice_sent=true')
  ok(calls.some((c) => c.action === 'send_private_msg' && c.params?.message?.[0]?.type === 'record'), '真的发出了 record 段')
  // 只有语音时不该额外发一条空文本
  const textSends = calls.filter((c) => c.action === 'send_private_msg' && c.params?.message?.some((s) => s.type === 'text'))
  ok(textSends.length === 0, `没有多出一条空文本消息（实际 ${textSends.length} 条）`)

  // ---- text + voice：先文字后语音 ----
  calls.length = 0
  await tool.execute({ text: '听一下', voice: WAV, user_id: '1321833118' })
  const sends = calls.filter((c) => c.action === 'send_private_msg')
  ok(sends.length === 2, `文字和语音各发一条（实际 ${sends.length}）`)
  ok(sends[0]?.params?.message?.some((s) => s.type === 'text'), '第一条是文字')
  ok(sends[1]?.params?.message?.[0]?.type === 'record', '第二条是语音')

  // ---- 什么都不给：要报错，不能静默成功 ----
  let emptyThrew = false
  try {
    await tool.execute({ user_id: '1321833118' })
  } catch { emptyThrew = true }
  ok(emptyThrew === true, '什么都没给时抛错（不静默成功）')

  // ---- render 要能说出「含一条语音」 ----
  const rendered = tool.output.render({}, { message_id: 1, voice_sent: true }).map((b) => b.text).join('')
  ok(rendered.includes('语音'), `render 里提到语音（实际「${rendered}」）`)
  const renderedPlain = tool.output.render({}, { message_id: 1 }).map((b) => b.text).join('')
  ok(!renderedPlain.includes('语音'), '没发语音时不提语音（输出形态不变）')

  // ---- 引用索引：qq_send 发出去的消息必须能被「引用」找回会话（2026-11-05）----
  //
  // ⚠️ 这是「引用即路由」的第二个入口。outbound.js 的自动转发记了，
  //    但她主动调 qq_send 说的话走的是另一条路 —— 那条不记，
  //    用户引用她主动说的话时就会静默回落到默认绑定会话。
  //    这个缺口是我在准备实测时才发现的，当时 outbound 记了、tool 没记。
  const focus = await import('../lib/focus.js')
  focus.clearSent()
  sendReply = { retcode: 0, data: { message_id: -777001 } }
  calls.length = 0

  // ① 给了 exec.agent.session → 必须记下索引
  await tool.execute(
    { text: '这条是当前会话发的', user_id: '1321833118' },
    { agent: { session: { header: { id: 'session-current-workspace' } } } }
  )
  const hit = focus.sessionOfSent('-777001')
  ok(hit !== null, '★ qq_send 发出消息后记下了引用索引（用户引用它才能回对这个会话）')
  ok(hit?.sessionId === 'session-current-workspace', `索引里记的是发起调用的会话（实际 ${hit?.sessionId}）`)

  // ② 没有 exec / 取不到 session → 不记，且不能记错
  focus.clearSent()
  sendReply = { retcode: 0, data: { message_id: -777002 } }
  await tool.execute({ text: '没有 exec 的消息', user_id: '1321833118' })
  ok(focus.sessionOfSent('-777002') === null, '★ 取不到 exec.agent.session 时不记索引（绝不瞎记一个 id）')

  // ③ ★★ 不传 user_id 时，索引的 targetKey 必须落到实际收件人（2026-11-05 线上实测踩到）
  //
  //   线上现象：她发消息时没传 user_id（默认发给本人），target 是 { kind:'private' } —— **id 为空**，
  //   于是 targetKey 记成 `private:`。用户引用那条消息时，查询侧算的是 `private:1321833118`，
  //   两者不等 → 日志写「引用 xxx 属于 private:，与当前 private:1321833118 不符，不跨 target 搬运」
  //   → 静默回落到默认绑定会话。这个 bug 光测「记没记」是抓不到的，
  //   必须断言 **key 的内容**。
  focus.clearSent()
  sendReply = { retcode: 0, data: { message_id: -777004 } }
  await tool.execute(
    { text: '不传 user_id 的消息' },
    { agent: { session: { header: { id: 'session-current-workspace' } } } }
  )
  const noIdHit = focus.sessionOfSent('-777004')
  ok(noIdHit !== null, '不传 user_id 时也记了索引')
  ok(
    noIdHit?.targetKey === 'private:1321833118',
    `★★ 不传 user_id 时 targetKey 落到实际收件人而不是 private:（实际 ${JSON.stringify(noIdHit?.targetKey)}）`
  )

  // ③ session.id 的另一种形状（没有 header）也要认
  focus.clearSent()
  sendReply = { retcode: 0, data: { message_id: -777003 } }
  await tool.execute(
    { text: '裸 id 形状', user_id: '1321833118' },
    { agent: { session: { id: 'session-bare-id' } } }
  )
  ok(focus.sessionOfSent('-777003')?.sessionId === 'session-bare-id', '★ session.id（无 header）也能取到')
  focus.clearSent()
}

console.log('\n8. 同一目标每分钟语音频控：')
{
  voiceout.resetVoiceRateState()
  calls.length = 0
  const target = { kind: 'group', id: '1103117551' }
  for (let i = 0; i < voiceout.DEFAULT_VOICE_MAX_PER_MINUTE; i += 1) {
    await voiceout.sendVoiceToQQ(target, WAV)
  }
  const beforeRejected = calls.length
  let rejected = false
  try { await voiceout.sendVoiceToQQ(target, WAV) } catch (error) {
    rejected = String(error?.message ?? error).includes('每分钟最多')
  }
  ok(rejected, '超过固定上限时拒绝发送')
  ok(calls.length === beforeRejected, '频控拒绝发生在上传前')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed > 0 ? 1 : 0)
