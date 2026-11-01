/**
 * 记忆卡（关系持久化）测试：node tests/memory-sim.mjs，退出码 0 = 全过。
 *
 * 这块最关键的两件事：
 *   1. 落盘之后「重启」还认得（重新读文件）
 *   2. 注入正文不会无限膨胀 —— 它是**常驻**的，长度必须钉死，否则每回合烧 token
 *
 * 全程用临时文件，不碰 ~/.dsh/qq-bridge-memory.json。
 */
import { writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { remember, touchPeer, describeMemory, loadMemory, useMemoryFile, flushPersist } from '../lib/memory.js'

/**
 * 临时文件位置：优先 %TEMP%，不行就退到插件目录之外的工作区。
 *
 * 为什么要退：有的机器上 %TEMP% 带拒绝项（实测这台就是），
 * 子进程在 os.tmpdir() 里写文件会被 EPERM 挡住 ——
 * 那是环境问题，不该让一个纯逻辑测试报红，更不该让人误以为是记忆卡坏了。
 */
function scratchDir() {
  const candidates = [tmpdir(), join(dirname(fileURLToPath(import.meta.url)), '..', '..', '.tmp-test')]
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true })
      const probe = join(dir, `.probe-${process.pid}`)
      writeFileSync(probe, 'x')
      rmSync(probe, { force: true })
      return dir
    } catch {
      /* 换下一个 */
    }
  }
  return tmpdir()
}

const TMP = join(scratchDir(), `qq-memory-test-${process.pid}.json`)
useMemoryFile(TMP)
rmSync(TMP, { force: true })

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}`)
  }
}
function eq(actual, expected, name) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, `${name}${same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`)
}

console.log('记忆卡')

// 1. 没有卡
eq(describeMemory('private:1'), '', '没有卡时注入空串')
eq(loadMemory('private:1'), null, '没有卡时 loadMemory 为 null')

// 2. 记一条
remember('private:1', { fact: '喜欢猫' })
eq(loadMemory('private:1').facts.length, 1, '记一条事实')
ok(describeMemory('private:1').includes('喜欢猫'), '事实会出现在注入正文里')

// 3. 去重
remember('private:1', { fact: '喜欢猫' })
eq(loadMemory('private:1').facts.length, 1, '同一句话不重复记')

// 4. 称呼
remember('private:1', { nick: '树树' })
ok(describeMemory('private:1').includes('称呼：树树'), '称呼写进卡里')

// 5. 上限 8 条，挤掉最老的
for (let i = 0; i < 10; i += 1) remember('private:2', { fact: `事实${i}` })
const facts2 = loadMemory('private:2').facts
eq(facts2.length, 8, '一张卡最多留 8 条')
ok(!facts2.some((item) => item.text === '事实0'), '最老的被挤掉')
ok(facts2.some((item) => item.text === '事实9'), '最新的还在')

// 6. 注入长度上限
for (let i = 0; i < 8; i += 1) remember('private:3', { fact: '很长的记忆'.repeat(40) })
const text3 = describeMemory('private:3')
ok(text3.length <= 240, `注入正文有长度上限（实际 ${text3.length} 字）`)

// 7. 自动记：次数 / 时间 / 昵称
touchPeer('private:4', { nick: '小明' })
touchPeer('private:4', {})
const card4 = loadMemory('private:4')
eq(card4.count, 2, 'touchPeer 累计说话次数')
ok(Number(card4.lastSeen) > 0, 'touchPeer 记最后说话时间')
eq(card4.nick, '小明', 'touchPeer 记下昵称')

// 8. 群的卡用「关于这个群」
remember('group:9', { fact: '喜欢聊技术' })
ok(describeMemory('group:9').includes('关于这个群'), '群的卡用「关于这个群」')

// 9. 真的落盘了（写节流：需要先 flush）
flushPersist()
ok(existsSync(TMP), '关系卡真的写到磁盘')

// 10. 文件读坏不崩（不清空、不抛错）
writeFileSync(TMP, '{这不是 JSON', 'utf8')
useMemoryFile(TMP)
eq(describeMemory('private:1'), '', '文件读坏时不崩、按空处理')

console.log(`\n${passed} 过 / ${failed} 败`)
rmSync(TMP, { force: true })
process.exit(failed === 0 ? 0 : 1)
