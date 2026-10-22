// Fetch https://models.dev/api.json and write prices.json:
//   { provider: { modelId: [input, output, cacheRead, cacheWrite] } }   (USD per 1M tokens)
// Usage: node scripts/update-prices.mjs [provider ...]
import { writeFile } from 'node:fs/promises'

const args = process.argv.slice(2)
const wanted = args.length ? args : ['amazon-bedrock', 'anthropic', 'openai', 'deepseek']
const res = await fetch('https://models.dev/api.json')
if (!res.ok) throw new Error(`models.dev: HTTP ${res.status}`)
const api = await res.json()

const out = {}
for (const p of wanted) {
  const models = api[p]?.models
  if (!models) { console.warn(`skip: provider "${p}" not on models.dev`); continue }
  out[p] = {}
  for (const [id, m] of Object.entries(models)) {
    const c = m.cost
    if (!c || c.input === undefined || c.output === undefined) continue
    out[p][id] = [c.input, c.output, c.cache_read ?? c.input, c.cache_write ?? c.input]
  }
  console.log(`${p}: ${Object.keys(out[p]).length} priced models`)
}
await writeFile(new URL('../prices.json', import.meta.url), JSON.stringify(out) + '\n')
