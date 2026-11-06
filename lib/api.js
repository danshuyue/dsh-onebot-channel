/**
 * api.js —— 设置页 API（同源 /api/qq-bridge/*）。
 *
 * 与浏览器半侧（lib/client.js）只走同源 HTTP，不碰 RPC。
 */
import { getConfig, saveConfig, normalizeToolFeatures, VOICE_MODES } from './config.js'
import { note, serviceOf } from './env.js'
import { oneBotList, callOneBot } from './onebot.js'
import { listWorkspaceSessions } from './sessions.js'
import { discoverWsEndpoint, discoverHttpEndpoint } from './snowluma.js'
import { wsStatus } from './ws.js'
import { memorySummary, wipeMemory, readMemoryRaw, saveMemoryRaw, memoryFilePath } from './memory.js'
import { proactiveSummary, runProactiveOnce } from './proactive.js'
import { mergePending } from './poll.js'
import { readWorkspaces } from './progress.js'
import { normCwd } from './title.js'
import * as prompttext from './prompttext.js'
import { synthesize, searchBreezeVoices } from './tts.js'
import {
  breezeAccount, quotaStatus, chargeQuota, refundQuota, chargesQuota, billableChars
} from './tts-gate.js'
import { voiceOutputRoot } from './voiceout.js'
import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const API_PREFIX = '/api/qq-bridge'

/**
 * 这一份代码是哪个版本、跑在哪个进程里。
 *
 * 为什么非要有：2026-10-29 排查「改完没生效」，翻了半天日志才发现主进程是
 * 上午 11:08 起的，加载的还是旧版 —— 设置页看不到版本，人就只能靠猜。
 * 版本从自己旁边的 package.json 读：插件跑在 profile 的 node_modules 副本里，
 * import.meta.url 指向的就是**正在跑的那份**，而不是源码目录，这点很关键。
 */
const BOOT_AT = new Date().toISOString()

let cachedVersion
function pluginVersion() {
  if (cachedVersion !== undefined) return cachedVersion
  cachedVersion = ''
  try {
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')
    )
    if (typeof pkg.version === 'string') cachedVersion = pkg.version
  } catch (error) {
    note('api', `读 package.json 版本失败：${error instanceof Error ? error.message : error}`)
  }
  return cachedVersion
}

export function runtimeSummary() {
  return {
    version: pluginVersion(),
    pid: process.pid,
    bootAt: BOOT_AT
  }
}

/**
 * 工具箱分档的实际字符数 —— **实测，不手写常量**（0.17.4）。
 *
 * 为什么必须算：工具描述改一句话就是几百字符，手写「约 2.4 万字符」这种数字
 * 必然过时，然后变成骗人的说明。（这次就踩过：计划文档里的 2.4 万是虚报的 6 倍。）
 *
 * 做法：拿一个假 ctx 把 12 个注册函数全跑一遍，收集它们交给 tools.register 的定义，
 * 用 JSON.stringify({name,description,parameters}).length 量 —— 跟宿主真正塞进上下文的
 * 东西同一口径。结果按档聚合，**缓存**：定义是模块常量，一个进程里不会变。
 *
 * @returns {Promise<{silence:number, emoji:number, voiceIn:number, voiceOut:number, poke:number, send:number}>}
 */
let cachedSizes
export async function toolSchemaSizes() {
  if (cachedSizes !== undefined) return cachedSizes
  const sizes = { silence: 0, emoji: 0, voiceIn: 0, voiceOut: 0, poke: 0, send: 0 }
  try {
    const tool = await import('./tool.js')
    const regs = []
    // 假 ctx：只提供 tools.register，绝不碰宿主
    const fakeCtx = {
      get: (name) => (name === 'tools' ? { register: (def) => { regs.push(def); return () => {} } } : undefined),
      effect: () => {}
    }
    // 全开跑一遍：这样每档显示的是「它自己值多少」，与用户当前开关无关
    const all = { silence: true, emoji: true, voiceIn: true, voiceOut: true, poke: true }
    const list = [
      ['send', tool.registerSendTool, true],
      ['silence', tool.registerWaitTool], ['silence', tool.registerPassTool],
      ['silence', tool.registerSkipTool], ['silence', tool.registerCloseTool],
      ['emoji', tool.registerEmojiSearchTool], ['emoji', tool.registerCollectTool],
      ['emoji', tool.registerFacePreviewTool], ['emoji', tool.registerFacePickTool],
      ['emoji', tool.registerFaceRenameTool],
      ['poke', tool.registerPokeTool], ['voiceIn', tool.registerVoiceTool]
    ]
    const byName = {}
    for (const [tier, fn, isSend] of list) {
      const before = regs.length
      await fn(fakeCtx, undefined, isSend === true ? { features: all } : undefined)
      for (const def of regs.slice(before)) {
        const chars = JSON.stringify({ name: def.name, description: def.description, parameters: def.parameters }).length
        byName[def.name] = chars
        sizes[tier] += chars
        // 「发送语音」不是独立工具，是 qq_send 的 voice 参数：单独量它那一段
        if (def.name === 'qq_send') {
          sizes.voiceOut = JSON.stringify(def.parameters?.properties?.voice ?? {}).length
        }
      }
    }
    cachedSizes = sizes
  } catch (error) {
    note('api', `量工具 schema 字符数失败：${error instanceof Error ? error.message : error}`)
    cachedSizes = sizes
  }
  return cachedSizes
}

