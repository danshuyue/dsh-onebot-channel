/**
 * tts.js —— 文本 → 本地音频文件（2026-11-07，0.19.0）。
 *
 * ## 为什么有这个模块
 *
 * 在此之前插件**只负责发**语音（voiceout.js），合成整个在插件外面：
 * 模型去调 `gptsovits` MCP，拿到 wav 路径再 `qq_send(voice=路径)`。
 * 要接 Breeze Blue 这种商业 API，就必须有人在插件里合成 —— 而 Breeze 没有 MCP。
 *
 * 所以本模块只做一件事：**把一段文字变成一个本地音频文件的路径**。
 * 不发送、不管名单、不管额度 —— 那是 tts-gate.js 的活。
 * 发出去仍然走 voiceout.js 的 sendVoiceToQQ，那条链路一行没动。
 *
 * ## 两条路
 *
 *   gptsovits → POST <voiceGptsovitsUrl>（默认 127.0.0.1:9872），免费、离线
 *   breeze    → POST api.breeze.blue/v1/text-to-speech/<voice_id>，按字计费
 *
 * 选哪条由 `voiceEngine` 决定，模型无感（用户 2026-11-07 定）。
 *
 * ## 三条硬纪律
 *
 * 1. **失败不抛。** 调用方是工具，要把原因原样说给模型听；抛错会被宿主翻成
 *    一条没有上下文的 ToolError，模型不知道该怎么应对。同 voice.js 的纪律。
 * 2. **所有合成串行走一个队列。** Breeze Free 档 `max_concurrent_generations: 1`
 *    （实测），而 GPT-SoVITS 是单进程 uvicorn（workers=1）—— 两边都扛不住并发。
 * 3. **落盘只落在 voiceOutputRoot() 里。** 那是语音出口的信任根，
 *    voiceout.js 的 containment 检查以它为准。写到外面等于造出「发不出去的语音」。
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { getConfig } from './config.js'
import { note } from './env.js'
import { voiceOutputRoot } from './voiceout.js'
import { findSensitive } from './sensitive.js'

// ==================== 常量 ====================

/** Breeze 的硬上限（实测：1200 字 → 422 `text must be 1000 characters or fewer`）。 */
export const BREEZE_MAX_CHARS = 1000

/** Breeze 基础地址。实测可用；env 覆盖只为测试方便，正常不用填。 */
export const BREEZE_BASE = 'https://api.breeze.blue'

/**
 * 合成超时。
 *
 * 实测：21 字 2866ms、9 字 2731ms~12057ms、**1000 字满额 5803ms**。
 * 那个 12 秒的观测和同样的 9 字文本放在一起，说明它是排队而不是计算 ——
 * 所以超时必须留足余量，**15 秒级别会误杀**。
 */
export const SYNTH_TIMEOUT_MS = 30000

/** 队列上限。超过就拒：语音是「冒头」的动作，一次要 4 条说明用法就不对。 */
export const MAX_QUEUED = 3

/** GPT-SoVITS 参考音频的硬性时长（秒）。服务端会拒，但在这里先拦能给出更好的话。 */
export const REF_MIN_SECONDS = 3
export const REF_MAX_SECONDS = 10

/**
 * 数值容错 + 区间钳制。
 *
 * 为什么需要：这些参数都是**用户手填**的（配置文件 / 设置页输入框），
 * 而服务端对越界值只会回一个没有细节的 500（Gradio 的老毛病）。
 * 在这里先夹到合法区间，至少能保证「填错了也还能合成出声音」。
 *
 * ⚠️ `null` / `undefined` / 空串 走默认值，而 **`0` 是合法值**
 *    （seed / cfg_rate 都可能要 0），所以不能用 `Number(x) || fallback`。
 */
