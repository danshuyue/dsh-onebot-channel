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

// ---- 4. API 暴露的字段必须在 DEFAULTS 里存在（防拼错/防遗漏改名）-----------
const publicBlock = apiSrc.slice(apiSrc.indexOf('export function publicConfig'), apiSrc.indexOf('const NUMERIC_FIELDS'))
const publicKeys = [...publicBlock.matchAll(/^ {4}([A-Za-z][A-Za-z0-9]*):/gm)].map((m) => m[1])
const orphanPublic = publicKeys.filter((k) => !defaultKeys.includes(k))
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

// ---- 6. 每个可写字段都要在设置页里真的有控件 --------------------------------
const clientSrc = read('lib/client.js')
const tunablesBlock = clientSrc.slice(clientSrc.indexOf('setTunables({'), clientSrc.indexOf('})', clientSrc.indexOf('setTunables({')))
const notLoaded = writable.filter((k) => !new RegExp(`\\b${k}:`).test(tunablesBlock))
ok(notLoaded.length === 0, `可写字段都进了设置页的表单状态${notLoaded.length ? '，缺：' + notLoaded.join(', ') : ''}`)

// 字符串数组字段（proactiveTargets）在界面里是「勾选列表」，不是带引号的字段名字面量，
// 所以这里只要求标识符出现过 —— 仍然是「完全没接」级别的看守。
const notRendered = writable.filter((k) => !new RegExp(`\\b${k}\\b`).test(clientSrc))
ok(notRendered.length === 0, `可写字段都渲染出了控件${notRendered.length ? '，缺：' + notRendered.join(', ') : ''}`)

// ---- 7. 刻意不给控件的字段：必须写在白名单里，别静默漏掉 --------------------
const DELIBERATE = {
  routes: '路由表由绑定表格接管',
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
  workspaceCwd: '由会话列表决定，界面只显示',
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
  ['closureEnabled', '判断收尾'],
  ['memoryEnabled', '关系记忆开关'],
  ['backfillOnStart', '上线补历史'],
  ['mergeWindowMs', '合并窗口（标记已读的中间态）'],
  ['mergeMaxWaitMs', '合并上限'],
  ['proactiveEnabled', '主动搭话开关'],
  ['proactiveIdleHours', '主动搭话的空闲门槛'],
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

// ---- 9. 过时文案不再出现 ----------------------------------------------------
ok(!clientSrc.includes('可以在这里给某个号新建会话'), '顶部注释不再声称有「新建会话」')
ok(!clientSrc.includes('新配置下一轮轮询生效'), '保存提示不再说「下一轮轮询生效」')

process.stdout.write(`\n${pass} 过 ${fail} 败\n`)
process.exit(fail === 0 ? 0 : 1)