/** 给设置页看的配置：不返回 token 明文。 */
export function publicConfig() {
  const config = getConfig()
  return {
    enabled: config.enabled === true,
    selfUin: String(config.selfUin ?? ''),
    workspaceCwd: String(config.workspaceCwd ?? ''),
    textPrefix: String(config.textPrefix ?? ''),
    // 0.18.6：正文头模板（空 = 用内置默认）
    privateHeaderTemplate: String(config.privateHeaderTemplate ?? ''),
    groupHeaderTemplate: String(config.groupHeaderTemplate ?? ''),
    groupOnlyWhenAt: config.groupOnlyWhenAt === true,
    groupContextCount: Number(config.groupContextCount) || 0,
    splitReply: config.splitReply === true,
    // 分条依据：paragraph（换行分条）/ sentence（按句末标点）
    splitMode: config.splitMode === 'sentence' ? 'sentence' : 'paragraph',
    splitMaxChars: Number(config.splitMaxChars) || 120,
    splitMaxParts: Number(config.splitMaxParts) || 8,
    splitMinChars: Number(config.splitMinChars) || 0,
    // 分条间隔（2026-11-07）：一个模式 + 一组数值，取代旧的 min/max 区间
    splitDelayMode: String(config.splitDelayMode) === 'perChar' ? 'perChar' : 'fixed',
    splitDelayMs: Number.isFinite(Number(config.splitDelayMs)) ? Number(config.splitDelayMs) : 800,
    splitDelayPerCharMs: Number.isFinite(Number(config.splitDelayPerCharMs)) ? Number(config.splitDelayPerCharMs) : 120,
    splitDelayMaxCapMs: Number.isFinite(Number(config.splitDelayMaxCapMs)) ? Number(config.splitDelayMaxCapMs) : 3000,
    pollMs: Number(config.pollMs) || 2000,
    groupPollMs: Number(config.groupPollMs) || 3000,
    resumeColdSession: config.resumeColdSession !== false,
    autoForwardReply: config.autoForwardReply !== false,
    // 0.7.1 起：对话节奏与沉默权
    replyQuietMs: Number(config.replyQuietMs) || 0,
    waitMaxMs: Number(config.waitMaxMs) || 60000,
    waitTurnMaxMs: Number.isFinite(Number(config.waitTurnMaxMs)) ? Number(config.waitTurnMaxMs) : 60000,
    closureEnabled: config.closureEnabled !== false,
    // 0.8.0 起：关系记忆
    memoryEnabled: config.memoryEnabled !== false,
    // 0.9.0 起：私聊合并窗口（标记已读的中间态）
    mergeWindowMs: Number(config.mergeWindowMs) || 0,
    mergeMaxWaitMs: Number(config.mergeMaxWaitMs) || 15000,
    mergeMaxMessages: Number(config.mergeMaxMessages) || 10,
    // 0.16.0：@ 唤醒后的群聊连续对话窗口
    windowEnabled: config.windowEnabled !== false,
    windowIdleMs: Number.isFinite(Number(config.windowIdleMs)) ? Number(config.windowIdleMs) : 120000,
    windowMaxMs: Number.isFinite(Number(config.windowMaxMs)) ? Number(config.windowMaxMs) : 600000,
    windowMaxReplies: Number.isFinite(Number(config.windowMaxReplies)) ? Number(config.windowMaxReplies) : 5,
    windowPerPeerDaily: Number.isFinite(Number(config.windowPerPeerDaily)) ? Number(config.windowPerPeerDaily) : 10,
    windowPerGroupDaily: Number.isFinite(Number(config.windowPerGroupDaily)) ? Number(config.windowPerGroupDaily) : 20,
    waterWindows: Array.isArray(config.waterWindows) ? config.waterWindows.map((v) => String(v ?? '')).filter(Boolean) : [],
    // 0.9.0 起：主动搭话
    proactiveEnabled: config.proactiveEnabled === true,
    proactiveIdleHours: Number(config.proactiveIdleHours) || 6,
    proactiveIdleMaxHours: Number(config.proactiveIdleMaxHours) || 0,
    proactiveDailyMax: Number(config.proactiveDailyMax) || 1,
    proactiveQuietFrom: String(config.proactiveQuietFrom ?? ''),
    proactiveQuietTo: String(config.proactiveQuietTo ?? ''),
    proactiveBackoffMax: Number(config.proactiveBackoffMax) || 4,
    // 空数组 = 所有已绑私聊都可主动（跟 config 里的语义一致，别在前端再翻译一遍）
    proactiveTargets: Array.isArray(config.proactiveTargets)
      ? config.proactiveTargets.map((v) => String(v ?? '')).filter((v) => v !== '')
      : [],
    // 0.8.0 起：上线补历史
    backfillOnStart: config.backfillOnStart !== false,
    backfillMaxPages: Number(config.backfillMaxPages) || 5,
    backfillDeliver: Number(config.backfillDeliver) || 20,
    notifyTurnFailures: config.notifyTurnFailures !== false,
    voiceOutputDir: String(config.voiceOutputDir ?? ''),
    // ---- 0.19.0：语音合成双引擎 ----
    //
    // ⚠️ 这一整块最初漏了（0.19.0 提交时 publicConfig 里只有 splitDelay* 和
    //    voiceOutputDir），后果很严重：设置页读不到当前档位，**用户选的档位和填的
    //    key 保存后不生效** —— 因为前端拿不到初值、后端也没把这些键列进可写字段表。
    //    是在装进 profile、用 /state 实证时发现的：voiceMode 返回空串。
    //    ⇒ 教训：加配置项必须四件事同改（config / api 暴露 / api 可写分类 / 前端），
    //      少任何一处都表现成「界面能改、改了没用」这种最难查的形态。
    voiceMode: VOICE_MODES.includes(String(config.voiceMode)) ? String(config.voiceMode) : 'off',
    voiceEngine: String(config.voiceEngine) === 'breeze' ? 'breeze' : 'gptsovits',
    voiceTargetsPrivate: Array.isArray(config.voiceTargetsPrivate)
      ? config.voiceTargetsPrivate.map((v) => String(v ?? '')).filter((v) => v !== '')
      : [],
    voiceTargetsGroup: Array.isArray(config.voiceTargetsGroup)
      ? config.voiceTargetsGroup.map((v) => String(v ?? '')).filter((v) => v !== '')
      : [],
    voiceDailyChars: Number.isFinite(Number(config.voiceDailyChars)) ? Number(config.voiceDailyChars) : 1000,
    voiceGptsovitsUrl: String(config.voiceGptsovitsUrl ?? ''),
    voiceGptsovitsRef: String(config.voiceGptsovitsRef ?? ''),
    voiceGptsovitsRefText: String(config.voiceGptsovitsRefText ?? ''),
    // ⚠️ key 本身**绝不回传**（同 token / wsToken 的处理）。
    //    前端只需要知道「配没配」来决定输入框的 placeholder —— 所以给一个布尔。
    voiceBreezeKeySet: String(config.voiceBreezeKey ?? '').trim() !== '',
    voiceBreezeVoice: String(config.voiceBreezeVoice ?? ''),
    voiceBreezeModel: String(config.voiceBreezeModel ?? ''),
    voiceBreezeFormat: String(config.voiceBreezeFormat ?? 'wav') || 'wav',
    // 0.16.5：戳一戳（notice 事件，不是消息）
    pokeEnabled: config.pokeEnabled !== false,
    pokeCooldownMs: Number.isFinite(Number(config.pokeCooldownMs)) ? Number(config.pokeCooldownMs) : 10000,
    // 0.16.7：合并转发展开（「群聊的聊天记录」卡片）
    forwardExpandEnabled: config.forwardExpandEnabled !== false,
    forwardMaxDepth: Number.isFinite(Number(config.forwardMaxDepth)) ? Number(config.forwardMaxDepth) : 2,
    forwardMaxMessages: Number.isFinite(Number(config.forwardMaxMessages)) ? Number(config.forwardMaxMessages) : 50,
    forwardMaxChars: Number.isFinite(Number(config.forwardMaxChars)) ? Number(config.forwardMaxChars) : 2000,
    forwardImagesEnabled: config.forwardImagesEnabled === true,
    forwardImageLimit: Number.isFinite(Number(config.forwardImageLimit)) ? Number(config.forwardImageLimit) : 6,
    forwardTimeoutMs: Number.isFinite(Number(config.forwardTimeoutMs)) ? Number(config.forwardTimeoutMs) : 4000,
    forwardConcurrency: Number.isFinite(Number(config.forwardConcurrency)) ? Number(config.forwardConcurrency) : 3,
    forwardMaxRequests: Number.isFinite(Number(config.forwardMaxRequests)) ? Number(config.forwardMaxRequests) : 16,
    forwardBudgetMs: Number.isFinite(Number(config.forwardBudgetMs)) ? Number(config.forwardBudgetMs) : 6000,
    imageCopyDir: String(config.imageCopyDir ?? ''),
    wsEnabled: config.wsEnabled !== false,
    wsFallbackPollMs: Number(config.wsFallbackPollMs) || 30000,
    // WS 的地址可以显示（token 不行）。wsToken 有没有配不单独暴露 ——
    // 前端只要知道「地址 + 留空保持原样」就够了，多一个字段没人用就是死的。
    wsUrl: String(config.wsUrl ?? ''),
    // 0.15.0 起：HTTP API 地址也进设置页（token 同样不回显）。
    // 此前它只在配置文件里，改端口得手改 JSON —— 用户明确要这个入口。
    onebotHttp: String(config.onebotHttp ?? ''),
    // 0.17.4：工具箱分档（对象字段，单独走 OBJECT_FIELDS）
    toolFeatures: normalizeToolFeatures(config.toolFeatures),
    // 0.17.5：跨工作区会话进度（2026-11-05）
    // 命令层前缀：空串 = 关闭命令层，所以这里**不能用 `||` 兜底**（会把 '' 变成 '/'）。
    qqCommandPrefix: typeof config.qqCommandPrefix === 'string' ? config.qqCommandPrefix : '/',
    focusTagEnabled: config.focusTagEnabled !== false,
    focusIdleResetMs: Number.isFinite(Number(config.focusIdleResetMs)) ? Number(config.focusIdleResetMs) : 3600000,
    progressMaxRows: Number.isFinite(Number(config.progressMaxRows)) ? Number(config.progressMaxRows) : 12,
    progressIdleWindowMs: Number.isFinite(Number(config.progressIdleWindowMs)) ? Number(config.progressIdleWindowMs) : 86400000
  }
}