function clampNumber(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

// ==================== 串行队列 ====================

/** 队列尾。**必须是模块级**：并发限制是全局限的，不是按会话/按目标。 */
let chain = Promise.resolve()
let pending = 0

/** 仅测试用：把队列状态清干净。 */
export function resetTtsQueue() {
  chain = Promise.resolve()
  pending = 0
}

/**
 * 把一个合成任务排进全局串行队列。
 *
 * ⚠️ `chain = run.catch(() => {})` 这一行是**关键**：
 *    不加的话，一次失败会让整条链变成 rejected，之后所有合成**瞬间全失败**，
 *    而且失败原因是上一个任务的错误 —— 这是 Promise 链队列的经典坑。
 *
 * @param {() => Promise<any>} task
 * @returns {Promise<any>} 任务本身的返回/抛出（队列不吞错误）
 */
export function enqueue(task) {
  if (pending >= MAX_QUEUED) {
    return Promise.reject(new Error(`语音合成排队太长了（一次最多 ${MAX_QUEUED} 条），等一等再要`))
  }
  pending += 1
  const run = chain.then(task)
  // 链上挂的是「吃掉错误」的版本，返回给调用方的 run 仍然会抛
  chain = run.then(() => {}, () => {})
  return run.finally(() => { pending -= 1 })
}

/** 当前排队数（测试/状态页用）。 */
export function queueDepth() {
  return pending
}

// ==================== 字节校验 ====================

/**
 * 内容审计：念出来的字里不能有本机路径 / 凭据。
 *
 * 为什么合成阶段就要审：voiceout.js 那边只扫**音频字节里的可见 ASCII**，
 * 而 TTS 出来的字节里根本没有原文 —— 文字早被编码成波形了。
 * 所以那道闸对「TTS 念出 key」完全无效，必须在这里、在原文上审。
 *
 * @returns {string|null} 命中描述，null = 干净
 */
export function findLeakInText(text) {
  const hit = findSensitive(text)
  if (hit === null) return null
  return hit.kind === 'credential' ? `凭据特征 ${hit.sample}` : `本机路径 ${hit.sample}`
}

/**
 * 校验音频字节是不是真音频。
 *
 * ⚠️ **不复用 voiceout.js 的 validateVoiceBytes**：那个函数按**扩展名**分支，
 *    而我们这里拿到的是「还不知道是什么」的一坨字节 —— 先看字节再定扩展名，
 *    方向正好相反。重复实现一小段是可接受的代价（两份逻辑各自简单且可单测）；
 *    共用反而要让 validateVoiceBytes 改成「先嗅探」，会动到发送主链路。
 *
 * @returns {{ok:true, ext:string} | {ok:false, error:string}}
 */
export function sniffAudio(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    return { ok: false, error: '合成结果为空' }
  }
  const has = (offset, text) => bytes.length >= offset + text.length
    && bytes.toString('ascii', offset, offset + text.length) === text

  if (has(0, 'RIFF') && has(8, 'WAVE')) return { ok: true, ext: 'wav' }
  // Breeze 的 mp3 实测是裸 MPEG 帧同步字（fff3c4c4），**没有 ID3**。
  // 所以两种头都要认，不能只认 ID3。
  if (has(0, 'ID3')) return { ok: true, ext: 'mp3' }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return { ok: true, ext: 'mp3' }
  if (has(0, 'fLaC')) return { ok: true, ext: 'flac' }
  if (has(0, 'OggS')) return { ok: true, ext: 'ogg' }
  if (bytes.length >= 8 && bytes.toString('hex', 4, 8) === '66747970') return { ok: true, ext: 'm4a' }
  return { ok: false, error: '合成结果不像音频（既不是 WAV/MP3，也不是 FLAC/OGG/M4A）' }
}

// ==================== 落盘 ====================

/**
 * 把音频字节写进语音产物目录，返回绝对路径。
 *
 * 文件名用 `tts_<时间戳>_<随机>.wav` —— 带随机后缀是因为同一毫秒可能来两条，
 * 撞名会让后一条覆盖前一条，而前一条的路径可能已经被 qq_send 拿走了。
 *
 * @returns {{ok:true, path:string, bytes:number} | {ok:false, error:string}}
 */
