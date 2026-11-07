/**
 * workspace-picker-mutation —— 变异验证：把实现改坏，确认测试真的会红。
 *
 * 为什么必须做（docs/维护索引.md §4 坑 27）：
 *   「写完一条断言，就把对应实现改坏再跑一遍，确认它变红。」
 *   这个功能尤其危险 —— 它的失败形态就是「什么都没发生」：
 *   路径写死 → 会话列表空 → 界面上没有任何报错。
 *   一个只会绿的测试在这里等于零保护。
 *
 * ⚠️ 子进程 stdout **必须重定向到文件**而不是管道：
 *   受限环境下 stdio:'pipe' 会 EPERM，读到 0 字节，
 *   现象是「变异一个都没被抓住」——看着像测试假绿，其实是没跑起来（坑 28）。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, closeSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeIsolatedTestMarker } from './sandbox-guard.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = join(HERE, '..')

function pickRoot() {
  for (const root of [
    join(tmpdir(), `wsp-mut-${process.pid}`),
    join(PLUGIN, '..', '.tmp-test', `wsp-mut-${process.pid}`)
  ]) {
    try { mkdirSync(root, { recursive: true }); return root } catch { /* next */ }
  }
  throw new Error('没有可写的临时目录')
}

const ROOT = pickRoot()
mkdirSync(ROOT, { recursive: true })

/**
 * 每个变异一个**独立的 HOME**。
 *
 * ⚠️ 不能共用一个：`workspace-picker-sim.mjs` 的第 11 段会往
 * `~/.dsh/qq-bridge.config.json` 里写死路径、改坏 JSON，跑完就留在那儿了。
 * 下一个变异在同一份 HOME 上启动时，`loadConfig()` 读到的就是上一轮的残留 ——
 * 表现是「改坏的代码照样绿 / 没改坏的反而红」，看日志完全对不上号。
 * 单跑一遍有时是绿的，跑整串必红，最容易被误判成「测试本身坏了」。
 */
function makeHome(tag) {
  const home = join(ROOT, `home-${tag}`)
  mkdirSync(join(home, '.dsh', 'storages'), { recursive: true })
  writeIsolatedTestMarker(home)
  return home
}

/** 复制一份插件（只复制跑测试需要的部分），每次变异都在副本上改。 */
function makeCopy(tag) {
  const dir = join(ROOT, `copy-${tag}`)
  cpSync(PLUGIN, dir, {
    recursive: true,
    filter: (src) => !src.includes('node_modules') && !src.includes('.git') && !src.includes('.tmp-test')
  })
  return dir
}

/**
 * 跑一次测试，返回 { ok, output }。
 * 输出走文件重定向 —— 管道在受限环境会 EPERM（坑 28）。
 */
function runTest(copyDir, testRel, home) {
  const log = join(home, `log-${Math.random().toString(36).slice(2)}.txt`)
  let fd
  try {
    fd = openSync(log, 'w')
    execFileSync(process.execPath, [join(copyDir, testRel)], {
      cwd: copyDir,
      stdio: ['ignore', fd, fd],
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        DSH_TEST_HOME: home,
        TMPDIR: home,
        TEMP: home,
        TMP: home
      }
    })
    closeSync(fd); fd = undefined
    return { ok: true, output: '' }
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* 已关 */ } }
    let output = ''
    try { output = readFileSync(log, 'utf8') } catch { output = '' }
    return { ok: false, output: output || `（读不到输出：${error instanceof Error ? error.message : error}）` }
  }
}

/** 在副本里替换文本（必须真的替换到，否则算「变异没生效」，直接报错）。 */
function patch(copyDir, rel, from, to) {
  const file = join(copyDir, rel)
  const src = readFileSync(file, 'utf8')
  if (!src.includes(from)) throw new Error(`变异没命中：${rel} 里找不到\n${from.slice(0, 200)}`)
  writeFileSync(file, src.replace(from, to), 'utf8')
}

const TEST = 'tests/workspace-picker-sim.mjs'

// ---- baseline：原始代码必须绿 ----------------------------------------------
const baselineDir = makeCopy('baseline')
const baseline = runTest(baselineDir, TEST, makeHome('baseline'))
if (!baseline.ok) {
  console.error('✗ baseline 就红了 —— 后面的变异结论没意义，先把它修绿：\n')
  console.error(baseline.output.split('\n').filter((l) => l.includes('✗') || /Error/.test(l)).slice(0, 20).join('\n'))
  process.exit(1)
}
console.log('✓ baseline 绿（原始代码）')
rmSync(baselineDir, { recursive: true, force: true })

/**
 * 变异清单。每条对应一条**行为断言**，改坏了必须变红。
 * label 说清「还原成什么旧缺陷」，并对齐预期变红的那几条 ——
 * 光看「红了」不够：红的必须是**该条**断言，不能是别的错连坐。
 */
