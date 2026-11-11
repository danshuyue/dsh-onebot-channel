/**
 * ui-wiring.mjs —— 设置页与配置项的一致性看守。
 *
 * 为什么要有这条测试：0.7.1 / 0.8.0 加的 replyQuietMs、memoryEnabled、closureEnabled
 * 全都没进设置页，功能在代码里活着、用户却看不见也改不了；同时还留着
 * wsPrivateMergeMs / route.onlyWhenAt 这种「写进去但没人读」的死配置。
 * 人眼对不齐，就让机器每次都对一遍。
 *
 * 纯文本解析，不 import 插件模块（import 会拉起 cordis 依赖，测试不该需要宿主）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

let pass = 0
let fail = 0
function ok(cond, label) {
  if (cond) { pass += 1; process.stdout.write(`✓ ${label}\n`) } else { fail += 1; process.stdout.write(`✗ ${label}\n`) }
}

// ---- 1. 配置默认值里的全部键 ------------------------------------------------
const configSrc = read('lib/config.js')
const defaultsBlock = configSrc.slice(configSrc.indexOf('export const DEFAULTS'), configSrc.indexOf('let config ='))
const defaultKeys = [...defaultsBlock.matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1])
ok(defaultKeys.length > 30, `解析到 ${defaultKeys.length} 个配置默认键`)

// ---- 2. 死配置：解析出来但全代码没人读 --------------------------------------
// 动态列目录 —— 写死文件清单会漏（allowlist.js 就是这么漏掉的，差点误判成死配置）
const libFiles = readdirSync(join(ROOT, 'lib')).filter((f) => f.endsWith('.js'))
const srcOf = (f) => { try { return read(`lib/${f}`) } catch { return '' } }
/** 只看 config.js 之外的文件：config.js 里出现只算「声明」。 */
function referencedOutsideConfig(key) {
  const others = libFiles.filter((f) => f !== 'config.js').map(srcOf).join('\n')
  return new RegExp(`\\b${key}\\b`).test(others)
}
/** 只在 config.js 内部被消费的键（迁移逻辑），不算死配置但也不该算 UI 字段。 */
const CONFIG_INTERNAL_ONLY = ['sessionId', 'groupSessionId']
const deadKeys = defaultKeys
  .filter((k) => !CONFIG_INTERNAL_ONLY.includes(k))
  .filter((k) => !referencedOutsideConfig(k))
ok(!deadKeys.includes('wsPrivateMergeMs'), '退役键 wsPrivateMergeMs 已从默认值里删掉')
ok(deadKeys.length === 0, `没有「有默认值但无人读」的死配置${deadKeys.length ? '：' + deadKeys.join(', ') : ''}`)

// ---- 3. 路由表字段：写进去的必须有消费方 ------------------------------------
const apiSrc = read('lib/api.js')
const routeWrite = apiSrc.slice(apiSrc.indexOf('function normalizeRouteTable'), apiSrc.indexOf('function readBody'))
const routeKeys = [...routeWrite.matchAll(/route\.([A-Za-z][A-Za-z0-9]*)\s*=/g)].map((m) => m[1])
ok(routeKeys.includes('sessionId'), '路由表写入含 sessionId')
ok(!routeKeys.includes('onlyWhenAt'), '路由表不再写死字段 onlyWhenAt')
const deliverSrc = read('lib/deliver.js')
const routeRead = routeKeys.filter((k) => new RegExp(`route\\.${k}\\b`).test(deliverSrc))
ok(routeRead.length === routeKeys.length, `路由表每个写入字段都有消费方（${routeRead.join('/')}）`)