/** 可数字段：非负有限数才接受。 */
export const NUMERIC_FIELDS = [
  'groupContextCount', 'splitMaxChars', 'splitMaxParts', 'splitMinChars',
  'splitDelayMs', 'splitDelayPerCharMs', 'splitDelayMaxCapMs', 'pollMs', 'groupPollMs',
  'replyQuietMs', 'waitMaxMs', 'waitTurnMaxMs', 'backfillMaxPages', 'backfillDeliver', 'wsFallbackPollMs',
  'mergeWindowMs', 'mergeMaxWaitMs', 'mergeMaxMessages',
  'windowIdleMs', 'windowMaxMs', 'windowMaxReplies', 'windowPerPeerDaily', 'windowPerGroupDaily',
  'proactiveIdleHours', 'proactiveIdleMaxHours', 'proactiveDailyMax', 'proactiveBackoffMax', 'pokeCooldownMs',
  'forwardMaxDepth', 'forwardMaxMessages', 'forwardMaxChars', 'forwardImageLimit',
  'forwardTimeoutMs', 'forwardConcurrency', 'forwardMaxRequests', 'forwardBudgetMs',
  // 0.17.5：跨工作区会话进度
  // focusIdleResetMs 允许 0（= 焦点永不超时），所以这里不能按「非负」之外再加限制。
  'focusIdleResetMs', 'progressMaxRows', 'progressIdleWindowMs',
  // 0.19.0：语音每日字数额度（0 = 不限，所以跟着「允许 0」这一组）
  'voiceDailyChars'
]
/** 布尔字段。 */
export const BOOLEAN_FIELDS = [
  'groupOnlyWhenAt', 'splitReply', 'resumeColdSession', 'autoForwardReply',
  'closureEnabled', 'memoryEnabled', 'backfillOnStart', 'notifyTurnFailures', 'wsEnabled',
  'windowEnabled', 'proactiveEnabled', 'pokeEnabled',
  'forwardExpandEnabled', 'forwardImagesEnabled',
  // 0.17.5：跨工作区会话进度
  'focusTagEnabled'
]
/** 可编辑的纯文本字段（空串是合法值 —— 比如清空图片目录就回到默认）。 */
export const STRING_FIELDS = [
  'textPrefix', 'imageCopyDir', 'voiceOutputDir', 'proactiveQuietFrom', 'proactiveQuietTo',
  // 0.17.5：命令前缀。空串 = 关闭命令层，**是有意义的值**，不能当「没填」处理。
  'qqCommandPrefix',
  // 0.18.6：正文头模板。空串 = 用内置默认（与旧行为逐字一致）。
  // ⚠️ 这两项**不走 applyTunables 的通用赋值**，走 /save 里的专门校验分支
  //    （groupHeaderTemplate 有「必须渲染出群友」的护栏）。
  'privateHeaderTemplate', 'groupHeaderTemplate',
  // ---- 0.19.0：语音合成 ----
  //
  // ⚠️ key **不在这个表里**：它必须走「留空 = 保持原样」那条专门分支
  //    （同 token / wsToken）。放进 STRING_FIELDS 会让「留空」变成「清空」——
  //    用户在设置页点一次保存就把 key 抹掉了。见 /save 里的 voiceBreezeKey 分支。
  'voiceGptsovitsUrl', 'voiceGptsovitsRef', 'voiceGptsovitsRefText',
  'voiceBreezeVoice', 'voiceBreezeModel', 'voiceBreezeFormat'
]
/**
 * 字符串数组字段。目前只有主动搭话的白名单。
 * 提交 `[]` 是合法且有意义的（= 全放开），所以不能用「空就跳过」那套。
 */
export const ARRAY_FIELDS = [
  'proactiveTargets', 'waterWindows',
  // 0.19.0：语音的对象名单（私聊 / 群各一份）。
  // `[]` 是有意义的（= 不限制），所以必须在这个类里 —— 走「空就跳过」那套就永远清不空。
  'voiceTargetsPrivate', 'voiceTargetsGroup'
]
/**
 * 枚举字段：只接受列出的值，别的一律丢弃（防止手改配置或旧前端写进一个没人认识的值，
 * 那样 outbound 会静默退回默认分支，行为跟预期不符还查不出来）。
 */
export const ENUM_FIELDS = {
  splitMode: ['paragraph', 'sentence'],
  // 分条间隔模式（2026-11-07）：fixed = 每条等固定时间，perChar = 按字数算
  splitDelayMode: ['fixed', 'perChar'],
  // 0.19.0：语音四档与引擎。枚举保护在这里特别重要 ——
  // 手改配置写个 "ACTIVE" 就静默落回 off 是安全的，但写进一个没人认识的值
  // 会让 deriveToolFeatures 算出意外的 voiceOut。
  voiceMode: ['off', 'passive', 'free', 'active'],
  voiceEngine: ['gptsovits', 'breeze']
}
/**
 * 对象字段（0.17.4）。目前只有工具箱分档。
 *
 * 为什么单独一类而不是塞进 BOOLEAN_FIELDS：toolFeatures 是**嵌套对象**，
 * 按布尔处理会把整个对象覆盖成 true/false；而且必须走 normalizeToolFeatures —— 
 * 前端传 `{emoji:"true"}` 或 `{}` 时，缺的键要补默认，不认识的值要丢。
 * ⚠️ 只 merge 已知的 5 个键：多传的键一律不落盘（防止前端版本不一致时写进垃圾配置）。
 */