export function writeVoiceFile(bytes, ext, now = Date.now()) {
  const root = voiceOutputRoot()
  if (root.ok !== true) return { ok: false, error: root.error }
  try {
    mkdirSync(root.dir, { recursive: true })
    // 时间戳：`20261106180834`（14 位，本地时区）。
    //
    // ⚠️ 为什么不用 toISOString().replace(/-|:/g,'').slice(0,15)：
    //    toISOString() 是 `2026-11-06T18:08:34.123Z`，去掉分隔符后
    //    毫秒那个句点还在，slice(0,15) 会把它切进文件名 ——
    //    实测出现过 `tts_20261106180834._b89bd8.wav`。
    // 用 getFullYear 这些逐个取就没这个问题，而且拿到的是**本地时间**
    // （文件名给人看，UTC 会让人对不上自己刚才干的事）。
    const d = new Date(now)
    const pad = (n, width = 2) => String(n).padStart(width, '0')
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
      + `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    const name = `tts_${stamp}_${randomBytes(3).toString('hex')}.${ext}`
    const target = join(root.dir, name)
    writeFileSync(target, bytes)
    return { ok: true, path: target, bytes: bytes.length }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `写不进语音产物目录（${message}）：${root.dir}` }
  }
}

// ==================== 引擎 A：GPT-SoVITS ====================

/** 默认参考音频（MCP 的 `_REF_HINT`，实测本机存在；台词有同名 .txt）。 */
export const DEFAULT_REF_WAV =
  'E:\\AI\\文转语音\\音频\\沃雅妮莎\\VO_Anecdote\\Dialog\\VO_vodyanitsa\\vo_anecdote_107901_vodyanitsa_02.wav'

/** 参考音频语料根（跨机部署时要改这个而不是逐条填路径）。 */
export const DEFAULT_VOICE_ROOT = 'E:\\AI\\文转语音\\音频'

/**
 * 参考音频的台词从哪来。
 *
 * 顺序**照抄 MCP 的 `resolve_ref_text()`**：
 *   1) 显式传入
 *   2) 同名 .txt / .lab / .list（`.list` 是 `wav|speaker|lang|text` 四段格式，取第 4 段）
 *   3) 默认台词
 *
 * ⚠️ 第 3 条是必须有的：GPT-SoVITS 的参考音频和台词是**成对**送的，
 *    只给音频不给台词会让它拿错的音素去对齐，合成出来是怪声 ——
 *    而现象看起来像「音色变了」，极难查。MCP 早就在用这条默认值了，
 *    插件不照抄就会退化成「不配就合成不了」。
 */
export const DEFAULT_REF_TEXT = '喏，奥黛塔，这是我的冰淇淋，你吃一口。'

export function resolveRefText(refPath, explicitText) {
  const given = String(explicitText ?? '').trim()
  if (given !== '') return { ok: true, text: given, source: 'explicit' }

  const path = String(refPath ?? '').trim()
  if (path === '') return { ok: true, text: DEFAULT_REF_TEXT, source: 'default' }

  const stem = path.replace(/\.[^./\\]+$/, '')
  for (const ext of ['.txt', '.lab', '.list']) {
    const candidate = stem + ext
    try {
      if (!existsSync(candidate)) continue
      let text = readFileSync(candidate, 'utf8').replace(/^\uFEFF/, '').trim()
      // .list 格式：wav|speaker|lang|text —— 取第 4 段
      if (ext === '.list') {
        const bits = text.split('|')
        if (bits.length >= 4) text = bits[3].trim()
      }
      if (text !== '') return { ok: true, text, source: `sidecar${ext}` }
    } catch {
      // 读失败就当没有，继续找下一个后缀
    }
  }
  // 找不到 sidecar 也要能跑 —— 用默认台词，并**记日志说明**（不静默）
  note('tts', `参考音频旁边没有台词文件，回落到默认台词：${path}`)
  return { ok: true, text: DEFAULT_REF_TEXT, source: 'default' }
}

/**
 * 拼 GPT-SoVITS 的 inference payload（**23 个位置参数，顺序不可变**）。
 *
 * ⚠️ **这一段是照抄来的，不是设计出来的。**
 *    来源：`E:\AI\文转语音\gptsovits-mcp\gptsovits_mcp_server.py` 的
 *    `build_inference_args()` —— 逐项对齐，包括那些看着没用的 `True`。
 *
 * ⚠️ **踩过两次，都是「看着像对的」错**：
 *    ① 第一版按 `GPT-SoVITS-api-v1-接口文档.md` 写了 15 个参数
 *      （refer_wav_path / prompt_text / top_k… 那套命名）—— **完全用错了接口**。
 *      v1 文档描述的是 `api.py` 那套旧 REST；9872 跑的是 inference WebUI，
 *      收的是**位置参数数组**，不是带名字的 JSON。
 *    ② 第二版以为 `ref["file"]` 是路径字符串 —— 错。它是 Gradio 的
 *      **FileData 对象** `{path, meta:{_type:"gradio.FileData"}}`，
 *      而且这个 path 是**上传之后**服务端给的路径，不是本机路径。
 *
 *    参数个数或形状错一个，只会得到一个没有细节的 500 —— Gradio/FastAPI
 *    对「参数不对」和「内部出错」回同一个 500，从错误信息上完全分不出来。
 *
 * ## 哪些是可调的（2026-11-07 起全部从配置来）
 *
 * 下面每一项都有默认值，**配置不填就退回这里的默认**，与升级前逐字一致。
 * 那 4 个 `True` / `False` 是源码固定值，**没有暴露** —— 改了也没意义，
 * 暴露出去只会让人以为调了有效。
 *
 * @param {{text:string, refFile:object, refText:string, textLang?:string,
 *          speed?:number, topK?:number, topP?:number, temperature?:number,
 *          splitMethod?:string, batchSize?:number, fragmentInterval?:number,
 *          seed?:number, repetitionPenalty?:number, sampleSteps?:string, cfgRate?:number}} p
 */
export function buildGptsovitsArgs({
  text,
  refFile,
  refText,
  textLang = '中文',
  speed = 1,
  topK = 15,
  topP = 1.0,
  temperature = 1.0,
  splitMethod = '凑四句一切',
  batchSize = 20,
  fragmentInterval = 0.3,
  seed = -1,
  repetitionPenalty = 1.35,
  sampleSteps = '32',
  cfgRate = 0.0
}) {
  return [
    text,                      // 0  text
    textLang,                  // 1  text_lang
    refFile,                   // 2  ref["file"] —— FileData 对象
    [],                        // 3  aux_refs（空 = 只用主参考音频；v5 本来也忽略这一位）
    refText,                   // 4  ref["prompt_text"]
    textLang,                  // 5  ref["prompt_lang"]
    topK,                      // 6  top_k
    topP,                      // 7  top_p
    temperature,               // 8  temperature
    splitMethod,               // 9  split_method
    batchSize,                 // 10 batch_size（源码默认 20，不是 1）
    speed,                     // 11 speed
    false,                     // 12 ref_free（给了参考音频就得是 false）
    true,                      // 13 源码固定 True
    fragmentInterval,          // 14 fragment_interval
    seed,                      // 15 seed（-1 = 随机）
    seed < 0,                  // 16 keep_random（源码是 `seed=-1 if keep_random else seed`）
    true,                      // 17 源码固定 True
    true,                      // 18 源码固定 True
    repetitionPenalty,         // 19 repetition_penalty
    String(sampleSteps),       // 20 sample_steps（**字符串**）
    false,                     // 21 源码固定 False
    cfgRate                    // 22 cfg_rate
  ]
}

/** 解析参考音频路径：绝对路径直接用；相对路径按 VOICE_ROOT / 当前目录找。 */
export function resolveRefWav(configured) {
  const raw = String(configured ?? '').trim()
  const target = raw === '' ? DEFAULT_REF_WAV : raw
  if (isAbsolute(target) && existsSync(target)) return { ok: true, path: target }

  for (const root of [DEFAULT_VOICE_ROOT, process.cwd()]) {
    const candidate = join(root, target)
    if (existsSync(candidate)) return { ok: true, path: candidate }
  }
  return {
    ok: false,
    error: `参考音频不存在：${target}`
      + '\n如果是跨机部署（DSH 在虚拟机、TTS 在宿主机），本机必须有这个 wav 才能上传 ——'
      + '服务端不对外提供语料目录。把参考音频放到本机，然后在设置里填绝对路径。'
  }
}

/**
 * 把参考音频 multipart 上传到 9872，返回服务端路径。
 *
 * ⚠️ **这一步不能省。** `ref["file"].path` 必须是**服务端**的文件路径，
 *    把本机路径直接塞进去会被当成「服务端没有这个文件」而失败。
 *    MCP 的 `upload_file()` 干的就是这件事（POST /upload，字段名 `files`）。
 *
 * ⚠️ 字段名必须是 `files`（复数），返回是**数组**，取 `[0]`。
 */
export async function uploadReference(base, localPath) {
  let bytes
  try {
    bytes = readFileSync(localPath)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `读不到参考音频（${message}）：${localPath}` }
  }
  const boundary = `----dshonebot${randomBytes(12).toString('hex')}`
  const name = localPath.split(/[/\\]/).pop() || 'ref.wav'
  const head = Buffer.from(
    `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="files"; filename="${name}"\r\n`
    + 'Content-Type: application/octet-stream\r\n\r\n',
    'utf8'
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  const payload = Buffer.concat([head, bytes, tail])

  let response
  try {
    response = await fetch(`${base}/upload`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: payload,
      signal: AbortSignal.timeout(SYNTH_TIMEOUT_MS)
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `上传参考音频失败（${message}）` }
  }
  if (!response.ok) {
    let body = ''
    try {
      body = (await response.text()).slice(0, 300)
    } catch {
      body = ''
    }
    return { ok: false, error: `上传参考音频失败（HTTP ${response.status}）：${body}` }
  }
  let parsed
  try {
    parsed = await response.json()
  } catch {
    return { ok: false, error: '上传参考音频的返回不是 JSON' }
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || typeof parsed[0] !== 'string') {
    return { ok: false, error: `上传参考音频的返回异常：${JSON.stringify(parsed).slice(0, 200)}` }
  }
  return { ok: true, remote: parsed[0] }
}

/**
 * 走本机 GPT-SoVITS 合成。
 *
 * 接口形状**逐字照抄 MCP**（`gptsovits_mcp_server.py` 的 `tts_api` / `t_speak`）：
 *
 *   POST <base>/api/inference
 *   body: {"data": [ <23 个位置参数> ]}
 *   resp: {"data": [ <result>, <seed> ]}
 *
 * 而且 `<result>` **不是音频字节**，是 `{path, url}`：
 *   · 同机（服务端与本进程同一台）→ 按 path 直接读文件
 *   · 跨机（虚拟机 / 局域网）→ path 是**那边**的路径，本机读不到，得按 url 下载
 * 两条都要支持 —— SnowLuma 就跑在另一台机器上，这台 DSH 完全可能哪天也搬过去。
 *
 * @returns {Promise<{ok:true, bytes:Buffer} | {ok:false, error:string}>}
 */
export async function synthesizeGptsovits({ text, config, refOverride = null }) {
  const base = String(config?.voiceGptsovitsUrl ?? '').trim().replace(/\/+$/, '')
  if (base === '') return { ok: false, error: '没配 GPT-SoVITS 服务地址（设置 → 高级 → 语音合成 → 服务地址）' }

  // ---- 1. 参考音频：解析 → 时长校验 → 上传 ----
  const resolved = refOverride === null
    ? resolveRefWav(config?.voiceGptsovitsRef)
    : { ok: true, path: refOverride }
  if (resolved.ok !== true) return { ok: false, error: resolved.error }

  // 时长先自己卡一遍：GPT-SoVITS 只吃 3~10 秒，超范围时服务端只回 500 {"error":null}，
  // 看不出是参考音频的问题。这里提前报错，用户才知道该换哪一条。
  const duration = wavDurationSeconds(resolved.path)
  if (duration !== null && (duration < REF_MIN_SECONDS || duration > REF_MAX_SECONDS)) {
    return {
      ok: false,
      error: `参考音频时长 ${duration.toFixed(2)} 秒，超出 GPT-SoVITS 要求的 `
        + `${REF_MIN_SECONDS}~${REF_MAX_SECONDS} 秒：${resolved.path}`
    }
  }

  const uploaded = await uploadReference(base, resolved.path)
  if (uploaded.ok !== true) return { ok: false, error: uploaded.error }

  const refTextResult = resolveRefText(
    resolved.path,
    config?.voiceGptsovitsRefText
  )

  const args = buildGptsovitsArgs({
    text,
    refFile: { path: uploaded.remote, meta: { _type: 'gradio.FileData' } },
    refText: refTextResult.text,
    // ---- 以下全部来自配置，不填就退回默认（= 升级前的行为）----
    textLang: String(config?.voiceGptsovitsLang ?? '') || '中文',
    speed: clampNumber(config?.voiceGptsovitsSpeed, 0.5, 2, 1),
    topK: clampNumber(config?.voiceGptsovitsTopK, 1, 100, 15),
    topP: clampNumber(config?.voiceGptsovitsTopP, 0.1, 1, 1.0),
    temperature: clampNumber(config?.voiceGptsovitsTemperature, 0.1, 2, 1.0),
    splitMethod: String(config?.voiceGptsovitsSplit ?? '') || '凑四句一切',
    batchSize: clampNumber(config?.voiceGptsovitsBatchSize, 1, 100, 20),
    fragmentInterval: clampNumber(config?.voiceGptsovitsFragmentInterval, 0, 2, 0.3),
    seed: clampNumber(config?.voiceGptsovitsSeed, -1, Number.MAX_SAFE_INTEGER, -1),
    repetitionPenalty: clampNumber(config?.voiceGptsovitsRepetitionPenalty, 1, 3, 1.35),
    sampleSteps: String(config?.voiceGptsovitsSampleSteps ?? '') || '32',
    cfgRate: clampNumber(config?.voiceGptsovitsCfgRate, 0, 1, 0.0)
  })

  // ---- 2. inference ----
  let response
  try {
    response = await fetch(`${base}/api/inference`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // ⚠️ 必须包一层 {"data": [...]}：这是 Gradio 的调用约定。
      //    直接把数组当 body 发过去会得到 422，而且提示不会说清是包装层的问题。
      body: JSON.stringify({ data: args }),
      signal: AbortSignal.timeout(SYNTH_TIMEOUT_MS)
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    note('tts', `gptsovits 请求失败：${message}`)
    return {
      ok: false,
      error: `连不上本机 GPT-SoVITS（${base}）：${message}。`
        + '去 http://127.0.0.1:9874 →「1-GPT-SoVITS-TTS / 1C-推理」→ 点「开启TTS推理WebUI」'
    }
  }

  if (!response.ok) {
    // ⚠️ 必须把服务端原文捞出来：GPT-SoVITS 对「参数不对」和「内部出错」都回 500，
    //    没有 body 就完全没法区分。这段日志是排查的唯一线索。
    let body = ''
    try {
      body = (await response.text()).slice(0, 500)
    } catch {
      body = '（读不到响应体）'
    }
    note('tts', `gptsovits HTTP ${response.status}：${body}`)
    return { ok: false, error: `GPT-SoVITS 返回 HTTP ${response.status}：${body}` }
  }

  let payload
  try {
    payload = await response.json()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `GPT-SoVITS 返回的不是 JSON（${message}）` }
  }
  // Gradio 出错时是 200 + {"error": "..."}，不是 5xx —— MCP 的 tts_api 也判这一条。
  if (payload !== null && typeof payload === 'object' && payload.error) {
    const why = String(payload.error).slice(0, 500)
    note('tts', `gptsovits 返回 error：${why}`)
    return { ok: false, error: `GPT-SoVITS 报错：${why}` }
  }
  const data = Array.isArray(payload?.data) ? payload.data : null
  const first = data === null ? null : data[0]
  if (first === null || typeof first !== 'object') {
    return { ok: false, error: 'GPT-SoVITS 没返回音频（data[0] 是空的）' }
  }

  return fetchGptsovitsResult(base, first)
}

/**
 * 把 `{path,url}` 变成字节：同机读文件，跨机下载。
 *
 * ⚠️ 为什么两条都要试、而不是「读不到就下载」：
 *    跨机时 `path` 是**服务端那边**的路径（比如 `C:\...\output\tts_xxx.wav`），
 *    在本机读它只会 ENOENT；而同机时 url 也能下（多绕一圈 HTTP）。
 *    所以顺序是「先读文件，失败再下 url」，并**在日志里说明走了哪条**。
 */
async function fetchGptsovitsResult(base, fileObj) {
  const localPath = typeof fileObj.path === 'string' ? fileObj.path.trim() : ''
  if (localPath !== '') {
    try {
      const bytes = readFileSync(localPath)
      if (bytes.length > 0) return { ok: true, bytes }
    } catch {
      // 同机读不到（或本来就是跨机）→ 落到 url
    }
  }

  const rawUrl = typeof fileObj.url === 'string' ? fileObj.url.trim() : ''
  if (rawUrl === '') {
    return {
      ok: false,
      error: 'GPT-SoVITS 给了结果，但既读不到文件也没有下载地址'
        + '（如果服务跑在另一台机器上，这是正常现象 —— 检查一下返回里有没有 url）'
    }
  }
  // 相对地址要拼上 base（服务端可能只回 `/file=...`）
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : `${base}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(SYNTH_TIMEOUT_MS) })
    if (!response.ok) {
      return { ok: false, error: `从 GPT-SoVITS 下载音频失败（HTTP ${response.status}）：${url}` }
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length === 0) return { ok: false, error: '从 GPT-SoVITS 下载到的音频是空的' }
    return { ok: true, bytes }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `从 GPT-SoVITS 下载音频失败（${message}）：${url}` }
  }
}

