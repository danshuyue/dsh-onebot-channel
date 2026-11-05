/**
 * sandbox-guard.mjs —— 破坏性测试的「隔离 HOME」守卫。
 *
 * ## 为什么有这道守卫（2026-11-06 真实事故）
 *
 * `tests/progress-sim.mjs` 的 `reset()` 是破坏性的，它会删除：
 *   - `$HOME/.dsh/sessions/**`                  —— 真实会话日志
 *   - `$HOME/.dsh/storages/session_projcache/**` —— 真实投影缓存
 * 并把 `$HOME/.dsh/storages/workspace.json` 覆盖成一份 **version 1** 的空 fixture。
 *
 * 2026-11-06 00:16，这份测试被**直接执行**（没有经过 run-isolated.mjs 的临时 HOME），
 * 于是真实用户目录被清空：
 *   - 481 个会话 / 493 个日志文件（约 680 MB）被删；
 *   - workspace.json 变成 `{"unit":{"version":1},"tables":{"workspaces":{}}}`。
 *
 * 随后 DSH NEXT 2.0.22（core 0.2.2-rc.1）启动时报：
 *   `StorageError: unit 'workspace': stored version 1 is not accepted by version 2`
 * workspaceRegistry 起不来 → sessionController 一直 pending → 渲染进程
 * `web boot: 1 entry did not activate` → 连续 3 次 reload → 启动失败。
 * 完整时间线与恢复过程：`docs/事故复盘-2026-11-06-测试误删真实DSH目录.md`。
 *
 * ## 守卫规则（防呆，不是防恶意）
 *
 * 1. 必须由 `tests/run-isolated.mjs` 启动，且它设置的 `DSH_TEST_HOME`
 *    必须等于当前 `os.homedir()`；
 * 2. 当前 HOME 下必须有 `.dsh/.dsh-test-sandbox.json` 标记（由 run-isolated 写）；
 * 3. `os.homedir()` 不能等于 `os.userInfo().homedir`。
 *
 * 第 3 条很关键：Windows 上 `os.homedir()` 跟随 `USERPROFILE`，而
 * `os.userInfo().homedir` 来自系统账号本身。只改 `HOME`（或只改一半环境变量）
 * 骗不过它。
 *
 * 未来接手的 agent：如果你看到「已拒绝执行」，**不要绕过**。
 * 这个测试会删真实会话，正确跑法就在报错信息里：
 *   `node tests/run-isolated.mjs tests/progress-sim.mjs`
 * 或 `npm run test:progress`。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join, resolve } from 'node:path'

export const SANDBOX_MARKER = join('.dsh', '.dsh-test-sandbox.json')

function samePath(a, b) {
  const left = process.platform === 'win32' ? String(a).toLowerCase() : String(a)
  const right = process.platform === 'win32' ? String(b).toLowerCase() : String(b)
  return left === right
}

/** run-isolated.mjs（以及 mutation 的临时副本）调用：给隔离 HOME 打标记。 */
export function writeIsolatedTestMarker(home) {
  const dataDir = join(home, '.dsh')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(
    join(dataDir, '.dsh-test-sandbox.json'),
    JSON.stringify({
      home: resolve(home),
      runner: 'tests/run-isolated.mjs',
      pid: process.pid,
      createdAt: new Date().toISOString()
    }) + '\n',
    'utf8'
  )
}

/**
 * 在测试做任何写操作之前调用。不合格时打印说明并以退出码 2 结束。
 * @param {{ testFile?: string }} options
 */
export function assertIsolatedTestHome({ testFile = 'unknown test' } = {}) {
  const home = resolve(homedir())
  const realHome = resolve(userInfo().homedir || process.env.USERPROFILE || home)
  const declared = process.env.DSH_TEST_HOME ? resolve(process.env.DSH_TEST_HOME) : ''
  const markerPath = join(home, SANDBOX_MARKER)
  const problems = []

  if (!declared) problems.push('DSH_TEST_HOME 未设置（说明不是由 tests/run-isolated.mjs 启动的）')
  else if (!samePath(declared, home)) problems.push(`DSH_TEST_HOME=${declared} 与当前 os.homedir()=${home} 不一致`)

  if (samePath(home, realHome)) problems.push(`当前 HOME 就是真实用户目录：${realHome}`)

  if (!existsSync(markerPath)) {
    problems.push(`当前 HOME 下没有隔离标记：${markerPath}`)
  } else {
    try {
      const marker = JSON.parse(readFileSync(markerPath, 'utf8'))
      if (marker.home && !samePath(resolve(marker.home), home)) {
        problems.push(`隔离标记里的 home=${marker.home} 与当前 HOME=${home} 不一致`)
      }
    } catch {
      problems.push('隔离标记无法读取或不是合法 JSON')
    }
  }

  if (problems.length === 0) return

  console.error(`
✗ 已拒绝执行：${testFile}

这个测试是破坏性的：
  - 删除 $HOME/.dsh/sessions/**（真实会话日志）
  - 删除 $HOME/.dsh/storages/session_projcache/**
  - 重写 $HOME/.dsh/storages/workspace.json

它只能跑在 tests/run-isolated.mjs 创建的临时 HOME 里。当前不合格的原因是：
${problems.map((item) => `  - ${item}`).join('\n')}

正确跑法（任选其一）：
  node tests/run-isolated.mjs tests/progress-sim.mjs
  npm run test:progress

事故背景（2026-11-06）：
  有人直接运行这个测试，删掉了真实 ~/.dsh/sessions（481 个会话 / 约 680 MB），
  并把 workspace.json 写成 version 1，导致 DSH NEXT 2.0.22 启动失败。
  复盘：docs/事故复盘-2026-11-06-测试误删真实DSH目录.md

Refusing to run: this destructive test only runs under the isolated HOME created by
tests/run-isolated.mjs. Do not bypass this guard - use the command above.
`)
  process.exit(2)
}
