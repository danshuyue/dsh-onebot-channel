import assert from 'node:assert/strict'
import { waitForTools } from '../lib/env.js'

let attempts = 0
const tools = { register() {} }
const resolved = await waitForTools({
  get(name) {
    assert.equal(name, 'tools')
    attempts += 1
    return attempts >= 3 ? tools : undefined
  }
}, 'test', undefined, 100, 5)
assert.equal(resolved, tools, 'retries until the tool service becomes available')
assert.ok(attempts >= 3, 'checks service more than once')

const controller = new AbortController()
const waiting = waitForTools({ get: () => undefined }, 'test', controller.signal, 1000, 1000)
controller.abort()
assert.equal(await waiting, null, 'cancels pending service wait on disposal')

console.log('tool-retry-sim: all assertions passed')
