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

// 11. 原始 JSON 编辑（0.18.6）：读 / 校验 / 保存
{
  const { readMemoryRaw, saveMemoryRaw } = await import('../lib/memory.js')

  // 文件是坏 JSON 时也要能读出来 —— 编辑器的用途之一就是修它
  const broken = readMemoryRaw()
  ok(broken.ok === true, '文件坏了也能读到原文（好让人去修）')
  ok(String(broken.text).includes('这不是 JSON'), '读到的是原始内容')

  // 保存坏 JSON → 拒绝，且**原文件不动**
  const before = readMemoryRaw().text
  const bad = saveMemoryRaw('{还是坏的')
  ok(bad.ok === false, '坏 JSON 被拒绝')
  ok(String(bad.error).includes('JSON'), `错因说清是 JSON 问题（实际「${bad.error}」）`)
  eq(readMemoryRaw().text, before, '被拒时原文件一个字节都没变')

  // 空串 → 拒绝（要清空请用「清空记忆」，别存空文件）
  ok(saveMemoryRaw('').ok === false, '空内容被拒绝')
  ok(saveMemoryRaw('   ').ok === false, '只有空白也被拒绝')

  // 数组 / 标量 → 拒绝（最外层必须是对象）
  // ⚠️ 每一条都要单独验证「原文件没变」—— 不能只在坏 JSON 那条测一次。
  //    第一版我把 before/after 只放在坏 JSON 那里，结果「数组被拒时也偷偷写了盘」
  //    这种变异抓不到（前面那条已经改过文件，后面的比对基准已经脏了）。
  const beforeArray = readMemoryRaw().text
  ok(saveMemoryRaw('[]').ok === false, '数组被拒绝（最外层必须是对象）')
  eq(readMemoryRaw().text, beforeArray, '数组被拒时原文件一个字节都没变')

  const beforeScalar = readMemoryRaw().text
  ok(saveMemoryRaw('123').ok === false, '标量被拒绝')
  eq(readMemoryRaw().text, beforeScalar, '标量被拒时原文件一个字节都没变')

  // 合法对象 → 保存成功，且**立刻生效**（内存态要作废重载）
  const good = saveMemoryRaw(JSON.stringify({
    'private:777': { nick: '手写的名字', facts: [{ text: '手动加的事实', at: 1 }], count: 3, lastSeen: 2 }
  }))
  ok(good.ok === true, '合法 JSON 保存成功')
  eq(good.count, 1, '返回写入的卡数')
  eq(loadMemory('private:777').nick, '手写的名字', '保存后立刻能读到（内存态已作废重载）')
  ok(describeMemory('private:777').includes('手动加的事实'), '手写的事实进了注入正文')

  // 写盘格式：2 空格缩进 + 结尾换行（人可读，和插件自己写的保持一致）
  const saved = readMemoryRaw().text
  ok(saved.endsWith('\n'), '文件以换行结尾')
  ok(saved.includes('\n  '), '用 2 空格缩进')
}

console.log(`\n${passed} 过 / ${failed} 败`)
rmSync(TMP, { force: true })
process.exit(failed === 0 ? 0 : 1)
