// Parse `wrangler tail --format json` output.
//
// Two things make this necessary rather than a one-liner:
//   * the output is pretty-printed objects concatenated, not JSON lines, so it
//     needs brace counting rather than a split on newlines;
//   * `Date.now()` inside a Worker only advances on I/O, so every duration the
//     Worker measures itself reads as 0 once deployed. wallTime and cpuTime from
//     the platform are the only real timings available on Cloudflare.
import { readFileSync } from 'node:fs'

const text = readFileSync(process.argv[2], 'utf8')
const events = []
let depth = 0, start = -1
for (let i = 0; i < text.length; i++) {
  const ch = text[i]
  if (ch === '{') { if (depth === 0) start = i; depth++ }
  else if (ch === '}') {
    depth--
    if (depth === 0 && start >= 0) {
      try { events.push(JSON.parse(text.slice(start, i + 1))) } catch { /* partial */ }
      start = -1
    }
  }
}

const requests = events.filter((e) => typeof e.cpuTime === 'number')
if (!requests.length) {
  console.log('no request records found')
  process.exit(0)
}

const cpu = requests.map((r) => r.cpuTime).sort((a, b) => a - b)
const wall = requests.map((r) => r.wallTime).sort((a, b) => a - b)
const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))]

console.log(`records: ${requests.length}`)
console.log(`outcomes: ${JSON.stringify(count(requests.map((r) => r.outcome)))}`)
console.log(`execution: ${JSON.stringify(count(requests.map((r) => r.executionModel)))}`)
console.log(`cpuTime  ms  min ${cpu[0]}  p50 ${pct(cpu, 0.5)}  p95 ${pct(cpu, 0.95)}  max ${cpu[cpu.length - 1]}`)
console.log(`wallTime ms  min ${wall[0]}  p50 ${pct(wall, 0.5)}  p95 ${pct(wall, 0.95)}  max ${wall[wall.length - 1]}`)

const exceptions = requests.flatMap((r) => r.exceptions ?? [])
if (exceptions.length) {
  console.log(`\nexceptions: ${exceptions.length}`)
  for (const e of exceptions.slice(0, 5)) console.log(`  ${e.name}: ${String(e.message).slice(0, 180)}`)
}

console.log('\nper record (cpu / wall / outcome):')
for (const r of requests.slice(0, 25)) {
  const url = r.event?.request?.url ?? r.event?.cron ?? r.executionModel
  console.log(`  ${String(r.cpuTime).padStart(6)} / ${String(r.wallTime).padStart(7)} / ${r.outcome.padEnd(8)} ${String(url).slice(-58)}`)
}

function count(list) {
  const out = {}
  for (const x of list) out[x] = (out[x] ?? 0) + 1
  return out
}
