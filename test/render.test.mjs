import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

let factory
globalThis.window = { __ModuleLoader__: { load: (m) => { factory = m.factory } } }
new Function(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'))()
const React = { createElement: (t, p, ...c) => ({ t, p, c }), useState: () => [true, () => {}], useRef: () => ({ current: null }), useEffect: () => {}, useSyncExternalStore: (sub, get) => get() }
const prim = { Tooltip: (p) => p.children, useAnchoredPosition: () => ({ left: 10, top: 20 }), useDismissOnOutsidePointer: () => {} }
globalThis.document = { addEventListener() {}, removeEventListener() {}, body: 'BODY' }
const mod = factory((id) => (id === 'react' ? React : id === 'react-dom' ? { createPortal: (n) => n } : prim))

const m = (model, cost, o = {}) => ({ provider: 'amazon-bedrock', model, input: 120000, output: 30000, cacheRead: 2000000, cacheWrite: 150000, price: [2, 10, 0.1, 2.5], cost, ...o })
const proj = {
  sessionCost: { models: [m('global.anthropic.claude-sonnet-5-5', 1.11)] },
  subagentCatalog: [{ id: 'c1', mode: 'one-shot' }, { id: 'c2', mode: 'one-shot' }],
  sessionStats: { turns: 5, steps: 40, llmMs: 600000, toolMs: 90000, ttftMs: 20000, ttftSteps: 40, decodeMs: 300000, decodeTokens: 30000 },
  contextPressure: { pressureTokens: 200000, contextWindow: 1000000 }
}
const sessions = { list: { subscribe: () => () => {}, getSnapshot: () => ({ projectionsBySession: { c1: { values: { sessionCost: { models: [m('claude-haiku-4-5', 0.5, { provider: 'anthropic' })] } } } } }) },
  refreshProjections: (id) => { sessions.asked.push(id); return Promise.resolve() }, asked: [] }
const text = (n) => n == null || typeof n === 'boolean' ? '' : typeof n !== 'object' ? String(n) : Array.isArray(n) ? n.map(text).join(' ') : [n.c].map(text).join(' ')

test('panel shows per-model rows, subagent split and incomplete marker', () => {
  const out = text(mod.CostPill({ useProjection: (k) => proj[k], sessions }))
  console.log(out.replace(/\s+/g, ' '))
  assert.match(out, /~\$1\.61\+/) // 1.11 + 0.5, c2 is not loaded -> "+"
  for (const w of ['claude-haiku-4-5', 'claude-sonnet-5-5', 'main session', 'subagents (2)', 'not loaded yet', 'per turn', 'saved by cache', 'burn rate']) assert.ok(out.includes(w), w)
})

test('renders without optional projections or sessions service', () => {
  const out = text(mod.CostPill({ useProjection: (k) => (k === 'sessionCost' ? proj.sessionCost : undefined) }))
  assert.ok(out.includes('claude-sonnet-5-5'))
})

test('unpriced model is flagged', () => {
  const out = text(mod.CostPill({ useProjection: (k) => (k === 'sessionCost' ? { models: [m('x', null, { price: null })] } : undefined) }))
  assert.ok(out.includes('no price')); assert.ok(out.includes('$?'))
})

test('hidden when no tokens', () => {
  assert.equal(mod.CostPill({ useProjection: (k) => (k === 'sessionCost' ? { models: [] } : undefined) }), null)
})
