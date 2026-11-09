/**
 * api.js —— 设置页 API（同源 /api/qq-bridge/*）。
 *
 * 与浏览器半侧（lib/client.js）只走同源 HTTP，不碰 RPC。
 */
import { getConfig, saveConfig, normalizeToolFeatures, VOICE_MODES, normalizeNotifyTarget, NOTIFY_TARGET_MODES } from './config.js'
import { note, serviceOf, LOAD_LOG } from './env.js'
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
// resolveVoiceTestText：「测一下」的句子（配置可改，留空 = 内置那句）。
// 与 tool.js 的 runVoiceSelfTest 共用，避免「按钮测的」和「工具测的」不是同一句话。
import { resolveVoiceTestText } from './tool.js'
import {
  breezeAccount, quotaStatus, chargeQuota, refundQuota, chargesQuota, billableChars
} from './tts-gate.js'
import { voiceOutputRoot } from './voiceout.js'
// 诊断包（0.19.7）要读三样「活状态」：游标、出站队列、节奏账本。
// 都是只读引用 —— 诊断包不许改任何运行时状态。
import { getState } from './state.js'
import { outbound } from './outbound.js'
import { exportDiagLog } from './diaglog.js'
import { suppressedKeys, recentDelivery } from './rhythm.js'
import { readFileSync, existsSync, realpathSync, statSync } from 'node:fs'
// 0.19.5：只有 /log-file 用异步读（日志能到几十万字节，同步读会堵住事件循环）。
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
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

/**
 * **启动那一刻**生效的语音模式（2026-11-07 用户要求）。
 *
 * 为什么需要它：`voiceMode` 改完必须重启 DSH 才真正生效
 * （「禁用」档是把 qq_tts 整个不注册，工具注册发生在 apply 里）。
 * 但设置页读到的是**配置里的值** —— 用户改完、保存、切出去再回来，
 * 看到的是自己刚选的那个，会以为已经生效了，然后发现语音行为没变。
 *
 * 所以在这里把启动时的值固化下来，`/state` 一起返回，
 * 前端就能并排显示「正在生效 X / 已选择 Y」，不一致时给警告。
 *
 * 取不到（模块刚加载、config 还没就绪）就记空串 —— 前端会退化成不显示对比。
 */
let BOOT_VOICE_MODE = ''
export function captureBootVoiceMode(config) {
  try {
    BOOT_VOICE_MODE = String(config?.voiceMode ?? '')
  } catch {
    BOOT_VOICE_MODE = ''
  }
  return BOOT_VOICE_MODE
}

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
    bootAt: BOOT_AT,
    // 启动时生效的语音模式（空串 = 没捕获到，前端不显示对比）
    activeVoiceMode: BOOT_VOICE_MODE
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
    // 硬上限（2026-11-09）：漏了这行就是「界面能改、改了没用」（见维护索引 §3 第 2 处）
    groupContextMax: Number(config.groupContextMax) || 20,
    // 0.21.4：上下文过载时的「请用引用 / @」提示阈值（0 = 关）
    // ⚠️ 脏值回默认 5（不能顺着 NaN 走到「功能消失」），与 prompt.js 的 crowdHintText 同口径
    groupCrowdHintCount: Number.isFinite(Number(config.groupCrowdHintCount))
      ? Number(config.groupCrowdHintCount)
      : 5,
    windowQueueMax: Number(config.windowQueueMax) || 20,
    windowQueueAll: config.windowQueueAll !== false,
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
    // 0.20.2：自动转发按渠道拆开（旧的单布尔 autoForwardReply 会被 migrateAutoForward 迁进来）
    autoForwardPrivate: config.autoForwardPrivate !== false,
    autoForwardGroup: config.autoForwardGroup === true,
    // 0.21.4：群里那些「本该进群」的正文改投私聊（带【群聊 …】前缀），默认关
    groupReportToPrivate: config.groupReportToPrivate === true,
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
    // 0.20.0：系统消息发到哪里（same / private / off）。三选一取代了上面的布尔。
    notifyTarget: normalizeNotifyTarget(config.notifyTarget),
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
    // GPT-SoVITS 独有的调参（设置页只在选本机引擎时显示）
    voiceGptsovitsLang: String(config.voiceGptsovitsLang ?? ''),
    voiceGptsovitsSpeed: Number.isFinite(Number(config.voiceGptsovitsSpeed)) ? Number(config.voiceGptsovitsSpeed) : 1,
    voiceGptsovitsTopK: Number.isFinite(Number(config.voiceGptsovitsTopK)) ? Number(config.voiceGptsovitsTopK) : 15,
    voiceGptsovitsTopP: Number.isFinite(Number(config.voiceGptsovitsTopP)) ? Number(config.voiceGptsovitsTopP) : 1,
    voiceGptsovitsTemperature: Number.isFinite(Number(config.voiceGptsovitsTemperature)) ? Number(config.voiceGptsovitsTemperature) : 1,
    voiceGptsovitsSplit: String(config.voiceGptsovitsSplit ?? ''),
    voiceGptsovitsBatchSize: Number.isFinite(Number(config.voiceGptsovitsBatchSize)) ? Number(config.voiceGptsovitsBatchSize) : 20,
    voiceGptsovitsFragmentInterval: Number.isFinite(Number(config.voiceGptsovitsFragmentInterval)) ? Number(config.voiceGptsovitsFragmentInterval) : 0.3,
    voiceGptsovitsSeed: Number.isFinite(Number(config.voiceGptsovitsSeed)) ? Number(config.voiceGptsovitsSeed) : -1,
    voiceGptsovitsRepetitionPenalty: Number.isFinite(Number(config.voiceGptsovitsRepetitionPenalty)) ? Number(config.voiceGptsovitsRepetitionPenalty) : 1.35,
    voiceGptsovitsSampleSteps: String(config.voiceGptsovitsSampleSteps ?? '32'),
    voiceGptsovitsCfgRate: Number.isFinite(Number(config.voiceGptsovitsCfgRate)) ? Number(config.voiceGptsovitsCfgRate) : 0,
    // ⚠️ key 本身**绝不回传**（同 token / wsToken 的处理）。
    //    前端只需要知道「配没配」来决定输入框的 placeholder —— 所以给一个布尔。
    voiceBreezeKeySet: String(config.voiceBreezeKey ?? '').trim() !== '',
    voiceBreezeVoice: String(config.voiceBreezeVoice ?? ''),
    voiceBreezeModel: String(config.voiceBreezeModel ?? ''),
    voiceBreezeFormat: String(config.voiceBreezeFormat ?? 'wav') || 'wav',
    voiceBreezeSpeed: Number.isFinite(Number(config.voiceBreezeSpeed)) ? Number(config.voiceBreezeSpeed) : 0.9,
    // Breeze 独有的 voice_settings（设置页只在选 Breeze 时显示）
    voiceBreezeGuidanceScale: Number.isFinite(Number(config.voiceBreezeGuidanceScale)) ? Number(config.voiceBreezeGuidanceScale) : 1,
    voiceBreezeVolume: Number.isFinite(Number(config.voiceBreezeVolume)) ? Number(config.voiceBreezeVolume) : 1,
    voiceBreezeSpeakerBoost: config.voiceBreezeSpeakerBoost === true,
    // 「测一下」的句子（留空 = 内置那句）
    voiceTestText: String(config.voiceTestText ?? ''),
    // 注册/推广链接（0.19.5）：留空 = 设置页用内置的官方登录页。
    // 走 cleanSignupUrl 再吐出去 —— 配置文件是明文的，手改进去一个
    // `javascript:` 不能被原样送到前端的 <a href>。
    voiceSignupUrl: cleanSignupUrl(config.voiceSignupUrl),
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
    // 0.20.1：忽略指令。空数组是有意义的值（= 关闭），所以不能用 `||` 兜底成默认表 ——
    // 那会让用户「清空这张表」永远失败，而且毫无报错。
    ignoreCommands: Array.isArray(config.ignoreCommands)
      ? config.ignoreCommands.map((v) => String(v ?? '')).filter((v) => v !== '')
      : [],
    focusTagEnabled: config.focusTagEnabled !== false,
    focusIdleResetMs: Number.isFinite(Number(config.focusIdleResetMs)) ? Number(config.focusIdleResetMs) : 3600000,
    progressMaxRows: Number.isFinite(Number(config.progressMaxRows)) ? Number(config.progressMaxRows) : 12,
    progressIdleWindowMs: Number.isFinite(Number(config.progressIdleWindowMs)) ? Number(config.progressIdleWindowMs) : 86400000
  }
}

