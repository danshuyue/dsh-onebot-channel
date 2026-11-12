/**
 * voiceout.js —— 把本地音频文件当语音发到 QQ。
 *
 * 为什么需要单独一个模块（2026-11-04）：
 *   SnowLuma 跑在**另一台机器**（实测 192.168.79.128，VMware 里的 Windows），
 *   所以 `send_private_msg` 里填本机路径会 ENOENT —— 它看到的是它自己的文件系统。
 *   必须先把字节传过去、拿到**它那边**的 file_path，才能作为 record 段发出去。
 *
 * 两步走（实测 SnowLuma 2.2.1）：
 *   1. POST /upload_file_stream { stream_id, filename, total_chunks:1, file_size,
 *        chunk_index:0, chunk_data:<base64> }        → chunk_received
 *   2. POST /upload_file_stream { stream_id, is_complete:true }
 *        → { file_path: "C:\\...\\onebot-stream\\upload\\<uin>\\<sid>__<name>.wav" }
 *   3. 拿 file_path 作为 record 段的 file 发出去
 *
 * ⚠️ 第 2 步必须是**单独一次请求**：`is_complete:true` 跟数据块塞在同一个请求里
 *   只会返回 chunk_received（实测），拿不到 file_path。
 *
 * ⚠️ 为什么要 base64 一整块而不是分块：单块 16MB 实测 241ms 就过了，
 *   而 TTS 出来的 wav 一般几百 KB。分块只在超大文件时才值得，这里不需要。
 *
 * ⚠️ 为什么格式不用自己转：实测 wav 和 mp3 直接传，SnowLuma 会自己转成 amr，
 *   QQ 客户端能正常播放（ffprobe 复核过 6.58 秒的成品）。
 */