export const OBJECT_FIELDS = ['toolFeatures']

/** 白名单只认 `private:<数字>`：脏数据留在配置里会让功能静默失效，干脆在入口处滤掉。 */
function cleanTargetList(value) {
  if (!Array.isArray(value)) return null
  const out = []
  for (const item of value) {
    const key = String(item ?? '').trim()
    if (!/^private:\d+$/.test(key)) continue
    if (out.includes(key)) continue
    out.push(key)
    if (out.length >= 200) break
  }
  return out
}

/** 把设置页提交的可调参数合并进 config。返回是否有改动。 */
function applyTunables(body) {
  const config = getConfig()
  let changed = false
  if (body === null || typeof body !== 'object') return changed
  for (const key of NUMERIC_FIELDS) {
    if (body[key] === undefined) continue
    const value = Number(body[key])
    if (Number.isFinite(value) && value >= 0) {
      config[key] = value
      changed = true
    }
  }
  for (const key of BOOLEAN_FIELDS) {
    if (body[key] === undefined) continue
    config[key] = body[key] === true
    changed = true
  }
  for (const key of STRING_FIELDS) {
    if (typeof body[key] !== 'string') continue
    // 正文头模板走 /save 里的专门分支（groupHeaderTemplate 有护栏校验），
    // 在这里通用赋值会让非法模板绕过校验直接落进配置。
    if (key === 'privateHeaderTemplate' || key === 'groupHeaderTemplate') continue
    config[key] = body[key].trim()
    changed = true
  }
  for (const key of ARRAY_FIELDS) {
    if (body[key] === undefined) continue
    const list = key === 'proactiveTargets'
      ? cleanTargetList(body[key])
      : Array.isArray(body[key])
        ? body[key].map((v) => String(v ?? '').trim()).filter((v) => /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(v)).slice(0, 24)
        : null
    if (list === null) continue
    config[key] = list
    changed = true
  }
  for (const [key, allowed] of Object.entries(ENUM_FIELDS)) {
    if (typeof body[key] !== 'string') continue
    const value = body[key].trim()
    if (!allowed.includes(value)) continue
    config[key] = value
    changed = true
  }
  for (const key of OBJECT_FIELDS) {
    if (body[key] === undefined) continue
    // normalizeToolFeatures 负责「缺键补默认、不认识的值丢掉、非对象→全默认」，
    // 所以这里不需要自己校验形状 —— 传什么进来都不会把配置写坏。
    config[key] = normalizeToolFeatures(body[key])
    changed = true
  }
  return changed
}

/**
 * 清洗前端传来的路由表，只留 sessionId / prefix。
 *
 * 只留这两个是因为**只有它们有消费方**：sessionId → deliver.pickSessionId，
 * prefix → deliver.prefixOf（私聊正文前缀）。
 *
 * ⚠️ 以前这里还留 `onlyWhenAt`，但全代码没有任何地方读它（群里「只在 @ 时响应」
 *   只有全局开关 groupOnlyWhenAt）。留着它会让前端以为这个字段生效、写进去却毫无作用，
 *   所以直接删掉 —— 存进去的假配置比不存更坏。
 *
 * ⚠️ 2026-11-06：`prefix` 也只对**私聊**有消费方。`deliver.prefixOf` 全仓库只有
 *   `poll.js` 的私聊路径调用一次，群头（`poll.js` 里那段 `（QQ群 …·群友「谁」…）`）
 *   是插件按发送者身份硬拼的。所以群表现在**不再接受** prefix ——
 *   设置页也撤掉了那个输入框。两处一起撤，才不会「界面没有、配置里却还留着一个没人读的值」。
 *   已存的群 prefix 会在下次保存时被这里清掉（它本来就从未生效过）。
 *
 * @param table 前端传来的那张表（private 或 group）
 * @param allowPrefix 是否保留 prefix。只有私聊传 true。
 */