// ---- 3b. prefix 的**作用域**必须跟消费方一致（2026-11-06）--------------------
// prefixOf 全仓库只有 poll.js 的私聊路径调用一次；群头是 poll.js 按发送者身份硬拼的。
// 也就是说 route.prefix 对群聊从来没有消费方。以前的界面却给群表也渲染了输入框，
// 用户填了以为生效 —— 这正是「群聊前缀到底是干什么的」这个问题的来源。
// 光删控件不够：后端要是照存，配置里就留着一个永远不生效的值。两头都得钉住。
// （前端那半边在下面 clientSrc 定义之后再查，见 3c。）
ok(/export function prefixOf[\s\S]{0,400}?\n}/.test(deliverSrc), 'deliver.js 里仍导出 prefixOf')
const prefixCallers = libFiles
  .filter((f) => f !== 'deliver.js')
  .filter((f) => /prefixOf\(/.test(srcOf(f)))
ok(prefixCallers.join(',') === 'poll.js', `prefixOf 只被 poll.js 调用（实际：${prefixCallers.join(',') || '无'}）`)
// 后端：群表不许再收 prefix，私聊表收
ok(/normalizeRouteTable\(body\.routes\.group,\s*false\)/.test(apiSrc), '群聊路由表不再保存 prefix（它没有消费方）')
ok(/normalizeRouteTable\(body\.routes\.private,\s*true\)/.test(apiSrc), '私聊路由表仍保留 prefix')

// ---- 4. API 暴露的字段必须在 DEFAULTS 里存在（防拼错/防遗漏改名）-----------
const publicBlock = apiSrc.slice(apiSrc.indexOf('export function publicConfig'), apiSrc.indexOf('const NUMERIC_FIELDS'))
const publicKeys = [...publicBlock.matchAll(/^ {4}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1])
/**
 * 只读派生字段：publicConfig 里算出来的、**故意不是配置键**的那些。
 *
 * 为什么需要这个名单：下面那条断言原本把「暴露了但不在 DEFAULTS 里」一律当错误 ——
 * 那对拼错的键名是对的，但派生字段会被误判。加派生字段时必须在这里说明理由，
 * 否则就会看到一条红，而那条红的正确解法是「登记」而不是「删掉字段」。
 */
const DERIVED_PUBLIC = {
  // 凭据只回「配没配」，key 本身绝不回传。前端拿它决定输入框的 placeholder。
  voiceBreezeKeySet: '派生自 voiceBreezeKey，只表示「配了没」，不回传 key 本身',
  // 0.23.0：判定模型实际会用哪个。派生自 interestJudge{Provider,Model} + agentOptions，
  // 界面要显示「继承时是什么」，但不该让前端自己推一遍那条回落规则（两处实现迟早不一致）。
  interestJudgeEffective: '派生自 interestJudgeProvider/Model，空值时回落 agentOptions'
}
const orphanPublic = publicKeys
  .filter((k) => !(k in DERIVED_PUBLIC))
  .filter((k) => !defaultKeys.includes(k))
ok(orphanPublic.length === 0, `API 暴露字段都在 DEFAULTS 里${orphanPublic.length ? '，多余：' + orphanPublic.join(', ') : ''}`)

// ---- 5. 可写字段的分类表必须都指向真配置 ------------------------------------
function arrayOf(name) {
  const start = apiSrc.indexOf(`export const ${name} = [`)
  const block = apiSrc.slice(start, apiSrc.indexOf(']', start))
  return [...block.matchAll(/'([A-Za-z][A-Za-z0-9]*)'/g)].map((m) => m[1])
}
const writable = [
  ...arrayOf('NUMERIC_FIELDS'),
  ...arrayOf('BOOLEAN_FIELDS'),
  ...arrayOf('STRING_FIELDS'),
  ...arrayOf('ARRAY_FIELDS'),
  // 枚举字段（splitMode）是对象不是数组，单独取键
  ...[...apiSrc
    .slice(apiSrc.indexOf('export const ENUM_FIELDS'), apiSrc.indexOf('}', apiSrc.indexOf('export const ENUM_FIELDS')))
    .matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1])
]
const bogus = writable.filter((k) => !defaultKeys.includes(k))
ok(writable.length >= 20, `可写字段 ${writable.length} 个`)
ok(bogus.length === 0, `可写字段都是真配置${bogus.length ? '，假的：' + bogus.join(', ') : ''}`)

