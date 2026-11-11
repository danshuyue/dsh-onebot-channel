/**
 * 保存链路的行为测试：node tests/save-fields-sim.mjs，退出码 0 = 全过。
 *
 * ## 为什么必须有这个文件
 *
 * 2026-11-07 用户报了两个「保存了但没存上」的 bug：
 *
 *   ① 勾上「增强音色相似度」→ 保存 → 重进「高级」→ 复选框变回不勾选
 *   ② 勾选「能使用语音的对象」→ 保存 → 重进 → 复选框全空
 *
 * 两个都是**静默丢弃**，零报错。而当时的测试（`http-config-sim.mjs`）只做了
 * 源码字符串断言（`saveBlock.includes('waterWindows')`）——
 * 它只能证明「代码里提到了这个字段名」，完全证明不了「值真的能存进去」。
 *
 * 所以这里**跑真正的 applyTunables**：给一个 body，检查 config 里的值变没变。
 * 这类「接线错但语法对」的 bug 只有行为测试能抓。
 */
let passed = 0
let failed = 0
function ok(condition, name, detail) {
  if (condition) { passed += 1; console.log(`  ✓ ${name}${detail ? `　${detail}` : ''}`) }
  else { failed += 1; console.error(`  ✗ ${name}${detail ? `　${detail}` : ''}`) }
}
function eq(actual, expected, name) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, `${name}${same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`)
}

import { readFileSync, writeFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), '..')
const DATA = join(homedir(), '.dsh')
const CONFIG = join(DATA, 'qq-bridge.config.json')
const STATE = join(DATA, 'qq-bridge-state.json')

const configBackup = readFileSync(CONFIG, 'utf8')
let stateBackup = null
try { stateBackup = readFileSync(STATE, 'utf8') } catch { stateBackup = null }
process.on('exit', () => {
  writeFileSync(CONFIG, configBackup, 'utf8')
  if (stateBackup !== null) writeFileSync(STATE, stateBackup, 'utf8')
  else rmSync(STATE, { force: true })
})

writeFileSync(CONFIG, JSON.stringify({ enabled: true, selfUin: 1000000002, peerUin: 1000000001 }, null, 2), 'utf8')
writeFileSync(STATE, JSON.stringify({ lastId: 0, lastSeq: 0, lastTime: 1, groups: {} }, null, 2), 'utf8')

const api = await import('../lib/api.js')
const config = await import('../lib/config.js')

/** 重新读一遍配置（applyTunables 改的是 getConfig() 那份单例）。 */
function cfg() {
  return config.getConfig()
}

console.log('1. 数组字段：每个都按自己的语义清洗（0.19.2 的 bug 就死在这）：')
{
  // ① voiceTargets* 的元素是 private:/group:，不是时间格式
  api.applyTunables({ voiceTargetsPrivate: ['private:1321833118', 'private:999'] })
  eq(cfg().voiceTargetsPrivate, ['private:1321833118', 'private:999'], '语音私聊名单能存住')

  api.applyTunables({ voiceTargetsGroup: ['group:975663147'] })
  eq(cfg().voiceTargetsGroup, ['group:975663147'], '语音群名单能存住')

  // ② 群和私聊两种前缀都要收（cleanTargetList 只认 private:，不能复用它）
  api.applyTunables({ voiceTargetsPrivate: ['group:123', 'private:456'] })
  eq(cfg().voiceTargetsPrivate, ['private:456'], '混进群前缀时只留私聊（前缀不符的丢掉）')

  // ③ 水群时间段仍然走时间格式
  api.applyTunables({ waterWindows: ['12:00-14:00', '垃圾', '18:00-09:00'] })
  eq(cfg().waterWindows, ['12:00-14:00', '18:00-09:00'], '时间段字段仍然只收 HH:MM-HH:MM')

  // ④ proactiveTargets 仍然只认 private:
  api.applyTunables({ proactiveTargets: ['private:1321833118', 'group:1'] })
  eq(cfg().proactiveTargets, ['private:1321833118'], '主动搭话名单仍然只认私聊')

  // ⑤ 空数组是合法值（能清空）
  api.applyTunables({ voiceTargetsPrivate: [] })
  eq(cfg().voiceTargetsPrivate, [], '空数组能存进去（= 清空，不是「跳过」）')
}

console.log('\n2. 布尔字段：voiceBreezeSpeakerBoost 必须可写：')
{
  api.applyTunables({ voiceBreezeSpeakerBoost: true })
  ok(cfg().voiceBreezeSpeakerBoost === true, '勾上能存住（原来这里被静默丢弃）')
  api.applyTunables({ voiceBreezeSpeakerBoost: false })
  ok(cfg().voiceBreezeSpeakerBoost === false, '取消勾选也能存住')
}

