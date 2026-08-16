// Compose the browser side: stage every client plugin bundle and emit the boot
// manifest the shell reads from `window.__DSH_BOOT__`.
//
// This is cf-boot's counterpart for the browser, and it exists because the
// frontend is only half free. `@deepseek-ai/dsh-web-frontend` ships the compiled
// SHELL — its dependencies are react, react-dom and dsh-client-web, and not one
// dsh-client-* plugin. Its own README is explicit: "Composition is entirely the
// host graph's ... the shell makes zero composition decisions." Serving dist/
// verbatim gets a page that throws
//
//     client-modules: window.__DSH_BOOT__ is missing or not an object
//
// before it renders anything, which is exactly what it did.
//
// Each plugin ships its browser build as `lib/client.js`, a classic script that
// registers itself on execution:
//
//     window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-client-x", factory })
//
// and declares its wiring in package.json:
//
//     "dsh": { "client": { "inject": [...], "platform": "web", "immediately": true } }
//
// So composition is: pick the roster, serve the bundles, list them. Upstream's
// own host does this by scanning loaded server plugins at runtime; a Worker has
// no runtime resolution, so the scan happens here at build time — the same move
// design 10.6 makes for the server tree.
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, dirname } from 'node:path'

// Resolve from every workspace that installs upstream packages. The browser
// plugins are split across two: the dsh-client-* set is declared by U1, and the
// three server-shaped ones come in as U2's dependencies. Resolving from one
// place silently skipped the other half.
const BASES = ['../units/edge/package.json', '../units/session-do/package.json', '../package.json']
  .map((rel) => createRequire(new URL(rel, import.meta.url)))

function resolvePkg(name) {
  for (const req of BASES) {
    try { return req.resolve(`${name}/package.json`) } catch { /* try the next */ }
  }
  return undefined
}
const PUBLIC = './units/edge/public'
const CLIENT_DIR = join(PUBLIC, 'client')

// The roster. Everything the closure carries, minus what cannot work here —
// each exclusion is a reason, not a preference.
const EXCLUDE = new Map([
  ['@deepseek-ai/dsh-client-hmr', 'hot module replacement; a dev-server feature with no server to talk to'],
  ['@deepseek-ai/dsh-client-modules', 'the loader itself, already inside the shell bundle'],
  ['@deepseek-ai/dsh-client-web', 'the shell; it is the page, not an entry in its own graph'],
  ['@deepseek-ai/dsh-client-web-react', 'shell internals, bundled with the shell'],

  // Design 8.2 item 1, and it turns out to be a roster line rather than a patch.
  //
  // The two directory pickers both register the single slot
  // "conversation.hero.workspace.directoryFlow", so installing both is a boot
  // failure, not a preference: "already has a registration at priority 0".
  // Upstream expects the deployment to install exactly one.
  //
  // `browse` is the one that matches this deployment: cf-workspace-picker
  // serves the seam's `browse` capability over the container's filesystem, and
  // `native` would call host.pickDirectory, which correctly answers
  // directory-picker-unavailable because there is no desktop to open a dialog
  // on.
  ['@deepseek-ai/dsh-client-ui-directory-picker-native', 'design 8.2 item 1: both pickers claim one single slot; this deployment serves the `browse` capability'],

  // ADR-09: no Worker extensions, so there is no plugin plane to manage. These
  // two are that plane's UI and its transport — they call
  // `dynamicCordisRunner/syncInspectManifest` and `dynamicCordisRunner/inventory`,
  // which this host does not serve and answered 404 twice on every load.
  // Shipping a panel whose every call fails is worse than not shipping it.
  ['@deepseek-ai/dsh-client-ui-cordis', 'ADR-09: the plugin plane is not implemented; its calls 404'],
  ['@deepseek-ai/dsh-cordis-client-runner', 'ADR-09: transport for the plugin plane above'],
])

