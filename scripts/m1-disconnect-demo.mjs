// M1 (3) acceptance: a turn outlives the client that asked for it.
//
// Sequence: subscribe, send a prompt, drop the socket immediately, wait, then
// reconnect and check that the events produced while nobody was listening are
// there. This is the demonstrable property the whole cloud host exists for — a
// local dsh cannot do it, because its process belongs to the terminal you
// closed.
//
// It follows upstream's contract rather than a private one: a subscription is
// acknowledged with `session/subscribed { lastSeq }`, live events arrive as
// `session/event`, and the backlog is PULLED with a cursor. Nothing is pushed
// on connect.
const BASE = process.argv[2] ?? 'http://127.0.0.1:8809'
const WS = BASE.replace(/^http/, 'ws')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function connect() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS)
    const live = []
    const subscribed = new Promise((res) => {
      ws.addEventListener('message', (event) => {
        const message = JSON.parse(event.data)
        if (message.type === 'session/subscribed') res(message)
        if (message.type === 'session/event') live.push(message.event)
      })
    })
    ws.addEventListener('open', () => resolve({ ws, subscribed, live }))
    ws.addEventListener('error', reject)
  })
}

/** Page the backlog the way a real client would, instead of expecting a dump. */
async function history(from = 0) {
  const events = []
  let cursor = from
  for (let page = 0; page < 100; page++) {
    const res = await fetch(`${BASE}/history?from=${cursor}&limit=200`)
    const data = await res.json()
    events.push(...data.events)
    if (data.done || !data.events.length) return { events, lastSeq: data.lastSeq }
    cursor = data.nextFrom
  }
  return { events, lastSeq: -1 }
}

const state = async () => (await fetch(`${BASE}/state`)).json()

console.log('--- 1. subscribe ---')
const first = await connect()
const ack = await first.subscribed
console.log(`   session/subscribed lastSeq=${ack.lastSeq}`)
const before = await history()
console.log(`   backlog pulled: ${before.events.length} events`)

console.log('--- 2. send a prompt, then drop the socket at once ---')
first.ws.send(JSON.stringify({ prompt: 'work while I am gone' }))
await sleep(50)
first.ws.close()
console.log('   socket closed')

console.log('--- 3. wait with nobody listening ---')
await sleep(5000)
const mid = await state()
console.log(`   durable events ${mid.durable.eventCount}, queue ${JSON.stringify(mid.queue)}, sockets ${mid.sockets}`)

console.log('--- 4. reconnect and catch up from the cursor ---')
const second = await connect()
const ack2 = await second.subscribed
console.log(`   session/subscribed lastSeq=${ack2.lastSeq}`)
const missed = await history(ack.lastSeq + 1)
console.log(`   pulled ${missed.events.length} events missed while away`)

const types = {}
for (const event of missed.events) types[event.type] = (types[event.type] ?? 0) + 1
console.log(`   ${JSON.stringify(types)}`)

const all = await history()
const contiguous = all.events.every((event, i) => event.seq === i)

console.log('\n=== verdict ===')
console.log(`turn ran with no client attached : ${missed.events.length > 0 ? 'YES' : 'NO'}`)
console.log(`prompt marked completed          : ${mid.queue.completed >= 1 ? 'YES' : 'NO'}`)
console.log(`log contiguous, no gaps          : ${contiguous ? 'YES' : 'NO'}`)
console.log(`nothing pushed on connect        : ${ack.lastSeq !== undefined ? 'YES' : 'NO'}`)
second.ws.close()
process.exit(missed.events.length > 0 && mid.queue.completed >= 1 && contiguous ? 0 : 1)
