/**
 * apply-gate-sim.mjs —— 启动就绪闸门不能挡住合法的「只配 routes」部署（2026-11-06）
 *
 * 用户报告（Ubuntu，v0.18.8）：WS 参数配得完全正确，状态页却永远显示
 * 「推送未连（轮询兜底）」，日志里一条 [ws] 都没有。
 *
 * 根因：lib/index.js 的 apply() 里那道就绪闸门要求 `Number(config.peerUin) > 0`，
 * 而 peerUin 早就退化成可选别名了（state.js:63 / allowlist.js:63 都是「>0 才加」）。
 * 于是「只配 routes.private、不填 peerUin」这种**合法配置**被判成 config incomplete
 * → 整个入站通路不启动（私聊轮询 / 群轮询 / WS 推送全没有）→ startWs() 永远不可达。
 *
 * 这个测试钉：
 *   A. token 为空时**应该**被挡（这道闸门本身是对的，不能一起删掉）
 *   B. peerUin = 0 但 routes.private 非空时**不能**被挡（本次修的）
 *   C. 被挡时日志要说清「挡掉了什么」，不能只写 config incomplete
 *
 * ⚠️ 只在隔离 HOME 下跑：node tests/run-isolated.mjs tests/apply-gate-sim.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let passed = 0
let failed = 0
function ok(cond, name) {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.error(`  ✗ ${name}`) }
}

const PLUGIN = join(import.meta.dirname, '..')
const indexSrc = readFileSync(join(PLUGIN, 'lib', 'index.js'), 'utf8')

console.log('\nA. 闸门本身：token 为空时必须被挡（这道不能一起删掉）：')
{
  const gateLine = indexSrc.split('\n').find((l) => l.includes('if (config.token ===')) ?? ''
  const gateCode = gateLine.replace(/\/\/.*$/, '').trim()
  ok(gateCode !== '', '能定位到闸门那一行')
  ok(/config\.token === ''/.test(gateCode), `闸门仍然校验 token（实际：${gateCode}）`)
  ok(indexSrc.includes('config incomplete (token)'), '被挡时的日志文案还在')
}

console.log('\nB. 本次修复：闸门**不再**要求 peerUin > 0：')
{
  const gateLine = indexSrc.split('\n').find((l) => l.includes('if (config.token ===')) ?? ''
  const gateCode = gateLine.replace(/\/\/.*$/, '').trim()
  ok(gateLine !== '', '能定位到闸门那一行')
  ok(!/peerUin/.test(gateCode), `闸门那一行没有 peerUin 判断（实际：${gateCode}）`)

  // 反向确认：整个文件里 peerUin 仍然在别处被正常使用（别误删）
  ok(/peerUin/.test(indexSrc), 'index.js 其它地方仍在用 peerUin（只删闸门那一处）')
}

console.log('\nC. 被挡时的日志要说清「挡掉了什么」：')
{
  ok(/config incomplete \(token\) → 未启动轮询\/WS/.test(indexSrc),
    '日志写明「→ 未启动轮询/WS」，不是光一句 config incomplete')
}

console.log('\nD. 行为验证：把闸门条件求值，确认它对各种配置的判断都对：')
{
  // ⚠️ 不要真的调 apply() —— 它内部有探活等待（最长 150 秒）和 waitForTools（10 秒），
  //    在测试里跑会把整条测试链卡死（第一版就这么踩的）。
  // ⚠️ 不要用「宽正则抽表达式」那套 —— 太脆：在第一个 ) 处截断、被行尾注释破坏，
  //    抽错了仍然能求值通过（假绿）。第一版踩了两次。
  //    现在按「整行 + 去注释 + 精确匹配 if (…) {」来抽，且 B 段已经先断言了
  //    「这一行里没有 peerUin」—— 所以这里只在那一刻才求值。
  const gateLine = indexSrc.split('\n').find((l) => l.includes('if (config.token ===')) ?? ''
  const gateCode = gateLine.replace(/\/\/.*$/, '').trim()

  if (/peerUin/.test(gateCode)) {
    // B 段已经报红了，这里不再重复刷同样的错，只留一句说明
    console.log('  闸门里含 peerUin，跳过求值（B 段已报红）')
  } else {
    const condMatch = gateCode.match(/^if \((.*)\)\s*\{$/)
    ok(condMatch !== null, `能从闸门那一行抽出完整条件（实际：${gateCode}）`)
    const expr = condMatch === null ? 'true' : condMatch[1]
    console.log(`  抽取到的条件: ${expr}`)

    const evaluate = (config) => {
      try {
        // eslint-disable-next-line no-new-func
        return Boolean(new Function('config', `return (${expr})`)(config))
      } catch (error) {
        return `求值失败: ${error.message}`
      }
    }

    // 用户报告里那台机器的形态：token 有，peerUin 是 0，routes.private 有人
    ok(evaluate({ token: 'test-token', peerUin: 0, routes: { private: { 1321833118: {} } } }) === false,
      '「只配 routes、peerUin=0」放行（false = 不拦）')
    ok(evaluate({ token: '', peerUin: 0 }) === true, 'token 为空时仍然拦（闸门本身没被删）')
    ok(evaluate({ token: 'test-token', peerUin: 1321833118 }) === false, 'token + peerUin 都配了也放行')
  }
}
