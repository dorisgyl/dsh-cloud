// Load the real page in a real browser and report whether it mounts.
//
// The static gates in `check-web-boot.mjs` answer "can the page start". This
// answers "did it finish", and the difference is not academic: following
// upstream to 0.1.0-rc.8 produced a deployment where every plugin activated,
// the boot spinner sat at 100%, the console was empty, and the application
// never appeared. The shell's last step is
//
//     await ctx.inject(['uiRenderer'], ...)
//
// and `inject` has no timeout, so a missing provider is not an error — it is a
// wait. Nothing static saw it. This did, on the first run.
//
// It is deliberately NOT part of `build:edge`. It needs a browser and a live
// agent Worker, neither of which a build can assume, and a gate that cannot run
// everywhere gets disabled everywhere. Run it before a deploy that changed the
// browser side:
//
//     npx wrangler dev --config units/session-do/wrangler.jsonc --local --port 8787
//     npm run check:page
//
// Environment: DSH_API overrides the agent Worker origin, CHROME overrides the
// browser binary, DSH_PAGE_TIMEOUT_MS overrides the 25s budget.
//
// What it stands in for is U1: static files as they are, the SPA document with
// the generated boot head prepended, and /api forwarded to the session object
// with the prefix stripped — WebSockets included, because the event downlinks
// are WebSockets and a boot that cannot open them retries forever behind the
// splash, which would manufacture the very symptom under test. Identity and
// admission are U1's other half and are not what this asks about; Access cannot
// be satisfied from a script anyway.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'

const PUBLIC = resolve('./units/edge/public')
const FRAGMENT = resolve('./units/edge/build/boot-head.json')
const API = process.env.DSH_API ?? 'http://127.0.0.1:8787'
const BUDGET_MS = Number(process.env.DSH_PAGE_TIMEOUT_MS ?? 25000)
const PAGE_PORT = 8123
const DEBUG_PORT = 9333

const CHROMES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)

/** Skip loudly rather than fail: a missing browser is not a broken page. */
function give(reason) {
  console.log(`\nSKIPPED - ${reason}`)
  process.exitCode = 0
  process.exit(0)
}

const chrome = CHROMES.find((path) => existsSync(path))
if (!chrome) give(`no Chrome found. Set CHROME=<path>. Looked in:\n  ${CHROMES.join('\n  ')}`)
if (!existsSync(FRAGMENT)) give(`${FRAGMENT} is missing -- run \`npm run build:edge\` first`)
try {
  await fetch(`${API}/state?tree=0`, { signal: AbortSignal.timeout(4000) })
} catch {
  give(`no agent Worker at ${API}.\n  npx wrangler dev --config units/session-do/wrangler.jsonc --local --port 8787`)
}

// ---------------------------------------------------------------- stand-in U1
const TYPES = {
  '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.png': 'image/png',
}
// Read per request, so a rebuild between runs is picked up rather than cached
// into a measurement that describes the previous build.
const bootHead = () => JSON.parse(readFileSync(FRAGMENT, 'utf8')).html

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const path = decodeURIComponent(url.pathname)

  if (path.startsWith('/api/')) {
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined
      : await new Promise((done) => { const parts = []; req.on('data', (d) => parts.push(d)); req.on('end', () => done(Buffer.concat(parts))) })
    try {
      const upstream = await fetch(API + path.slice('/api'.length) + url.search, {
        method: req.method,
        headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
        body,
      })
      const text = await upstream.text()
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
      return res.end(text)
    } catch (error) {
      res.writeHead(502, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: 'proxy-failed', detail: String(error?.message ?? error) }))
    }
  }

  if (path === '/' || path === '/index.html') {
    const html = readFileSync(join(PUBLIC, 'index.html'), 'utf8')
    const at = html.indexOf('<head>') + '<head>'.length
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(html.slice(0, at) + bootHead() + html.slice(at))
  }

  const file = resolve(PUBLIC, '.' + path)
  if (!file.startsWith(PUBLIC) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ error: 'not-found', path }))
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
  res.end(readFileSync(file))
})

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x')
  if (!url.pathname.startsWith('/api/')) return socket.destroy()
  const wss = new WebSocketServer({ noServer: true })
  wss.handleUpgrade(req, socket, head, (client) => {
    const upstream = new WebSocket(API.replace(/^http/, 'ws') + url.pathname.slice('/api'.length) + url.search)
    const queued = []
    upstream.on('open', () => { for (const message of queued.splice(0)) upstream.send(message) })
    client.on('message', (m) => (upstream.readyState === 1 ? upstream.send(m) : queued.push(m)))
    upstream.on('message', (m) => client.readyState === 1 && client.send(m))
    const bye = () => { try { client.close() } catch { /* already gone */ } try { upstream.close() } catch { /* already gone */ } }
    client.on('close', bye); upstream.on('close', bye); upstream.on('error', bye)
  })
})
await new Promise((ready) => server.listen(PAGE_PORT, ready))

