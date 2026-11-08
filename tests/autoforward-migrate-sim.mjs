/**
 * autoforward-migrate-sim.mjs —— 0.20.2 自动转发按渠道拆分的迁移与语义测试。
 * node tests/autoforward-migrate-sim.mjs，退出码 0 = 全过。
 *
 * ## 为什么单独一个文件
 * 存量配置的迁移是本仓库最容易「静默出错」的一类改动：
 *   · 0.20.0 的 notifyTurnFailures 如果没迁，用户明明关过、升级后又开始发；
 *   · 0.19.x 的语音配置漏进 publicConfig，界面改了不生效、零报错。
 * 所以旧键 → 新键这一步必须有**独立断言**，而不是靠「跑一遍没报错」。
 *
 * 本文件**不写任何配置、不起服务**：只调纯函数，因此不需要隔离 HOME。
 * （`migrateAutoForward` 只读 rawFile / 写传入的 config 对象，不碰磁盘。）
 */
let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`) } else { failed += 1; console.error(`  ✗ ${name}`) }
}
function eq(actual, expected, name) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, `${name}${same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`)
}

const config = await import('../lib/config.js')
const { DEFAULTS, migrateAutoForward, autoForwardEnabledFor } = config

console.log('默认值：')
eq(DEFAULTS.autoForwardPrivate, true, '私聊默认开（存量行为不变）')
eq(DEFAULTS.autoForwardGroup, false, '群聊默认**关**（用户要求：群里只在 qq_send 时出声）')
ok(!('autoForwardReply' in DEFAULTS), '旧的全局键已从 DEFAULTS 移除（不留两个真相源）')

console.log('\n迁移：旧 autoForwardReply=false → 新键：')
{
  // ⚠️ 模拟 loadConfig 的合并：{...DEFAULTS, ...rawFile}
  const cfg = { ...DEFAULTS, autoForwardReply: false }
  const migrated = migrateAutoForward(cfg, { autoForwardReply: false })
  eq(migrated, true, 'false 触发了迁移')
  eq(cfg.autoForwardPrivate, false, '用户关过 → 私聊也保持关（不能升级后自己开回来）')
  eq(cfg.autoForwardGroup, false, '群保持关')
}

console.log('\n迁移：旧 autoForwardReply=true（默认值）：')
{
  const cfg = { ...DEFAULTS, autoForwardReply: true }
  const migrated = migrateAutoForward(cfg, { autoForwardReply: true })
  eq(migrated, true, 'true 也走一遍（把新键落进配置文件，语义不变）')
  eq(cfg.autoForwardPrivate, true, '私聊保持开')
  eq(cfg.autoForwardGroup, false, '群仍然是关 —— 旧键从没表达过「群里也要发」')
}

console.log('\n迁移：用户已经显式写过新键 → 一个都不许覆盖（自己选过的算数）：')
{
  const cfg = {
    ...DEFAULTS,
    autoForwardReply: false,
    autoForwardPrivate: true,
    autoForwardGroup: true
  }
  const migrated = migrateAutoForward(cfg, {
    autoForwardReply: false,
    autoForwardPrivate: true,
    autoForwardGroup: true
  })
  eq(migrated, false, '不需要迁移')
  eq(cfg.autoForwardPrivate, true, '显式设过的私聊值不被旧键覆盖')
  eq(cfg.autoForwardGroup, true, '显式设过的群值不被旧键覆盖')
}

console.log('\n迁移：边界情况：')
{
  const cfg = { ...DEFAULTS, autoForwardReply: false, autoForwardGroup: true }
  migrateAutoForward(cfg, { autoForwardReply: false, autoForwardGroup: true })
  eq(cfg.autoForwardPrivate, false, '只显式设了群 → 私聊仍按旧键迁（false）')
  eq(cfg.autoForwardGroup, true, '显式群值保留')
}
{
  const cfg = { ...DEFAULTS }
  eq(migrateAutoForward(cfg, null), false, '没有配置文件（全新安装）→ 不迁')
  eq(migrateAutoForward(cfg, {}), false, '空配置 → 不迁')
  eq(migrateAutoForward(cfg, { autoForwardReply: 'false' }), false, '非布尔值不迁（脏数据不猜）')
}

console.log('\n渠道判定 autoForwardEnabledFor：')
{
  const cfg = { autoForwardPrivate: true, autoForwardGroup: false }
  eq(autoForwardEnabledFor({ kind: 'private', id: '1' }, cfg), true, '私聊开 → 转发')
  eq(autoForwardEnabledFor({ kind: 'group', id: '2' }, cfg), false, '群关 → 不转发')

  const cfg2 = { autoForwardPrivate: false, autoForwardGroup: true }
  eq(autoForwardEnabledFor({ kind: 'private', id: '1' }, cfg2), false, '私聊关 → 不转发')
  eq(autoForwardEnabledFor({ kind: 'group', id: '2' }, cfg2), true, '群开 → 转发')

  // 脏值 / 缺字段都按默认值走，别让一个 undefined 把功能关掉
  eq(autoForwardEnabledFor({ kind: 'private', id: '1' }, {}), true, '配置缺字段 → 私聊按默认开')
  eq(autoForwardEnabledFor({ kind: 'group', id: '2' }, {}), false, '配置缺字段 → 群按默认关')
  eq(autoForwardEnabledFor(undefined, cfg), true, '没有 target → 按私聊口径（默认开）')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed > 0 ? 1 : 0)