// ---- 4b. 反向：可写字段必须真的被 publicConfig 暴露 -------------------------
//
// ⚠️ 这条是 0.19.0 装进 profile 之后才补的，起因是一次真实事故：
//    语音那 12 个配置项（voiceMode / voiceEngine / voiceTargets* / voiceDailyChars /
//    voiceBreeze* …）进了 DEFAULTS、也进了设置页，**但忘了进 publicConfig**。
//    后果是「界面能改、改了没用」：前端拿不到初值，后端保存也不落盘。
//    上面那条 4 号断言查的是「暴露的 → 在 DEFAULTS 里」，方向正好相反，抓不到它；
//    而 ui-wiring 当时全绿（105 过 0 败），于是这个洞一路漏到了实机才知道。
//
// 排除项：有正当理由不暴露的键。
const INTENTIONALLY_UNEXPOSED = {
  // 凭据绝不回传 —— 前端只读 voiceBreezeKeySet 这个布尔。见 api.js 的注释。
  voiceBreezeKey: '凭据，绝不回显（前端读 voiceBreezeKeySet 布尔）'
}
{
  const notPublic = writable
    .filter((k) => !(k in INTENTIONALLY_UNEXPOSED))
    .filter((k) => !publicKeys.includes(k))
  ok(notPublic.length === 0,
    `⚠️ 可写字段都在 publicConfig 里（否则界面能改、改了不生效）${notPublic.length ? '，缺：' + notPublic.join(', ') : ''}`)
}

// ---- 6. 每个可写字段都要在设置页里真的有控件 --------------------------------
const clientSrc = read('lib/client.js')

// ---- 3c. prefix 作用域：前端那半边（接 3b，需要 clientSrc）------------------
const tableSrc = clientSrc.slice(clientSrc.indexOf('function renderTable'), clientSrc.indexOf('function onField'))
ok(tableSrc !== '', '能定位到 renderTable 的函数体')
ok(tableSrc.includes("kind === 'private'"), '绑定表按私聊/群聊分流渲染前缀格')
ok(tableSrc.includes('群头自动生成'), '群聊那一格改成了说明文字，不是输入框')
ok(tableSrc.includes('群聊不需要前缀'), '绑定页写明了「群聊不需要前缀」')
ok(tableSrc.includes('留空 = 用「高级」里的私聊默认前缀'), '私聊前缀说明了自己与全局默认的关系')
// 群聊那一格不能还是 input：以前就是「群表也渲染输入框」造成的假配置。
// 盯的是「群聊分支渲染的是 span」，不是「文件里没有 input」——
// 私聊分支当然还有 input，全文件搜必然误判。
// ⚠️ 窗口要够宽：span 的属性（className/key/title）加起来 300+ 字符，
//    写 {0,200} 会假红（第一次就踩到了）。
const groupBranch = tableSrc.slice(tableSrc.indexOf(": h('span'"), tableSrc.indexOf("}, '群头自动生成')"))
ok(groupBranch !== '', '能定位到群聊那一格的 span 分支')
ok(!groupBranch.includes('qqb-input'), '群聊分支里没有输入框（改成了纯文字说明）')
ok(!groupBranch.includes('setPrefixOf'), '群聊分支不再写 route.prefix')
// 「高级」那张卡：三样叫「前缀」的东西要区分开
ok(clientSrc.includes('这一页有两个「前缀」'), '高级页解释了私聊默认前缀与绑定表前缀的区别')
ok(clientSrc.includes('第三样东西'), '高级页指出「命令前缀」是另一回事，别混')
/**
 * 取 `setTunables({ ... })` 那一整个调用的源码。
 *
 * ⚠️ 原来写的是「从 `setTunables({` 切到它之后第一个 `})`」。
 *    0.23.0 给 `interestPoints` 加了一个 `.map(function (row) { ... })` 之后，
 *    那个内层调用的收尾 `})` 就把切片**提前截断**了 ——
 *    于是排在它后面的十几个新键全被判成「没进表单状态」（假红）。
 *
 * 这个假红的形态很值得记：**切片锚点撞上了新代码里的同形 token**。
 * 修法不是放宽断言（那是把看守拆掉），而是换一个真正稳的判据：
 * 从 `{` 起按**花括号深度**数到回 0，那就是这个对象字面量的结尾。
 * 它仍然是同一个方向的看守（「这些键到底在不在这个调用里」），只是不再脆弱。
 */
function tunablesCallSource(source) {
  const start = source.indexOf('setTunables({')
  if (start < 0) return ''
  let depth = 0
  let seenOpen = false
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') { depth += 1; seenOpen = true; continue }
    if (ch === '}') {
      depth -= 1
      if (seenOpen && depth === 0) return source.slice(start, i + 1)
    }
  }
  return source.slice(start)
}
const tunablesBlock = tunablesCallSource(clientSrc)
ok(tunablesBlock.length > 200, '能按花括号深度定位 setTunables 那一整个调用')
const notLoaded = writable.filter((k) => !new RegExp(`\\b${k}:`).test(tunablesBlock))
ok(notLoaded.length === 0, `可写字段都进了设置页的表单状态${notLoaded.length ? '，缺：' + notLoaded.join(', ') : ''}`)

