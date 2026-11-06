/**
 * session-title-sim.mjs —— 会话列表的标题必须有名字，不能显示 #id（2026-11-06）
 *
 * 用户截图：设置页「绑定会话」下拉里显示 `#43de6086` 而不是会话名。
 *
 * 根因（两条独立缺陷叠加）：
 *   ① `inject` 里没有 `sessionTitle` → serviceOf(ctx,'sessionTitle') 抛
 *      "cannot get property ... without inject" → listLiveSessions 的 titleSvc 为 undefined
 *   ② 活着的会话对象上**没有 title 字段**（标题在投影里，必须问那个服务）
 *   → title 恒空。而扫盘兜底 scanSessionDirs(want) 在 want==='' 时返回空，
 *     workspaceCwd 为空/指向别处时就彻底没得救。
 *   → 前端 sessionLabel 兜底显示 `#` + id 前 8 位。
 *
 * 这个测试钉三件事：
 *   A. inject 里必须有 sessionTitle（少了就静默降级，日志看不出）
 *   B. titleByIdFromDisk 能按 id 找回标题，且**快**（不能整树扫描）
 *   C. listWorkspaceSessions 会对空标题的会话补标题
 *
 * ⚠️ 只在隔离 HOME 下跑：node tests/run-isolated.mjs tests/session-title-sim.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const HOME = mkdtempSync(join(tmpdir(), 'dsh-session-title-'))
const DATA = join(HOME, '.dsh')
mkdirSync(DATA, { recursive: true })
process.env.USERPROFILE = HOME
process.env.HOME = HOME
process.on('exit', () => { try { rmSync(HOME, { recursive: true, force: true }) } catch {} })

writeFileSync(join(DATA, 'qq-bridge.config.json'), JSON.stringify({
  enabled: true, selfUin: '1000000002', peerUin: '1000000001', ownerUin: '1000000001',
  onebotHttp: 'http://127.0.0.1:9/', token: 't', workspaceCwd: '',
  routes: { private: {}, group: {} }, wsEnabled: false, proactiveEnabled: false
}, null, 2), 'utf8')

const PLUGIN = join(import.meta.dirname, '..')
let passed = 0
let failed = 0
function ok(cond, name) {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.error(`  ✗ ${name}`) }
}

// ---- 造一个真的会话日志（zstd 多帧，和宿主写的一样）----
const { zstdCompressSync } = await import('node:zlib')
function makeSessionLog(wsDir, sessionName, title) {
  const dir = join(HOME, '.dsh', 'sessions', wsDir, sessionName)
  mkdirSync(dir, { recursive: true })
  const events = [
    { type: 'user/message', seq: 1, data: { message: { role: 'user', content: [{ type: 'text', text: '随便一句话，不该被当成标题' }] } } },
    { type: 'session/title', seq: 2, data: { title } }
  ]
  // 逐帧压缩（宿主的 v4 日志就是多帧 zstd，插件按帧解）
  const frames = events.map((e) => zstdCompressSync(Buffer.from(JSON.stringify(e) + '\n', 'utf8')))
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames))
  return dir
}

const WS = '--D-test-workspace--'
makeSessionLog(WS, 'session-aaaa1111-0000-0000-0000-000000000001', '这是真正的会话名')

console.log('\nA. inject 里必须有 sessionTitle（缺了会静默降级成 #id）：')
{
  const indexSrc = readFileSync(join(PLUGIN, 'lib', 'index.js'), 'utf8')
  const m = indexSrc.match(/export const inject\s*=\s*\[([^\]]*)\]/)
  ok(m !== null, '能定位到 inject 声明')
  const list = m === null ? '' : m[1]
  ok(list.includes("'sessionTitle'"), "inject 含 'sessionTitle'（否则设置页显示 #id）")
  ok(list.includes("'sessions'"), "inject 仍含 'sessions'")
  ok(list.includes("'agentPresets'"), "inject 仍含 'agentPresets'（冷启动 preset）")
}

console.log('\nB. titleByIdFromDisk 能按 id 找回标题（这是兜底的关键）：')
const title = await import(pathToFileURL(join(PLUGIN, 'lib', 'title.js')).href)
{
  const withPrefix = title.titleByIdFromDisk('session-aaaa1111-0000-0000-0000-000000000001')
  ok(withPrefix === '这是真正的会话名', `带 session- 前缀能查到（实际 ${JSON.stringify(withPrefix)}）`)

  const bare = title.titleByIdFromDisk('aaaa1111-0000-0000-0000-000000000001')
  ok(bare === '这是真正的会话名', `不带前缀也能查到（实际 ${JSON.stringify(bare)}）`)

  ok(title.titleByIdFromDisk('deadbeef-0000-0000-0000-000000000000') === '', '不存在的 id 返回空串')
  ok(title.titleByIdFromDisk('') === '', '空 id 返回空串')
}

console.log('\nC. titleByIdFromDisk 必须快（不能整树扫描，否则 /state 又卡了）：')
{
  // 造 30 个干扰会话，确认查一个 id 的时间不随会话数线性涨太多
  for (let i = 0; i < 30; i += 1) {
    makeSessionLog('--D-other-ws--', `session-filler${String(i).padStart(4, '0')}-0000-0000-0000-00000000000${i % 10}`, `干扰会话 ${i}`)
  }
  const t0 = Date.now()
  for (let i = 0; i < 10; i += 1) title.titleByIdFromDisk('session-aaaa1111-0000-0000-0000-000000000001')
  const perCall = (Date.now() - t0) / 10
  console.log(`  单次耗时约 ${perCall.toFixed(1)}ms（31 个会话的目录树）`)
  ok(perCall < 200, `单次 < 200ms（实际 ${perCall.toFixed(1)}ms）`)
}

console.log('\nD. scanSessionDirs("") 仍然返回空（不能改成全树扫描，那要 8 秒）：')
{
  const empty = title.scanSessionDirs('')
  ok(empty.length === 0, 'want="" 时返回空（全树扫描实测 342 会话 / 8.3 秒，绝不能走那条路）')
  // want 非空时只扫那一个工作区。用一个**绝不会撞上真实目录**的名字
  let one
  try {
    one = title.scanSessionDirs('Z:/no-such-workspace-xyzzy-12345')
  } catch (error) {
    console.log('  scanSessionDirs 抛错:', error.message)
    one = null
  }
  ok(Array.isArray(one) && one.length === 0, `不存在的工作区返回空数组而不是抛错（实际 ${one === null ? '抛错' : one.length + ' 项'}）`)
}

console.log('\nE. listWorkspaceSessions 会给空标题的会话补上标题：')
{
  // 造一个「活着的会话」：sessions 服务返回它，但**没有 title 字段**（模拟真实情况）
  const liveId = 'session-aaaa1111-0000-0000-0000-000000000001'
  // ⚠️ 这个会话的 cwd 必须**等于**配置里的 workspaceCwd，否则 listLiveSessions 会按
  //    cwd 把它过滤掉（那不是 bug，是筛选逻辑）。配置是插件自己读的，
  //    所以这里从 getConfig() 拿真实值，而不是硬编码。
  const cfgMod = await import(pathToFileURL(join(PLUGIN, 'lib', 'config.js')).href)
  const wantCwd = String(cfgMod.getConfig().workspaceCwd ?? '')

  const ctx = {
    get(key) {
      if (key === 'sessions') {
        return {
          list: () => [{ header: { id: liveId, cwd: wantCwd, updatedAt: '2026-11-06T00:00:00Z' } }]
        }
      }
      // sessionTitle 故意取不到 —— 复刻「没 inject」那条路
      if (key === 'sessionTitle') throw new Error('cannot get property "sessionTitle" without inject')
      return undefined
    }
  }
  const sessions = await import(pathToFileURL(join(PLUGIN, 'lib', 'sessions.js')).href)
  const list = sessions.listWorkspaceSessions(ctx)
  const found = list.find((s) => s.id === liveId)
  ok(found !== undefined, `会话出现在列表里（列表 ${list.length} 项，workspaceCwd=${JSON.stringify(wantCwd)}）`)
  ok(found !== undefined && found.title === '这是真正的会话名', `标题被补上了（实际 ${JSON.stringify(found?.title)}）`)
  ok(found !== undefined && found.title !== '', '标题不是空串（空串会让前端显示 #id）')
}

console.log(`\n${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
