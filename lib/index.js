// Node half: registers the `sessionCost` session projection.
//
// The projection folds the session log into token buckets PER MODEL (the model that actually
// answered each request, not the one selected in the composer) and prices them from models.dev
// (prices.json). Tokens, not dollars, are persisted in the projection state, so refreshing
// prices.json never needs a state migration; dollars are computed in `view`.
//
// Mirrors @deepseek-ai/dsh-token-meter's `tokenUsage` fold (same "replace the slot of the same
// (turn, step)" semantics, `llm/retry-started` closes the slot) and additionally covers
// `compaction/summary`, which carries its own provider/model/usage.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-cost-plugin'
export const inject = ['sessionProjections']

/** provider -> modelId -> [input, output, cacheRead, cacheWrite], USD per 1M tokens. */
export const PRICES = JSON.parse(readFileSync(fileURLToPath(new URL('../prices.json', import.meta.url)), 'utf8'))

const REGION = /^(global|us|eu|apac|au|jp|in)\./

export function priceFor(provider, model, prices = PRICES) {
  const table = prices[provider]
  if (!table || !model) return undefined
  if (table[model]) return table[model]
  const bare = model.replace(REGION, '')
  return table['global.' + bare] || table[bare]
}

export const KEY = 'sessionCost'
export const STATE_VERSION = 1

const UNKNOWN = { provider: '?', model: '?' }
const num = (n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0)

/** The usage sample one assistant settlement reports: explicit `usage`, else the last stream usage chunk. */
function usageOf(event) {
  if (event.type === 'assistant/message' && event.data.usage !== undefined) return event.data.usage
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  const stream = event.data.stream
  if (!Array.isArray(stream)) return undefined
  for (let i = stream.length - 1; i >= 0; i--) {
    const r = stream[i]
    if (r && r.type === 'chunk' && r.chunk && r.chunk.type === 'usage') return r.chunk.usage
  }
  return undefined
}

// Buckets: [uncached input, output, cache read, cache write]. `inputTokens` is already uncached.
const bucketsOf = (u) => [num(u.inputTokens), num(u.outputTokens), num(u.cacheReadTokens), num(u.cacheWriteTokens)]
const sameBuckets = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]
const keyOf = (m) => m.provider + '/' + m.model
const neg = (b) => b.map((v) => -v)

/** Return `models` with the signed `delta` added to model `m`. */
function addTo(models, m, delta) {
  const key = keyOf(m)
  const prev = models[key]
  const b = prev ? prev.b : [0, 0, 0, 0]
  return { ...models, [key]: { provider: m.provider, model: m.model, b: b.map((v, i) => v + delta[i]) } }
}

export function init(inherited = 0) {
  return { inherited, cur: null, slot: null, models: {} }
}

export function fold(state, event) {
  switch (event.type) {
    case 'request/header': {
      const c = event.data.header && event.data.header.config
      if (!c) return state
      if (state.cur && state.cur.provider === c.provider && state.cur.model === c.model) return state
      return { ...state, cur: { provider: c.provider, model: c.model } }
    }
    case 'request/context': {
      const c = event.data
      if (state.cur && state.cur.provider === c.provider && state.cur.model === c.model) return state
      return { ...state, cur: { provider: c.provider, model: c.model } }
    }
    case 'llm/retry-started':
      return state.slot && state.slot.turn === event.data.turn && state.slot.step === event.data.step
        ? { ...state, slot: null }
        : state
    case 'assistant/message':
    case 'assistant/attempt': {
      // Events inherited from a fork/seed were paid for in the session they came from.
      if (event.seq < state.inherited) return state
      const sample = usageOf(event)
      if (sample === undefined) return state
      const src = event.type === 'assistant/message' ? event.data.message && event.data.message.source : undefined
      const m = src && src.kind === 'model' ? { provider: src.provider, model: src.model } : state.cur || UNKNOWN
      const b = bucketsOf(sample)
      const { turn, step } = event.data
      const prev = state.slot && state.slot.turn === turn && state.slot.step === step ? state.slot : undefined
      if (prev && keyOf(prev.m) === keyOf(m) && sameBuckets(prev.b, b)) return state
      let models = state.models
      if (prev) models = addTo(models, prev.m, neg(prev.b))
      models = addTo(models, m, b)
      return { ...state, models, slot: { turn, step, m, b } }
    }
    case 'compaction/summary': {
      if (event.seq < state.inherited) return state
      const d = event.data
      if (!d.usage) return state
      const m = d.provider && d.model ? { provider: d.provider, model: d.model } : state.cur || UNKNOWN
      return { ...state, models: addTo(state.models, m, bucketsOf(d.usage)) }
    }
    default:
      return state
  }
}

/** Client view: one row per model with tokens, price and cost (null = no models.dev price). */
export function view(state, prices = PRICES) {
  const models = []
  for (const e of Object.values(state.models)) {
    const [input, output, cacheRead, cacheWrite] = e.b
    if (input + output + cacheRead + cacheWrite === 0) continue
    const price = priceFor(e.provider, e.model, prices)
    const cost = price
      ? (input * price[0] + output * price[1] + cacheRead * price[2] + cacheWrite * price[3]) / 1e6
      : null
    models.push({ provider: e.provider, model: e.model, input, output, cacheRead, cacheWrite, price: price || null, cost })
  }
  models.sort((a, b) => (b.cost || 0) - (a.cost || 0))
  return { models }
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const bad = (what) => { throw new Error(`${KEY}: invalid ${what}`) }

// Minimal zod-shaped schemas (the registry only calls `.parse`), so the plugin needs no zod dependency.
export const stateSchema = {
  parse(v) {
    if (!v || typeof v !== 'object' || typeof v.models !== 'object' || v.models === null || !isNum(v.inherited)) bad('state')
    for (const e of Object.values(v.models)) {
      if (!e || typeof e.provider !== 'string' || typeof e.model !== 'string' || !Array.isArray(e.b) || e.b.length !== 4 || !e.b.every(isNum)) bad('state model entry')
    }
    return v
  }
}
export const viewSchema = {
  parse(v) {
    if (!v || !Array.isArray(v.models)) bad('view')
    return v
  }
}

export function apply(ctx) {
  ctx.sessionProjections.register({
    key: KEY,
    stateVersion: STATE_VERSION,
    stateSchema,
    init: (_header, inheritedEventCount) => init(inheritedEventCount),
    apply: fold,
    wire: { viewSchema, view: (state) => view(state) }
  })
}
