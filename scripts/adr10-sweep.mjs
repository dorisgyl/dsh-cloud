// Sweep the ADR-10 question: what share of the session log is assistant/chunk?
//
// Every previous answer came from one measurement under conditions that turned
// out not to generalise — 10.5% with resume-per-turn, 37% after the live-agent
// fix, 19% against a terse real model. So this sweeps the two variables that
// actually drive it instead of sampling once more:
//
//   reply length  — how much text the model produces
//   delta size    — how finely the provider slices it
//
// Each point runs on its own Durable Object so it starts from an empty log.
const BASE = process.argv[2] ?? 'http://127.0.0.1:8819'
const TURNS = Number(process.argv[3] ?? 5)

// A chunk ENTRY costs ~120 bytes of structure however few characters it holds,
// so the count is what matters. 24 characters per delta matches what the real
// model produced (11 entries for a ~250-character reply).
const REPLY_LENGTHS = [100, 250, 500, 1000, 2000, 4000, 8000]
const DELTA_SIZES = [8, 24, 80]

const rows = []
for (const chunk of DELTA_SIZES) {
  for (const reply of REPLY_LENGTHS) {
    const obj = `sweep-r${reply}-c${chunk}`
    const url = `${BASE}/sweep?reply=${reply}&chunk=${chunk}&turns=${TURNS}&obj=${obj}`
    const res = await fetch(url)
    const data = await res.json()
    if (data.failed) {
      console.error(`FAILED reply=${reply} chunk=${chunk}: ${JSON.stringify(data.failed).slice(0, 160)}`)
      continue
    }
    rows.push(data)
    process.stderr.write('.')
  }
}
process.stderr.write('\n')

console.log(`chunk share of the durable session log, ${TURNS} turns per point\n`)
for (const chunk of DELTA_SIZES) {
  console.log(`delta size ${chunk} chars`)
  console.log('  reply chars | chunk entries |  KB/turn | chunk KB | chunk share')
  for (const r of rows.filter((x) => x.chunkChars === chunk)) {
    console.log(
      '  ' + String(r.replyChars).padStart(11) +
      ' | ' + String(r.chunkEntriesPerTurn).padStart(13) +
      ' | ' + (r.bytesPerTurn / 1024).toFixed(1).padStart(8) +
      ' | ' + (r.chunkBytesPerTurn / 1024).toFixed(1).padStart(8) +
      ' | ' + (r.chunkShare + '%').padStart(11),
    )
  }
  console.log()
}

// The fixed cost is what chunks are measured against; state it explicitly so
// the share is interpretable rather than just a number.
const smallest = rows.find((r) => r.replyChars === REPLY_LENGTHS[0] && r.chunkChars === DELTA_SIZES[1])
if (smallest) {
  const fixed = smallest.bytesPerTurn - smallest.chunkBytesPerTurn
  console.log(`per-turn cost that is NOT chunks, at the shortest reply: ${(fixed / 1024).toFixed(1)} KB`)
  console.log('(context snapshots, turn/step boundaries, the assembled message)')
}
