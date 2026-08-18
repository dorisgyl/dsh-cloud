// Does a WebSocket upgrade survive hostname-based Access with a service token?
// This is the entire reason the design must not use Worker-level Access, and it
// had not been verified against a live deployment.
import { readFileSync } from 'node:fs'
import WebSocket from 'ws'

const env = Object.fromEntries(
  readFileSync('.access-token', 'utf8').trim().split('\n').map((l) => l.split('=')),
)
const url = process.env.DSH_URL ?? 'wss://dsh-cloud-demo.nevoflux.app/api/'
const ws = new WebSocket(url, {
  headers: {
    'CF-Access-Client-Id': env.CF_ACCESS_CLIENT_ID,
    'CF-Access-Client-Secret': env.CF_ACCESS_CLIENT_SECRET,
  },
})

const done = (code, msg) => { console.log(msg); try { ws.close() } catch {} ; process.exit(code) }
setTimeout(() => done(1, 'TIMEOUT: no upgrade within 20s'), 20000)

ws.on('unexpected-response', (_req, res) => done(1, `UPGRADE REFUSED: HTTP ${res.statusCode}`))
ws.on('error', (e) => done(1, `ERROR: ${e.message}`))
ws.on('open', () => console.log('upgrade OK'))
ws.on('message', (data) => {
  const m = JSON.parse(String(data))
  console.log('received:', JSON.stringify(m).slice(0, 160))
  if (m.type === 'session/subscribed') done(0, 'WebSocket through Access: WORKS')
})