// ==================== 引擎 B：Breeze Blue ====================

/**
 * 把 Breeze 的错误信封翻成一句人话。
 *
 * 实测错误体是**扁平 JSON**：`{ok:false, code, detail, error, meta?}`（见调研 §12.6）。
 * 404 / 400 / 422 都是「配错了」，重试一百次也一样 —— 所以这里**不做重试**，
 * 直接把 code + detail 交给模型，让它去改（或者告诉用户去改配置）。
 */
export function describeBreezeError(status, bodyText) {
  let parsed = null
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    parsed = null
  }
  const code = String(parsed?.code ?? '').trim()
  const detail = String(parsed?.detail ?? parsed?.error ?? '').trim()
  const head = `Breeze 返回 HTTP ${status}${code === '' ? '' : `（${code}）`}`

  if (detail !== '') return `${head}：${detail}`
  if (bodyText.trim() === '') return head
  return `${head}：${bodyText.trim().slice(0, 200)}`
}

/**
 * 走 Breeze Blue 合成。
 *
 * 三条实测结论直接落在这里（见 docs/调研-Breeze-TTS-API.md §12.7）：
 *   ① `output_format` 是 **query 参数**，写进 body 会被 422 `extra_forbidden` 拒
 *   ② 成功是**二进制**、失败是 JSON → 靠 content-type 分流，不能无脑 res.json()
 *   ③ 长度**本地先判**，别等 422 白跑一次网络
 *
 * @returns {Promise<{ok:true, bytes:Buffer, format:string} | {ok:false, error:string}>}
 */
