/**
 * http-config-sim.mjs —— HTTP API 配置入口（0.15.0）的行为看守。
 *
 * 为什么要单测这一条：onebotHttp / token 以前只能手改 JSON，界面上完全没有入口。
 * 现在给了控件，就得保证三件事不被改坏：
 *   1. 地址必须 http(s)://，脏值不能写进配置（写进去 = 主链路直接连不上）
 *   2. token 留空 = 保持原样（前端不回显凭据，空串绝不能覆盖掉真 token）
 *   3. 自动发现读的是 httpServers，不是 wsServers（两套 token 混用会 401）
 *
 * 纯静态解析，不 import 插件模块（import 会拉起 cordis 依赖，测试不该需要宿主）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')

let pass = 0
let fail = 0
function ok(cond, label) {
  if (cond) { pass += 1; process.stdout.write(`✓ ${label}\n`) } else { fail += 1; process.stdout.write(`✗ ${label}\n`) }
}

const apiSrc = read('lib/api.js')
const clientSrc = read('lib/client.js')
const snowSrc = read('lib/snowluma.js')

// ---- 1. state 要把地址吐给前端（token 不能） ----
const publicBlock = apiSrc.slice(apiSrc.indexOf('export function publicConfig'), apiSrc.indexOf('const NUMERIC_FIELDS'))
ok(publicBlock.includes('onebotHttp'), 'state 暴露 onebotHttp 给设置页')
ok(!/^\s+token:/m.test(publicBlock), 'state 不暴露 token 明文')

// ---- 2. 保存：地址校验 + 留空不覆盖 ----
const saveBlock = apiSrc.slice(apiSrc.indexOf("route === '/save'"), apiSrc.indexOf("route === '/detect-ws'"))
ok(saveBlock.includes('onebotHttp'), '/save 接受 onebotHttp')
ok(/\^https\?:\\\/\\\//.test(saveBlock), '/save 校验地址必须以 http(s):// 开头')
ok(saveBlock.includes('400'), '非法地址返回 400 而不是照写')
ok(/body\.token\.trim\(\) !== ''/.test(saveBlock), 'token 留空 = 保持原样（不覆盖已有凭据）')
ok(/body\.onebotHttp\.trim\(\) !== ''/.test(saveBlock), '地址留空 = 保持原样')

// ---- 3. 自动发现：读 httpServers ----
ok(apiSrc.includes("'/detect-http'"), '有 /detect-http 路由')
ok(apiSrc.includes('discoverHttpEndpoint'), '/detect-http 调用 discoverHttpEndpoint')
ok(snowSrc.includes('httpServers'), '自动发现读的是 httpServers')
ok(/export function discoverHttpEndpoint/.test(snowSrc), 'discoverHttpEndpoint 已导出')
// WS 那条不能被顺手改成读 httpServers（两套 token 混用会 401）
ok(snowSrc.includes('wsServers'), 'WS 自动发现仍读 wsServers（没被改坏）')
ok(snowSrc.indexOf('function endpointFromDir') < snowSrc.indexOf('function httpEndpointFromDir'),
  'WS 与 HTTP 是两个独立函数，没有合并')

// ---- 4. 前端：控件、密码框、留空语义 ----
ok(clientSrc.includes('onebotHttp'), '设置页有 HTTP 地址控件')
ok(clientSrc.includes('HTTP token'), '设置页有 HTTP token 控件')
ok(/type: 'password'[\s\S]{0,200}onChange: onField\('token'\)/.test(clientSrc) ||
   /onField\('token'\)[\s\S]{0,200}type: 'password'/.test(clientSrc),
  'HTTP token 是密码框（不明文显示）')
ok(/key === 'token' && String\(tunables\[key\] \|\| ''\) === ''/.test(clientSrc),
  '保存时空 token 被跳过（不误清）')
ok(clientSrc.includes('/detect-http'), '前端能触发 HTTP 自动发现')
ok(clientSrc.includes("['ws', '配置']"), '分区名已从「推送」改成「配置」')
ok(clientSrc.includes('renderConfig'), '配置分区同时挂 HTTP 与 WS 两块')

// ---- 5. 概览要能一眼看出连接地址 ----
ok(/line\('连接'/.test(clientSrc), '概览有「连接」一行')
ok(clientSrc.includes("cfg.onebotHttp"), '概览显示 HTTP 地址')

console.log(`\n${pass} 过 ${fail} 败`)
process.exit(fail === 0 ? 0 : 1)
