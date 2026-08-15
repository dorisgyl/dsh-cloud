// M1 (3) acceptance: a turn outlives the client that asked for it.
//
// Sequence: connect, send a prompt, drop the socket immediately, wait, then
// reconnect and check that the events produced while nobody was listening are
// there. This is the demonstrable property the whole cloud host exists for —
// a local dsh cannot do it, because its process belongs to the terminal you
// closed.
const BASE = process.argv[2] ?? 'http://127.0.0.1:8809'
const WS = BASE.replace(/^http/, 'ws')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS)
    const replay = new Promise((res) => {
      ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data)
        if (msg.type === 'replay') res(msg.events)
      })
    })
    ws.addEventListener('open', () => resolve({ ws, replay }))
    ws.addEventListener('error', reject)
  })
}

async function state() {
  return (await fetch(`${BASE}/state`)).json()
}

console.log('--- 1. connect ---')
const first = await connect()
const before = await first.replay
console.log(`   replayed ${before.length} events on connect`)

console.log('--- 2. send a prompt, then drop the socket at once ---')
first.ws.send(JSON.stringify({ prompt: 'work while I am gone' }))
await sleep(50)
first.ws.close()
console.log('   socket closed')

console.log('--- 3. wait with nobody listening ---')
await sleep(4000)
const mid = await state()
console.log(`   durable events now ${mid.durable.eventCount}, queue ${JSON.stringify(mid.queue)}, sockets ${mid.sockets}`)

console.log('--- 4. reconnect ---')
const second = await connect()
const after = await second.replay
console.log(`   replayed ${after.length} events on reconnect`)

const grew = after.length - before.length
const types = {}
for (const e of after.slice(before.length)) types[e.type] = (types[e.type] ?? 0) + 1
console.log(`   gained ${grew} events while disconnected:`)
console.log(`   ${JSON.stringify(types)}`)

const contiguous = after.every((e, i) => e.seq === i)
const completed = mid.queue.completed >= 1

console.log('\n=== verdict ===')
console.log(`turn ran with no client attached : ${grew > 0 ? 'YES' : 'NO'}`)
console.log(`prompt marked completed          : ${completed ? 'YES' : 'NO'}`)
console.log(`log contiguous, no gaps          : ${contiguous ? 'YES' : 'NO'}`)
second.ws.close()
process.exit(grew > 0 && completed && contiguous ? 0 : 1)