// ------------------------------------------------------------------- a browser
const profile = mkdtempSync(join(tmpdir(), 'dsh-page-'))
const browser = spawn(chrome, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' })

const cleanup = () => {
  try { browser.kill() } catch { /* already gone */ }
  try { server.close() } catch { /* already gone */ }
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }) } catch { /* windows holds it briefly */ }
}
process.on('exit', cleanup)

/** The devtools endpoint takes a moment to bind. */
async function targets() {
  for (let attempt = 0; attempt < 40; attempt++) {
    try { return await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json() } catch { await new Promise((r) => setTimeout(r, 250)) }
  }
  throw new Error('the devtools endpoint never answered')
}
const target = (await targets()).find((t) => t.type === 'page')
const cdp = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false })
let seq = 0
const waiting = new Map()
const call = (method, params) => new Promise((done) => { const mine = ++seq; waiting.set(mine, done); cdp.send(JSON.stringify({ id: mine, method, params })) })

const problems = []
cdp.on('message', (raw) => {
  const message = JSON.parse(String(raw))
  if (waiting.has(message.id)) { waiting.get(message.id)(message.result); waiting.delete(message.id); return }
  const { method, params } = message
  if (method === 'Runtime.exceptionThrown') problems.push(`exception: ${params.exceptionDetails.exception?.description ?? params.exceptionDetails.text}`)
  if (method === 'Runtime.consoleAPICalled' && params.type === 'error') {
    problems.push(`console.error: ${params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`)
  }
  if (method === 'Network.responseReceived' && params.response.status >= 400) problems.push(`http ${params.response.status}: ${params.response.url}`)
  if (method === 'Network.loadingFailed' && params.type !== 'Image') problems.push(`request failed: ${params.errorText}`)
})
await new Promise((open) => cdp.on('open', open))
await call('Runtime.enable'); await call('Network.enable'); await call('Page.enable')

console.log(`loading http://127.0.0.1:${PAGE_PORT}/  (api -> ${API})`)
await call('Page.navigate', { url: `http://127.0.0.1:${PAGE_PORT}/` })

// Mounted means the boot splash removed itself and something replaced it. The
// splash also renders its own failure list, which is worth reading back.
const LOOK = `(() => {
  const splash = document.querySelector('[data-dsh-boot]')
  const root = document.getElementById('root')
  return JSON.stringify({
    mounted: splash === null && root !== null && root.children.length > 0,
    splash: splash ? (splash.innerText || '').replace(/\\s+/g, ' ').trim() : null,
    visible: ((document.body || {}).innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 240),
  })
})()`

const started = Date.now()
let state = { mounted: false, splash: null, visible: '' }
while (Date.now() - started < BUDGET_MS) {
  const answer = await call('Runtime.evaluate', { expression: LOOK, returnByValue: true })
  try { state = JSON.parse(answer?.result?.value ?? '{}') } catch { /* mid-navigation */ }
  if (state.mounted) break
  await new Promise((r) => setTimeout(r, 500))
}

const seconds = ((Date.now() - started) / 1000).toFixed(1)
if (state.mounted) {
  console.log(`\nmounted in ${seconds}s`)
  console.log(`  ${state.visible.slice(0, 160)}`)
} else {
  console.log(`\nNOT mounted after ${seconds}s`)
  console.log(`  the page still shows: ${state.splash ?? state.visible ?? '(nothing)'}`)
  if (state.splash && !/Failed to load plugins/.test(state.splash)) {
    console.log('  no failure was reported, so this is a wait rather than an error --')
    console.log('  the usual cause is a service the shell injects that no staged plugin provides')
  }
}

const distinct = [...new Set(problems)]
if (distinct.length) {
  console.log(`\nbrowser reported ${distinct.length} problem(s):`)
  for (const problem of distinct.slice(0, 25)) console.log(`  ${problem}`)
}

cdp.close()
cleanup()
if (!state.mounted) throw new Error(`the page did not mount within ${BUDGET_MS}ms`)
console.log('\nOK - the application mounted')