// 字符串数组字段（proactiveTargets）在界面里是「勾选列表」，不是带引号的字段名字面量，
// 所以这里只要求标识符出现过 —— 仍然是「完全没接」级别的看守。
const notRendered = writable.filter((k) => !new RegExp(`\\b${k}\\b`).test(clientSrc))
ok(notRendered.length === 0, `可写字段都渲染出了控件${notRendered.length ? '，缺：' + notRendered.join(', ') : ''}`)

// ---- 7. 刻意不给控件的字段：必须写在白名单里，别静默漏掉 --------------------
const DELIBERATE = {
  routes: '路由表由绑定表格接管',
  // 0.20.0：被 notifyTarget（三选一）取代，loadConfig 负责把旧值迁进去。
  // 再给它一个控件就是「一个行为两个真相源」—— 界面选「原路」、开关是关的，到底听谁的？
  notifyTurnFailures: '已被 notifyTarget 三选一取代（存量 false 会被迁成 off）',
  token: '凭据，前端不回显也不该可写',
  selfUin: '登录后由 OneBot 报回',
  peerUin: '私聊对象，由路由表取代',
  ownerUin: '本人号，由配置迁移处理',
  sessionId: '旧单路由字段，已迁移进 routes',
  groupSessionId: '旧单路由字段，已迁移进 routes',
  groupUins: '由群路由表自动同步',
  agentOptions: '冷启动的模型选择，属于部署级配置',
  sendApiPort: '本地端口，冲突时才改',
  snowlumaConfigDir: '自动发现用，通常留空',
  requestTimeoutMs: '协议端超时，排障时才动',
  seedOnFirstRun: '首轮是否补历史的行为开关，容易误伤',
  outboundEntryTtlMs: '队列寿命，属内部保护',
  fallbackToLiveSession: '会绕过路由表，故意不给一键开关',
  allowSendToAny: '安全逃生阀，故意只留配置文件',
  wsToken: '凭据，留空即保持原样',
  enabled: '总开关只在加载时读一次，给按钮会误导成即时生效',
  backfillOnStart: '上线补历史，开关在接口暂留',
  qzoneRequireConfirm: '说说发布工具当前未注册，不向设置页暴露无效开关',
  // 0.17.4：toolFeatures 是**对象**，五个子键在设置页是一组复选框（走 onFeature，
  // 不是 onField），所以「顶层键字面量」这套检查抓不到子键 —— 它有自己的断言（8e 节）。
  toolFeatures: '对象型字段，五个子键由「工具箱」区块的复选框组接管（见 8e 节）',
}
const uncovered = defaultKeys
  .filter((k) => !writable.includes(k))
  .filter((k) => DELIBERATE[k] === undefined)
  // wsUrl 这类「有控件、但走 /save 特殊分支（留空不覆盖）」的字段不在三个数组里，也算接好了
  .filter((k) => !new RegExp(`\\b${k}:`).test(tunablesBlock))
ok(uncovered.length === 0, `没有「既不可写又没说明」的配置${uncovered.length ? '：' + uncovered.join(', ') : ''}`)
const staleWhite = Object.keys(DELIBERATE).filter((k) => !defaultKeys.includes(k))
ok(staleWhite.length === 0, `白名单里没有已删除的键${staleWhite.length ? '：' + staleWhite.join(', ') : ''}`)

// ---- 8. 新功能确实挂进了设置页 ----------------------------------------------
for (const [key, label] of [
  ['replyQuietMs', '回复前静默'],
  ['waitMaxMs', '等待上限'],
  ['waitTurnMaxMs', '单回合等待总量'],
  ['closureEnabled', '判断收尾'],
  ['memoryEnabled', '关系记忆开关'],
  ['backfillOnStart', '上线补历史'],
  ['mergeWindowMs', '合并窗口（标记已读的中间态）'],
  ['mergeMaxWaitMs', '合并上限'],
  ['proactiveEnabled', '主动搭话开关'],
  ['proactiveIdleHours', '主动搭话的空闲门槛'],
  ['proactiveIdleMaxHours', '主动搭话的空闲上限（摇号区间）'],
  ['proactiveQuietFrom', '静默时段'],
]) {
  ok(new RegExp(`['"]${key}['"]`).test(clientSrc), `设置页有「${label}」（${key}）`)
}
ok(clientSrc.includes('/memory-clear'), '设置页能一键清空记忆卡')
ok(clientSrc.includes('/proactive-now'), '设置页能手动「现在试一次」主动搭话')

