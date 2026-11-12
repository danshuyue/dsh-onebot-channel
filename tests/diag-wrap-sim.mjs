/** Run only via: node tests/run-isolated.mjs tests/diag-wrap-sim.mjs */
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assertIsolatedTestHome } from './sandbox-guard.mjs'

assertIsolatedTestHome({ testFile: 'tests/diag-wrap-sim.mjs' })
// Point to a cached pre-fix env.js (and its sibling diaglog.js) for old-code falsification.
const envUrl = pathToFileURL(resolve(process.env.DSH_DIAG_ENV_SOURCE || 'lib/env.js'))
const envA = await import(envUrl.href + '?diag-wrap-a')
const envB = await import(envUrl.href + '?diag-wrap-b')
const { exportDiagLog, resetDiagLog, recordTool } = await import(new URL('./diaglog.js', envUrl).href)
const rows = () => exportDiagLog().tools
const wrap = (env, tools) => env.waitForTools({ get: () => tools }, 'diag-test')
let passed = 0
const failed = []
async function test(label, run) {
  resetDiagLog()
  try { await run(); passed++; console.log('  ✓ ' + label) }
  catch (error) { failed.push(label); console.error('  ✗ ' + label + ': ' + error.message) }
}
function backend() {
  return { definitions: [], register(def, ...extra) { this.definitions.push({ def, extra }); return def } }
}

await test('different tools shells sharing one register backend record once', async () => {
  const tools = backend()
  for (let n = 0; n < 4; n++) await wrap(envA, new Proxy(tools, {}))
  let calls = 0
  const def = { name: 'shared-shell', async execute() { calls++; return { ok: true } } }
  tools.register(def)
  await def.execute({ text: 'same' })
  assert.equal(calls, 1, 'business executes once')
  assert.equal(rows().length, 1, 'one invocation must yield one diagnostic')
})

await test('registering the same definition repeatedly does not stack execute wrappers', async () => {
  const tools = await wrap(envA, backend())
  const def = { name: 'same-def', async execute() { return 'value' } }
  tools.register(def)
  tools.register(def)
  tools.register(def)
  assert.equal(await def.execute({}), 'value')
  assert.equal(tools.definitions.length, 3, 'actual registrations are never deduplicated')
  assert.equal(rows().length, 1, 'only execution instrumentation is idempotent')
})

await test('multiple env module imports do not stack wrappers', async () => {
  const tools = backend()
  await wrap(envA, tools)
  await wrap(envB, tools)
  const def = { name: 'reload', async execute() { return 7 } }
  tools.register(def)
  await def.execute({})
  assert.equal(rows().length, 1, 'module-local WeakSets are insufficient')
})

await test('registration preserves receiver, all arguments, return and throw identity', async () => {
  const receiver = { expected: true }
  const tail = { option: true }
  const registrationError = new Error('registration error')
  const expected = { registration: true }
  let seen
  const tools = await wrap(envA, { register(...args) {
    assert.equal(this, receiver)
    seen = args
    if (args[0] === null) throw registrationError
    return expected
  } })
  const def = { name: 'registration', execute() { return 1 } }
  assert.equal(tools.register.call(receiver, def, tail, 3), expected)
  assert.deepEqual(seen, [def, tail, 3])
  assert.throws(() => tools.register.call(receiver, null, tail), e => e === registrationError)
})

await test('execute preserves receiver, all arguments and resolved/rejected identity', async () => {
  const tools = await wrap(envA, backend())
  const receiver = { identity: true }
  const args = { text: 'hello' }
  const exec = { agent: { session: { id: 'session-diag' } } }
  const third = { third: true }
  const value = { ok: true, exact: true }
  const error = new Error('business failure')
  const def = { name: 'async', execute(...callArgs) {
    assert.equal(this, receiver)
    assert.deepEqual(callArgs, [args, exec, third])
    return Promise.resolve(value)
  } }
  tools.register(def)
  assert.equal(await def.execute.call(receiver, args, exec, third), value)
  const reject = { name: 'reject', execute() { return Promise.reject(error) } }
  tools.register(reject)
  await assert.rejects(reject.execute({}), e => e === error)
  assert.equal(rows().length, 2)
  assert.equal(rows()[0].sessionId, 'session-diag')
  assert.equal(rows()[0].outcome, 'success')
  assert.equal(rows()[1].isError, true)
  assert.equal(rows()[1].outcome, 'error')
})