console.log('\n3. 字符串字段：voiceTestText（可自定义测试语句）：')
{
  api.applyTunables({ voiceTestText: '这是一句用来试听的测试句子。' })
  eq(cfg().voiceTestText, '这是一句用来试听的测试句子。', '测试语句能存住')
  api.applyTunables({ voiceTestText: '' })
  eq(cfg().voiceTestText, '', '清空能存住（空串 = 用内置默认，是有意义的值）')
}

console.log('\n4. resolveVoiceTestText：留空回落到内置那句，超长截断：')
{
  const tool = await import('../lib/tool.js')
  eq(tool.resolveVoiceTestText({ voiceTestText: '' }), tool.VOICE_TEST_TEXT, '留空 → 内置默认')
  eq(tool.resolveVoiceTestText({ voiceTestText: '   ' }), tool.VOICE_TEST_TEXT, '全空白 → 内置默认')
  eq(tool.resolveVoiceTestText({}), tool.VOICE_TEST_TEXT, '没这个键 → 内置默认')
  eq(tool.resolveVoiceTestText({ voiceTestText: '自定义' }), '自定义', '填了就用自己的')
  // 超长截断（按字计费，不能让人一不小心烧掉一大笔）
  const long = '字'.repeat(500)
  eq(tool.resolveVoiceTestText({ voiceTestText: long }).length, tool.VOICE_TEST_MAX_CHARS, '超长截断到上限')
}

console.log('\n5. 每个 ARRAY_FIELDS 都登记了清洗器（新增字段忘了登记会被抓）：')
{
  const apiSrc = readFileSync(join(PLUGIN, 'lib', 'api.js'), 'utf8')
  /**
   * 从 `export const X = [` 开始做**括号配对**取整段。
   *
   * ⚠️ 不能用 `indexOf(']')`：注释里会写 `['private:<数字>']` 这种方括号，
   *    一撞上就提前截断 —— 我第一次就是这么写的，结果只解析出前 2 个字段，
   *    而断言还「通过」了（因为 2 >= 2 的宽松条件）。这种假绿比不测更糟。
   */
  function arrayLiteralOf(src, marker) {
    const at = src.indexOf(marker)
    if (at < 0) return ''
    let depth = 0
    for (let i = at; i < src.length; i += 1) {
      const ch = src[i]
      if (ch === '[') depth += 1
      else if (ch === ']') {
        depth -= 1
        if (depth === 0) return src.slice(at, i + 1)
      }
    }
    return ''
  }
  const fieldsBlock = arrayLiteralOf(apiSrc, 'export const ARRAY_FIELDS = [')
  const noComments = fieldsBlock
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
  const fields = [...noComments.matchAll(/'([A-Za-z][A-Za-z0-9]*)'/g)].map((m) => m[1])
  // ⚠️ 这是**精确清单**，加新的数组字段时必须同步改这里 —— 那正是它的用处：
  //    它防的是「解析退化成假绿」（正则写坏了、一个字段都抽不到，后面全变成空断言）。
  //    0.20.1 加了 ignoreCommands（忽略指令表）。
  //    0.23.0 加了 wakeWords（唤醒词表）与 interestPoints（兴趣点，**对象数组** ——
  //    它是这张表里第一个非字符串元素，所以下面还有一条专门验它的清洗器）。
  eq(fields, ['proactiveTargets', 'waterWindows', 'voiceTargetsPrivate', 'voiceTargetsGroup', 'ignoreCommands',
    'wakeWords', 'interestPoints'],
    'ARRAY_FIELDS 解析出预期的 7 个字段（精确比对，防止解析退化成假绿）')

  const cAt = apiSrc.indexOf('const ARRAY_CLEANERS = {')
  const cleanersBlock = apiSrc.slice(cAt, apiSrc.indexOf('\n}', cAt))
  const missing = fields.filter((f) => !cleanersBlock.includes(`${f}:`))
  ok(missing.length === 0,
    `每个数组字段都登记了清洗器${missing.length ? '，缺：' + missing.join(', ') : ''}`)
}

console.log('\n6. 布尔/字符串/数字字段也都要在 publicConfig 里（反向，防「能存不能读」）：')
{
  const apiSrc = readFileSync(join(PLUGIN, 'lib', 'api.js'), 'utf8')
  const publicBlock = apiSrc.slice(apiSrc.indexOf('export function publicConfig'), apiSrc.indexOf('const NUMERIC_FIELDS'))
  const checks = ['voiceBreezeSpeakerBoost', 'voiceTestText', 'voiceBreezeSpeed', 'voiceTargetsPrivate']
  for (const key of checks) {
    ok(publicBlock.includes(`${key}:`), `${key} 在 publicConfig 里`)
  }
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed > 0 ? 1 : 0)