const MUTATIONS = [
  {
    label: 'DEFAULTS 的 workspaceCwd 写回不存在的旧路径（本次缺陷原样）',
    apply: (dir) => patch(dir, 'lib/config.js',
      "workspaceCwd: 'D:\\\\Yansunsky\\\\Desktop\\\\文本\\\\DSHQQ对话',",
      "workspaceCwd: 'D:\\\\DSH workspace\\\\QQ对话',"),
    expect: ['默认值指向真实工作区', '默认值目录在本机真实存在']
  },
  {
    label: '去掉 updatedAt 排序（最近用过的掉到最后）',
    apply: (dir) => patch(dir, 'lib/api.js',
      '    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))\n',
      ''),
    expect: ['按 updatedAt 倒序']
  },
  {
    label: '去掉字段白名单，把注册表原始字段整个吐出去',
    apply: (dir) => patch(dir, 'lib/api.js',
      `    .map((item) => ({
      id: String(item.id ?? ''),
      title: String(item.title ?? ''),
      path: String(item.path ?? ''),
      sessionCount: Array.isArray(item.sessionIds) ? item.sessionIds.length : 0,
      updatedAt: String(item.updatedAt ?? '')
    }))`,
      `    .map((item) => ({ ...item, sessionCount: Array.isArray(item.sessionIds) ? item.sessionIds.length : 0 }))`),
    expect: ['只返回界面用得上的字段']
  },
  {
    label: '删掉「没有 path 就丢掉」的过滤（脏数据漏进下拉框）',
    apply: (dir) => patch(dir, 'lib/api.js',
      "    .filter((item) => item !== null && typeof item === 'object' && String(item.path ?? '') !== '')\n",
      ''),
    expect: ['丢掉没有 path']
  },
  {
    label: '/save 跳过注册表校验，直接接受任何路径（原缺陷）',
    apply: (dir) => patch(dir, 'lib/api.js',
      '                const hit = choices.find((item) => normCwd(item.path) === wanted)',
      '                const hit = { path: raw } /* 变异：不比对注册表 */'),
    expect: ['注册表里没有的路径返回 400']
  },
  {
    label: '/save 把 workspaceCwd 的赋值提到校验之前（非法值先落进单例）',
    apply: (dir) => patch(dir, 'lib/api.js',
      '          let nextWorkspaceCwd\n',
      '          let nextWorkspaceCwd\n          if (typeof body?.workspaceCwd === \'string\') config.workspaceCwd = body.workspaceCwd /* 变异 */\n'),
    expect: ['被拒的值没有落进 config 单例']
  },
  {
    label: 'routes 赋值挪到工作区校验之前（测试抓到的那个真 bug）',
    apply: (dir) => patch(dir, 'lib/api.js',
      '          let nextWorkspaceCwd\n',
      '          // 变异：把 routes 的赋值抢到工作区校验前面\n'
      + '          if (body?.routes !== undefined && typeof body.routes === \'object\') {\n'
      + '            config.routes = { private: normalizeRouteTable(body.routes.private), group: normalizeRouteTable(body.routes.group) }\n'
      + '          }\n'
      + '          let nextWorkspaceCwd\n'),
    expect: ['被拒的请求没有顺手把 routes 也改了（校验必须在所有赋值之前）']
  },
  {
    label: '注册表读不到时直接 400（手填框变成死路）',
    apply: (dir) => patch(dir, 'lib/api.js',
      '              if (choices.length === 0) {',
      '              if (false) {'),
    expect: ['仍然能存']
  },
  {
    label: '注册表读不到的退路不查目录（手滑打错也能存）',
    apply: (dir) => patch(dir, 'lib/api.js',
      '                if (!exists) {',
      '                if (false) {'),
    expect: ['目录不存在 → 仍然拒绝']
  },
  {
    label: '大小写/斜杠不归一化（合法路径被误判成非法）',
    apply: (dir) => patch(dir, 'lib/api.js',
      '                const wanted = normCwd(raw)\n                const hit = choices.find((item) => normCwd(item.path) === wanted)',
      '                const hit = choices.find((item) => item.path === raw) /* 变异：不比 normCwd */'),
    expect: ['大小写/斜杠不同的合法路径能保存']
  },
  {
    label: '落盘用用户传的大小写，而不是注册表里的原始写法',
    apply: (dir) => patch(dir, 'lib/api.js',
      '                nextWorkspaceCwd = hit.path',
      '                nextWorkspaceCwd = raw'),
    expect: ['落盘用注册表里的原始大小写']
  },
  {
    label: '空串被当成「没填」跳过（关不掉工作区筛选）',
    apply: (dir) => patch(dir, 'lib/api.js',
      "              nextWorkspaceCwd = ''\n            } else {",
      '              nextWorkspaceCwd = undefined\n            } else {'),
    expect: ['空串真的写进去了']
  },
  {
    label: '非字符串不拦，改成强转（数字 12345 静默变成路径 "12345"，报错文案还会误导）',
    apply: (dir) => patch(dir, 'lib/api.js',
      "            if (typeof body.workspaceCwd !== 'string') {\n"
      + "              return sendJson(res, 400, { ok: false, error: '工作区必须是路径字符串' })\n"
      + '            }',
      '            body.workspaceCwd = String(body.workspaceCwd ?? \'\') /* 变异：强转 */'),
    expect: ['类型错误的文案说的是「要字符串」']
  },
  {
    label: '/workspaces 路由顺手写盘（只读性被破坏）',
    apply: (dir) => patch(dir, 'lib/api.js',
      '          const list = workspaceChoices()\n          return sendJson(res, 200, { ok: true, workspaces: list })',
      '          const list = workspaceChoices()\n          saveConfig()\n          return sendJson(res, 200, { ok: true, workspaces: list })'),
    expect: ['/workspaces 是只读的']
  },
  {
    label: '前端去掉降级分支（读不到注册表就没有输入框）',
    apply: (dir) => patch(dir, 'lib/client.js',
      '} else if (degraded || wsList.length === 0) {',
      '} else if (false) {'),
    expect: ['注册表读不到时降级成手填输入框']
  },
  {
    label: '选择器从「绑定」页摘掉（功能消失）',
    apply: (dir) => patch(dir, 'lib/client.js',
      '          renderWorkspacePicker(),\n',
      ''),
    expect: ['选择器挂在「绑定」页里']
  },
  {
    label: '普通保存又带上 workspaceCwd（历史非法值会卡住一切保存）',
    apply: (dir) => patch(dir, 'lib/client.js',
      "            if (key === 'workspaceCwd') continue\n",
      ''),
    expect: ['普通保存跳过 workspaceCwd']
  },
  {
    label: '选项 value 改成 title（提交的是名字不是路径，保存必 400）',
    apply: (dir) => patch(dir, 'lib/client.js',
      '              value: item.path,\n              key: item.id || item.path,',
      '              value: item.title,\n              key: item.id || item.path,'),
    expect: ['下拉框的 value 是路径而不是标题']
  },
  {
    label: '底部灰字退回直接拼路径（标题显示丢了）',
    apply: (dir) => patch(dir, 'lib/client.js',
      "'会话来源工作区：' + currentWorkspaceLabel()",
      "'会话来源工作区：' + wantCwd"),
    expect: ['底部那行确实由 currentWorkspaceLabel() 拼出来']
  },
  {
    label: '去掉「换工作区会搬图片目录」的提示（副作用被藏起来）',
    apply: (dir) => patch(dir, 'lib/client.js',
      "'注意：收到的图片副本存在「<工作区>\\\\收到的图片」下，换工作区 = 以后的新图存到新目录，'",
      "''"),
    expect: ['选择器卡片里写明换工作区会搬图片目录']
  },
  {
    label: '选中后不动用选择器那条路、把它塞回普通 save（顺手带上未保存的绑定）',
    apply: (dir) => patch(dir, 'lib/client.js',
      "        apiPost('/save', { workspaceCwd: raw })",
      "        apiPost('/save', payload /* 变异：跟普通保存同一份 payload */)"),
    expect: ['选中后只提交 workspaceCwd 一个字段']
  },
  {
    // 2026-11-06 test-delivery 报、Lead 实测复现的问题：
    // 原断言只查 `tunables.workspaceCwd` 这个子串，而它在 client.js 里出现 3 次，
    // 其中一次是**注释** —— 于是这个变异（功能真回退）之前是漏网的。
    label: 'wantCwd 退回只读 data.config（切换后下拉框停在旧值）',
    apply: (dir) => patch(dir, 'lib/client.js',
      "      var wantCwd = String(\n"
      + "        tunables !== null && tunables !== undefined && typeof tunables.workspaceCwd === 'string'\n"
      + '          ? tunables.workspaceCwd\n'
      + "          : (data.config && data.config.workspaceCwd ? data.config.workspaceCwd : '')\n"
      + '      )',
      "      var wantCwd = String(data.config && data.config.workspaceCwd ? data.config.workspaceCwd : '')"),
    expect: ['当前工作区优先读表单状态']
  },
  // ---- 存量配置自愈（config.js）：只改 DEFAULTS 救不了已有的配置文件 ----
  {
    label: '删掉存量配置自愈（升级后设置页还是 0 个会话，缺陷原样）',
    apply: (dir) => patch(dir, 'lib/config.js',
      '      if (workspaces.length > 0) {',
      '      if (false) {'),
    expect: ['失效路径被改回默认工作区', '自愈结果写回了配置文件']
  },
  {
    label: '自愈时把合法路径也重置（用户选的工作区每次启动都被改掉）',
    apply: (dir) => patch(dir, 'lib/config.js',
      '        if (!hit) {',
      '        if (true) {'),
    expect: ['合法路径原样保留']
  },
  {
    label: '自愈连空串也覆盖（用户主动选的「不筛工作区」被抢走）',
    apply: (dir) => patch(dir, 'lib/config.js',
      "  if (typeof config.workspaceCwd === 'string' && config.workspaceCwd !== '') {\n    try {\n      const { workspaces } = readWorkspaces()\n      if (workspaces.length > 0) {",
      "  if (typeof config.workspaceCwd === 'string') {\n    try {\n      const { workspaces } = readWorkspaces()\n      if (workspaces.length > 0) {"),
    expect: ['空串不被自愈覆盖']
  },
  {
    label: '自愈改成「挑会话最多的那个」（本机会挑到 CreateCMPOR，连带搬走图片目录）',
    apply: (dir) => patch(dir, 'lib/config.js',
      '          const fallback = workspaces.find((item) => normCwd(item.path) === normCwd(DEFAULTS.workspaceCwd))',
      '          const fallback = [...workspaces].sort((a, b) => (b.sessionIds?.length ?? 0) - (a.sessionIds?.length ?? 0))[0]'),
    expect: ['没有挑「会话最多」的那个']
  },
  {
    label: '默认工作区不在注册表时也硬改（乱改到别的工作区）',
    apply: (dir) => patch(dir, 'lib/config.js',
      '          const fallback = workspaces.find((item) => normCwd(item.path) === normCwd(DEFAULTS.workspaceCwd))',
      '          const fallback = workspaces.find((item) => normCwd(item.path) === normCwd(DEFAULTS.workspaceCwd)) ?? workspaces[0]'),
    expect: ['也没有掉进注册表里的第一个工作区']
  },
  {
    label: '自愈只在内存里改、不落盘（重启又变回死路径）',
    apply: (dir) => patch(dir, 'lib/config.js',
      '            config.workspaceCwd = fallback.path\n            saveConfig()',
      '            config.workspaceCwd = fallback.path'),
    expect: ['自愈结果写回了配置文件']
  }
]

