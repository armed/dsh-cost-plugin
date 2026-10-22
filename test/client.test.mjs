import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

let factory
globalThis.window = { __ModuleLoader__: { load: (m) => { factory = m.factory } } }
const code = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
new Function(code)()
const mod = factory((id) => (id === 'react' ? { createElement: () => null } : {}))

const row = (model, cost, o = {}) => ({ provider: 'p', model, input: 10, output: 5, cacheRead: 1, cacheWrite: 2, price: cost === null ? null : [1, 1, 1, 1], cost, ...o })

test('mergeRows sums per model and keeps unpriced as null', () => {
  const r = mod.mergeRows([row('a', 1), row('a', 2), row('b', null), row('b', 3)])
  assert.equal(r.length, 2)
  const a = r.find((x) => x.model === 'a'), b = r.find((x) => x.model === 'b')
  assert.equal(a.cost, 3); assert.equal(a.input, 20)
  assert.equal(b.cost, null)
})

test('collectTree walks nested subagents and reports what is missing', () => {
  const vals = {
    root: { sessionCost: { models: [row('a', 1)] }, subagentCatalog: [{ id: 'c1', mode: 'one-shot' }, { id: 'c2', mode: 'continuable' }, { id: 'x', mode: 'external' }, { id: 'c3', mode: 'one-shot' }] },
    c1: { sessionCost: { models: [row('b', 2)] }, subagentCatalog: [{ id: 'g1', mode: 'one-shot' }] },
    g1: { sessionCost: { models: [row('c', 4)] } },
    c3: {} // loaded but no sessionCost yet
  }
  const t = mod.collectTree(vals.root, (id) => vals[id])
  assert.equal(t.own.length, 1)
  assert.deepEqual(t.subs.map((r) => r.model).sort(), ['b', 'c'])
  assert.deepEqual(t.pending.sort(), ['c2', 'c3'])
  assert.equal(t.external, 1)
  assert.equal(t.count, 4)
})

test('collectTree survives cycles', () => {
  const vals = { a: { sessionCost: { models: [] }, subagentCatalog: [{ id: 'a', mode: 'one-shot' }] } }
  assert.doesNotThrow(() => mod.collectTree(vals.a, (id) => vals[id]))
})

test('module exposes the plugin entry points', () => {
  assert.equal(typeof mod.apply, 'function'); assert.deepEqual(mod.inject, ['slots', 'sessions'])
})

test('usd formatting', () => {
  assert.equal(mod.usd(0.0042), '$0.00'); assert.equal(mod.usd(0.42), '$0.42'); assert.equal(mod.usd(12.346), '$12.35'); assert.equal(mod.usd(123.4), '$123.40')
})
