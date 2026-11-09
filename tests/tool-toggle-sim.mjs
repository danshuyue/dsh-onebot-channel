/**
 * tool-toggle-sim.mjs —— 工具箱分档开关（0.17.4）。
 *
 * 钉住的东西：**关掉的那一档必须完全不出现**。
 *
 * 为什么这条值得单独一个测试文件（这是本功能唯一的真风险）：
 *   关掉一档是为了省 token。但如果关掉之后，还有任何一段**模型会读到的文字**
 *   指向那个没注册的工具，模型就会去调它 → 宿主返回 UNKNOWN_TOOL → 模型换个写法再试。
 *   于是「关掉省 token」变成「关掉更烧 token」，正好反了。
 *
 * 这种字一共有三条来源，三条都要断言：
 *   ① description（qq_send 那段最长，里面原本提了 qq_face_pick / qq_emoji_search /
 *      qq_face_rename / qq_skip / qq_wait / qq_close / qq_pass 六个工具）
 *   ② parameters 里每个参数的 description（custom_emoji / voice）
 *   ③ **失败路径上的报错**（render 的系统提示、execute throw 的 message）
 *      —— 第三条最隐蔽：平时测试跑不到，只有模型调错时才被抛回给它看。
 *
 * 隔离：纯假 ctx，不碰真宿主、不读写 ~/.dsh（config.js 的 loadConfig 只在用到时读）。
 */
const { registerSendTool, registerEmojiSearchTool, registerCollectTool, registerFacePreviewTool, registerFacePickTool, registerFaceRenameTool, registerWaitTool, registerPassTool, registerSkipTool, registerCloseTool, registerPokeTool, registerVoiceTool } = await import('../lib/tool.js')
const { normalizeToolFeatures, TOOL_FEATURE_DEFAULTS, DEFAULTS } = await import('../lib/config.js')

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.error(`  ✗ ${name}`) }
}

/** 每一档包含哪些工具 —— 这是「注册了什么」的唯一真相源。 */
const TIERS = {
  silence: ['qq_wait', 'qq_pass', 'qq_skip', 'qq_close'],
  emoji: ['qq_emoji_search', 'qq_face_pick', 'qq_face_preview', 'qq_face_rename', 'qq_collect_face'],
  voiceIn: ['qq_voice'],
  // 发送语音不是独立工具，是 qq_send 的 voice 参数
  voiceOut: [],
  poke: ['qq_poke']
}

const ALL_TOOL_FNS = [
  [registerEmojiSearchTool, 'emoji'], [registerCollectTool, 'emoji'],
  [registerFacePreviewTool, 'emoji'], [registerFacePickTool, 'emoji'],
  [registerFaceRenameTool, 'emoji'],
  [registerWaitTool, 'silence'], [registerPassTool, 'silence'],
  [registerSkipTool, 'silence'], [registerCloseTool, 'silence'],
  [registerPokeTool, 'poke'], [registerVoiceTool, 'voiceIn']
]

/**
 * 照 index.js 的注册逻辑跑一遍，返回 { tools: Map(name→def), registered: [name...] }。
 * ⚠️ 这里刻意**复刻** index.js 的 if 分支，而不是 import 它 ——
 *   index.js 的 apply 要拉起一整套宿主服务，测试不该需要宿主。
 *   代价是分支写了两份（见下面第 8 节的一致性断言）。
 */
async function boot(features) {
  const regs = []
  const ctx = {
    get: (name) => (name === 'tools'
      ? { register: (def) => { regs.push(def); return () => {} } }
      : (name === 'attachments' ? { saveImages: async () => [] } : undefined)),
    effect: () => {}
  }
  await registerSendTool(ctx, undefined, { features })
  for (const [fn, tier] of ALL_TOOL_FNS) {
    if (features[tier] === true) await fn(ctx, undefined)
  }
  return { tools: new Map(regs.map((def) => [def.name, def])), registered: regs.map((def) => def.name), regs }
}