/**
 * 允许负数的数字字段。
 *
 * 为什么需要单独一组：`NUMERIC_FIELDS` 的规则是「非负有限数」，而
 * `voiceGptsovitsSeed` 的 **-1 是有意义的值**（= 每次随机），
 * 填个 -1 会被静默丢掉，表现成「固定种子没生效」。
 */
export const SIGNED_NUMERIC_FIELDS = ['voiceGptsovitsSeed']

/**
 * 可数字段：非负有限数才接受。
 */
export const NUMERIC_FIELDS = [
  'groupContextCount', 'groupContextMax', 'groupCrowdHintCount', 'splitMaxChars', 'splitMaxParts', 'splitMinChars',
  'splitDelayMs', 'splitDelayPerCharMs', 'splitDelayMaxCapMs', 'pollMs', 'groupPollMs',
  'replyQuietMs', 'waitMaxMs', 'waitTurnMaxMs', 'backfillMaxPages', 'backfillDeliver', 'wsFallbackPollMs',
  'mergeWindowMs', 'mergeMaxWaitMs', 'mergeMaxMessages',
  'windowIdleMs', 'windowMaxMs', 'windowMaxReplies', 'windowPerPeerDaily', 'windowPerGroupDaily', 'windowQueueMax',
  'proactiveIdleHours', 'proactiveIdleMaxHours', 'proactiveDailyMax', 'proactiveBackoffMax', 'pokeCooldownMs',
  'forwardMaxDepth', 'forwardMaxMessages', 'forwardMaxChars', 'forwardImageLimit',
  'forwardTimeoutMs', 'forwardConcurrency', 'forwardMaxRequests', 'forwardBudgetMs',
  // 0.17.5：跨工作区会话进度
  // focusIdleResetMs 允许 0（= 焦点永不超时），所以这里不能按「非负」之外再加限制。
  'focusIdleResetMs', 'progressMaxRows', 'progressIdleWindowMs',
  // 0.19.0：语音每日字数额度（0 = 不限，所以跟着「允许 0」这一组）
  'voiceDailyChars',
  // 各引擎的调参。范围校验放在 tts.js 发送前（越界就夹到合法区间），
  // 这里只保证「是个数字」—— 因为 NUMERIC_FIELDS 的语义就是「非负有限数」。
  'voiceBreezeSpeed', 'voiceBreezeGuidanceScale', 'voiceBreezeVolume',
  'voiceGptsovitsSpeed', 'voiceGptsovitsTopK', 'voiceGptsovitsTopP', 'voiceGptsovitsTemperature',
  'voiceGptsovitsBatchSize', 'voiceGptsovitsFragmentInterval',
  'voiceGptsovitsRepetitionPenalty', 'voiceGptsovitsCfgRate'
]
/** 布尔字段。 */
export const BOOLEAN_FIELDS = [
  'groupOnlyWhenAt', 'splitReply', 'resumeColdSession', 'autoForwardPrivate', 'autoForwardGroup',
  // 0.21.4：群里的「本该进群」正文回传到私聊（默认关）。漏进这张表就是
  // 「界面能改、改了没用」—— 正是维护索引 §3 警告的第 2 处。
  'groupReportToPrivate',
  // ⚠️ autoForwardReply 已从这张表移除（0.20.2）：它被按渠道的两个新键取代，
  //    旧值由 loadConfig 的 migrateAutoForward 迁进 autoForwardPrivate。
  //    再让它可写就是「一个行为两个真相源」—— 同 0.20.0 的 notifyTurnFailures。
  // ⚠️ notifyTurnFailures 已从这张表移除（0.20.0）：它被 notifyTarget 三选一取代，
  //    再让它可写就是「一个行为两个真相源」—— 复选框关掉、下拉框选原路，
  //    到底听谁的？迁移把旧值折进 notifyTarget，之后只认新键。
  'closureEnabled', 'memoryEnabled', 'backfillOnStart', 'wsEnabled',
  'windowEnabled', 'proactiveEnabled', 'pokeEnabled',
  // 2026-11-09：窗口期内整段对话都进队列（关掉 = 退回只认触发人/@/引用）
  'windowQueueAll',
  'forwardExpandEnabled', 'forwardImagesEnabled',
  // 0.17.5：跨工作区会话进度
  'focusTagEnabled',
  // 0.19.0：Breeze 的 use_speaker_boost。
  // ⚠️ 0.19.2 漏了这一行 → 用户勾上、保存、重进就变回未勾选（值被静默丢弃）。
  //    这是「加配置项五处同改」里最容易漏的一处：publicConfig 有了、界面有了，
  //    但可写分类表没有 —— 表现成「保存了但没存上」，而且**零报错**。
  'voiceBreezeSpeakerBoost'
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
  // ⚠️ 0.19.5：这三个是**下拉框**，但配置里存的是字符串（「中文」「凑四句一切」「32」）。
  //    它们原来只出现在 publicConfig（能读），却从来没进过任何一张 applyTunables 的表
  //    （不能写）—— 于是设置页里改「语种 / 切句方式 / 采样步数」是**彻底存不住**的：
  //    POST 成功、重进页面又变回原样，零报错。0.19.2 那两个 bug 的同一形状。
  //    是 tests/voice-autosave-sim.mjs 逐个键跑 applyTunables 时抓出来的。
  'voiceGptsovitsLang', 'voiceGptsovitsSplit', 'voiceGptsovitsSampleSteps',
  'voiceBreezeVoice', 'voiceBreezeModel', 'voiceBreezeFormat',
  // 「测一下」的句子。空串有意义（= 用内置默认），所以归 STRING 这一组。
  'voiceTestText',
  // 0.19.5：注册/推广链接。空串 = 用官方登录页（内置常量），所以也归 STRING 这一组。
  // ⚠️ 只接受 http/https（见 cleanSignupUrl），别的一律清空 ——
  //    这个值最后会变成设置页里的 <a href>，放 javascript: 进来就是个 XSS 口子。
  'voiceSignupUrl'
]
/**
 * 字符串数组字段。目前只有主动搭话的白名单。
 * 提交 `[]` 是合法且有意义的（= 全放开），所以不能用「空就跳过」那套。
 */