// ---- 8b. 分区导航与「对谁开口」（0.9.1）-------------------------------------
ok(/var TABS = \[/.test(clientSrc), '设置页有功能分区表（TABS）')
for (const id of ['overview', 'binding', 'stance', 'proactive', 'memory', 'ws', 'advanced']) {
  ok(new RegExp(`\\['${id}'`).test(clientSrc), `分区表里有「${id}」`)
}
// 0.15.0：「推送」改名「配置」，HTTP API 也进了这一页
ok(clientSrc.includes("['ws', '配置']"), '「推送」分区已改名「配置」')
ok(clientSrc.includes('HTTP API'), '配置页有 HTTP API 区块')
ok(clientSrc.includes('onebotHttp'), '配置页能改 HTTP 地址')
ok(apiSrc.includes("'/detect-http'"), '后端有 HTTP 自动发现路由')
ok(apiSrc.includes('discoverHttpEndpoint'), '自动发现能读 httpServers')
ok(clientSrc.includes("className: 'qqb-tabs'"), '顶部真的渲染出分区条')
// 一次只挂一块：主 return 里不应再直接铺 renderTable / renderStance 等
ok(clientSrc.includes("tab === 'binding'"), '切分区时按 tab 决定渲染哪一块')
ok(clientSrc.includes('对谁开口'), '主动搭话里有「对谁开口」')
ok(clientSrc.includes('所有已绑私聊') && clientSrc.includes('只对勾选的人'), '两种选人模式都有')
ok(clientSrc.includes('boundPrivateKeys'), '选人名单来自「绑好会话的私聊」')
ok(clientSrc.includes('toggleTarget'), '能单独勾/取消一个人')
ok(clientSrc.includes('对TA试一次'), '每个人都能单独试一次')
ok(apiSrc.includes("body?.only"), '/proactive-now 支持指定对象（only）')
ok(apiSrc.includes('ARRAY_FIELDS'), '后端接受数组型字段（proactiveTargets）')

// ---- 8c. 手动触发要轮转（0.9.2）-------------------------------------------
// 踩过：固定打候选列表第一个，连点三次全发给同一个人，另一个号永远轮不到。
const proactiveSrc = read('lib/proactive.js')
ok(proactiveSrc.includes('orderByStalest'), '候选按「最久没被找过」排序')
ok(proactiveSrc.includes('next'), '状态里给出「下一个轮到谁」')
ok(clientSrc.includes('下一个轮到'), '设置页告诉用户这次打给谁')

// ---- 8d. 分条依据（0.10.0）-----------------------------------------------
// 用户原话：「不是单纯的标点符号切分」—— 说几条要由她自己用换行决定。
ok(defaultKeys.includes('splitMode'), 'splitMode 有默认值')
ok(apiSrc.includes('splitMode'), 'API 暴露并校验 splitMode')
ok(clientSrc.includes('splitMode'), '设置页有「怎么分条」的控件')
ok(clientSrc.includes('按换行分') && clientSrc.includes('按句末标点切'), '两种模式都能选')
const splitSrc = read('lib/split.js')
ok(/mode !== 'paragraph'/.test(splitSrc), 'split.js 里 paragraph 模式不按句号切')
ok(/mode === 'paragraph' \? isPunctOnly/.test(splitSrc), 'paragraph 模式不按字数合并短行')
ok(read('lib/outbound.js').includes("config.splitMode === 'sentence'"), '转发链把 splitMode 传给了切分器')
ok(read('docs/QQ对话说明.md').includes('换行 = 另起一条'), '对话说明里告诉了模型「换行就是分条」')
ok(clientSrc.includes('qqb-warn'), '插件被停用时页面会显式告警')

// ---- 8e. 工具箱分档（0.17.4）：对象字段的子键都要有落点 ---------------
// 前几节按 DEFAULTS 的**顶层键**扫描，toolFeatures 只是一个键，抓不到它的子键；
// 所以这里单独把子键对一遍 —— 漏一个，用户就永远打不开那一档。
//
// ⚠️ 0.19.0 变更：voiceOut 从「工具箱的复选框」挪去了「对话节奏 → 语音模式」四档。
//    它不是被删了（qq_send 的 voice 参数在不在 schema 里仍然看它），
//    而是**真相源换成了 voiceMode**，由 config.js 的 deriveToolFeatures 单向推导。
//    所以这个键的看守方式必须跟着变：查「有没有复选框」会永远红，
//    要查的是「它确实由 voiceMode 推导出来」——那才是现在真正要保证的事。
{
  const FEATURE_KEYS = ['silence', 'emoji', 'voiceIn', 'poke']
  const cfgSrc = read('lib/config.js')
  const defaultsBlock2 = cfgSrc.slice(cfgSrc.indexOf('export const TOOL_FEATURE_DEFAULTS'), cfgSrc.indexOf('export function normalizeToolFeatures'))
  for (const key of FEATURE_KEYS) {
    ok(new RegExp(`^ {2}${key}:`, 'm').test(defaultsBlock2), `TOOL_FEATURE_DEFAULTS 里有 ${key}`)
  }
  // voiceOut 仍然在默认值里（tool.js 的 featuresOf 按它工作），但不该有复选框
  ok(/^ {2}voiceOut:/m.test(defaultsBlock2), 'TOOL_FEATURE_DEFAULTS 里仍有 voiceOut（由 voiceMode 推导）')
  ok(!/row\('voiceOut',/.test(clientSrc), '「工具箱」里**没有** voiceOut 复选框（挪去四档了）')
  // 推导函数存在，且是单向的：从 voiceMode 算出 voiceOut
  ok(cfgSrc.includes('export function deriveToolFeatures'), 'config.js 导出 deriveToolFeatures')
  const deriveBlock = cfgSrc.slice(cfgSrc.indexOf('export function deriveToolFeatures'), cfgSrc.indexOf('export function normalizeToolFeatures'))
  ok(/base\.voiceOut\s*=\s*String\(config\?\.voiceMode/.test(deriveBlock),
    'deriveToolFeatures 从 voiceMode 推 voiceOut（单向，不反向写回）')
  ok(!/config\.voiceMode\s*=/.test(deriveBlock), 'deriveToolFeatures 不反向改写 voiceMode')
  // 子键必须真的接到「工具箱」区块的复选框上（row(...) 的四个参数是 key/标签/说明）
  for (const key of FEATURE_KEYS) {
    ok(new RegExp(`row\\('${key}',`).test(clientSrc), `设置页「工具箱」有 ${key} 的复选框`)
  }
  // 四档必须有控件，且是 radio（select 的 option 塞不下那四句定义）
  ok(/qqb-voice-mode/.test(clientSrc), '设置页有语音四档的 radio 组')
  ok(clientSrc.includes('function renderVoiceModeCard'), '四档有独立的卡片渲染函数')
  for (const mode of ['off', 'passive', 'free', 'active']) {
    ok(new RegExp(`\\['${mode}',`).test(clientSrc), `四档里有 ${mode}`)
  }
  // 嵌套字段必须走自己的 setter —— onField 会把整个对象替换成布尔值
  ok(clientSrc.includes('function onFeature'), '嵌套字段有专用的 onFeature setter')
  ok(!/onChange: onField\('toolFeatures'\)/.test(clientSrc), 'toolFeatures 没有被 onField 直接接管')
  // 后端：对象字段必须单独成类，并在保存时归一化
  ok(apiSrc.includes('OBJECT_FIELDS'), '后端有 OBJECT_FIELDS 这一类')
  ok(/OBJECT_FIELDS\s*=\s*\['toolFeatures'\]/.test(apiSrc), 'OBJECT_FIELDS 里就是 toolFeatures')
  ok(apiSrc.includes('normalizeToolFeatures(body[key])'), '保存时走 normalizeToolFeatures 归一化')
  // 字符数必须实测（不手写）：后端有测量函数、前端消费它
  ok(apiSrc.includes('export async function toolSchemaSizes'), '后端有实测 schema 字符数的函数')
  ok(apiSrc.includes('toolSizes: await toolSchemaSizes()'), '/state 里带实测字符数')
  ok(!/约 2\.4 万|24000|15000 字符/.test(clientSrc), '设置页没有手写的字符数常量')
  // 「改完要重启」必须写在设置页上（工具在 apply 里注册，热改无效）
  ok(clientSrc.includes('改完这一块要'), '工具箱卡片写明了改完要重启才生效')
}

// ---- 9. 过时文案不再出现 ----------------------------------------------------
ok(!clientSrc.includes('可以在这里给某个号新建会话'), '顶部注释不再声称有「新建会话」')
ok(!clientSrc.includes('新配置下一轮轮询生效'), '保存提示不再说「下一轮轮询生效」')

// ---- 10. 余额：配了 key 就自动查，别让人自己想起来点按钮（2026-11-07）-------
//
// 用户反馈「余额查不到」。查下来接口和后端都正常，真正的问题是**观感**：
// 卡片上写着「（点一下查）」，而这张卡只在引擎选中 Breeze 时才渲染
// —— 用户切过去还得自己想起来点那个「刷新」。
// 所以：加载时若 key 已配就自动查一次，占位文案也跟着改成「查询中…」。
{
  ok(clientSrc.includes('if (hasKey) {'), '配了 key 的加载路径里有自动查余额的分支')
  ok(clientSrc.includes("apiPost('/voice-balance', {})"), '自动查余额走的是 /voice-balance')
  // ⚠️ 只查「作为字符串字面量出现」的旧文案，不查注释 ——
  //    注释里会引述旧行为来说明为什么改（那是文档，不是残留）。
  ok(!clientSrc.includes("'（点一下查）'"), '占位文案不再写「（点一下查）」（已经自动查了）')
  // 自动查要静默失败：用户没主动问，弹红字反而像出故障了
  const autoBlock = clientSrc.slice(clientSrc.indexOf('if (hasKey) {'), clientSrc.indexOf('if (hasKey) {') + 1200)
  ok(autoBlock.includes('静默'), '自动查余额失败时保持静默（用户没主动问）')
}

// ---- 11. 语音模式：必须显示「正在生效 vs 已选择」（2026-11-07）--------------
//
// 用户反馈：「语音模式需要重启 dsh 才生效，这会让用户反直觉」。
// 只写一句「要重启」不够 —— 用户改完保存、切出去再回来，看到的是自己刚选的
// 新值，会以为已经生效，然后发现行为没变，于是当成 bug 报上来。
// 所以卡片必须并排显示两个值，不一致时给警告。
{
  ok(clientSrc.includes('activeVoiceMode'), '前端读 runtime.activeVoiceMode（启动时生效的模式）')
  ok(clientSrc.includes('function voiceModeStatus'), '有「正在生效 vs 已选择」的渲染函数')
  ok(clientSrc.includes('重启 DSH 后才会换成'), '不一致时明说「重启后才换」')
  ok(clientSrc.includes('当前模式：'), '一致时也显示「当前模式：X（已生效）」')
  // 后端必须真的捕获启动值，否则前端拿到空串、对比退化成不显示
  const apiSrc2 = readFileSync('lib/api.js')
  ok(apiSrc2.includes('captureBootVoiceMode'), 'api.js 有 captureBootVoiceMode')
  const indexSrc = readFileSync('lib/index.js')
  ok(indexSrc.includes('captureBootVoiceMode(config)'), 'index.js 在 apply 里调了它（否则永远是空串）')
}

// ---- 12. 测试语句可自定义（2026-11-07）--------------------------------------
{
  ok(clientSrc.includes('voiceTestText'), '设置页有「测试语句」控件')
  // 后端两处（工具自测 / 设置页按钮）必须同源，否则「按钮测的」和「工具测的」不是同一句
  const toolSrc = readFileSync('lib/tool.js')
  ok(toolSrc.includes('export function resolveVoiceTestText'), 'tool.js 导出 resolveVoiceTestText')
  ok(readFileSync('lib/api.js').includes('resolveVoiceTestText(config)'), 'api.js 的按钮也用它')
  ok(toolSrc.includes('resolveVoiceTestText(config)'), 'tool.js 的自测也用它')
}

process.stdout.write(`\n${pass} 过 ${fail} 败\n`)
process.exit(fail === 0 ? 0 : 1)
