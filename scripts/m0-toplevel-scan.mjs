// M0: scan U2's packages for workerd-forbidden operations at MODULE SCOPE.
//
// workerd disallows, in global scope: async I/O (fetch/connect), arming timers
// (setTimeout/setInterval) and generating random values. Node has no such rule,
// so upstream code written for Node does this freely.
//
// This is a heuristic pre-filter, not a gate. It cannot catch every case — the
// real M0 failure was `new AbortController()`, which appears on no list of
// dangerous APIs. Only booting workerd is authoritative.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = './units/session-do/node_modules/@deepseek-ai'
const BANNED = /\b(randomUUID|getRandomValues|randomBytes|Math\.random|setTimeout|setInterval|fetch)\s*\(/

function walk(d, out = []) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name)
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, out) }
    else if (/\.(js|mjs)$/.test(e.name)) out.push(p)
  }
  return out
}

// Crude module-scope test: track unclosed brace/paren depth up to the line;
// depth 0 means module scope.
function topLevelHits(src) {
  const hits = []
  let depth = 0
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const code = line.replace(/\/\/.*$/, '').replace(/(['"`]).*?\1/g, '""')
    if (depth === 0 && BANNED.test(code)) hits.push({ line: i + 1, text: line.trim().slice(0, 110) })
    for (const ch of code) { if (ch === '{' || ch === '(') depth++; else if (ch === '}' || ch === ')') depth-- }
    if (depth < 0) depth = 0
  }
  return hits
}

const results = []
for (const pkg of readdirSync(ROOT)) {
  const dir = join(ROOT, pkg)
  if (!statSync(dir).isDirectory()) continue
  let files = []; try { files = walk(dir) } catch { continue }
  for (const f of files) {
    const hits = topLevelHits(readFileSync(f, 'utf8'))
    if (hits.length) results.push({ pkg, file: relative(dir, f), hits })
  }
}

if (!results.length) console.log('No module-scope forbidden operations found (heuristic).')
for (const r of results) {
  console.log(`\n[${r.pkg}] ${r.file}`)
  for (const h of r.hits) console.log(`   L${h.line}: ${h.text}`)
}
console.log(`\nfiles matched: ${results.length}  packages: ${[...new Set(results.map(r => r.pkg))].length}`)