// The roster is defined by the DECLARATION, not by the package name.
//
// Filtering on a `dsh-client-` prefix looked right and quietly dropped three
// browser plugins that other plugins inject: dsh-api-remotes,
// dsh-typert-registry and dsh-cordis-client-runner all declare
// `dsh.client.platform === "web"` and ship lib/client.js under server-shaped
// names. Upstream's own registry scans declarations for exactly this reason.
const candidates = Object.keys(
  JSON.parse(readFileSync('./scripts/upstream-closure.json', 'utf8')).packages,
)

mkdirSync(CLIENT_DIR, { recursive: true })

const entries = []
const skipped = []
for (const name of candidates.sort()) {
  if (EXCLUDE.has(name)) { skipped.push([name, EXCLUDE.get(name)]); continue }

  const pkgPath = resolvePkg(name)
  if (!pkgPath) continue
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const client = pkg.dsh?.client
  if (!client) continue
  if (client.platform && client.platform !== 'web') {
    skipped.push([name, `dsh.client.platform is "${client.platform}"`]); continue
  }

  const bundle = join(dirname(pkgPath), 'lib', 'client.js')
  if (!existsSync(bundle)) { skipped.push([name, 'declares dsh.client but ships no lib/client.js']); continue }

  // One file per plugin, named after the package. The URL is what the loader
  // fetches, so it has to be stable and collision-free; `@` and `/` are dropped
  // rather than encoded so the path stays readable in a network panel.
  const file = `${name.replace('@deepseek-ai/', '')}.js`
  cpSync(bundle, join(CLIENT_DIR, file))

  entries.push({
    id: name,
    url: `/client/${file}`,
    // The version doubles as the cache key: a plugin that changes ships a new
    // rev, and the loader refetches exactly that one.
    rev: pkg.version,
    ...(client.inject === undefined ? {} : { inject: client.inject }),
    ...(client.immediately === undefined ? {} : { immediately: client.immediately }),
  })
}

// One rev for the whole graph, derived from its contents rather than the clock:
// two builds of the same roster produce the same manifest, so a redeploy that
// changed nothing does not invalidate every client's cache.
const rev = hash(entries.map((e) => `${e.id}@${e.rev}`).join('|'))
const manifest = { rev, entries }

mkdirSync('./units/edge/build', { recursive: true })
writeFileSync('./units/edge/build/boot-manifest.json', JSON.stringify(manifest, null, 2))

// Every injected id must be satisfied by something, or the loader waits on a
// plugin that is never coming and the page stays blank with nothing to read.
// This is a build failure, not a warning: a graph with a hole in it should not
// reach a deployment.
const provided = new Set(entries.map((e) => e.id))
const shellBundle = (() => {
  const dir = join(PUBLIC, 'assets')
  const file = readdirSync(dir).find((f) => f.startsWith('index-') && f.endsWith('.js'))
  return file ? readFileSync(join(dir, file), 'utf8') : ''
})()
const unresolved = []
for (const entry of entries) {
  for (const id of entry.inject ?? []) {
    // The shell registers some modules statically (ui-slots, ui-primitives),
    // and those ship inside its bundle rather than as graph rows. A package id
    // is specific enough that finding it in the bundle text is not a
    // coincidence.
    if (provided.has(id) || shellBundle.includes(id)) continue
    unresolved.push(`${entry.id} injects ${id}`)
  }
}
if (unresolved.length) {
  throw new Error(['client graph has unresolved injects:', ...unresolved].join('\n  '))
}

const bytes = readdirSync(CLIENT_DIR).reduce((n, f) => n + readFileSync(join(CLIENT_DIR, f)).length, 0)
console.log(`client: ${entries.length} plugins, ${(bytes / 1024 / 1024).toFixed(1)} MB, rev ${rev}`)
console.log(`  immediately: ${entries.filter((e) => e.immediately).length}`)
for (const [name, why] of skipped) console.log(`  skipped ${name.replace('@deepseek-ai/', '')}: ${why}`)

/** FNV-1a; short, stable, and not a security boundary. */
function hash(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}