await test('synchronous return and throw remain synchronous', async () => {
  const tools = await wrap(envA, backend())
  const value = { ok: true }
  const error = new Error('sync failure')
  const def = { name: 'sync', execute() { return value } }
  tools.register(def)
  assert.equal(def.execute({}), value)
  const bad = { name: 'sync-throw', execute() { throw error } }
  tools.register(bad)
  assert.throws(() => bad.execute({}), e => e === error)
  assert.equal(rows().length, 2)
})

await test('ok:false is business failure, not a thrown tool error', async () => {
  const tools = await wrap(envA, backend())
  const result = { ok: false, error: 'unavailable' }
  const def = { name: 'business-failure', async execute() { return result } }
  tools.register(def)
  assert.equal(await def.execute({}, { agent: { session: 'session-string' } }), result)
  assert.equal(rows()[0].isError, false)
  assert.equal(rows()[0].ok, false)
  assert.equal(rows()[0].outcome, 'failure')
  assert.equal(rows()[0].sessionId, 'session-string')
})

await test('identical concurrent calls at the same time keep separate call IDs', async () => {
  const tools = await wrap(envA, backend())
  const now = Date.now
  const fixed = now()
  Date.now = () => fixed
  try {
    const def = { name: 'same-input', async execute() { return { ok: true } } }
    tools.register(def)
    const args = { text: 'identical' }
    await Promise.all([def.execute(args), def.execute(args)])
    const out = rows()
    assert.equal(out.length, 2, 'never deduplicate by arguments/time')
    assert.ok(out.every(x => typeof x.callId === 'string' && x.callId.length > 0))
    assert.notEqual(out[0].callId, out[1].callId)
    assert.ok(out.every(x => x.startedAt === fixed && x.at === fixed))
  } finally { Date.now = now }
})

await test('diagnostic failures and readonly services cannot break business', async () => {
  const tools = await wrap(envA, backend())
  const result = { get ok() { throw new Error('diagnostic getter') } }
  const def = { name: 'hostile-result', execute() { return result } }
  tools.register(def)
  assert.equal(def.execute({}), result, 'result inspection cannot turn success into failure')
  const frozen = Object.freeze({ name: 'frozen-def', execute() { return 3 } })
  tools.register(frozen)
  assert.equal(frozen.execute(), 3)
  const readonly = Object.freeze({ register: def => def })
  assert.equal(await wrap(envA, readonly), readonly)
  assert.equal(readonly.register(frozen), frozen)
})

await test('recordTool accepts explicit identity and never merges real calls', async () => {
  const at = Date.now()
  const entry = { tool: 'direct', callId: 'explicit-id', startedAt: at - 4, sessionId: 'provided', at, result: { ok: false }, durationMs: 4 }
  recordTool(entry)
  recordTool(entry)
  assert.equal(rows().length, 2)
  assert.equal(rows()[0].callId, 'explicit-id')
  assert.equal(rows()[0].startedAt, at - 4)
  assert.equal(rows()[0].sessionId, 'provided')
  assert.equal(rows()[0].isError, false)
  assert.equal(rows()[0].ok, false)
  assert.equal(rows()[0].outcome, 'failure')
})

await test('cross-realm Promise resolution and rejection are recorded after settlement', async () => {
  const tools = await wrap(envA, backend())
  const value = runInNewContext('Promise.resolve({ok:false,error:"business-failure"})')
  const def = { name: 'cross-realm', execute() { return value } }
  tools.register(def)
  assert.equal(def.execute({}), value, 'original Promise identity')
  assert.equal((await value).ok, false)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(rows()[0].ok, false)
  assert.equal(rows()[0].outcome, 'failure')
  const rejected = runInNewContext('Promise.reject(new Error("realm-reject"))')
  const bad = { name: 'cross-realm-reject', execute() { return rejected } }
  tools.register(bad)
  const returned = bad.execute({})
  assert.equal(returned, rejected)
  await assert.rejects(returned)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(rows()[1].outcome, 'error')
  assert.equal(rows()[1].isError, true)
})

await test('custom thenables are not consumed by diagnostic observers', async () => {
  const tools = await wrap(envA, backend())
  let consumed = 0
  const value = { then() { consumed++ } }
  const def = { name: 'non-native-thenable', execute() { return value } }
  tools.register(def)
  assert.equal(def.execute({}), value)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(consumed, 0, 'diagnostics must not trigger deferred business a second time')
})

console.log(`diag-wrap-sim: ${passed} passed / ${failed.length} failed`)
if (failed.length) process.exitCode = 1