function normalizeRouteTable(table, allowPrefix) {
  const out = {}
  if (table === null || typeof table !== 'object') return out
  for (const [key, value] of Object.entries(table)) {
    const id = String(key ?? '').trim()
    if (id === '' || value === null || typeof value !== 'object') continue
    const route = {}
    if (typeof value.sessionId === 'string' && value.sessionId !== '') route.sessionId = value.sessionId
    if (allowPrefix === true && typeof value.prefix === 'string' && value.prefix !== '') route.prefix = value.prefix
    out[id] = route
  }
  return out
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

/**
 * 工作区注册表里的可选工作区（给设置页的「工作区」下拉用）。
 *
 * 数据源是 `progress.js` 的 `readWorkspaces()` —— 它已经在读
 * `~/.dsh/storages/workspace.json`（unit.version=2，数据在 tables.workspaces），
 * 读不到/坏 JSON 一律降级成空表、绝不抛。**别在这里再写一份读盘逻辑**，
 * 两份解析早晚会对不上（一份认 version 2、一份认 version 1）。
 * 同样地，title 缺失时它会拿路径末段兜底，这里**不再兜一遍** —— 两处兜底
 * 只会让「兜底坏了」这件事查不出来（谁兜的都看不出）。
 *
 * 这里只做界面关心的事：丢掉没有 path 的项、按 updatedAt 倒序（最近用过的排前面）、
 * 只留界面真的会用的字段（多给的字段没人用，就是将来的假配置）。
 *
 * 导出是为了让测试能直接打正反用例，不必为一个纯函数起一个 webServer。
 */
export function workspaceChoices() {
  const { workspaces } = readWorkspaces()
  return (Array.isArray(workspaces) ? workspaces : [])
    .filter((item) => item !== null && typeof item === 'object' && String(item.path ?? '') !== '')
    .map((item) => ({
      id: String(item.id ?? ''),
      title: String(item.title ?? ''),
      path: String(item.path ?? ''),
      sessionCount: Array.isArray(item.sessionIds) ? item.sessionIds.length : 0,
      updatedAt: String(item.updatedAt ?? '')
    }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
}

/**
 * 「测一下」用的固定短句（0.19.0）。
 *
 * ⚠️ 这三个字面量**必须是同一句**：`tool.js` 的 `VOICE_TEST_TEXT`（工具自测）、
 *    本文件的 `VOICE_TEST_SENTENCE`（设置页按钮）、`client.js` 的 `VOICE_TEST_SENTENCE`
 *    （按钮旁边那行提示）。测试按这句话断言，改动要三处一起改。
 *    之所以不在前端/后端之间传参：这是**验证通路**用的探针，一旦允许换句子，
 *    「这次测的和我平时发的是不是同一条路」就又要靠猜了。
 */
const VOICE_TEST_SENTENCE = '你好，这是一次测试。'

/**
 * 额度账本 → 设置页能直接显示的形状（/voice-test 与 /voice-balance 共用）。
 *
 * 为什么要单独一层：`quotaStatus()` 在「不限额度」时返回 `remaining: Infinity`，
 * 而 `JSON.stringify({ remaining: Infinity })` 出来是 `null` —— 前端拿到一个
 * 既不像「不限」也不像「0」的空值。这里显式换成 null，并**同时给 unlimited 标记**，
 * 让界面按标记显示「不限」而不是去猜 null 是什么意思。
 */
function quotaView(config) {
  const status = quotaStatus(config)
  return {
    used: status.used,
    limit: status.limit,
    remaining: status.unlimited === true ? null : status.remaining,
    unlimited: status.unlimited === true
  }
}

/** 语音产物的扩展名 → content-type（试听走浏览器解码，给错 MIME 会静默不出声）。 */
const VOICE_MIME = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4'
}

/**
 * 把 URL 里的文件名解析成**语音产物目录内**的真实文件（试听用）。
 *
 * 为什么非要有 containment：这个路由会把本机字节吐给浏览器，等于给设置页开了一个
 * 文件读取口子。只拼 `join(root, name)` 是不够的 —— `../` 能跳出去，而 Windows 上
 * 更隐蔽的是**目录 junction**：在根目录里放一个指向 `C:\` 的链接，路径看着还在根内，
 * 实际读到的是别处的文件。所以这里照抄 `voiceout.js` 的 `resolveConfiguredVoicePath`：
 * 两边都先取 `realpath`，再用 `relative` 判是否还在根内。
 *
 * ⚠️ **必须 `realpathSync.native`**：JS 版不解析 Windows junction，判了等于没判
 *    （`voiceout.js` 里对同一个坑有完整的实测注释）。
 *
 * @param {string} name 只接受 `tts_` 开头的裸文件名
 * @returns {{ok:true, path:string, mime:string} | {ok:false, error:string}}
 */
function resolveVoiceOutputFile(name) {
  if (typeof name !== 'string' || name === '') return { ok: false, error: '没给文件名' }
  // 前缀 + 分隔符 + `..` 三道都查：前缀保证只吐我们自己合成的产物，
  // 后两道是纵深防御（就算哪天前缀规则放宽，路径穿越也进不来）。
  if (!name.startsWith('tts_')) return { ok: false, error: '只提供 tts_ 开头的语音产物' }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return { ok: false, error: '文件名里不能带路径' }
  }

  const rootInfo = voiceOutputRoot()
  if (rootInfo.ok !== true) return { ok: false, error: rootInfo.error }

  let root
  try {
    // 先 resolve 再 native：配置里万一是相对路径，两种解析的基准必须一致。
    root = realpathSync.native(resolve(rootInfo.dir))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `语音产物目录不可用（${message}）：${rootInfo.dir}` }
  }

  let real
  try {
    real = realpathSync.native(join(root, name))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `读不到这个文件（${message}）` }
  }

  const relativePath = relative(root, real)
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    return { ok: false, error: '文件不在语音产物目录内' }
  }

  const ext = real.slice(real.lastIndexOf('.') + 1).toLowerCase()
  return { ok: true, path: real, mime: VOICE_MIME[ext] ?? 'application/octet-stream' }
}

function sendJson(res, code, data) {
  try {
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    })
    res.end(JSON.stringify(data))
  } catch (error) {
    note('api', `send failed ${error instanceof Error ? error.message : error}`)
  }
}

