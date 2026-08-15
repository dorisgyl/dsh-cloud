// Diff two /state snapshots, so a measurement can isolate what one batch of
// turns added to a log that already had history in it.
import { readFileSync } from 'node:fs'

const before = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const after = JSON.parse(readFileSync(process.argv[3], 'utf8'))
const turns = Number(process.argv[4] ?? 1)

const was = Object.fromEntries(before.durable.byType.map((x) => [x.type, x]))
const rows = after.durable.byType
  .map((x) => {
    const prev = was[x.type] ?? { n: 0, bytes: 0 }
    return { type: x.type, count: x.n - prev.n, bytes: x.bytes - prev.bytes }
  })
  .filter((r) => r.count || r.bytes)
  .sort((a, b) => b.bytes - a.bytes)

const total = rows.reduce((sum, r) => sum + r.bytes, 0)
const events = after.durable.eventCount - before.durable.eventCount

console.log(`${turns} turns: +${events} events, +${(total / 1024).toFixed(0)} KB`)
console.log(`per turn: ${(events / turns).toFixed(1)} events, ${(total / 1024 / turns).toFixed(2)} KB`)
console.log('\ntype                   +count      +KB   % of delta   avg bytes')
for (const r of rows) {
  console.log(
    r.type.padEnd(22) +
    String(r.count).padStart(7) +
    (r.bytes / 1024).toFixed(1).padStart(9) +
    (100 * r.bytes / total).toFixed(1).padStart(13) +
    String(r.count ? Math.round(r.bytes / r.count) : 0).padStart(12),
  )
}