export const ARRAY_FIELDS = [
  'proactiveTargets', 'waterWindows',
  // 0.19.0：语音的对象名单（私聊 / 群各一份）。
  // `[]` 是有意义的（= 不限制），所以必须在这个类里 —— 走「空就跳过」那套就永远清不空。
  'voiceTargetsPrivate', 'voiceTargetsGroup',
  // 0.20.1：忽略指令表。`[]` 有意义（= 关闭这项功能，回到「什么都投」），
  // 所以要在这个类里；没有对应的「空就跳过」语义。
  'ignoreCommands'
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
  voiceEngine: ['gptsovits', 'breeze'],
  // 0.20.0：系统消息发到哪里。same = 原路（旧行为）/ private = 全回传私聊 / off = 不发。
  notifyTarget: NOTIFY_TARGET_MODES
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

/**
 * 语音对象名单：`private:<uin>` 或 `group:<群号>`，两种都收。
 *
 * ⚠️ 为什么不能复用 cleanTargetList：那个只认 `private:`，
 *    群那半边会被整条滤掉（而语音是私聊/群各一张表，两张都得能存）。
 *
 * @param {'private'|'group'|'both'} [only] 限定只收哪一种前缀。
 *   私聊表里塞个 `group:` 是无意义数据（永远匹配不上），所以各自限定。
 */
function cleanVoiceTargetList(value, only = 'both') {
  if (!Array.isArray(value)) return null
  const pattern = only === 'private'
    ? /^private:\d+$/
    : only === 'group'
      ? /^group:\d+$/
      : /^(?:private|group):\d+$/
  const out = []
  for (const item of value) {
    const key = String(item ?? '').trim()
    // 只收合法的形状 —— 写错前缀的脏数据留在配置里会让闸门静默失效
    if (!pattern.test(key)) continue
    if (out.includes(key)) continue
    out.push(key)
    if (out.length >= 200) break
  }
  return out
}

/** 水群活动时间段：`HH:MM-HH:MM`。 */
function cleanTimeWindowList(value) {
  if (!Array.isArray(value)) return null
  return value
    .map((v) => String(v ?? '').trim())
    .filter((v) => /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(v))
    .slice(0, 24)
}

/**
 * 注册/推广链接（0.19.5）。空串是合法的（= 用内置的官方登录页）。
 *
 * ⚠️ 必须只放行 http / https：这个值最终会变成设置页里的 `<a href>`，
 *    能写 `javascript:alert(1)` 进来就是个 XSS 口子（虽然只有本机能改配置，
 *    但配置文件是明文、会被用户互相分享 —— 别给自己留这种坑）。
 *    太长也拒：>500 字基本只能是粘贴错了。
 */
function cleanSignupUrl(value) {
  const text = String(value ?? '').trim()
  if (text === '') return ''
  if (text.length > 500) return ''
  if (!/^https?:\/\//i.test(text)) return ''
  return text
}

/**
 * 忽略指令表（0.20.1）。
 *
 * 只做最基本的三件事：trim、丢掉空串、去重。**不做格式校验** ——
 * 用户想忽略什么形状的整条消息是他的自由（`#sl` / `/status` / `忽略我` 都合法），
 * 硬套一种正则只会让某天一个新写法静默失效。
 *
 * 上限 50 条：这张表是逐条消息比对的，几十条已经远超实际需要；
 * 超过基本只能是粘贴错了，截断比让它无限长安全。
 */
function cleanIgnoreCommands(value) {
  if (!Array.isArray(value)) return null
  const out = []
  for (const item of value) {
    const text = String(item ?? '').trim()
    if (text === '') continue
    if (out.includes(text)) continue
    out.push(text)
    if (out.length >= 50) break
  }
  return out
}

/**
 * `ARRAY_FIELDS` 的逐字段清洗器。
 *
 * ⚠️ 这是一张**显式登记表**，不是可以省略的细节：元素语义按字段完全不同，
 *    统一按某一种规则过滤必然把别的字段悄悄清空（0.19.2 就是这么坏的）。
 *    新增数组字段时必须在这里登记，否则 applyTunables 会记一条日志并跳过。
 */
const ARRAY_CLEANERS = {
  proactiveTargets: cleanTargetList,
  waterWindows: cleanTimeWindowList,
  // 私聊表只收 private:，群表只收 group: —— 放错表的数据永远匹配不上，
  // 留着只会让用户以为「勾了但没生效」
  voiceTargetsPrivate: (v) => cleanVoiceTargetList(v, 'private'),
  voiceTargetsGroup: (v) => cleanVoiceTargetList(v, 'group'),
  // 0.20.1：忽略指令。跟 waterWindows 一样是纯字符串表，但语义完全不同 ——
  // 这里只做「trim + 去空 + 去重 + 限长」，**不做任何格式校验**：
  // 用户的忽略指令可能是 `#sl`、`/status`、`忽略我` 任意形状，硬套一种正则就是自找麻烦。
  ignoreCommands: cleanIgnoreCommands
}

/**
 * 把设置页提交的可调参数合并进 config。返回是否有改动。
 *
 * ⚠️ 导出是**为了能被测试直接调用**（tests/save-fields-sim.mjs）。
 *    原来它是模块私有的，于是唯一能测的就是「源码里提没提到某个字段名」——
 *    而 0.19.2 那两个「保存了但没存上」的 bug 恰恰是：
 *    字段名提到了、代码语法也对，**只是清洗逻辑把值全过滤掉了**。
 *    字符串断言抓不到这种，必须真的跑一遍。
 */
export function applyTunables(body) {
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
  // 允许负数的（seed：-1 = 随机）
  for (const key of SIGNED_NUMERIC_FIELDS) {
    if (body[key] === undefined) continue
    const value = Number(body[key])
    if (Number.isFinite(value)) {
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
    // 链接要过协议白名单（只放行 http/https），不能直接 trim 了事
    if (key === 'voiceSignupUrl') {
      config[key] = cleanSignupUrl(body[key])
      changed = true
      continue
    }
    config[key] = body[key].trim()
    changed = true
  }
  for (const key of ARRAY_FIELDS) {
    if (body[key] === undefined) continue
    // ⚠️ 每个数组字段的**元素语义都不一样**，必须逐个指定清洗函数。
    //
    // 0.19.2 这里是个三元表达式：`proactiveTargets` 走 cleanTargetList，
    // **其余全部**走「时间格式」正则 `^\d{2}:\d{2}-\d{2}:\d{2}$`。
    // 后来加进来的 `voiceTargetsPrivate` / `voiceTargetsGroup` 元素是
    // `private:1321833118` / `group:975663147` —— 永远匹配不上时间格式，
    // 于是**全部被过滤掉**，配置里恒为 `[]`。
    //
    // 表现（用户 2026-11-07 反馈）：勾选「能使用语音的对象」→ 保存 → 重进
    // → 复选框全空。而语音那边的闸门是新语义「空 = 谁都不能用」，
    // 所以**语音直接哑掉**，且没有任何报错。
    //
    // 所以改成一张显式的「字段 → 清洗器」表。以后再往 ARRAY_FIELDS 加字段，
    // 忘了在这里登记就会走到 default 分支**抛错**（而不是被静默过滤成空数组）——
    // 静默失败是本仓库最贵的教训，宁可启动就炸。
    const cleaner = ARRAY_CLEANERS[key]
    if (cleaner === undefined) {
      note('api', `ARRAY_FIELDS 里的 ${key} 没有登记清洗器，已忽略（补 ARRAY_CLEANERS）`)
      continue
    }
    const list = cleaner(body[key])
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
 * 「测一下」用的句子（0.19.0；2026-11-07 起可自定义）。
 *
 * ⚠️ 历史：这句话原来在**三处**各硬编码一遍（tool.js 的工具自测、
 *    本文件的按钮、client.js 的提示文案），注释里写着「改动要三处一起改」。
 *    现在统一由 `resolveVoiceTestText(config)` 解析 ——
 *    读配置 `voiceTestText`，留空回落到 `tool.js` 的 `VOICE_TEST_TEXT`。
 *    后端两处（工具自测 + 按钮）必须同源，否则额度断言会对不上。
 *    `client.js` 那边仍有一份**文案副本**用于「用「xxx」合成一次」的提示，
 *    那是展示用途，不影响行为（见 tests/ui-wiring.mjs 的断言）。
 */

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

/**
 * 「导出配置」的脱敏清单（0.19.6）。
 *
 * ⚠️ 加配置项时**必须回头看这里**：这份 JSON 是给「贴到对话里让人看」用的，
 *    漏一个凭据就是一次真实的泄密（用户的 key 会进聊天记录、进模型上下文）。
 *    宁可多打码几个字段 —— 打码只损失一点诊断力，漏掉是事故。
 */
const SECRET_FIELDS = ['token', 'wsToken', 'voiceBreezeKey']

/** 打码：只告诉「配没配」，不吐任何字符（连长度都不给，长度也是信息）。 */
function maskSecret(value) {
  const text = String(value ?? '').trim()
  return text === '' ? '***未设置***' : '***已设置***'
}

/**
 * 生成「导出配置」的 JSON 文本（0.19.6，用户要求）。
 *
 * 内容取舍的依据：**这个文件是用来诊断「内容发错人 / 不生效」的**，所以
 *   · 全量配置（routes / groupUins / 各档位 / 各名单）—— 这是主证据
 *   · 运行态（版本、pid、bootAt、当前语音模式）—— 判断「装的是不是新版」
 *   · 几条派生事实（绑定表条数、语音名单条数）—— 一眼能对上界面
 * 不放进来的：日志正文（那是另一个按钮）、任何凭据明文。
 *
 * @returns {string} 格式化好的 JSON
 */
function redactConfig() {
  const config = getConfig()
  const safe = {}
  for (const key of Object.keys(config)) {
    if (SECRET_FIELDS.includes(key)) {
      safe[key] = maskSecret(config[key])
      continue
    }
    safe[key] = config[key]
  }
  return safe
}

/**
 * 派生摘要：界面显示「已绑 N 个」时，导出里的数字应该同数。
 * 两个导出入口（/config-export、/diag-export）共用这一份 —— 分开写必然漂移。
 */
function configSummary() {
  const config = getConfig()
  const routes = config.routes ?? {}
  return {
    privateRoutes: Object.keys(routes.private ?? {}).length,
    groupRoutes: Object.keys(routes.group ?? {}).length,
    groupUins: Array.isArray(config.groupUins) ? config.groupUins.length : 0,
    voiceTargetsPrivate: Array.isArray(config.voiceTargetsPrivate) ? config.voiceTargetsPrivate.length : 0,
    voiceTargetsGroup: Array.isArray(config.voiceTargetsGroup) ? config.voiceTargetsGroup.length : 0,
    // 凭据是「配没配」——masked 之后仍能看出这一点，这里再显式给一遍布尔，
    // 免得看的人要自己从 `***已设置***` 里读出来。
    hasToken: String(config.token ?? '').trim() !== '',
    hasWsToken: String(config.wsToken ?? '').trim() !== '',
    hasBreezeKey: String(config.voiceBreezeKey ?? '').trim() !== ''
  }
}

function buildConfigExport() {
  return JSON.stringify({
    schema: 'dsh-onebot-channel/config-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    runtime: runtimeSummary(),
    summary: configSummary(),
    config: redactConfig()
  }, null, 2)
}

/**
 * 诊断包的「DSH 侧日志」扫描（0.19.7，用户问「是不是该搭配导出 DSH 的日志」）。
 *
 * ## 为什么要它（这是回答用户那个问题的落地）
 *
 * QQ 桥自己的日志只能回答「我发给了谁」，回答不了「模型那一回合到底调用了什么工具」。
 * 而这两半凑齐才够定位 —— 比如「qq_send 失败于是自动转发兜底又发一遍」这种，
 * 必须同时看到 `[out] qq_send 调用失败，改走自动转发兜底` 和 DSH 那边 isError:true 的 tool/result。
 *
 * ## 取舍（三条，都是为了别把几 MB 塞进诊断包）
 *
 * 1. **只读今天和昨天**两份 `desktop-next-<YYYY-MM-DD>.0.jsonl`（实测单日能到 4 MB）；
 * 2. **只留 `tool/result` 与 `execute.failed`** —— 工具调用的事实全在这两类，
 *    其余几百条 `log` / `output` 是宿主自己的流水，对排查 QQ 收发没有价值；
 * 3. **只留当前路由表里那些 sessionId 的行**。这条最关键：DSH 日志是全站共用的，
 *    不过滤就会把用户在**别的项目**里的记录一起打包带走 —— 这个文件是要发给别人看的。
 *
 * ⚠️ 任何一步读失败都返回空数组，绝不让整个诊断包失败。
 *
 * @returns {Array<object>} 压平后的事件
 */
function collectDshToolEvents() {
  try {
    const wanted = new Set()
    try {
      const cfg = getConfig()
      for (const route of Object.values(cfg.routes?.private ?? {})) {
        const id = String(route?.sessionId ?? '').trim()
        if (id !== '') wanted.add(id)
      }
      for (const route of Object.values(cfg.routes?.group ?? {})) {
        const id = String(route?.sessionId ?? '').trim()
        if (id !== '') wanted.add(id)
      }
    } catch {
      return []
    }
    if (wanted.size === 0) return []

    const logsDir = join(homedir(), '.dsh', 'logs')
    const days = [0, 1].map((back) => {
      const day = new Date(Date.now() - back * 24 * 60 * 60 * 1000)
      return day.toISOString().slice(0, 10)
    })
    const out = []
    for (const day of days) {
      const file = join(logsDir, `desktop-next-${day}.0.jsonl`)
      if (!existsSync(file)) continue
      let text = ''
      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }
      for (const line of text.split('\n')) {
        // 便宜的前置过滤：没有 sessionId 就没什么可谈的
        if (!line.includes('"sessionId"')) continue
        if (!line.includes('tool/result') && !line.includes('execute.failed')) continue
        let entry = null
        try {
          entry = JSON.parse(line)
        } catch {
          continue // 末尾半行（宿主还在写）跳过
        }
        const fields = entry?.fields ?? {}
        const sessionId = String(fields.sessionId ?? '').trim()
        if (sessionId === '' || !wanted.has(sessionId)) continue
        out.push({
          time: String(entry?.time ?? ''),
          event: String(entry?.event ?? ''),
          sessionId,
          // `tool` 只在 execute.failed 上有；tool/result 宿主不记工具名，留空
          tool: String(fields.tool ?? ''),
          isError: fields.isError === true,
          durationMs: Number(fields.durationMs) || 0,
          // 失败原文有用（「工具不存在」之类），但截断 —— 有的报错带整段栈
          message: String(entry?.error?.message ?? '').slice(0, 300)
        })
      }
    }
    return out
  } catch {
    return []
  }
}

/**
 * 串行化诊断包里的「游标 / 窗口 / 编号表」三节（0.19.7）。
 *
 * 为什么合并成一个函数：这三节读的都是**进程内存里的活状态**，
 * 拆成三个 try/catch 只是让代码变长，降级粒度并不需要更细 ——
 * 任何一节读失败，整体给 null 仍然够诊断（其它节里有版本、配置、日志尾巴）。
 */
function collectRuntimeState() {
  try {
    const state = getState()
    const cursorOf = (bucket) => {
      const out = {}
      for (const [key, value] of Object.entries(bucket ?? {})) {
        out[key] = {
          lastId: Number(value?.lastId) || 0,
          lastSeq: value?.lastSeq === undefined ? null : Number(value.lastSeq),
          lastTime: value?.lastTime === undefined ? null : Number(value.lastTime),
          lastDeliveredSeq: value?.lastDeliveredSeq === undefined ? null : Number(value.lastDeliveredSeq),
          // ⚠️ 只给条数：seenIds 是最近 100 个 message_id。吐出来既没用
          //    （要看的是「去重有没有生效」，不是每个 id），又会撑大包体、把一堆消息编号带出去。
          seenIds: Array.isArray(value?.seenIds) ? value.seenIds.length : 0
        }
      }
      return out
    }
    const windows = {}
    for (const [groupId, win] of Object.entries(state.windows ?? {})) {
      windows[groupId] = {
        // 字段名按 window.js 的 ensureWindowRecord：active / openedAt / repliesInWindow，
        // 不能按「想当然的 open / budget」写 —— 写了也是一片 undefined，看着像没数据。
        active: win?.active === true,
        openedAt: win?.openedAt === undefined ? null : Number(win.openedAt),
        repliesInWindow: Number(win?.repliesInWindow) || 0,
        lastWindowSeq: Number(win?.lastWindowSeq) || 0,
        passStreak: Number(win?.passStreak) || 0,
        triggerUin: String(win?.triggerUin ?? ''),
        // 门控预约（「开窗 @ 还没投完」）在不在，决定批次会不会被挡 ——
        // 「顺序错乱」类故障要看的就是这个
        hasOpeningHold: win?.opening !== undefined && win?.opening !== null,
        pending: Array.isArray(win?.pending) ? win.pending.length : 0
      }
    }
    return {
      privates: cursorOf(state.privates),
      groups: cursorOf(state.groups),
      windows,
      // 焦点只给「指向哪个会话」，label 是用户自己起的名字，带走意义不大但无害
      focus: state.focus ?? {},
      // 编号表（/进度 的「去 3」）只给条数：条目内容是会话 id
      cmdTable: Object.fromEntries(
        Object.entries(state.cmdTable ?? {}).map(([key, value]) => [key, Array.isArray(value?.entries) ? value.entries.length : 0])
      ),
      lastSeenAt: state.lastSeenAt ?? null,
      lastError: state.lastError ?? null
    }
  } catch {
    return null
  }
}

/**
 * 出站队列 + 节奏账本（「内容发错人」直接相关的两节）。
 *
 * 队列深度和队头 target 是判断「是不是排着队发错了」的第一现场；
 * 抑制表能解释「她突然不说话」；最近投递能对上「这次该发给谁」。
 */
function collectOutboundState() {
  try {
    const queues = {}
    for (const [sessionId, queue] of outbound) {
      const head = Array.isArray(queue) && queue.length > 0 ? queue[0] : null
      queues[sessionId] = {
        depth: Array.isArray(queue) ? queue.length : 0,
        head: head === null ? null : {
          createdAt: Number(head.createdAt) || 0,
          ageMs: Math.max(0, Date.now() - (Number(head.createdAt) || 0)),
          target: head.target?.kind === undefined
            ? null
            : { kind: String(head.target.kind), id: String(head.target.id ?? '') },
          userSeq: head.userSeq ?? null,
          cursor: Number(head.cursor) || 0,
          ttlKeeps: Number(head.ttlKeeps) || 0,
          proactive: head.proactive === true
        }
      }
    }
    const cfg = getConfig()
    const routeKeys = []
    for (const key of Object.keys(cfg.routes?.private ?? {})) routeKeys.push({ kind: 'private', id: key })
    for (const key of Object.keys(cfg.routes?.group ?? {})) routeKeys.push({ kind: 'group', id: key })
    const recent = {}
    for (const item of routeKeys) {
      const key = `${item.kind}:${item.id}`
      // 按**会话**查最近投递（0.19.6 起 deliveries 是按 sessionId 记的）。
      // 这里逐个路由反查：先拿这条路绑的会话 id，再问那个会话刚投给了谁。
      const route = cfg.routes?.[item.kind]?.[item.id]
      const sessionId = String(route?.sessionId ?? '').trim()
      if (sessionId === '') continue
      const target = recentDelivery(sessionId)
      if (target !== null) recent[key] = { kind: String(target.kind), id: String(target.id) }
    }
    return {
      queues,
      suppressed: suppressedKeys(),
      recentDelivery: recent
    }
  } catch {
    return null
  }
}

/**
 * 生成诊断包（0.19.7，用户要求「导出日志要带上工具调用」）。
 *
 * 与 /config-export 的分工：
 *   · `/config-export` = 只有配置（小、快、贴进对话就能看）
 *   · `/diag-export`   = 配置 + 运行态 + 队列 + 日志尾巴 + DSH 工具事件（用来复盘）
 * 两边的 config / summary 都走**同一份** redactConfig() / configSummary()，
 * 保证「同一个事实在两份文件里不会不一样」。
 *
 * ⚠️ 每一节独立兜底：任何一节失败都降级成 null，**整个包仍然返回 200**。
 *    这个文件就是在插件已经不正常时用的 —— 让它 500 等于白加。
 */
function buildDiagExport() {
  return {
    schema: 'dsh-onebot-channel/diag-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    runtime: runtimeSummary(),
    summary: configSummary(),
    config: redactConfig(),
    state: collectRuntimeState(),
    outbound: collectOutboundState(),
    log: readLogTailSafely(),
    dshLog: collectDshLogSection(),
    // 2026-11-09（0.21.0）：用户要的「她到底看到了什么」。
    // 光有配置 + 游标 + 插件日志回答不了这个问题 ——
    // 上次「群聊不连贯」的三条根因（上下文没时间戳 / 没她自己 / 接话没进队列）
    // 全在投递正文里，插件日志一条都看不出来。见 diaglog.js。
    conversation: collectConversationSection()
  }
}

/** 对话流水那一节（包一层，读失败也只是空列表）。 */
function collectConversationSection() {
  try {
    return exportDiagLog()
  } catch (error) {
    return {
      note: '读不到对话流水',
      error: error instanceof Error ? error.message : String(error),
      bodies: [],
      tools: []
    }
  }
}

/** DSH 日志那一节（包一层，保证「读不到」也只是个空列表而不是接口失败）。 */
function collectDshLogSection() {
  let events = []
  try {
    events = collectDshToolEvents()
  } catch {
    events = []
  }
  const ids = []
  try {
    const cfg = getConfig()
    for (const route of Object.values(cfg.routes?.private ?? {})) {
      const id = String(route?.sessionId ?? '').trim()
      if (id !== '' && !ids.includes(id)) ids.push(id)
    }
    for (const route of Object.values(cfg.routes?.group ?? {})) {
      const id = String(route?.sessionId ?? '').trim()
      if (id !== '' && !ids.includes(id)) ids.push(id)
    }
  } catch {
    /* 取不到就空列表 */
  }
  return {
    // 口径写明，免得看的人以为「没有事件 = 没调用过工具」
    note: '只含当前绑定会话的 tool/result 与 execute.failed 事件（今天 + 昨天）',
    routeSessions: ids,
    count: events.length,
    // 上限 400：够看出「刚才那几回合调了什么」，又不至于把包撑爆
    events: events.slice(-400)
  }
}

/**
 * 读日志尾巴（只读文件末尾 96 KB，不把整个 8 MB 装进内存）。
 *
 * ⚠️ 读的是**已知常量路径**（LOAD_LOG），不接受任何参数 —— 与 /log-file 同一口径。
 */
function readLogTailSafely() {
  try {
    if (!existsSync(LOAD_LOG)) {
      return { file: 'qq-bridge-load.log', exists: false, bytes: 0, returnedLines: 0, lines: [] }
    }
    const size = statSync(LOAD_LOG).size
    const take = Math.min(size, 96 * 1024)
    if (take <= 0) {
      return { file: 'qq-bridge-load.log', exists: true, bytes: size, returnedLines: 0, lines: [] }
    }
    const buf = readFileSync(LOAD_LOG).subarray(size - take)
    // 从第一个换行开始截，避免半个行
    const start = buf.indexOf(0x0a)
    const text = (start >= 0 ? buf.subarray(start + 1) : buf).toString('utf8')
    const lines = text.split('\n').filter((line) => line !== '')
    return {
      file: 'qq-bridge-load.log',
      exists: true,
      bytes: size,
      returnedLines: lines.length,
      lines: lines.slice(-300)
    }
  } catch (error) {
    return {
      file: 'qq-bridge-load.log',
      exists: false,
      bytes: 0,
      returnedLines: 0,
      lines: [],
      error: error instanceof Error ? error.message : String(error)
    }
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
          // 2026-11-07：句子可自定义（配置 voiceTestText，留空 = 内置那句）。
          // 与 tool.js 的 runVoiceSelfTest 读**同一个**解析函数 ——
          // 否则「按钮测的」和「工具测的」会是两句不同的话，额度也对不上。
          const testText = resolveVoiceTestText(config)
          const chars = billableChars(testText)
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
            synth = await synthesize(testText, { config, engine })
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
          // scope='mine' = 只看账号自己的音色（克隆/设计出来的那几条）。
          // 为什么需要它：search 是按名称/语义匹配的，自己的音色名字里
          // 没有那个词就完全不出结果（实测：搜「少女」时「人鱼大姐姐」不在 52 条里）。
          const scope = body?.scope === 'mine' ? 'mine' : 'all'
          const result = await searchBreezeVoices(key, search, 30, scope)
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
          if (account.ok !== true) {
            // ⚠️ 必须把 timeout 一起吐出去（0.19.5）：前端要能区分
            //    「网络/上游太慢，重试就好」和「key 错了 / 没权限」。
            //    不区分的话用户只看到一句「查不到」，不知道要不要再点一次。
            return sendJson(res, 200, { ok: false, error: account.error, timeout: account.timeout === true })
          }
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
        // 导出日志（0.19.4）：GET 直出字节，浏览器 `<a download>` 就能存下来。
        //
        // 为什么要有它：用户报「分条间隔好像不生效」，而现场只有一份日志能取证。
        // 以前让他自己去 `~/.dsh/` 翻文件 —— 装在云服务器上时那是做不到的
        //（他碰不到那台机器上的文件系统）。所以这里给一个能点一下就下载的出口。
        //
        // ⚠️ 路径是写死的常量（LOAD_LOG），不吃任何 query/param：
        //    这里一旦接受用户给的路径，就等于给了一个任意文件读取入口。
        if (route === '/log-file' && req.method === 'GET') {
          let bytes = null
          try {
            // ⚠️ 用 await readFile 而不是 readFileSync（0.19.5 审核）：日志实测能到 80 万字节，
            //    同步整块读会把 DSH 的事件循环堵住 —— 同一进程里所有 QQ 会话一起卡。
            //    轮转又是**惰性**的（每 256 条 note 才 statSync 一次，见 lib/env.js），
            //    两次检查之间密集发送可以把它顶到数 MB，所以不能假设它小。
            bytes = await readFile(LOAD_LOG)
          } catch (error) {
            // ⚠️ 细节只进日志，不回给浏览器：ENOENT 的原文长这样
            //    `ENOENT: no such file or directory, open 'C:\Users\<用户名>\.dsh\...'`
            //    —— 用户名和安装路径就这么漏进了前端（下载失败时会把 error 显示出来）。
            const message = error instanceof Error ? error.message : String(error)
            note('api', `log-file 读不到：${message}`)
            return sendJson(res, 404, { ok: false, error: '还没有日志文件（跑一会儿再来看）' })
          }
          note('api', `log-file 导出 ${bytes.length} 字节`)
          res.writeHead(200, {
            'content-type': 'text/plain; charset=utf-8',
            'content-length': bytes.length,
            // attachment + 固定文件名：点了就是下载，不会在面板里展开一坨日志。
            'content-disposition': 'attachment; filename="qq-bridge-load.log"',
            'cache-control': 'no-cache'
          })
          res.end(bytes)
          return
        }
        // 导出配置（0.19.6）：用户要求「导出日志时顺带导出当前插件配置」。
        //
        // 为什么需要：0.19.4 那个「内容全发到群里」的 bug，我拿到日志后第一件事是
        // 猜当时的 routes / groupUins / 各档位是什么 —— 而日志里只有「投给了谁」，
        // 没有「当时配的是谁」。少这一半，等于让人对着半张验尸报告猜死因。
        //
        // ⚠️ 必须脱敏：token / wsToken / voiceBreezeKey 是凭据，
        //    这份 JSON 的用途是**发给别人看**（用户会贴给我），原样吐出去等于泄密。
        //    打码成 `***已设置***` / `***未设置***` 既够诊断，又不可用。
        //    （同 /state 的处理：那边是干脆不回传，这边要的是「配没配」这个事实。）
        if (route === '/config-export' && req.method === 'GET') {
          let text = ''
          try {
            text = buildConfigExport()
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            note('api', `config-export 生成失败：${message}`)
            return sendJson(res, 500, { ok: false, error: '导出配置失败，看日志' })
          }
          const bytes = Buffer.from(text, 'utf8')
          note('api', `config-export 导出 ${bytes.length} 字节`)
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': bytes.length,
            'content-disposition': 'attachment; filename="qq-bridge-config.json"',
            'cache-control': 'no-cache'
          })
          res.end(bytes)
          return
        }
        // 诊断包（0.19.7）：用户问「导出日志是不是该搭配导出 DSH 的日志」。
        //
        // 答案是「要，而且就连队列和游标一起带上」。原因：单看 QQ 桥日志只能回答
        // 「我发给了谁」，回答不了「那时候排着几个待发、游标停在哪个 seq、
        // 模型那回合调了什么工具」。而这四样凑齐，才够复盘一次「发错群」。
        //
        // ⚠️ 安全口径与 /log-file /config-export 完全一致：
        //    · 路径全是写死的常量（LOAD_LOG / ~/.dsh/logs/今天+昨天），不吃任何 query/param
        //    · 只认 GET
        //    · 凭据走 redactConfig() 打码，与 /config-export **同一份清单**
        //    · DSH 日志**只留当前绑定会话的行**，不把用户在别的项目里的记录带走
        if (route === '/diag-export' && req.method === 'GET') {
          let text = ''
          try {
            text = JSON.stringify(buildDiagExport(), null, 2)
          } catch (error) {
            // ⚠️ buildDiagExport 内部每一节都兜住了，走到这里说明连装箱都失败 ——
            //    仍然要给一个能下载的文件，而不是让用户对着一个 500 干瞪眼。
            const message = error instanceof Error ? error.message : String(error)
            note('api', `diag-export 生成失败：${message}`)
            text = JSON.stringify({
              schema: 'dsh-onebot-channel/diag-export',
              version: 1,
              exportedAt: new Date().toISOString(),
              runtime: runtimeSummary(),
              error: '诊断包生成失败（各节都取不到），只有版本信息可用'
            }, null, 2)
          }
          const bytes = Buffer.from(text, 'utf8')
          note('api', `diag-export 导出 ${bytes.length} 字节`)
          // 文件名带时间戳：用户一次排查可能导好几份，同名会覆盖
          const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': bytes.length,
            'content-disposition': `attachment; filename="qq-bridge-diag-${stamp}.json"`,
            'cache-control': 'no-cache'
          })
          res.end(bytes)
          return
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
            // 同样不回 ENOENT 原文（含绝对路径与用户名），只给一句人话。
            return sendJson(res, 500, { ok: false, error: '读不到这个语音文件（可能已经被清理了，重新合成一次）' })
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