export function registerApi(ctx) {
  const server = serviceOf(ctx, 'webServer')
  if (server === undefined || server === null || typeof server.register !== 'function') {
    note('api', 'webServer 不可用，跳过 API 注册')
    return
  }
  // register 返回 disposer，必须挂到 ctx.effect 上：
  // 热重载时插件被 dispose，不释放的话下次挂同一个 prefix 会抛
  // "webserver: duplicate prefix route"，接口就 404 了。
  const dispose = server.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const route = (req.url ?? '').split('?')[0].slice(API_PREFIX.length) || '/'
      try {
        if (route === '/state' && req.method === 'GET') {
          // 这三项只用来显示「昵称 / 群名 / 机器人自己是谁」—— 全是装饰性字段，
          // 而 /state 其余 90% 的内容（配置、路由、会话、记忆、工具字符数…）都是本地的。
          //
          // ⚠️ 老实现是三次**串行** await，各带 8 秒超时。SnowLuma 没连上时
          //    最坏要等 24 秒才返回，而前端 reload() 在那之前一直停在「加载中…」——
          //    用户只会以为插件坏了。这个 bug 存在很久了，不是某一版引入的。
          //
          // 三条纪律（别改回去）：
          //   ① 并发（Promise.all），别一个等一个 —— 最坏从 24 秒降到单次超时
          //   ② 单独给短超时：这几项慢一点无所谓，不该让用户等。
          //      用常量而不是 requestTimeoutMs：后者是给**投递主链路**用的，
          //      把 UI 的等待压到 1.5 秒不影响收发。
          //   ③ 三项各自兜错，任何一个失败都只降级成 [] / null，绝不让 /state 整体失败。
          //      oneBotList 内部已经 catch；get_login_info 这里再包一层。
          const SELF_TIMEOUT_MS = 1500
          const [friends, groups, self] = await Promise.all([
            oneBotList('get_friend_list', 'user_id', 'nickname', SELF_TIMEOUT_MS),
            oneBotList('get_group_list', 'group_id', 'group_name', SELF_TIMEOUT_MS),
            (async () => {
              try {
                const info = await callOneBot({ action: 'get_login_info', timeoutMs: SELF_TIMEOUT_MS })
                if (info !== null && info !== undefined && info.retcode === 0 && info.data) {
                  return { uin: String(info.data.user_id ?? ''), name: String(info.data.nickname ?? '') }
                }
                return null
              } catch (error) {
                note('api', `get_login_info failed: ${error instanceof Error ? error.message : error}`)
                return null
              }
            })()
          ])
          const config = getConfig()
          return sendJson(res, 200, {
            ok: true,
            self,
            runtime: runtimeSummary(),
            config: publicConfig(),
            // 设置页要显示「关掉这一档省多少字符」—— 数字必须实测，不手写
            toolSizes: await toolSchemaSizes(),
            ws: wsStatus(),
            memory: memorySummary(),
            proactive: proactiveSummary(),
            merge: mergePending(),
            routes: {
              private: config.routes?.private ?? {},
              group: config.routes?.group ?? {}
            },
            sessions: listWorkspaceSessions(ctx),
            friends,
            groups
          })
        }
        if (route === '/workspaces' && req.method === 'GET') {
          // 只读：给「绑定」页顶部的下拉框提供选项。
          // 读不到注册表 → 空数组 + ok:true（读不到不等于接口坏了，
          // 前端据此降级成「手填路径」，不要让它误判成页面出错）。
          const list = workspaceChoices()
          return sendJson(res, 200, { ok: true, workspaces: list })
        }
        if (route === '/memory-clear' && req.method === 'POST') {
          // 「她把我忘了」的后悔药：清空整张关系卡表（不可撤销，前端必须二次确认）
          const ok = wipeMemory()
          note('api', `memory cleared ok=${ok}`)
          return sendJson(res, ok ? 200 : 500, { ok, memory: memorySummary() })
        }
        if (route === '/memory-raw' && req.method === 'GET') {
          // 关系卡原始 JSON（2026-11-06）：设置页的「编辑原始文件」用。
          // 返回原文而不是结构化对象 —— 结构抄进界面就要维护两份 schema。
          const raw = readMemoryRaw()
          if (raw.ok !== true) return sendJson(res, 500, { ok: false, error: raw.error })
          return sendJson(res, 200, { ok: true, text: raw.text, file: memoryFilePath() })
        }
        if (route === '/memory-raw' && req.method === 'POST') {
          // 校验（是不是 JSON 对象）→ 通过才落盘。校验失败不动原文件。
          const body = await readBody(req)
          const result = saveMemoryRaw(typeof body?.text === 'string' ? body.text : '')
          note('api', `memory raw save ok=${result.ok === true}`)
          if (result.ok !== true) return sendJson(res, 400, { ok: false, error: result.error })
          return sendJson(res, 200, { ok: true, count: result.count, memory: memorySummary() })
        }
        if (route === '/proactive-now' && req.method === 'POST') {
          // 设置页的「现在试一次」：忽略开关/配额/空闲/静默，立刻投一次。
          // 为什么允许在开关关着时也能试：不试一下谁也不知道手感对不对。
          // body.only 指定对象（`private:123`）；不传就按名单里第一个。
          const body = await readBody(req)
          const only = typeof body?.only === 'string' ? body.only : ''
          const result = await runProactiveOnce(ctx, { force: true, only })
          note('api', `proactive-now sent=${result.sent} skipped=${result.skipped.map((s) => `${s.key}:${s.reason}`).join(',') || '-'}`)
          return sendJson(res, 200, { ok: true, ...result, proactive: proactiveSummary() })
        }
        if (route === '/clear-credentials' && req.method === 'POST') {
          const config = getConfig()
          config.token = ''
          config.wsToken = ''
          const ok = saveConfig()
          note('api', `credentials cleared ok=${ok}`)
          return sendJson(res, ok ? 200 : 500, { ok })
        }
        if (route === '/save' && req.method === 'POST') {
          const config = getConfig()
          const body = await readBody(req)
          // 先校验再赋值：失败请求不能让 routes / WS / tunables 部分生效。
          let nextHttp = null
          if (typeof body?.onebotHttp === 'string' && body.onebotHttp.trim() !== '') {
            const raw = body.onebotHttp.trim()
            let parsed
            try { parsed = new URL(raw) } catch { parsed = null }
            if (parsed === null || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hostname === '') {
              return sendJson(res, 400, { ok: false, error: 'HTTP API 地址要形如 http://127.0.0.1:3000/（协议 + 主机都要有）' })
            }
            const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
            if (!Number.isInteger(port) || port < 1 || port > 65535) {
              return sendJson(res, 400, { ok: false, error: `HTTP API 端口不合法：${parsed.port}` })
            }
            nextHttp = raw
          }
          if (body?.waterWindows !== undefined) {
            const valid = Array.isArray(body.waterWindows) && body.waterWindows.every((value) => {
              const match = String(value ?? '').trim().match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/)
              if (match === null) return false
              return Number(match[1]) <= 23 && Number(match[2]) <= 59 && Number(match[3]) <= 23 && Number(match[4]) <= 59
            })
            if (!valid) return sendJson(res, 400, { ok: false, error: '活动时间段必须是 HH:MM-HH:MM，小时 00~23、分钟 00~59' })
          }
          /**
           * 工作区：**先校验再赋值**（跟上面 onebotHttp 同一套路数）。
           *
           * 为什么非要拦：这个值不只筛会话，还是「收到的图片」副本的根目录
           * （images.js:305 / collect.js:452）。手滑填错一个字母，面板上会话列表立刻变空，
           * 而且此后收到的图全落到一个新目录里 —— 用户只会看到「图片突然没了」。
           * 静默接受一个不存在的路径是最坏的选项，所以宁可 400 并说清楚。
           *
           * ⚠️ 位置很关键：这段必须**排在所有赋值之前**（routes 也在它后面）。
           *    写这个功能时这里真踩过一次：routes 先赋值、工作区后校验，于是请求虽然 400 了，
           *    内存里的绑定表已经变了。saveConfig 没跑，但 getConfig() 是模块单例，
           *    下一次任何写盘都会把它带下去。tests/workspace-picker-sim.mjs 的
           *    「被拒的请求没有顺手把 routes 也改了」就是钉这条的。
           *
           * 空串是**合法值**（= 不筛工作区，退回 DATA_DIR 存图），得放行。
           */
          /**
           * 正文头模板（0.18.6）：**先校验再赋值**，与上面工作区同一套路数。
           *
           * 为什么必须拦：
           *   ① 群模板如果渲染不出「群友」，身份提示（poll.js 的
           *      `context.some(line => line.includes('群友'))`）会**静默失效** ——
           *      那是防群内 prompt injection 的唯一防线，不能让人无意中关掉。
           *   ② 变量拼错（{sendLabel}）会原样留在产物里，模型看到一行大括号。
           *   ③ 模板每条消息都会带上，太长就是每条都多付一次成本。
           *
           * 空串合法（= 用内置默认，与旧行为逐字一致）。
           */
          let nextPrivateTemplate
          let nextGroupTemplate
          if (body?.privateHeaderTemplate !== undefined) {
            if (typeof body.privateHeaderTemplate !== 'string') {
              return sendJson(res, 400, { ok: false, error: '私聊正文头模板必须是字符串' })
            }
            const check = prompttext.validateTemplate('private', body.privateHeaderTemplate, () => (
              prompttext.renderPrivateHeader({ prefix: '（QQ 私聊）', ownerUin: '10000', uin: '10000' })
            ))
            if (check.ok !== true) return sendJson(res, 400, { ok: false, error: `私聊正文头：${check.error}` })
            nextPrivateTemplate = String(body.privateHeaderTemplate).trim()
          }
          if (body?.groupHeaderTemplate !== undefined) {
            if (typeof body.groupHeaderTemplate !== 'string') {
              return sendJson(res, 400, { ok: false, error: '群聊正文头模板必须是字符串' })
            }
            const check = prompttext.validateTemplate('group', body.groupHeaderTemplate, () => {
              // 用「一个群友」当样例 —— 护栏要能在这个样例下渲染出「群友」。
              // 不能用用户本人当样例：那条分支的产物里本来就没有「群友」二字，
              // 会误判成「模板不合格」。
              const senderUin = '10001'
              return {
                groupId: '100000',
                groupName: prompttext.groupNamePart('测试群'),
                senderLabel: prompttext.senderLabelOf({ isOwner: false, nickname: '样例群友', senderUin }),
                nickname: prompttext.speakerNameOf({ isOwner: false, nickname: '样例群友', senderUin }),
                senderUin
              }
            })
            if (check.ok !== true) return sendJson(res, 400, { ok: false, error: `群聊正文头：${check.error}` })
            nextGroupTemplate = String(body.groupHeaderTemplate).trim()
          }
          let nextWorkspaceCwd
          if (body?.workspaceCwd !== undefined) {
            if (typeof body.workspaceCwd !== 'string') {
              return sendJson(res, 400, { ok: false, error: '工作区必须是路径字符串' })
            }
            const raw = body.workspaceCwd.trim()
            if (raw === '') {
              nextWorkspaceCwd = ''
            } else {
              const choices = workspaceChoices()
              if (choices.length === 0) {
                /**
                 * 注册表读不到（文件缺失 / 坏 JSON / 从没建过工作区）时的退路：
                 * 没法按注册表比，就退一步只认「这个目录在不在」。
                 *
                 * 为什么不是「读不到就一律拒绝」：那样前端降级出来的「手填路径」框
                 * 会**永远存不进去**，等于把降级路径做成了死路。
                 * 为什么还要查目录：手滑打错一个字母就静默把图片目录搬走，
                 * 比 400 难查得多。
                 */
                let exists = false
                try { exists = existsSync(raw) } catch { exists = false }
                if (!exists) {
                  return sendJson(res, 400, {
                    ok: false,
                    error: `读不到工作区注册表，只能按目录是否存在来校验：${raw} 不存在。`
                  })
                }
                note('api', `工作区注册表读不到，按目录存在性接受了 ${raw}`)
                nextWorkspaceCwd = raw
              } else {
                const wanted = normCwd(raw)
                const hit = choices.find((item) => normCwd(item.path) === wanted)
                if (hit === undefined) {
                  return sendJson(res, 400, {
                    ok: false,
                    error: `这个路径不在工作区注册表里：${raw}。请在 DSH 里先新建/打开一次那个工作区，再从下拉框里选。`
                  })
                }
                // 落盘用注册表里的**原始大小写**，别把用户传的大小写写进配置 ——
                // Windows 上两者等价，但配置里会一直显示成奇怪的样子。
                nextWorkspaceCwd = hit.path
              }
            }
          }
          // ---- 以上全部是校验，从这里开始才是赋值 ----
          if (body?.routes !== undefined && typeof body.routes === 'object') {
            config.routes = {
              // 只有私聊保留 prefix（群聊的群头由 poll.js 按发送者身份硬拼，见 normalizeRouteTable 注释）
              private: normalizeRouteTable(body.routes.private, true),
              group: normalizeRouteTable(body.routes.group, false)
            }
            // 绑定即监听：群表里的群号自动进监听列表。
            // 之前只写 routes.group、不写 groupUins，结果设置页里绑了群却完全没轮询（踩过）。
            config.groupUins = Object.keys(config.routes.group ?? {})
          }
          // wsEnabled 由 applyTunables 统一处理（BOOLEAN_FIELDS），这里不再重复赋值
          if (typeof body?.wsUrl === 'string' && body.wsUrl.trim() !== '') config.wsUrl = body.wsUrl.trim()
          if (typeof body?.wsToken === 'string' && body.wsToken.trim() !== '') config.wsToken = body.wsToken.trim()
          if (nextHttp !== null) config.onebotHttp = nextHttp
          if (nextWorkspaceCwd !== undefined) config.workspaceCwd = nextWorkspaceCwd
          if (nextPrivateTemplate !== undefined) config.privateHeaderTemplate = nextPrivateTemplate
          if (nextGroupTemplate !== undefined) config.groupHeaderTemplate = nextGroupTemplate
          if (typeof body?.token === 'string' && body.token.trim() !== '') config.token = body.token.trim()
          // ---- 0.19.0：Breeze 的 key ----
          //
          // ⚠️ 必须**留空 = 保持原样**（同上面 token / wsToken 的做法）。
          //    它不在 STRING_FIELDS 里正是因为这个：通用赋值会把「留空」当「清空」，
          //    用户点一次保存就把 key 抹了，而界面上看不出任何异常。
          //    前端那边也不回显 key（只给 voiceBreezeKeySet 布尔），所以留空是常态。
          if (typeof body?.voiceBreezeKey === 'string' && body.voiceBreezeKey.trim() !== '') {
            config.voiceBreezeKey = body.voiceBreezeKey.trim()
          }
          // wsFallbackPollMs 也归 applyTunables（NUMERIC_FIELDS），不再单独判一遍
          applyTunables(body)
          const ok = saveConfig()
          note('api', `saved routes private=${Object.keys(config.routes?.private ?? {}).length} group=${Object.keys(config.routes?.group ?? {}).length} ws=${config.wsEnabled === false ? 'off' : config.wsUrl}`)
          return sendJson(res, ok ? 200 : 500, { ok })
        }
        if (route === '/detect-ws' && req.method === 'POST') {
          // 自动发现 SnowLuma 的 WS 接入点（省得手动抄 token）
          const config = getConfig()
          const body = await readBody(req)
          if (typeof body?.snowlumaConfigDir === 'string' && body.snowlumaConfigDir.trim() !== '') {
            config.snowlumaConfigDir = body.snowlumaConfigDir.trim()
          }
          const endpoint = discoverWsEndpoint(String(config.snowlumaConfigDir ?? ''))
          if (endpoint === null) {
            return sendJson(res, 404, {
              ok: false,
              error: '没找到 SnowLuma 的 WS 接入点。可以手动填地址和 token（见 SnowLuma 的 config/onebot_*.json）。'
            })
          }
          config.wsUrl = endpoint.url
          config.wsToken = endpoint.token
          saveConfig()
          return sendJson(res, 200, { ok: true, url: endpoint.url, source: endpoint.source })
        }
        if (route === '/detect-http' && req.method === 'POST') {
          // 0.15.0：自动发现 SnowLuma 的 HTTP API 接入点（与 WS 那套 token 不是一回事）
          const config = getConfig()
          const body = await readBody(req)
          if (typeof body?.snowlumaConfigDir === 'string' && body.snowlumaConfigDir.trim() !== '') {
            config.snowlumaConfigDir = body.snowlumaConfigDir.trim()
          }
          const endpoint = discoverHttpEndpoint(String(config.snowlumaConfigDir ?? ''))
          if (endpoint === null) {
            return sendJson(res, 404, {
              ok: false,
              error: '没找到 SnowLuma 的 HTTP 接入点。可以手动填地址和 token（见 SnowLuma 的 config/onebot_*.json 的 httpServers）。'
            })
          }
          config.onebotHttp = endpoint.url
          if (endpoint.token !== '') config.token = endpoint.token
          saveConfig()
          return sendJson(res, 200, { ok: true, url: endpoint.url, source: endpoint.source, hasToken: endpoint.token !== '' })
        }
        // ---------------- 语音（0.19.0）----------------
        // 四个路由全部是 POST：它们要么有副作用（测一下会花钱），要么要发外部请求。
        // 全部返回 `{ok:false,error}` + HTTP 200：这些是**业务结果**，不是 HTTP 错误 ——
        // 前端按 result.ok 分支处理，不靠状态码。跟 /proactive-now 的风格一致。
        if (route === '/voice-test' && req.method === 'POST') {
          /**
           * 「测一下」：真的合成一次固定短句。
           *
           * ⚠️ 为什么**不**调 `synthesizeForTarget`：那边先查档位和名单。
           *    而这是**人自己点的**按钮 —— 人刚配完 key、档位还在 off，正是最需要验证的时刻；
           *    名单为空时它也该能跑（还没绑任何对象也要能验 key）。
           *    所以这里走裸 `synthesize`，自己管额度。
           *
           * ⚠️ 但**额度照算**：它真的花钱。跳过额度等于在设置页留一个
           *    「绕过每日上限随便点」的按钮。
           */
          const config = getConfig()
          const chars = billableChars(VOICE_TEST_SENTENCE)
          const engine = String(config.voiceEngine ?? '') === 'breeze' ? 'breeze' : 'gptsovits'

          // 只有 breeze 计费：给本机引擎也扣额度，等于让「已有上限」莫名其妙地
          // 卡住免费功能（tts-gate.js 里 chargesQuota 的注释是同一理由）。
          let reserved = 0
          if (chargesQuota(engine)) {
            const charged = chargeQuota(chars, config)
            if (charged.ok !== true) {
              // 额度不足是用户最可能撞上的失败，所以把「怎么办」放在最前面 ——
              // `chargeQuota` 自己的文案讲的是「为什么不行」，这里补的是「下一步做什么」。
              return sendJson(res, 200, {
                ok: false,
                error: `额度不够，先把每日上限调大或者等明天。${charged.error}`,
                quota: quotaView(config)
              })
            }
            reserved = charged.chars
          }

          let synth
          try {
            synth = await synthesize(VOICE_TEST_SENTENCE, { config, engine })
          } catch (error) {
            // synthesize 不抛，但排队队列会抛（一次最多排 3 条）
            if (reserved > 0) refundQuota(reserved)
            const message = error instanceof Error ? error.message : String(error)
            note('api', `voice-test 排队失败：${message}`)
            return sendJson(res, 200, { ok: false, error: message, quota: quotaView(config) })
          }
          if (synth.ok !== true) {
            if (reserved > 0) refundQuota(reserved)
            note('api', `voice-test 合成失败 engine=${engine}`)
            return sendJson(res, 200, { ok: false, error: synth.error, quota: quotaView(config) })
          }

          // ⚠️ 只回 basename，**绝对不回绝对路径**：
          //    设置页不需要它（同名文件就在语音产物目录里），
          //    而路径本身会顺带泄露用户名/目录结构，没有回传的价值。
          const name = basename(synth.path)
          note('api', `voice-test ok engine=${synth.engine} chars=${synth.chars} ${synth.ms}ms`)
          return sendJson(res, 200, {
            ok: true,
            engine: synth.engine,
            chars: synth.chars,
            ms: synth.ms,
            bytes: synth.bytes,
            file: name,
            // 试听走 GET /voice-file/<name>：浏览器拿不到本机路径，只能靠这个入口取字节。
            previewUrl: `${API_PREFIX}/voice-file/${encodeURIComponent(name)}`,
            quota: quotaView(config)
          })
        }
        if (route === '/voice-voices' && req.method === 'POST') {
          /**
           * 音色搜索。**不做缓存**：
           * 官方要求 voice-list 至少缓存 60 秒，但这是配置页的**手动触发**按钮，
           * 一次点击一个请求，本来就低频；加一层缓存只会多一份可能过期的状态，
           * 换不来任何可感知的收益（这是「能省则省」该省的地方反面）。
           */
          const config = getConfig()
          const key = String(config.voiceBreezeKey ?? '').trim()
          if (key === '') {
            return sendJson(res, 200, { ok: false, error: '还没填 Breeze 的 API key（设置 → 高级 → 语音合成）' })
          }
          const body = await readBody(req)
          const search = typeof body?.search === 'string' ? body.search.trim() : ''
          const result = await searchBreezeVoices(key, search, 30)
          if (result.ok !== true) {
            // 注意：这里只记「失败」本身，**绝不把 key 或请求头写进日志**
            note('api', `voice-voices 失败 search=${search === '' ? '(空)' : search}`)
            return sendJson(res, 200, { ok: false, error: result.error })
          }
          return sendJson(res, 200, { ok: true, total: result.total, voices: result.voices })
        }
        if (route === '/voice-balance' && req.method === 'POST') {
          /**
           * 余额 + 当日额度。两个数据源合在一个响应里：
           * 设置页那张卡上它们并排显示，拆成两个请求只会多一次往返和两处可能的失败。
           */
          const config = getConfig()
          const account = await breezeAccount(config)
          if (account.ok !== true) return sendJson(res, 200, { ok: false, error: account.error })
          return sendJson(res, 200, {
            ok: true,
            account: {
              balance: account.balance,
              pending: account.pending,
              plan: account.plan,
              concurrency: account.concurrency,
              commercial: account.commercial
            },
            quota: quotaView(config)
          })
        }
        // 试听：GET（浏览器 <audio src> 只会发 GET，不能 POST）
        if (route.startsWith('/voice-file/') && req.method === 'GET') {
          const raw = route.slice('/voice-file/'.length)
          let name = raw
          try {
            // 前端 encodeURIComponent 过一次，这里解回来；解不开就按原文用
            name = decodeURIComponent(raw)
          } catch {
            name = raw
          }
          const found = resolveVoiceOutputFile(name)
          if (found.ok !== true) {
            note('api', `voice-file 拒绝 ${raw}：${found.error}`)
            return sendJson(res, 404, { ok: false, error: found.error })
          }
          try {
            const bytes = readFileSync(found.path)
            res.writeHead(200, {
              'content-type': found.mime,
              'content-length': bytes.length,
              // 同一文件名内容不会变（文件名带时间戳+随机），可以长缓存；
              // 但用 no-cache 更稳妥 —— 试听本来就是即时行为，省这点流量没必要。
              'cache-control': 'no-cache'
            })
            res.end(bytes)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            note('api', `voice-file 读取失败 ${name}：${message}`)
            return sendJson(res, 500, { ok: false, error: `读不到这个语音文件（${message}）` })
          }
          return
        }
        return sendJson(res, 404, { ok: false, error: `unknown route: ${route}` })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        note('api', `${route} threw ${message}`)
        return sendJson(res, 500, { ok: false, error: message })
      }
    }
  })
  if (typeof dispose === 'function') ctx.effect(() => dispose, 'dsh-onebot-channel: api route')
  note('api', `registered at ${API_PREFIX}`)
}
