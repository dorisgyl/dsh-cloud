// M1 step 1a: work out what each U2 package actually exports, so cf-boot knows
// how to register it.
//
// Cordis accepts three plugin shapes: a function `(ctx, config)`, a class
// constructed with `(ctx, config)`, or an object with `apply(ctx, config)`.
// Plugins declare `inject` (services they need; they stay dormant until all are
// present) and `provide` (services they publish).
//
// Run from the repo root; resolution happens from units/session-do.
import { readFileSync, writeFileSync } from 'node:fs'

const deps = Object.keys(JSON.parse(readFileSync('./scripts/u2-deps.json', 'utf8')))

const norm = (inject) => {
  if (!inject) return []
  if (Array.isArray(inject)) return inject
  if (typeof inject === 'object') return Object.keys(inject)
  return [String(inject)]
}

function classify(mod) {
  // A plugin may be the default export or the module namespace itself.
  const candidates = [
    ['default', mod?.default],
    ['module', mod],
  ]
  for (const [where, v] of candidates) {
    if (!v) continue
    if (typeof v === 'function') {
      // Class plugins are functions too; a prototype with own members implies a class.
      const isClass = /^\s*class\s/.test(Function.prototype.toString.call(v))
      return { where, kind: isClass ? 'class' : 'function', target: v }
    }
    if (typeof v === 'object' && typeof v.apply === 'function' && v.apply !== Function.prototype.apply) {
      return { where, kind: 'object', target: v }
    }
  }
  return null
}

const rows = []
for (const name of deps) {
  let mod
  try {
    mod = await import(name)
  } catch (err) {
    rows.push({ name, kind: 'IMPORT FAILED', error: String(err.message).slice(0, 140) })
    continue
  }
  const found = classify(mod)
  if (!found) {
    rows.push({ name, kind: 'library', exports: Object.keys(mod).slice(0, 8) })
    continue
  }
  const t = found.target
  rows.push({
    name,
    kind: found.kind,
    from: found.where,
    pluginName: t.name ?? mod.name ?? null,
    inject: norm(t.inject ?? mod.inject),
    provide: norm(t.provide ?? mod.provide),
    reusable: t.reusable ?? mod.reusable ?? undefined,
  })
}

writeFileSync('./scripts/m1-plugin-map.json', JSON.stringify(rows, null, 2))

const short = (n) => n.replace('@deepseek-ai/', '')
const byKind = {}
for (const r of rows) (byKind[r.kind] = byKind[r.kind] || []).push(r)

for (const kind of Object.keys(byKind).sort()) {
  console.log(`\n=== ${kind} (${byKind[kind].length}) ===`)
  for (const r of byKind[kind]) {
    if (r.kind === 'IMPORT FAILED') { console.log(`  ${short(r.name).padEnd(36)} ${r.error}`); continue }
    if (r.kind === 'library') { console.log(`  ${short(r.name).padEnd(36)} exports: ${(r.exports || []).join(', ')}`); continue }
    const inj = r.inject.length ? `needs[${r.inject.join(' ')}]` : ''
    const pro = r.provide.length ? `provides[${r.provide.join(' ')}]` : ''
    console.log(`  ${short(r.name).padEnd(36)} ${(r.pluginName || '').padEnd(26)} ${pro} ${inj}`)
  }
}

// The union of every declared service, split into provided vs merely required.
const provided = new Set(rows.flatMap(r => r.provide || []))
const needed = new Set(rows.flatMap(r => r.inject || []))
const unmet = [...needed].filter(s => !provided.has(s)).sort()
console.log(`\n=== services provided by this set (${provided.size}) ===`)
console.log([...provided].sort().join('  '))
console.log(`\n=== required but NOT provided by this set (${unmet.length}) ===`)
console.log(unmet.join('  ') || '(none)')
console.log('\nEach unmet service is either a seam cf-* must implement, or a package we wrongly excluded.')