export async function synthesizeBreeze({ text, config }) {
  const key = String(config?.voiceBreezeKey ?? '').trim()
  if (key === '') {
    return { ok: false, error: 'Breeze 的 API key 没填（设置 → 高级 → 语音合成 → API Key）' }
  }
  const voiceId = String(config?.voiceBreezeVoice ?? '').trim()
  if (voiceId === '') {
    return { ok: false, error: 'Breeze 还没选音色（设置 → 语音 → 搜索音色），没 voice_id 合成不了' }
  }
  if (text.length > BREEZE_MAX_CHARS) {
    return {
      ok: false,
      error: `这段有 ${text.length} 字，超了 Breeze 的上限 ${BREEZE_MAX_CHARS} 字。请自己缩写，或分成几条说`
    }
  }

  const format = String(config?.voiceBreezeFormat ?? 'wav').trim() || 'wav'
  const model = String(config?.voiceBreezeModel ?? '').trim()
  const url = `${BREEZE_BASE}/v1/text-to-speech/${encodeURIComponent(voiceId)}`
    + `?output_format=${encodeURIComponent(format)}`

  const body = { text, language_code: 'zh' }
  if (model !== '') body.model_id = model
  // ---- voice_settings（2026-11-07 全部暴露；只对 Breeze 有效）----
  //
  // 官方四个子字段：
  //   speed            0.5~2.0   变速**保持音高**，停顿一起缩放
  //   volume           0.01~2.0  线性振幅乘数，**不是响度归一化**，>1 可能削波
  //   guidance_scale   1.0~10.0  对参考音色/instructions 的贴合强度
  //   use_speaker_boost         提升相似度；instructions 非空且 guidance>1 时被忽略
  //
  // ⚠️ 只在**至少一项偏离默认**时才发 `voice_settings`：
  //    少发一个字段就少一次被服务端 schema 挑刺的机会，
  //    也让抓包时一眼看出「到底动过哪些参数」。
  const voiceSettings = {}
  const speed = clampNumber(config?.voiceBreezeSpeed, 0.5, 2, 1)
  if (Math.abs(speed - 1) > 0.001) voiceSettings.speed = speed
  const volume = clampNumber(config?.voiceBreezeVolume, 0.01, 2, 1)
  if (Math.abs(volume - 1) > 0.001) voiceSettings.volume = volume
  const guidance = clampNumber(config?.voiceBreezeGuidanceScale, 1, 10, 1)
  if (Math.abs(guidance - 1) > 0.001) voiceSettings.guidance_scale = guidance
  if (config?.voiceBreezeSpeakerBoost === true) voiceSettings.use_speaker_boost = true
  if (Object.keys(voiceSettings).length > 0) body.voice_settings = voiceSettings

  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SYNTH_TIMEOUT_MS)
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    note('tts', `breeze 请求失败：${message}`)
    return { ok: false, error: `连不上 Breeze（${message}）` }
  }

  if (!response.ok) {
    let bodyText = ''
    try {
      bodyText = await response.text()
    } catch {
      bodyText = ''
    }
    const why = describeBreezeError(response.status, bodyText)
    note('tts', `breeze 合成失败：${why}`)
    if (response.status === 402) {
      return { ok: false, error: `${why}（账户余额不够了，去 breezeblue.ai 充值，或改用本机引擎）` }
    }
    if (response.status === 401) {
      return { ok: false, error: `${why}（API key 不对或已失效，去设置里重填）` }
    }
    if (response.status === 429) {
      return { ok: false, error: `${why}（并发或频率满了，等几秒再说）` }
    }
    return { ok: false, error: why }
  }

  let bytes
  try {
    bytes = Buffer.from(await response.arrayBuffer())
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `读不到 Breeze 的音频（${message}）` }
  }
  return { ok: true, bytes, format }
}