let caught = 0
const missed = []
/** 完整结果同时写一份到磁盘 —— run-isolated 只回显过滤后的 ✗ 行，看不到全貌。 */
const REPORT = join(PLUGIN, '..', '.tmp-test', 'workspace-picker-mutation-report.txt')
const report = []
function both(line, isError = false) {
  report.push(line)
  if (isError) console.error(line); else console.log(line)
}
for (const item of MUTATIONS) {
  const dir = makeCopy(`m${caught + missed.length}`)
  const home = makeHome(`m${caught + missed.length}`)
  try {
    item.apply(dir)
  } catch (error) {
    both(`✗ 变异没生效：${item.label}\n  ${error instanceof Error ? error.message : error}`, true)
    missed.push(item.label)
    rmSync(dir, { recursive: true, force: true })
    continue
  }
  const result = runTest(dir, TEST, home)
  if (result.ok) {
    missed.push(item.label)
    both(`✗ 没被抓住：${item.label}`, true)
  } else {
    const reds = result.output.split('\n').filter((line) => line.includes('✗')).map((line) => line.trim())
    const hitExpected = item.expect.some((label) => reds.some((line) => line.includes(label)))
    if (hitExpected) {
      caught += 1
      both(`✓ 抓住：${item.label}`)
      both(`    └─ ${reds.slice(0, 2).join(' / ')}`)
    } else {
      missed.push(`${item.label}（红了但不是预期那几条）`)
      both(`✗ 红的不是预期断言：${item.label}`, true)
      both(`   预期含：${item.expect.join(' / ')}`, true)
      both(`   实际红：${reds.slice(0, 5).join(' / ') || '（没有 ✗ 行）'}`, true)
    }
  }
  rmSync(dir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}

rmSync(ROOT, { recursive: true, force: true })

both(`\n${caught} 个变异被抓住 / ${missed.length} 个漏网`, missed.length > 0)
if (missed.length > 0) {
  both('\n漏网的变异：', true)
  for (const label of missed) both(`  - ${label}`, true)
}

// 报告落盘：run-isolated 只回显过滤后的 ✗ 行，跑了几个变异、抓住几个看不到。
try {
  mkdirSync(join(PLUGIN, '..', '.tmp-test'), { recursive: true })
  writeFileSync(REPORT, report.join('\n') + '\n', 'utf8')
  console.log(`\n（完整报告：${REPORT}）`)
} catch { /* 写不了不算失败 */ }
process.exit(missed.length === 0 ? 0 : 1)