import { readFileSync, statSync, realpathSync, mkdirSync, existsSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { callOneBot } from './onebot.js'
import { DATA_DIR, note } from './env.js'
import { getConfig } from './config.js'
import { assertSendAllowed, normUin } from './allowlist.js'
import { findSensitive } from './sensitive.js'

/** 单块上传的字节上限。实测 16MB 没问题；给到 20MB 留余量，超了直接拒。 */
export const MAX_VOICE_BYTES = 20 * 1024 * 1024
export const LEADING_SILENCE_MS = 250
export const DEFAULT_VOICE_MAX_PER_MINUTE = 5

/** 认得的音频扩展名。SnowLuma 会自己转码，所以这里只管「是不是音频」。 */
const AUDIO_EXT = new Set(['wav', 'mp3', 'silk', 'amr', 'ogg', 'm4a', 'flac', 'spx', 'wma'])

/** 这个路径看起来像音频吗（按扩展名判断，不嗅探内容）。 */
export function looksLikeAudio(filePath) {
  const name = String(filePath ?? '').trim()
  const dot = name.lastIndexOf('.')
  if (dot < 0) return false
  return AUDIO_EXT.has(name.slice(dot + 1).toLowerCase())
}

/**
 * 语音产物目录的**实际根**（2026-11-06 改）。
 *
 * 以前：`voiceOutputDir` 留空 = 拒绝读取本机任何语音文件。
 * 现在：留空 = 用 `<工作区>/voice`；配置成 `off` 才是真的关掉。
 *
 * 为什么要改：空串当「禁止」等于让所有人开箱即用时功能是坏的，
 * 而用户并不知道自己需要先去填一个目录。给个默认位置、需要时再关，
 * 比「默认坏掉、要自己去修」合理。
 *
 * ⚠️ 但「默认给个目录」不等于放松安全边界：`off` 仍然是硬关闭，
 *    而且目录**只能**是这个默认位置或用户显式配置的那个 ——
 *    下面的 resolveConfiguredVoicePath 照样做 realpath containment 检查，
 *    链接逃逸、目录外文件、内容签名、大小、频控一条都没放松。
 *    这个函数的产出只是「信任根在哪」，不是「放行」。
 *
 * 目录不存在时**在这里建**：默认位置是新的，第一次发语音时它一定还没建。
 * 建不出来就返回错误（而不是静默失败），否则会表现成「发语音没反应」。
 *
 * @returns {{ ok: true, dir: string } | { ok: false, error: string }}
 */
export function voiceOutputRoot() {
  const config = getConfig()
  const configured = String(config?.voiceOutputDir ?? '').trim()

  // 显式关掉。保留这个语义，否则用户没有办法真正禁用本机文件读取。
  // 大小写不敏感是**故意的**：用户手打 "Off" / "OFF" 都该关掉，
  // 而不是掉进「把 OFF 当成一个目录名去建」那条路。
  // 代价：真有个叫 OFF 的目录想拿来放语音的人会被挡住 —— 这种人多半不存在，
  // 而「以为关了其实没关」是安全问题，不对称就得往安全那边倒。
  if (configured.toLowerCase() === 'off') {
    return { ok: false, error: '语音发送已关闭（语音产物目录设成了 off）' }
  }

  // 默认位置**优先落 DATA_DIR，不落工作区**（2026-11-06 审核后改）。
  //
  // 为什么不是 `<工作区>/voice`：工作区是 **agent 自己可写**的地方。
  // 默认目录落在那儿 = agent 能自己造目录、往里塞东西，而语音出口
  // 不做文字敏感词审计（见 tool.js 的 voice 参数说明）——
  // 等于给了一条「自己写文件、自己念出来发出去」的旁路。
  // DATA_DIR（~/.dsh）不是 agent 的常规工作目录，门槛高得多。
  // 用户仍可以显式把 voiceOutputDir 指到工作区里，那是他自己的选择。
  const isDefault = configured === ''
  const dir = isDefault ? join(DATA_DIR, 'voice') : configured

  // 只在**不存在**时才建，而且**只给默认分支建**（2026-11-06 审核后改）。
  //
  // 为什么不给显式配置的分支建：用户把 `D:\tts-out` 打成 `D:\tts-oot` 时，
  // 旧行为是「语音输出目录不可用（ENOENT）」—— 他知道是自己填错了。
  // 如果这里替他建出来，报错会变成「读不到这个文件」，反而把他引向
  // 「是不是 TTS 没生成」这个错误方向。默认分支不同：那个目录本来就不存在，
  // 不建的话第一次发语音必然失败，而用户没做错任何事。
  try {
    if (existsSync(dir)) {
      // 「存在」不等于「是目录」：用户完全可能把这里填成一个文件名。
      if (!statSync(dir).isDirectory()) {
        return { ok: false, error: `语音产物目录不是目录：${dir}` }
      }
    } else if (isDefault) {
      mkdirSync(dir, { recursive: true })
    } else {
      return { ok: false, error: `语音输出目录不存在：${dir}（路径填错了？它不会被自动创建）` }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `语音产物目录不可用（${message}）：${dir}` }
  }
  return { ok: true, dir }
}

/** 真实路径，**必须用 native 版**（2026-11-06 审核发现的逃逸漏洞）。
 *
 * `realpathSync`（JS 实现）**不解析 Windows 目录 junction**，只有
 * `realpathSync.native` 会。实测：根目录里放一个 junction 指向外部目录，
 * 请求 `root/escape/secret.txt` 时——
 *   · `realpathSync`        → `...\root\escape\secret.txt`（没跳出去，containment 通过）
 *   · `realpathSync.native` → `...\outside\secret.txt`（跳出去了，被拦）
 * 也就是说用 JS 版做 containment，任何人（含 agent 自己）都能在信任根里
 * 造一个 junction，把任意本机文件当语音发出去。
 *
 * 这个漏洞不是本次改动引入的（更早就有），但默认目录落进 agent 可写的工作区
 * 会让它变得随手可用 —— 所以默认目录挪去了 DATA_DIR，这里同时换成 native。
 */
function realpathDeep(target) {
  return realpathSync.native(target)
}

/**
 * 扫一遍语音字节里的可见文本，命中敏感信息就返回描述（2026-11-06 审核后加）。
 *
 * 为什么语音也要审：文本出口有 `assertClean`，语音出口原来**完全不看内容** ——
 * 只要能把字节包成合法 WAV 容器（`validateVoiceBytes` 只验 RIFF/WAVE/fmt/data
 * 结构，data 里装什么不管），本机路径和凭据特征就能绕过审计发出去。
 *
 * 怎么扫：把字节按 latin1 解成字符串。音频是二进制，绝大多数是噪声，
 * 但 ASCII 明文（路径、sk- 开头的 key）会原样保留下来，正则照样能命中。
 * 用 latin1 而不是 utf8：utf8 解码遇到非法字节会插入替换符，可能把
 * 一段连续的 ASCII 打断成两截，反而漏掉。
 *
 * 代价：20MB 的文件解一次字符串 + 一次正则，实测在几十毫秒量级，
 * 而语音发送本身要走网络上传，这点开销可以接受。
 */
function findSensitiveText(bytes) {
  let text
  try {
    text = bytes.toString('latin1')
  } catch {
    return null
  }
  const hit = findSensitive(text)
  if (hit === null) return null
  return hit.kind === 'credential' ? `凭据特征 ${hit.sample}` : `本机路径 ${hit.sample}`
}

/** 解析并校验本机语音路径：只允许配置的 TTS 目录内真实文件。 */
function resolveConfiguredVoicePath(filePath) {
  const raw = String(filePath ?? '').trim()
  if (raw === '') return { ok: false, error: '没给文件路径' }

  const rootInfo = voiceOutputRoot()
  if (rootInfo.ok !== true) return { ok: false, error: rootInfo.error }
  const configured = rootInfo.dir

  let root
  try {
    root = realpathDeep(resolve(configured))
    if (!statSync(root).isDirectory()) return { ok: false, error: `语音输出目录不是目录：${configured}` }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `语音输出目录不可用（${message}）` }
  }

  const requested = isAbsolute(raw) ? resolve(raw) : resolve(root, raw)
  let real
  try {
    // native 版：JS 版不解析 Windows junction，会放过「根内 junction 指向外部」。
    real = realpathDeep(requested)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `读不到这个文件（${message}）` }
  }

  const relativePath = relative(root, real)
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    return { ok: false, error: '语音文件必须位于配置的 TTS 输出目录内' }
  }
  return { ok: true, path: real }
}

