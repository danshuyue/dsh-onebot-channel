/**
 * 在隔离 HOME 下跑一遍测试：node tests/run-isolated.mjs [测试文件名...]
 *
 * 为什么需要（docs/维护索引.md §4 坑 28）：
 *   多数 sim 会**直接改写真实的** `~/.dsh/qq-bridge.config.json`
 *   （segments-sim / outbound-tool-sim / group-sim / poke-sim …）。
 *   本机沙箱已经把 lib/*.js 和 ~/.dsh 写成只读，所以它们必然 EPERM ——
 *   那不是代码坏了，是「这套测试本来就必须换 HOME 跑」。
 *
 * 这个脚本做的事：
 *   1. 造一个临时 HOME，放一份**够用**的 qq-bridge.config.json
 *      （含 groupUins + routes，否则 openWindow 直接返回 false，群类用例全线崩）
 *   2. 逐个用 `node` 子进程跑指定测试（不给参数 = 跑 package.json 的 test:raw 测试链）
 *   3. 汇总谁红了，退出码 = 红了的个数
 *
 * ⚠️ 子进程输出用**文件重定向**而不是管道：受限环境下管道会 EPERM，
 *   连 stdout 都读不到（见 turn-notice-mutation.mjs 里同一段注释）。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync, closeSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')

/**
 * 挑一个**真的写得进去**的临时根。
 *
 * ⚠️ 不能无脑用 `os.tmpdir()`：在 win_bash / 某些受限终端里它指向一个只读的
 *   每会话目录（`…\dsh-win-bash-\<id>\`），`mkdirSync` 直接 EPERM。
 *    所以逐个试：先系统临时目录，不行就退回工作区的 `.tmp-test/`
 *    （工作区一定可写，而且是本仓库既有的临时目录惯例）。
 */
function pickRoot() {
  const candidates = [
    join(tmpdir(), `qq-bridge-isolated-${process.pid}`),
    join(PLUGIN, '..', '.tmp-test', `qq-bridge-isolated-${process.pid}`)
  ]
  for (const root of candidates) {
    try {
      mkdirSync(root, { recursive: true })
      return root
    } catch {
      // 换下一个
    }
  }
  throw new Error('找不到可写的临时目录（系统临时目录和工作区 .tmp-test 都失败）')
}

const HOME = pickRoot()
const DATA = join(HOME, '.dsh')
mkdirSync(DATA, { recursive: true })

/** 够用的沙箱配置：群、私聊、路由都齐，免得被测模块自己判「未配置」直接跳过。 */
const PEER = 1321833118
const SELF = 3566906627
const GROUP = '975663147'
const SESSION = 'session-isolated-test'

writeFileSync(join(DATA, 'qq-bridge.config.json'), JSON.stringify({
  enabled: true,
  selfUin: SELF,
  peerUin: PEER,
  ownerUin: PEER,
  onebotHttp: 'http://127.0.0.1:3000/',
  token: 'test-token',
  workspaceCwd: '',
  groupUins: [GROUP],
  groupOnlyWhenAt: true,
  routes: {
    private: { [String(PEER)]: { sessionId: SESSION } },
    group: { [GROUP]: { sessionId: SESSION } }
  },
  mergeWindowMs: 0,
  replyQuietMs: 0,
  splitReply: true,
  autoForwardReply: true,
  backfillOnStart: false,
  memoryEnabled: false,
  wsEnabled: false,
  proactiveEnabled: false,
  windowEnabled: true
}, null, 2), 'utf8')

writeFileSync(join(DATA, 'qq-bridge-state.json'), JSON.stringify({
  lastId: 0, lastSeq: 1, lastTime: 1, privates: {}, groups: {}
}, null, 2), 'utf8')

// 默认跑 npm test 那一串（按 package.json 里的顺序，少写死一份清单）
const DEFAULT_TESTS = (() => {
  const pkg = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'))
  const chain = String(pkg.scripts?.['test:raw'] ?? '')
  return [...chain.matchAll(/node\s+(\S+)/g)].map((match) => match[1])
})()

const tests = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_TESTS
if (tests.length === 0) {
  console.error('✗ 没解析到任何测试（package.json 的 test 脚本形状变了？）')
  process.exit(2)
}

function runOne(script) {
  const log = join(HOME, `log-${script.replace(/[\\/]/g, '_')}.txt`)
  let fd
  try {
    fd = openSync(log, 'w')
    execFileSync(process.execPath, [script], {
      cwd: PLUGIN,
      stdio: ['ignore', fd, fd],
      env: {
        ...process.env,
        HOME,
        USERPROFILE: HOME,
        TMPDIR: HOME,
        TEMP: HOME,
        TMP: HOME
      }
    })
    return { ok: true, output: '' }
  } catch (error) {
    let output = ''
    try {
      output = readFileSync(log, 'utf8')
    } catch {
      output = `（读不到输出：${error instanceof Error ? error.message : error}）`
    }
    return { ok: false, output }
  } finally {
    if (fd !== undefined) try { closeSync(fd) } catch { /* 已关 */ }
  }
}

const failed = []
for (const script of tests) {
  const result = runOne(script)
  if (result.ok) {
    console.log(`  ✓ ${script}`)
  } else {
    failed.push({ script, output: result.output })
    console.log(`  ✗ ${script}`)
  }
}

try { rmSync(HOME, { recursive: true, force: true }) } catch { /* 清不掉不算失败 */ }

console.log(`\n${tests.length - failed.length} 过 / ${failed.length} 败`)
for (const item of failed) {
  console.error(`\n===== ${item.script} =====`)
  const lines = item.output.split('\n')
  const marks = lines.filter((line) => line.includes('✗') || /Error:|EPERM|MODULE_NOT_FOUND/.test(line))
  console.error(marks.slice(0, 25).join('\n') || lines.slice(-15).join('\n'))
}
process.exit(failed.length)