// ==================== 对外主入口 ====================

/**
 * 合成一段文字，返回本地音频路径。
 *
 * **不含**名单检查、不含额度和排队 —— 那些在 tts-gate.js 里。
 * 这个函数是「纯粹的一次合成」，方便单测和复用。
 *
 * @param {string} text
 * @param {{engine?:string, config?:object}} [options]
 * @returns {Promise<{ok:true, path:string, engine:string, bytes:number, chars:number, ms:number}
 *                 | {ok:false, error:string}>}
 */
export async function synthesize(text, options = {}) {
  const config = options.config ?? getConfig()
  const raw = String(text ?? '')
  const trimmed = raw.trim()

  if (trimmed === '') return { ok: false, error: '要念的文字是空的' }

  // 内容审计放在**一切之前**：念出来的东西收不回来，比浪费一次 API 调用严重得多。
  const leak = findLeakInText(trimmed)
  if (leak !== null) {
    note('tts', `合成被内容审计拦下：${leak}`)
    return { ok: false, error: `这段话里有${leak}，不能念出来发出去。改一下再说` }
  }

  const engine = options.engine
    ?? (String(config?.voiceEngine ?? '') === 'breeze' ? 'breeze' : 'gptsovits')

  const started = Date.now()
  let result
  if (engine === 'breeze') {
    result = await synthesizeBreeze({ text: trimmed, config })
  } else {
    result = await synthesizeGptsovits({ text: trimmed, config })
  }
  if (result.ok !== true) return result

  const sniffed = sniffAudio(result.bytes)
  if (sniffed.ok !== true) {
    note('tts', `${engine} 返回的东西不像音频：${sniffed.error}`)
    return { ok: false, error: sniffed.error }
  }

  const written = writeVoiceFile(result.bytes, sniffed.ext)
  if (written.ok !== true) return written

  const ms = Date.now() - started
  note('tts', `${engine} 合成成功 ${trimmed.length} 字 → ${written.bytes} 字节 ${ms}ms ${written.path}`)
  return {
    ok: true,
    path: written.path,
    engine,
    bytes: written.bytes,
    chars: trimmed.length,
    ms
  }
}