/** 音频内容签名校验：扩展名是必要条件，不是内容证明。 */
function validateVoiceBytes(filePath, bytes) {
  const ext = filePath.slice(filePath.lastIndexOf('.') + 1).toLowerCase()
  const has = (offset, text) => bytes.length >= offset + Buffer.byteLength(text) && bytes.toString('ascii', offset, offset + Buffer.byteLength(text)) === text
  if (ext === 'wav') {
    if (!has(0, 'RIFF') || !has(8, 'WAVE') || bytes.length < 44) return 'WAV 文件头无效（不是完整 RIFF/WAVE）'
    const end = bytes.readUInt32LE(4) + 8
    if (end !== bytes.length) return 'WAV 文件结构无效（RIFF 长度不匹配）'
    let offset = 12
    let hasFormat = false
    let hasData = false
    while (offset + 8 <= end) {
      const id = bytes.toString('ascii', offset, offset + 4)
      const size = bytes.readUInt32LE(offset + 4)
      const dataEnd = offset + 8 + size
      if (dataEnd > end) return 'WAV 文件结构无效（块超出文件范围）'
      if (id === 'fmt ' && size >= 16) hasFormat = true
      if (id === 'data' && size > 0) hasData = true
      offset = dataEnd + (size & 1)
    }
    if (offset !== end || !hasFormat || !hasData) return 'WAV 文件结构无效（缺少有效 fmt/data 块）'
    return null
  }
  if (ext === 'mp3') {
    if (has(0, 'ID3')) return null
    if (bytes.length >= 4 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return null
    return 'MP3 文件头无效'
  }
  if (ext === 'amr' && (has(0, '#!AMR\n') || has(0, '#!AMR-WB\n'))) return null
  if ((ext === 'ogg' || ext === 'spx') && has(0, 'OggS')) return null
  if (ext === 'flac' && has(0, 'fLaC')) return null
  if (ext === 'm4a' && has(4, 'ftyp')) return null
  if (ext === 'silk' && has(0, '#!SILK_V3')) return null
  if (ext === 'wma' && bytes.length >= 16 && bytes.subarray(0, 16).equals(Buffer.from('3026b2758e66cf11a6d900aa0062ce6c', 'hex'))) return null
  if (ext === 'wav') return 'WAV 文件头无效（不是 RIFF/WAVE）'
  return `音频内容与 .${ext} 扩展名不匹配`
}

function prependWavSilence(bytes) {
  let offset = 12
  let format = null
  let dataHeader = -1
  let dataOffset = -1
  let dataSize = 0

  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const end = offset + 8 + size
    if (end > bytes.length) return bytes
    if (id === 'fmt ' && size >= 16) {
      format = {
        code: bytes.readUInt16LE(offset + 8),
        sampleRate: bytes.readUInt32LE(offset + 12),
        blockAlign: bytes.readUInt16LE(offset + 20)
      }
    } else if (id === 'data' && dataHeader < 0) {
      dataHeader = offset
      dataOffset = offset + 8
      dataSize = size
    }
    offset = end + (size & 1)
  }

  if (format === null || dataHeader < 0 || dataSize === 0 || format.sampleRate === 0 || format.blockAlign === 0) return bytes
  if (format.code !== 1 && format.code !== 3) return bytes

  const frames = Math.ceil(format.sampleRate * LEADING_SILENCE_MS / 1000)
  let silenceLength = frames * format.blockAlign
  if (silenceLength % 2 !== 0) silenceLength += format.blockAlign
  if (silenceLength > MAX_VOICE_BYTES - bytes.length) return null
  const silence = Buffer.alloc(silenceLength)
  const output = Buffer.concat([bytes.subarray(0, dataOffset), silence, bytes.subarray(dataOffset)])
  output.writeUInt32LE(output.length - 8, 4)
  output.writeUInt32LE(dataSize + silence.length, dataHeader + 4)
  return output
}