/** 一段工具定义里**模型能读到**的全部文字（description + 每个参数的描述）。 */
function readableText(def) {
  const parts = [String(def.description ?? '')]
  for (const [, prop] of Object.entries(def.parameters?.properties ?? {})) {
    parts.push(String(prop?.description ?? ''))
  }
  return parts.join('\n')
}

/** 某个工具名是否以「独立标识符」出现在文字里（避免 custom_emoji 之类误判）。 */
function mentions(text, name) {
  return new RegExp(`\\b${name}\\b`).test(text)
}

const ALL_ON = { silence: true, emoji: true, voiceIn: true, voiceOut: true, poke: true }
const DEFAULT = normalizeToolFeatures(undefined)

// ---------------------------------------------------------------------------
console.log('1. 默认配置（沉默权开、其余关）：')
{
  ok(DEFAULT.silence === true, '沉默权默认开')
  ok(DEFAULT.emoji === false && DEFAULT.voiceIn === false && DEFAULT.voiceOut === false && DEFAULT.poke === false,
    '表情包 / 语音识别 / 发送语音 / 戳一戳 默认关')

  const { registered, tools } = await boot(DEFAULT)
  ok(registered.length === 5, `默认只注册 5 个工具（实际 ${registered.length}：${registered.join(' ')})`)
  ok(tools.has('qq_send'), 'qq_send 永远注册')
  for (const name of ['qq_wait', 'qq_pass', 'qq_skip', 'qq_close']) {
    ok(tools.has(name), `沉默权开着 → ${name} 注册了`)
  }
  for (const name of ['qq_emoji_search', 'qq_face_pick', 'qq_face_preview', 'qq_face_rename', 'qq_collect_face', 'qq_voice', 'qq_poke']) {
    ok(!tools.has(name), `默认关着的档 → ${name} 没注册`)
  }
}

// ---------------------------------------------------------------------------
console.log('\n2. 全关：只剩 qq_send，且它的文字里不出现任何别的工具名：')
{
  const NONE = { silence: false, emoji: false, voiceIn: false, voiceOut: false, poke: false }
  const { registered, tools, regs } = await boot(NONE)
  ok(registered.length === 1 && registered[0] === 'qq_send', `只注册 qq_send（实际 ${registered.join(' ')})`)

  // ★ 这是本测试的核心：qq_send 的 description 是全仓库最长的一段，
  //   原本在里面点了 6 个工具的名字。全关时**一个都不许留**。
  const text = readableText(tools.get('qq_send')) + String(tools.get('qq_send')?.output?.render ? '' : '')
  const forbidden = ['qq_skip', 'qq_wait', 'qq_close', 'qq_pass', 'qq_face_pick', 'qq_emoji_search',
    'qq_face_rename', 'qq_face_preview', 'qq_collect_face', 'qq_voice', 'qq_poke']
  const leaked = forbidden.filter((name) => mentions(text, name))
  ok(leaked.length === 0, `qq_send 的可读文字里没有任何被关掉的工具名${leaked.length ? `：${leaked.join(', ')}` : ''}`)

  // qq_send 自己的名字当然要在（否则连它自己都不提了）
  ok(mentions(text, 'qq_send') || regs.length === 1, 'qq_send 自身仍然可用')
}

