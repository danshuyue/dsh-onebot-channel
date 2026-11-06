/**
 * sensitive-breeze-sim.mjs —— 出站内容审计能不能认出 Breeze 的 key（0.19.0）。
 *
 * ## 为什么有这个测试
 *
 * 0.19.0 之前 `sensitive.js` 有个**真实漏洞**，是用真实 key 实测发现的：
 *
 *   `brz_AAAA1111BBBB2222CCCC3333DDDD4444`（裸 key）      → 漏
 *   `api key: brz_...`（api 和 key 之间有空格）            → 漏
 *   `API KEY = brz_...`                                   → 漏
 *   `key: brz_...`                                        → 漏
 *   `the api key is brz_...`                              → 漏
 *
 * 两个根因：
 *   ① 关键词正则是 `api[_-]?key`，**不允许中间那个空格** ——
 *      而人写英文时最自然的恰恰是带空格那个；
 *   ② 裸 `brz_xxx` 完全不在特征库里，没有任何关键词可依。
 *
 * 语音功能上线后模型手里就攥着一个 `brz_` key，而它经常在解释
 * 「我在干嘛」时顺嘴写出来 —— 这正是 `sensitive.js` 文件头声明要挡的那件事。
 *
 * ## 为什么还要测「不该命中的」
 *
 * 本文件头明确警告过：表情包文件名是 MD5、图片 URL 全是十六进制串，
 * 加 `/[0-9a-f]{32}/` 这类宽正则会误伤正常消息。
 * 所以这里既测漏（该抓的没抓），也测**误伤**（不该抓的抓了）——
 * 只测漏的测试会把「往正则里塞更多东西」当成进步。
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}${extra ? '　' + extra : ''}`) }
  else { fail += 1; console.log(`  ✗ ${label}${extra ? '　' + extra : ''}`) }
}

const { findSensitive } = await import('../lib/sensitive.js')

// 用真实 key 的形状（不是真 key，但长度/前缀一致）
const KEY = 'brz_AAAA1111BBBB2222CCCC3333DDDD4444'

console.log('\n1. 必须抓住（原来漏的那几种）：')
{
  const mustCatch = [
    ['裸 key', KEY],
    ['api key: 带空格', `api key: ${KEY}`],
    ['API KEY = 大写', `API KEY = ${KEY}`],
    ['key: 单独', `key: ${KEY}`],
    ['the api key is', `the api key is ${KEY}`],
    ['apikey:', `apikey: ${KEY}`],
    ['xi-api-key:', `xi-api-key: ${KEY}`],
    ['sk- 风格', 'sk-abcdefghijklmnopqrstuvwxyz123456'],
    ['中文叙述里夹着它', `我把 api key 配成 ${KEY} 了，你记一下`]
  ]
  for (const [label, text] of mustCatch) {
    const hit = findSensitive(text)
    ok(hit !== null, label, hit === null ? '（没抓到）' : `${hit.kind}`)
    if (hit !== null) ok(hit.kind === 'credential', `${label} → 归类为凭据而不是路径`)
  }
}

console.log('\n1b. `api key`（带空格）这条规则**必须独立存在**：')
{
  // 为什么单独测：`brz_` 形状规则会把带 key 的用例全都接住，
  // 于是「api\s+key 那条正则还在不在」**看起来无关紧要** —— 实测变异验证时
  // 它就是漏网的（删掉之后所有 brz 用例照样绿）。
  // 但那不等于它多余：不带已知前缀的凭据（中转站的自定义 key、别人家的 token）
  // 只有这条能抓。所以这里**必须用不带 brz_/sk- 前缀的串**来测，
  // 否则测的其实是前缀规则，不是空格规则。
  const generic = [
    ['api key: 普通串', 'api key: abcdefg1234567890abcdef'],
    ['API KEY = 大写', 'API KEY = zzzz9999yyyy8888xxxx'],
    ['the api key is', 'the api key is qqqqwwwwEEEERRRR1234'],
    // ⚠️ 下面两条是唯一**只靠「key 单独成词」那条规则**才能命中的形状：
    //    `api key` 会被 `api[_-]?key` 顺手接住（虽然它不匹配空格，
    //    但 `key` 前面的 `api ` 让它变成了独立的 `key`）——
    //    所以只测 `api key` 是测不到那条规则的（变异验证里它一直漏网）。
    ['key: 单独', 'key: abcdefg1234567890abcdef'],
    ['中文「密钥：」', '我的密钥：abc123def456ghi789jkl']
  ]
  for (const [label, text] of generic) {
    const hit = findSensitive(text)
    ok(hit !== null, `⚠️ ${label}（不带已知前缀也要抓）`, hit === null ? '（漏了 —— api\\s+key 规则可能被删）' : hit.kind)
  }
}

console.log('\n2. 不能误伤（正常聊天 / 正常内容）：')
{
  const mustPass = [
    ['普通聊天', '今天天气不错，出去走走吧'],
    ['聊密码概念', '我密码忘了怎么办'],
    ['聊 token 概念', 'token 是什么意思'],
    ['英文 key 概念', 'this key is important to me'],
    ['api key 概念', 'api key 是什么东西'],
    ['voc_ 音色 id', '这个音色 voc_2b6gng7k39k9 挺不错'],
    ['md5 文件名', '3f2a1b4c5d6e7f809a1b2c3d4e5f6071.wav'],
    ['md5 带扩展名', 'd41d8cd98f00b204e9800998ecf8427e.png'],
    ['短 brz 串（不够长）', 'brz_abc 这个词'],
    ['空串', '']
  ]
  for (const [label, text] of mustPass) {
    const hit = findSensitive(text)
    ok(hit === null, label, hit === null ? '' : `误伤为 ${hit.kind}: ${hit.sample}`)
  }
}

console.log('\n3. 原有的路径检测没被改坏：')
{
  ok(findSensitive('我看了 C:\\Users\\x\\.dsh\\qq-bridge.config.json') !== null, 'Windows 路径仍能抓到')
  ok(findSensitive('文件在 /home/user/secret.txt') !== null, 'Unix 路径仍能抓到')
  ok(findSensitive('token=abcdef123456') !== null, '原有「token=值」仍能抓到')
}

console.log('\n4. 打码不泄露原文：')
{
  const hit = findSensitive(`api key: ${KEY}`)
  ok(hit !== null, '抓到了')
  if (hit !== null) {
    ok(!hit.sample.includes(KEY), '⚠️ sample 里**没有**完整 key')
    ok(hit.sample.includes('***'), 'sample 是打过码的')
  }
}

console.log(`\n结果：${pass} 过 / ${fail} 败`)
process.exitCode = fail === 0 ? 0 : 1
