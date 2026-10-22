import test from 'node:test'
import assert from 'node:assert/strict'
import { init, fold, view, priceFor, stateSchema, apply } from '../lib/index.js'

const SONNET = { provider: 'amazon-bedrock', model: 'global.anthropic.claude-sonnet-5-5' } // [2, 10, 0.1, 2.5]
let seq = 0
const ev = (type, data) => ({ type, seq: seq++, time: 0, data })
const header = (m) => ev('request/header', { header: { config: m }, reason: 'initial' })
const usage = (i, o, cr = 0, cw = 0) => ({ inputTokens: i, outputTokens: o, cacheReadTokens: cr, cacheWriteTokens: cw })
const msg = (turn, step, m, u) => ev('assistant/message', { turn, step, message: { role: 'assistant', source: { kind: 'model', ...m } }, stream: [], usage: u })
const run = (events, s = init()) => events.reduce((st, e) => fold(st, e), s)

test('priceFor handles region prefixes', () => {
  assert.deepEqual(priceFor(SONNET.provider, SONNET.model), [2, 10, 0.1, 2.5])
  assert.ok(priceFor(SONNET.provider, 'apac.anthropic.claude-sonnet-5-5'))
  assert.equal(priceFor('nope', 'x'), undefined)
})

test('cost is attributed to the model that answered, not the selected one', () => {
  const other = { provider: 'anthropic', model: 'claude-sonnet-4-5' }
  const s = run([header(SONNET), msg(1, 1, SONNET, usage(1_000_000, 100_000, 2_000_000, 400_000)), msg(1, 2, other, usage(10, 20))])
  const v = view(s)
  assert.equal(v.models.length, 2)
  const son = v.models.find((m) => m.model === SONNET.model)
  assert.ok(Math.abs(son.cost - 4.2) < 1e-9)
  assert.equal(son.input, 1_000_000)
})

test('same (turn, step) sample replaces, retry-started keeps both attempts', () => {
  let s = run([header(SONNET), ev('assistant/attempt', { turn: 1, step: 1, stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage: usage(100, 5) } }] })])
  assert.equal(view(s).models[0].input, 100)
  s = run([msg(1, 1, SONNET, usage(100, 50))], s) // final message of the same attempt replaces
  assert.equal(view(s).models[0].input, 100); assert.equal(view(s).models[0].output, 50)
  s = run([ev('llm/retry-started', { turn: 1, step: 1, retryId: 'r', retry: 1 }), msg(1, 1, SONNET, usage(100, 50))], s)
  assert.equal(view(s).models[0].input, 200) // retried request is billed again
})

test('attempt without a message uses the model from request/header', () => {
  const s = run([header(SONNET), ev('assistant/attempt', { turn: 1, step: 1, stream: [{ type: 'chunk', time: 0, chunk: { type: 'usage', usage: usage(7, 1) } }] })])
  assert.equal(view(s).models[0].model, SONNET.model)
})

test('compaction/summary is billed to its own model', () => {
  const m = { provider: 'anthropic', model: 'claude-haiku-4-5' }
  const s = run([header(SONNET), ev('compaction/summary', { provider: m.provider, model: m.model, usage: usage(500, 100) })])
  assert.equal(view(s).models[0].model, m.model)
})

test('unpriced model has cost null', () => {
  const s = run([msg(1, 1, { provider: 'x', model: 'y' }, usage(1, 1))])
  assert.equal(view(s).models[0].cost, null)
})

test('events inherited from a fork are not counted', () => {
  const s0 = init(2)
  const s = run([{ ...msg(1, 1, SONNET, usage(999, 1)), seq: 1 }, { ...msg(2, 1, SONNET, usage(5, 1)), seq: 2 }], s0)
  assert.equal(view(s).models[0].input, 5)
})

test('state survives a JSON round trip and schema parse', () => {
  const s = run([header(SONNET), msg(1, 1, SONNET, usage(3, 4))])
  assert.deepEqual(stateSchema.parse(JSON.parse(JSON.stringify(s))), s)
  assert.throws(() => stateSchema.parse({ models: {} }))
})

test('apply registers one projection with a wire view', () => {
  let def
  apply({ sessionProjections: { register: (d) => { def = d } } })
  assert.equal(def.key, 'sessionCost')
  const st = def.init({}, 0)
  assert.deepEqual(def.wire.view(st), { models: [] })
})