// ---------------------------------------------------------------------------
console.log('\n3. 关掉表情包 → qq_send 不再指向表情工具（耦合点 2）：')
{
  const features = { silence: true, emoji: false, voiceIn: false, voiceOut: false, poke: false }
  const { tools } = await boot(features)
  const send = tools.get('qq_send')
  const text = readableText(send)

  ok(!mentions(text, 'qq_face_pick'), 'description 里没有 qq_face_pick（原 4 处指路话术）')
  ok(!mentions(text, 'qq_emoji_search'), 'description 里没有 qq_emoji_search')
  ok(!mentions(text, 'qq_face_rename'), 'description 里没有 qq_face_rename（:79 那处容易漏）')
  ok(!mentions(text, 'qq_face_preview'), 'description 里没有 qq_face_preview')
  ok(!mentions(text, 'qq_collect_face'), 'description 里没有 qq_collect_face')

  // 经典小表情仍然可用（它不是表情包档的东西），所以常用清单要留着
  ok(text.includes('呲牙'), '经典小表情的常用清单还在（emoji 参数没被连坐）')
  ok(mentions(text, 'emoji') || String(send.parameters?.properties?.emoji?.description ?? '') !== '',
    'emoji 参数仍然保留')

  // custom_emoji **整参数移除**（2026-11-05 审计推翻了初版的「保留 + 警告」方案）
  //
  // ⚠️ 初版断言的是「参数保留、只去掉指路话术」。审计员实测推翻了它：
  //   `findCustomFace` 是**单字部分命中就给分**，所以猜「好」会匹配到
  //   「这是你的私人癖好」并**静默发出去**；8 个常见单字里 5 个是「猜中但猜错」，且不报错。
  //   初版注释里「猜不中只会白费一次调用」是错的 —— 猜不中不会发生，发生的是猜错还发出去。
  //   往 QQ 发一张错的表情包比少发一张严重得多，用户还完全看不出这是猜的。
  //   所以表情包档关掉时，这个参数**不该出现在 schema 里**。
  const props = send.parameters?.properties ?? {}
  ok(props.custom_emoji === undefined,
    '★ 表情包关掉时 custom_emoji 从 schema 移除（不留盲猜窄口：实测猜错会静默发出错误表情）')
  ok(props.emoji !== undefined, '但 emoji（经典小表情）仍在 —— 它不依赖收藏夹，不该被连坐')
}

console.log('\n4. 开着表情包 → 指路话术回来：')
{
  const features = { silence: true, emoji: true, voiceIn: false, voiceOut: false, poke: false }
  const { tools, registered } = await boot(features)
  const text = readableText(tools.get('qq_send'))
  ok(mentions(text, 'qq_face_pick'), 'qq_face_pick 的指路话术在（按情绪挑）')
  ok(mentions(text, 'qq_emoji_search'), 'qq_emoji_search 的指路话术在')
  ok(mentions(text, 'qq_face_rename'), 'qq_face_rename 的指路话术在')
  for (const name of TIERS.emoji) ok(registered.includes(name), `表情包档开着 → ${name} 注册了`)
}

// ---------------------------------------------------------------------------
console.log('\n5. 关掉发送语音 → schema 里没有 voice 这个键：')
{
  const features = { silence: true, emoji: false, voiceIn: false, voiceOut: false, poke: false }
  const { tools } = await boot(features)
  const props = tools.get('qq_send').parameters?.properties ?? {}
  // ⚠️ 不能是「留着参数、调用时报错」—— 那会让模型反复试、白烧 token
  ok(!Object.prototype.hasOwnProperty.call(props, 'voice'), 'parameters.properties 里没有 voice 键')
  ok(readableText(tools.get('qq_send')).indexOf('语音') < 0 || !mentions(readableText(tools.get('qq_send')), 'voice'),
    'description 里也不再出现 voice 参数名')
}
{
  const features = { silence: true, emoji: false, voiceIn: false, voiceOut: true, poke: false }
  const { tools } = await boot(features)
  const props = tools.get('qq_send').parameters?.properties ?? {}
  ok(Object.prototype.hasOwnProperty.call(props, 'voice'), '打开发送语音 → voice 键回到 schema 里')
  ok(String(props.voice?.description ?? '').includes('语音产物目录'), 'voice 的描述说明只允许专用目录')
}

// ---------------------------------------------------------------------------
console.log('\n6. 关掉沉默权 → qq_send 不再指向沉默四件套：')
{
  const features = { silence: false, emoji: false, voiceIn: false, voiceOut: false, poke: false }
  const { tools } = await boot(features)
  const text = readableText(tools.get('qq_send'))
  for (const name of ['qq_skip', 'qq_wait', 'qq_close', 'qq_pass']) {
    ok(!mentions(text, name), `沉默权关着 → 不出现 ${name}`)
  }
  // 但「正文会被自动转发」这条必须留着：它是唯一还能防止「写分析被发出去」的说明
  ok(text.includes('自动转发'), '仍然说明了「没调工具时正文会被自动转发」')
  ok(text.includes('一个字都别写'), '给了关掉沉默权时唯一的静默办法（不写正文）')
}
{
  const features = { silence: true, emoji: false, voiceIn: false, voiceOut: false, poke: false }
  const { tools } = await boot(features)
  const text = readableText(tools.get('qq_send'))
  for (const name of ['qq_skip', 'qq_wait', 'qq_close', 'qq_pass']) {
    ok(mentions(text, name), `沉默权开着 → 提到 ${name}`)
  }
}

