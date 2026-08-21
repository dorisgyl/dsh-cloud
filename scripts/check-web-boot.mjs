// Run the browser's boot prelude outside a browser, and assert it can boot.
//
// This check exists because of an outage it would have prevented. Following
// upstream to 0.1.0-rc.8 left the page dead on
//
//     web boot: window.__ModuleLoader__ bootstrap facade is missing
//
// while every check in this repository passed: the agent Worker booted clean
// in workerd, the seam shapes matched, the bundles built. None of them looked
// at the browser, and the browser is where half of this deployment runs.
//
// rc.8 lifted the module loader out of the shell. The boot protocol became
// three ordered pieces -- an inline queue-mode `window.__ModuleLoader__`, two
// blocking classic scripts, then the graph -- and this repository was still
// injecting the one piece that was the whole protocol at rc.6.
//
// So: take the fragment U1 actually injects, execute it the way a parser would,
// and assert the page reaches the state the shell demands before it runs. No
// DOM is involved up to that point, which is why this can be a plain script.
//
//   node scripts/check-web-boot.mjs
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createContext, runInContext } from 'node:vm'

const PUBLIC = './units/edge/public'
const FRAGMENT = './units/edge/build/boot-head.json'

if (!existsSync(FRAGMENT)) {
  throw new Error(`${FRAGMENT} is missing -- run \`npm run build:edge\` first`)
}
const html = JSON.parse(readFileSync(FRAGMENT, 'utf8')).html

/** The script elements of the fragment, in the order a parser would run them. */
function scriptsOf(source) {
  const found = []
  const pattern = /<script(?:\s+src="([^"]*)")?\s*>([\s\S]*?)<\/script>/g
  let match
  while ((match = pattern.exec(source)) !== null) {
    found.push(match[1] ? { kind: 'src', url: match[1] } : { kind: 'inline', code: match[2] })
  }
  return found
}

const failures = []
const note = (ok, what) => { if (!ok) failures.push(what); console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}`) }

// A window object is all the prelude touches. If a future upstream prelude
// needs more of the DOM, it will say so by throwing here rather than in
// somebody's browser.
const sandbox = { console }
sandbox.window = sandbox
sandbox.globalThis = sandbox
const context = createContext(sandbox)

console.log('boot prelude, executed in parser order:')
const scripts = scriptsOf(html)
note(scripts.length > 0, `the fragment contains ${scripts.length} script element(s)`)

for (const script of scripts) {
  if (script.kind === 'inline') {
    runInContext(script.code, context, { filename: 'inline-boot-script' })
    note(true, 'inline script ran')
    continue
  }
  const file = join(PUBLIC, script.url.replace(/^\//, ''))
  if (!existsSync(file)) { note(false, `${script.url} is served by U1 (file missing at ${file})`); continue }
  runInContext(readFileSync(file, 'utf8'), context, { filename: script.url })
  note(true, `${script.url} ran`)
}

console.log('\nthe state the shell reads before it renders:')
const loader = sandbox.__ModuleLoader__
note(loader !== undefined, 'window.__ModuleLoader__ is installed')
note(typeof loader?.create === 'function', 'the facade exposes create()')
note(typeof sandbox.__DSH_BOOT__ === 'object' && sandbox.__DSH_BOOT__ !== null, 'window.__DSH_BOOT__ is an object')

// The one thing create() checks before doing anything else: the modules bundle
// registered itself into the queue, and its factory yields the bootstrap face.
// Getting this far is the difference between a working page and the blank one.
const BOOTSTRAP = '@deepseek-ai/dsh-client-modules'
const queued = loader?.pendingQueue?.find((registration) => registration.id === BOOTSTRAP)
note(queued !== undefined, `${BOOTSTRAP} registered itself into the queue`)
if (queued !== undefined) {
  const reject = (specifier) => { throw new Error(`bootstrap requested "${specifier}" before the module system existed`) }
  const exports = queued.factory(reject)
  note(typeof exports?.createClientModuleSystem === 'function' && typeof exports?.apply === 'function',
    'the bootstrap bundle exports the module-system face create() requires')
}

// The shell's own last step, which is not a module edge and so appears in no
// manifest: `mountApp` does `ctx.inject(["uiRenderer"], ...)` and waits for that
// SERVICE. `inject` has no timeout. A roster missing its provider gives a page
// with every plugin active, an empty console, and a spinner that never stops --
// which is exactly how this deployment shipped once.
//
// The names are read out of the shell rather than listed here, so the day
// upstream awaits a second service this fails instead of hanging.
console.log('\nservices the shell waits for before it mounts:')
const shellDir = join(PUBLIC, 'assets')
const shellFile = existsSync(shellDir) && readdirSync(shellDir).find((f) => f.startsWith('index-') && f.endsWith('.js'))
const shell = shellFile ? readFileSync(join(shellDir, shellFile), 'utf8') : ''
note(shell !== '', 'the shell bundle is present')
const awaited = new Set()
for (const call of shell.matchAll(/\.inject\(\[([^\]]{0,200})\]/g)) {
  for (const quoted of call[1].matchAll(/["']([a-zA-Z][a-zA-Z0-9_.]{1,30})["']/g)) awaited.add(quoted[1])
}
note(awaited.size > 0, `the shell awaits ${awaited.size} service(s): ${[...awaited].join(', ') || 'none found'}`)
const staged = existsSync(join(PUBLIC, 'client'))
  ? readdirSync(join(PUBLIC, 'client')).map((f) => ({ file: f, text: readFileSync(join(PUBLIC, 'client', f), 'utf8') }))
  : []
for (const service of awaited) {
  // Mentioning the name is a weak test and a sufficient one: a service nothing
  // in the roster even names cannot be provided by it.
  const providers = staged.filter((b) => b.text.includes(service)).map((b) => b.file.replace('.js', ''))
  note(providers.length > 0, `${service} is named by a staged bundle (${providers.slice(0, 3).join(', ') || 'NOBODY'})`)
}

console.log('\nthe graph the loader will fetch:')
const entries = sandbox.__DSH_BOOT__?.entries ?? []
const orphans = entries.filter((entry) => !existsSync(join(PUBLIC, entry.url.replace(/^\//, ''))))
note(entries.length > 0, `${entries.length} entries`)
note(orphans.length === 0, orphans.length === 0
  ? 'every entry has a bundle on disk'
  : `these entries have no bundle: ${orphans.map((o) => o.id).join(', ')}`)

// Throwing rather than exiting: build-edge imports this as its last gate, and a
// process.exit(0) on success would end the build before the Worker is bundled.
// An uncaught throw is a non-zero exit when run directly and a failed build when
// imported, which is the same answer in both places.
if (failures.length > 0) {
  console.log(`\nFAILED - ${failures.length} check(s): the page would not boot`)
  throw new Error(`web boot check failed: ${failures.join('; ')}`)
}
console.log('\nOK - the page reaches plugin boot')
