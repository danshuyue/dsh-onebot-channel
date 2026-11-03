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
import { readFileSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import { callOneBot } from './onebot.js'
import { note } from './env.js'

/** 单块上传的字节上限。实测 16MB 没问题；给到 20MB 留余量，超了直接拒。 */
export const MAX_VOICE_BYTES = 20 * 1024 * 1024

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
 * 把本地音频上传到协议端，返回**它那边**的路径。
 *
 * @param {string} filePath 本机音频路径
 * @returns {Promise<{ok:true, filePath:string, bytes:number} | {ok:false, error:string}>}
 *   失败不抛：调用方是工具，要把原因说给模型听。
 */
export async function uploadVoiceFile(filePath) {
  const raw = String(filePath ?? '').trim()
  if (raw === '') return { ok: false, error: '没给文件路径' }
  if (!looksLikeAudio(raw)) {
    return { ok: false, error: `不认识的音频格式（${raw}）。支持 ${[...AUDIO_EXT].join(' / ')}` }
  }

  let bytes
  try {
    const info = statSync(raw)
    if (!info.isFile()) return { ok: false, error: `不是文件：${raw}` }
    if (info.size === 0) return { ok: false, error: `文件是空的：${raw}` }
    if (info.size > MAX_VOICE_BYTES) {
      return { ok: false, error: `文件太大（${Math.round(info.size / 1024 / 1024)}MB，上限 ${MAX_VOICE_BYTES / 1024 / 1024}MB）` }
    }
    bytes = readFileSync(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `读不到这个文件（${message}）` }
  }

  const streamId = randomUUID()
  const filename = basename(raw) || 'voice.wav'

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
  const uploaded = await uploadVoiceFile(filePath)
  if (uploaded.ok !== true) throw new Error(uploaded.error)

  const isGroup = target?.kind === 'group'
  // 私聊没给 id 时退到默认私聊对象（跟 outbound.sendOneToQQ 同口径）
  const { getConfig } = await import('./config.js')
  const config = getConfig()
  const privateUin = Number(target?.id ?? 0) > 0 ? Number(target.id) : Number(config.peerUin)

  const result = await callOneBot({
    action: isGroup ? 'send_group_msg' : 'send_private_msg',
    params: isGroup
      ? { group_id: Number(target.id), message: [{ type: 'record', data: { file: uploaded.filePath } }] }
      : { user_id: privateUin, message: [{ type: 'record', data: { file: uploaded.filePath } }] },
    timeoutMs: 30000
  })
  if (result?.retcode !== 0) {
    throw new Error(`语音没发出去（retcode=${result?.retcode ?? '?'} ${String(result?.wording ?? result?.message ?? '').trim()}）`)
  }
  return result
}