const voiceAttempts = new Map()
const VOICE_RATE_WINDOW_MS = 60000
export function resetVoiceRateState() { voiceAttempts.clear() }

function targetForVoice(target, config) {
  const isGroup = target?.kind === 'group'
  if (!isGroup && target?.kind !== 'private') throw new Error('语音发送目标类型不合法')
  const rawId = String(target?.id ?? '').trim() || (isGroup ? '' : String(config.peerUin ?? '').trim())
  const uin = normUin(rawId)
  if (uin === '') throw new Error('语音发送目标号不合法')
  const id = Number(uin)
  const action = isGroup ? 'send_group_msg' : 'send_private_msg'
  const params = isGroup ? { group_id: id } : { user_id: id }
  assertSendAllowed(action, params, String(config.peerUin ?? ''))
  return { action, params, key: `${isGroup ? 'group' : 'private'}:${id}` }
}

function claimVoiceSlot(key) {
  const limit = DEFAULT_VOICE_MAX_PER_MINUTE
  if (limit === 0) throw new Error('语音发送已被配置为禁用（每分钟上限为 0）')
  const now = Date.now()
  for (const [target, previous] of voiceAttempts) {
    const active = previous.filter((at) => now - at < VOICE_RATE_WINDOW_MS)
    if (active.length === 0) voiceAttempts.delete(target)
    else voiceAttempts.set(target, active)
  }
  const previous = voiceAttempts.get(key) ?? []
  if (previous.length >= limit) throw new Error(`语音发送过于频繁（每分钟最多 ${limit} 次）`)
  previous.push(now)
  voiceAttempts.set(key, previous)
}


/**
 * 把本地音频上传到协议端，返回**它那边**的路径。
 *
 * @param {string} filePath 本机音频路径
 * @returns {Promise<{ok:true, filePath:string, bytes:number} | {ok:false, error:string}>}
 *   失败不抛：调用方是工具，要把原因说给模型听。
 */