// ---------------------------------------------------------------------------
console.log('\n7. 失败路径上的报错也不能悬空（最隐蔽的一条）：')
{
  // render：收藏表情没匹配上时的 [系统] 提示，原本直接叫模型「先调 qq_face_pick」
  const off = await boot({ silence: true, emoji: false, voiceIn: false, voiceOut: false, poke: false })
  const renderedOff = off.tools.get('qq_send').output.render({}, { message_id: 1, custom_emoji_missed: '委屈' })
    .map((b) => String(b.text ?? '')).join('')
  ok(!mentions(renderedOff, 'qq_face_pick'), 'render 的错误提示里没有 qq_face_pick（表情包关着）')
  ok(renderedOff.includes('委屈'), 'render 仍然说明了是哪个表情没匹配上')

  const on = await boot({ silence: true, emoji: true, voiceIn: false, voiceOut: false, poke: false })
  const renderedOn = on.tools.get('qq_send').output.render({}, { message_id: 1, custom_emoji_missed: '委屈' })
    .map((b) => String(b.text ?? '')).join('')
  ok(mentions(renderedOn, 'qq_face_pick'), '表情包开着时 render 才指路 qq_face_pick')

  // ---- execute 的 throw（另一条失败路径，平时跑不到，最容易漏）----
  // 「只有收藏表情、而收藏夹里没找到」时抛的错，模型会原样读到。
  // 这里把协议端换成假的（收藏夹为空），走到那条 throw。
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ retcode: 0, data: [] }) })
  async function throwOf(features) {
    const { tools } = await boot(features)
    try {
      await tools.get('qq_send').execute({ custom_emoji: '委屈' })
      return ''  // 没抛错 = 行为退化，下面单独断言
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
  const offMsg = await throwOf({ silence: true, emoji: false, voiceIn: false, voiceOut: false, poke: false })
  const onMsg = await throwOf({ silence: true, emoji: true, voiceIn: false, voiceOut: false, poke: false })
  globalThis.fetch = realFetch

  ok(offMsg !== '', '只有表情且没匹配上时真的抛错了（不静默成功）')
  ok(!mentions(offMsg, 'qq_face_pick'), 'execute 的报错里没有 qq_face_pick（表情包关着）')
  ok(mentions(onMsg, 'qq_face_pick'), '表情包开着时 execute 的报错才指路 qq_face_pick')
}

// 面模型会真的读到的另外两处：face-resolve / preview 的报错。
// 它们改成「不点名任何工具」的通用说法 —— 这样无论开关都不悬空，也不用把 features 穿进去。
console.log('\n7b. face-resolve / preview 的报错改成不点名工具的通用说法：')
{
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
  // ⚠️ 先剥掉注释再查：注释里写「关掉之后 qq_emoji_search 根本不存在」
  //   是为了给改代码的人解释原因，**到不了模型眼前**。断言的语义是
  //   「没有任何会被抛给模型的字符串提到那个工具」，所以必须只看代码、不看注释。
  //   （真按原文查会把解释性注释判成缺陷 —— 这条测试自己踩了一次。）
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1')
  const faceResolve = stripComments(readFileSync(join(ROOT, 'lib', 'face-resolve.js'), 'utf8'))
  const preview = stripComments(readFileSync(join(ROOT, 'lib', 'preview.js'), 'utf8'))

  ok(!faceResolve.includes('qq_emoji_search'), 'face-resolve.js 的报错不再提 qq_emoji_search')
  ok(!preview.includes('qq_collect_face'), 'preview.js 的报错不再提 qq_collect_face')
  // 改完要仍然是个可操作的提示，不能只剩一句「错了」
  ok(faceResolve.includes('换用中文名'), 'face-resolve 仍然给了下一步动作（换中文名）')
  ok(preview.includes('现有'), 'preview 仍然报出了现有张数（模型能据此换序号）')
}

// ---------------------------------------------------------------------------
console.log('\n8. normalizeToolFeatures 容错（手改配置不能崩，也不能静默全开）：')
{
  const d = TOOL_FEATURE_DEFAULTS
  ok(JSON.stringify(normalizeToolFeatures(undefined)) === JSON.stringify(d), 'undefined → 全默认')
  ok(JSON.stringify(normalizeToolFeatures(null)) === JSON.stringify(d), 'null → 全默认')
  ok(JSON.stringify(normalizeToolFeatures('yes')) === JSON.stringify(d), '字符串 "yes" → 全默认')
  ok(JSON.stringify(normalizeToolFeatures(42)) === JSON.stringify(d), '数字 → 全默认')
  ok(JSON.stringify(normalizeToolFeatures([true, true])) === JSON.stringify(d), '数组 → 全默认')

  const partial = normalizeToolFeatures({ emoji: true })
  ok(partial.emoji === true, '只给 emoji:true → 该键生效')
  ok(partial.silence === d.silence, '缺的键补默认（silence 仍是默认的 true）')
  ok(partial.poke === false, '缺的键补默认（poke 仍是 false）')

  // 字符串 "true" 不是布尔，必须当「不认识」→ 回默认（而不是被 truthy 判成开）
  ok(normalizeToolFeatures({ emoji: 'true' }).emoji === false, 'emoji:"true"（字符串）不被当成开')
  ok(normalizeToolFeatures({ silence: 1 }).silence === true, 'silence:1 不生效，回默认 true')
  ok(normalizeToolFeatures({ emoji: null }).emoji === false, 'emoji:null 回默认')

  // 多传的键不落进配置（防前端版本不一致时写入垃圾）
  const extra = normalizeToolFeatures({ emoji: true, bogus: true })
  ok(!Object.prototype.hasOwnProperty.call(extra, 'bogus'), '不认识的键被丢掉')
}
console.log('\n8b. DEFAULTS 里的 toolFeatures 就是默认值本身：')
{
  ok(JSON.stringify(DEFAULTS.toolFeatures) === JSON.stringify(TOOL_FEATURE_DEFAULTS),
    'DEFAULTS.toolFeatures 与 TOOL_FEATURE_DEFAULTS 一致')
  ok(!Object.prototype.hasOwnProperty.call(TOOL_FEATURE_DEFAULTS, 'send'),
    'qq_send 不在 toolFeatures 里（它不可关，写进来会让人以为关了有用）')
}

// ---------------------------------------------------------------------------
console.log('\n9. 设置页 / 配置项接线：')
{
  const { readFileSync } = await import('node:fs')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
  const clientSrc = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  const apiSrc = readFileSync(join(ROOT, 'lib', 'api.js'), 'utf8')
  const indexSrc = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8')

  ok(clientSrc.includes('renderToolbox'), '设置页有工具箱区块')
  ok(clientSrc.includes('onFeature'), '复选框走嵌套字段的 setter（不是 onField）')
  // ⚠️ 不能只查文件名里有没有「重启 DSH」—— 那个词在 client.js 里不止一处
  //   （停用告警、sync 说明都提到了），变异把工具箱那句改掉它照样绿。
  //   必须钉**工具箱那句本身**。
  ok(clientSrc.includes('改完这一块要') && clientSrc.includes('才生效'),
    '工具箱卡片里写明了「改完这一块要重启 DSH 才生效」')
  // 保存成功的提示也要说明这一层差异，否则跟工具箱那句打架
  ok(clientSrc.includes('要重启 DSH 才生效'), '保存成功的提示也说明了工具箱要重启')
  ok(!clientSrc.includes('已保存，下一轮投递生效（推送链路会自己重连，不用重启）。'),
    '旧的「已保存，下一轮投递生效…不用重启」那句已被换掉（否则与工具箱矛盾）')
  ok(clientSrc.includes('toolSizes'), '字符数来自后端实测（toolSizes），不是手写常量')
  ok(apiSrc.includes('OBJECT_FIELDS'), '后端接受对象型字段')
  ok(apiSrc.includes('toolSchemaSizes'), '后端有实测字符数的函数')
  ok(apiSrc.includes('toolSizes'), '/state 返回实测的字符数')
  ok(!/约 2\.4 万|24000/.test(clientSrc), '设置页没有残留虚报的「2.4 万字符」常量')

  // 注册分支只在 index.js 里有一份真身 —— 这里确认它按 features 分了支
  //
  // ⚠️ 这一组断言在 2026-11-09 修过一次**假绿**（坑 29 的教科书形态）：
  //    原来写的是 `indexSrc.includes('if (features.emoji)')` ——
  //    只证明「这个字符串在文件里出现过」。而 index.js 里有**两处**
  //    `if (features.emoji)`（qq_emoji_search 一处、收藏表情四件套一处），
  //    变异脚本只改坏其中一处时，另一处照样满足断言 → **改坏了却仍然绿**。
  //    这正是 tool-toggle-mutation 的变异 1 一直抓不到东西的原因。
  //
  //    修法：不看「有没有出现过」，而是把每个档的**工具调用**逐个点名，
  //    并且要求每个调用都处在某个 features 分支之后（顺序比较）。
  //    这样改坏任意一处都会让「该工具在分支之后」不成立。
  // 每个表情包工具都必须出现在某个 **features.emoji 分支块内部**（而不是文件里随便哪处）
  //
  // ⚠️ 踩过两次，别再用「比较全局位置」这种写法：
  //   ① 用 indexOf 取工具名 → 命中的是文件开头的 import 行（位置最靠前），恒假；
  //   ② 改用 lastIndexOf 后仍被变异逃掉 —— 因为 index.js 里有**两处**
  //      `if (features.emoji)`（qq_emoji_search 一处、收藏表情四件套一处），
  //      变异只把**第一处**改成 `if (true)`，而工具调用在第二块里，
  //      「工具位置 > 第一个分支位置」照样成立 → 改坏了却仍然绿。
  //
  //   正确判据：对**每个**工具，找到它所在的那个块，再确认**那个块的入口**是
  //   `if (features.emoji)` 而不是 `if (true)`。做法：取工具调用位置之前
  //   **最近一个** `if (` 开头的行为块入口，断言它包含 features.emoji。
  //
  //   ⚠️ 循环必须保证 cursor **严格变小**：第一版写成 `cursor = prevLineStart`，
  //      而 `lastIndexOf('\n', cursor - 1) + 1` 在 cursor 已经是行首时返回同一个值
  //      → cursor 不再前进 → **死循环**（表现为测试进程卡死、被外层超时杀掉，
  //      看起来像「测试跑不完」，很容易误判成别的毛病）。
  for (const tool of ['registerEmojiSearchTool', 'registerCollectTool', 'registerFacePreviewTool', 'registerFacePickTool', 'registerFaceRenameTool']) {
    const at = indexSrc.lastIndexOf(tool)
    // 从调用点往前逐行找最近的 `if (` 行 —— 那就是它所在块的入口
    const lines = indexSrc.slice(0, at).split('\n')
    let entry = ''
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (/^\s*if\s*\(/.test(lines[i])) { entry = lines[i].trim(); break }
    }
    ok(entry.includes('features.emoji'),
      `index.js：${tool} 所在的块由 features.emoji 把守（实际入口：${entry || '没找到'}）`)
  }
  ok(indexSrc.includes('if (features.silence)'), 'index.js：沉默权按开关注册')
  ok(indexSrc.includes('if (features.voiceIn)'), 'index.js：语音识别按开关注册')
  ok(indexSrc.includes('if (features.poke)'), 'index.js：戳一戳按开关注册')
  ok(indexSrc.includes('{ features }'), 'index.js：把 features 传给 registerSendTool')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed > 0 ? 1 : 0)