// ==================== Breeze 账户 ====================

/** 调 Breeze 的 GET 接口（余额/权益/音色），统一鉴权和错误处理。 */
async function breezeGet(path, { key, query = '', timeoutMs = 15000 } = {}) {
  const auth = String(key ?? '').trim()
  if (auth === '') return { ok: false, error: 'Breeze 的 API key 没填' }
  const url = `${BREEZE_BASE}${path}${query === '' ? '' : `?${query}`}`
  let response
  try {
    response = await fetch(url, {
      headers: { 'xi-api-key': auth },
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `连不上 Breeze（${message}）` }
  }
  let bodyText = ''
  try {
    bodyText = await response.text()
  } catch {
    bodyText = ''
  }
  if (!response.ok) return { ok: false, error: describeBreezeError(response.status, bodyText) }
  try {
    return { ok: true, data: JSON.parse(bodyText) }
  } catch {
    return { ok: false, error: 'Breeze 返回的不是 JSON' }
  }
}

/**
 * 查余额 + 权益（并发上限、能否商用）。
 *
 * ⚠️ `balance` 实测是**浮点**（1772.2），别用整数解析。
 * ⚠️ 结算有延迟：`settlement_pending=true` 时刚花的钱还没从余额里扣掉。
 *
 * @returns {Promise<{ok:true, balance:number, pending:boolean, plan:string, concurrency:number, commercial:boolean}
 *                 | {ok:false, error:string}>}
 */
export async function fetchBreezeAccount(key) {
  const [balanceResult, entResult] = await Promise.all([
    breezeGet('/v1/balance', { key }),
    breezeGet('/v1/entitlements', { key })
  ])
  // 余额是主：拿不到就是错的。权益拿不到只说明少两个数字，不该让余额查询整个失败。
  if (balanceResult.ok !== true) return balanceResult

  const b = balanceResult.data ?? {}
  const e = entResult.ok === true ? (entResult.data ?? {}) : {}
  return {
    ok: true,
    balance: Number(b.balance ?? 0),
    pending: b.settlement_pending === true,
    plan: typeof e.plan_code === 'string' ? e.plan_code : '（未知）',
    concurrency: Number.isFinite(Number(e.max_concurrent_generations))
      ? Number(e.max_concurrent_generations)
      : 1,
    commercial: e.commercial_use_allowed === true
  }
}

/**
 * 搜索音色。
 *
 * ## 实测数据（2026-11-07 用真实 key 探过）
 *
 * | 查询 | total | 个人音色在哪 |
 * |---|---|---|
 * | `language_code=zh`，不搜索 | 530 | 第 1 位 |
 * | `search=人鱼` | 50 | 第 1 位（名字里有「人鱼」） |
 * | `search=少女` | 52 | **不在结果里** |
 * | `voice_type=personal` | **只有个人音色** | 全部 |
 * | `GET /v1/voices/<id>` | 1 | 精确命中 |
 *
 * ## 为什么要支持「按 ID 直接取」
 *
 * 用户的抱怨是「我自己的音色搜不到」。查下来不是接口不给，而是两个原因叠加：
 *   ① **`search=` 是按名称/语义匹配** —— 名字里没有那个词就不出现
 *      （他的音色叫「人鱼大姐姐」，搜「少女」自然没有）；
 *   ② 个人音色通常只有 1~5 个，混在 530 条目录里容易被淹掉。
 *
 * 猜关键词太不可靠，而**用户手上就有准确的 ID**（在官网音色库点开就能复制）。
 * 所以最直接的路是：**粘一个 `voc_xxx` 进来 → 精确取回那一条**。
 * 走 `GET /v1/voices/<id>`（实测 200，还带回 `preview_url` 可试听）。
 *
 * @param {string} key
 * @param {string} keyword 关键词；**填 `voc_` 开头的 ID 时会走精确查询**
 * @param {number} limit
 * @param {'all'|'mine'} [scope] `'mine'` = 只看账号自己的音色（克隆/设计出来的）
 * @returns {Promise<{ok:true, voices:Array<object>, total:number, byId?:boolean} | {ok:false, error:string}>}
 */
export async function searchBreezeVoices(key, keyword, limit = 30, scope = 'all') {
  const size = Math.max(1, Math.min(100, Math.floor(Number(limit) || 30)))
  const kw = String(keyword ?? '').trim()

  // ---- ① 看起来是 voice_id → 精确查那一条 ----
  // 为什么识别 `voc_` 前缀就够了：那是 Breeze 的 ID 命名约定（实测所有音色都是）。
  // 认错也不会有害 —— 真拿一个不存在的 ID 去查，返回 404，照样是「没找到」。
  if (BREEZE_VOICE_ID_RE.test(kw)) {
    const one = await fetchBreezeVoice(key, kw)
    if (one.ok !== true) return one
    return { ok: true, voices: [one.voice], total: 1, byId: true }
  }

  // ---- ② 普通关键词搜索 ----
  const mine = scope === 'mine'
  const params = [`page_size=${size}`]
  // ⚠️ scope='mine' 时**不能**再加 language_code 过滤：
  //    实测 `voice_type=personal&language_code=en` 返回 0 ——
  //    个人音色如果语言标签不是 zh 就会被静默筛掉。
  //    「我的音色」本来就没几条，全列出来让用户自己认更靠谱。
  if (!mine) params.push('language_code=zh')
  params.push(mine ? 'voice_type=personal' : 'voice_type=all')
  if (kw !== '') params.push(`search=${encodeURIComponent(kw)}`)

  const result = await breezeGet('/v1/voices', { key, query: params.join('&') })
  if (result.ok !== true) return result

  const data = result.data ?? {}
  const list = Array.isArray(data.voices) ? data.voices : []
  return {
    ok: true,
    total: Number(data.total ?? list.length),
    voices: list.map(normalizeVoice)
  }
}

/** `voc_` + 一串字母数字 —— 实测的音色 ID 约定。 */
export const BREEZE_VOICE_ID_RE = /^voc_[A-Za-z0-9]{6,}$/

/** 统一音色对象形状（列表与单查都走它，避免两处字段名漂移）。 */
function normalizeVoice(voice) {
  return {
    id: String(voice?.voice_id ?? ''),
    name: String(voice?.name ?? ''),
    gender: String(voice?.gender ?? ''),
    age: String(voice?.age ?? ''),
    accent: voice?.accent ?? null,
    // 「是不是我自己的」—— 界面上要标出来，否则用户分不清哪条是自己的
    mine: String(voice?.voice_type ?? '') === 'personal',
    // 公开 CDN 上的 mp3，**无需鉴权就能播**（实测 200 / audio/mpeg）——
    // 所以试听是零成本的（不消耗 credits、不走合成）。
    previewUrl: typeof voice?.preview_url === 'string' ? voice.preview_url : '',
    // 官网音色库那一行小字，选音色时很有用
    description: String(voice?.description ?? '')
  }
}

/**
 * 按 ID 取一条音色（`GET /v1/voices/<id>`，实测 200）。
 *
 * @returns {Promise<{ok:true, voice:object} | {ok:false, error:string}>}
 */
export async function fetchBreezeVoice(key, voiceId) {
  const id = String(voiceId ?? '').trim()
  if (!BREEZE_VOICE_ID_RE.test(id)) {
    return { ok: false, error: `这不像一个音色 ID（应该形如 voc_xxxxxxxxxxxx）：${id}` }
  }
  const result = await breezeGet(`/v1/voices/${encodeURIComponent(id)}`, { key })
  if (result.ok !== true) {
    // 404 时给一句更有用的话：ID 打错是最常见的输入错误
    if (String(result.error).includes('404') || String(result.error).includes('RESOURCE_NOT_FOUND')) {
      return { ok: false, error: `没找到这个音色（ID 可能打错了，或者它不属于当前账号）：${id}` }
    }
    return result
  }
  const voice = normalizeVoice(result.data ?? {})
  if (voice.id === '') return { ok: false, error: `这个 ID 没取到音色：${id}` }
  return { ok: true, voice }
}

/**
 * 量一条音频的时长（秒）。只用 WAV 的 fmt 块算，不解码。
 *
 * 为什么要它：GPT-SoVITS 只接受 3~10 秒的参考音频，而设置页需要
 * 在保存时就告诉用户「这条太长了」，而不是等到合成失败。
 *
 * @returns {number|null} 秒；算不出来返回 null（不猜）
 */
export function wavDurationSeconds(filePath) {
  try {
    const path = String(filePath ?? '').trim()
    if (path === '' || !existsSync(path)) return null
    const size = statSync(path).size
    if (size < 44) return null
    const bytes = readFileSync(path)
    if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') return null

    let byteRate = 0
    let dataSize = 0
    let offset = 12
    while (offset + 8 <= bytes.length) {
      const id = bytes.toString('ascii', offset, offset + 4)
      const chunkSize = bytes.readUInt32LE(offset + 4)
      if (id === 'fmt ' && chunkSize >= 16) byteRate = bytes.readUInt32LE(offset + 16)
      if (id === 'data') dataSize = chunkSize
      offset += 8 + chunkSize + (chunkSize & 1)
    }
    if (byteRate <= 0 || dataSize <= 0) return null
    return dataSize / byteRate
  } catch {
    return null
  }
}

/** 供别处判断「这个路径看着像不像我们产出的东西」（设置页试听用）。 */
export function isVoiceOutputPath(filePath) {
  const root = voiceOutputRoot()
  if (root.ok !== true) return false
  const target = resolve(String(filePath ?? ''))
  const base = resolve(root.dir)
  return target === base ? false : target.startsWith(base.endsWith('\\') || base.endsWith('/') ? base : base + '\\')
}

/** 目录里的产物文件名列表（设置页「试听」找最新一条用）。 */
export function listVoiceOutputs(limit = 10) {
  const root = voiceOutputRoot()
  if (root.ok !== true) return []
  try {
    return readdirSync(root.dir).slice(-limit)
  } catch {
    return []
  }
}