export async function uploadVoiceFile(filePath) {
  const raw = String(filePath ?? '').trim()
  const resolved = resolveConfiguredVoicePath(raw)
  if (resolved.ok !== true) return resolved
  const realPath = resolved.path
  if (!looksLikeAudio(realPath)) {
    return { ok: false, error: `不认识的音频格式（${raw}）。支持 ${[...AUDIO_EXT].join(' / ')}` }
  }

  let bytes
  try {
    const before = statSync(realPath)
    if (!before.isFile()) return { ok: false, error: `不是文件：${raw}` }
    if (before.size === 0) return { ok: false, error: `文件是空的：${raw}` }
    if (before.size > MAX_VOICE_BYTES) {
      return { ok: false, error: `文件太大（${Math.round(before.size / 1024 / 1024)}MB，上限 ${MAX_VOICE_BYTES / 1024 / 1024}MB）` }
    }
    bytes = readFileSync(realPath)
    // 文件可能在读取期间被替换；至少保证上传字节数与读取后的 stat 一致。
    const after = statSync(realPath)
    if (realpathDeep(realPath) !== realPath || !after.isFile() || after.size !== before.size || bytes.length !== after.size) {
      return { ok: false, error: '语音文件在读取期间发生变化，拒绝上传' }
    }
    const invalid = validateVoiceBytes(realPath, bytes)
    if (invalid !== null) return { ok: false, error: invalid }
    // 内容审计（2026-11-06 审核后加）：语音出口原来**完全不看内容**，
    // 而文本出口有 assertClean。这意味着只要能把字节包成合法 WAV 容器，
    // 本机路径 / 凭据特征就能绕过审计发出去 —— 默认目录落进 agent 可写区域时
    // 这条路等于敞开。这里补一道：按文本扫一遍，命中就拒。
    // 只在 WAV 的 data 块之外也能扫到，所以直接扫全量字节里的可见文本。
    const leak = findSensitiveText(bytes)
    if (leak !== null) return { ok: false, error: `语音内容里出现敏感信息（${leak}），拒绝发送` }
    const padded = prependWavSilence(bytes)
    if (padded === null || padded.length > MAX_VOICE_BYTES) {
      return { ok: false, error: `加入开头静音后文件过大（上限 ${MAX_VOICE_BYTES / 1024 / 1024}MB）` }
    }
    bytes = padded
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `读不到这个文件（${message}）` }
  }

  const streamId = randomUUID()
  const filename = basename(realPath) || 'voice.wav'

  // ---- 第 1 步：传数据 ----
  try {
    const first = await callOneBot({
      action: 'upload_file_stream',
      params: {
        stream_id: streamId,
        filename,
        total_chunks: 1,
        file_size: bytes.length,
        chunk_index: 0,
        chunk_data: bytes.toString('base64')
      },
      // 语音文件比普通接口慢，但也别拖着一回合；16MB 实测 241ms，给 30 秒足够宽
      timeoutMs: 30000
    })
    if (first?.retcode !== 0) {
      const why = String(first?.wording ?? first?.message ?? '').trim()
      note('voiceout', `上传第 1 步失败：retcode=${first?.retcode ?? '?'} ${why}`)
      return { ok: false, error: why === '' ? `上传失败（retcode=${first?.retcode ?? '?'}）` : why }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    note('voiceout', `上传第 1 步抛错：${message}`)
    return { ok: false, error: `音频没传上去（${message}）` }
  }

  // ---- 第 2 步：单独请求完成，拿 file_path ----
  // ⚠️ 不能跟数据块合并（实测只会回 chunk_received，不给 file_path）
  try {
    const done = await callOneBot({
      action: 'upload_file_stream',
      params: { stream_id: streamId, is_complete: true },
      timeoutMs: 30000
    })
    if (done?.retcode !== 0) {
      const why = String(done?.wording ?? done?.message ?? '').trim()
      note('voiceout', `上传第 2 步失败：retcode=${done?.retcode ?? '?'} ${why}`)
      return { ok: false, error: why === '' ? `上传收尾失败（retcode=${done?.retcode ?? '?'}）` : why }
    }
    const remote = String(done?.data?.file_path ?? '').trim()
    if (remote === '') {
      note('voiceout', '上传完成但没给 file_path')
      return { ok: false, error: '协议端上传完成却没返回文件路径' }
    }
    note('voiceout', `上传完成 ${filename} ${bytes.length} 字节 → ${remote}`)
    return { ok: true, filePath: remote, bytes: bytes.length }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    note('voiceout', `上传第 2 步抛错：${message}`)
    return { ok: false, error: `音频上传收尾失败（${message}）` }
  }
}

/**
 * 发一条语音。会先上传，再以 record 段发出去。
 *
 * @param {{kind:'private'|'group', id:string}} target 目标
 * @param {string} filePath 本机音频路径
 * @returns {Promise<{message_id:number}>}
 */
export async function sendVoiceToQQ(target, filePath) {
  const config = getConfig()
  const destination = targetForVoice(target, config)
  claimVoiceSlot(destination.key)
  const uploaded = await uploadVoiceFile(filePath)
  if (uploaded.ok !== true) throw new Error(uploaded.error)

  const result = await callOneBot({
    action: destination.action,
    params: { ...destination.params, message: [{ type: 'record', data: { file: uploaded.filePath } }] },
    timeoutMs: 30000
  })
  if (result?.retcode !== 0) {
    throw new Error(`语音没发出去（retcode=${result?.retcode ?? '?'} ${String(result?.wording ?? result?.message ?? '').trim()}）`)
  }
  return result
}
