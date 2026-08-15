// Answer the three client questions M0 left open, because each of them can
// still invalidate a design decision:
//
//   1. Does the upstream client run outside a browser? (design 8.4 assumes a
//      Node CLI and the test harness can drive the same /remote clients)
//   2. What does it do when it reconnects to a session with a turn in flight?
//      (design 6.6 assumes this is free because it is the same as refreshing
//      the page mid-stream)
//   3. Does the UI render tool panels from the registry, or hardcode them?
//      (design 8.2 is five changes and ADR-04 caps patches at three; a
//      hardcoded panel list makes it six and spends a patch)
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.argv[2]

// Globals that only exist in a browser. `document` and `window` are the ones
// that decide whether a package can be imported under Node at all.
const BROWSER = /\b(document|window|navigator|localStorage|sessionStorage|HTMLElement|customElements)\b/

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(path, out) }
    else if (/\.(js|mjs)$/.test(entry.name)) out.push(path)
  }
  return out
}

function scan(pkg) {
  const dir = join(ROOT, pkg)
  let files = []
  try { if (!statSync(dir).isDirectory()) return null; files = walk(dir) } catch { return null }
  const hits = new Map()
  let bytes = 0
  for (const file of files) {
    bytes += statSync(file).size
    const source = readFileSync(file, 'utf8')
    for (const line of source.split('\n')) {
      const code = line.replace(/\/\/.*$/, '').replace(/(['"`]).*?\1/g, '""')
      const match = code.match(BROWSER)
      if (match) hits.set(match[1], (hits.get(match[1]) ?? 0) + 1)
    }
  }
  return { pkg, kb: Math.round(bytes / 1024), globals: Object.fromEntries(hits) }
}

const packages = readdirSync(ROOT).filter((n) => n.startsWith('dsh-client'))
const results = packages.map(scan).filter(Boolean)

const clean = results.filter((r) => !Object.keys(r.globals).length)
const browserBound = results.filter((r) => Object.keys(r.globals).length)

console.log(`=== client packages: ${results.length} ===`)
console.log(`no browser globals (importable under Node): ${clean.length}`)
console.log('  ' + clean.map((r) => r.pkg.replace('dsh-client-', '')).join('  '))
console.log(`\nbrowser-bound: ${browserBound.length}`)
for (const r of browserBound.sort((a, b) => b.kb - a.kb)) {
  console.log(`  ${r.pkg.padEnd(38)} ${String(r.kb).padStart(5)} KB  ${JSON.stringify(r.globals)}`)
}
