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
import { pathToFileURL } from 'node:url'

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

/** The importable entry point of an upstream package, from the same bases. */
function resolveEntry(name) {
  for (const req of BASES) {
    try { return req.resolve(name) } catch { /* try the next */ }
  }
  throw new Error(`${name} is not installed in any workspace that build-client resolves from`)
}

/**
 * The bundles upstream's boot fragment turns into blocking classic scripts,
 * mirrored here only so the assertion below can name them. Upstream keeps the
 * list private; the assertion is what notices if it stops matching.
 */
const PARSER_PRELOADED = ['@deepseek-ai/dsh-client-modules', '@deepseek-ai/dsh-client-runtime']
const PUBLIC = './units/edge/public'
const CLIENT_DIR = join(PUBLIC, 'client')

// The roster. Everything the closure carries, minus what cannot work here —
// each exclusion is a reason, not a preference.
const EXCLUDE = new Map([
  ['@deepseek-ai/dsh-client-hmr', 'hot module replacement; a dev-server feature with no server to talk to'],
  // dsh-client-modules used to be excluded here as "the loader itself, already
  // inside the shell bundle". That was true at 0.1.0-rc.6 and false at rc.8,
  // and the difference took the whole page down.
  //
  // rc.8 lifted the module loader OUT of the shell. The shell now reads
  // `globalThis.__ModuleLoader__` and throws "web boot: window.__ModuleLoader__
  // bootstrap facade is missing" when nothing installed it; the host installs a
  // queue-mode facade inline and parser-preloads this package's client bundle,
  // which supplies the real implementation. So it is a graph entry now -- the
  // injected preload tag resolves its URL out of `graph.entries`, and an
  // excluded package has no URL to resolve.
  ['@deepseek-ai/dsh-client-web', 'the shell; it is the page, not an entry in its own graph'],
  // dsh-client-web-react and dsh-client-schema-form used to be excluded here as
  // shell internals. They stopped existing at 0.1.0-rc.8: upstream's
  // packages/client/ has no such directory and no rc.8 client package depends
  // on either, so the exclusion has nothing left to exclude. The names stay in
  // this comment because `upstream-closure.json` still lists them — the roster
  // is fed by that crawl, and a reader who greps for them should find out why
  // they are gone rather than find nothing.

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

  // Upstream's official branding, new at 0.1.0-rc.8 and the one client plugin
  // this deployment must NOT install. rc.8 also published BRAND_GUIDELINES.md:
  // "DeepSeek Harness" is a registered trademark, descriptive use is fine, and
  // official brand materials must not be used in a way that suggests
  // endorsement. A third-party port wearing the official marks is exactly that
  // suggestion. The README's "Unofficial. Not affiliated with DeepSeek" says
  // the opposite, and a page carrying both would be lying in one of them.
  ['@deepseek-ai/dsh-client-ui-brand-official', 'BRAND_GUIDELINES.md (rc.8): official marks in a third-party port would imply endorsement'],
])

// The roster is defined by the DECLARATION, not by the package name.
//
// Filtering on a `dsh-client-` prefix looked right and quietly dropped three
// browser plugins that other plugins inject: dsh-api-remotes,
// dsh-typert-registry and dsh-cordis-client-runner all declare
// `dsh.client.platform === "web"` and ship lib/client.js under server-shaped
// names. Upstream's own registry scans declarations for exactly this reason.
//
// The closure is a CRAWL, and a crawl has a date. `upstream-closure.json` was
// taken at 0.1.0-rc.6, so a package upstream added later could not appear in
// the roster no matter what was installed -- and one of them was
// `dsh-client-ui-renderer`, which provides the `uiRenderer` service the shell
// awaits as its final boot step. `ctx.inject()` waits without a timeout, so the
// page sat on "Loading plugins…" with every plugin active, nothing in the
// console, and nothing to read.
//
// So the crawl is one source and not the only one: the packages a unit
// DECLARES are candidates too. Installing a client package is now enough to
// have it considered, which is what everyone already assumed was true.
const declared = ['../units/edge/package.json', '../units/session-do/package.json']
  .flatMap((rel) => Object.keys(JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')).dependencies ?? {}))
const candidates = [...new Set([
  ...Object.keys(JSON.parse(readFileSync('./scripts/upstream-closure.json', 'utf8')).packages),
  ...declared,
])]

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

// Upstream orders the graph before composing it, and says why: a row may
// require another, scan order breaks ties, and a cycle is an error naming the
// packages on it. Alphabetical order happened to work here; ordering is not
// ours to guess, so it is theirs to compute -- before the rev, so the hash
// describes the graph that actually ships.
//
// Resolved through the same workspace bases as every other upstream package: a
// bare import would look in the repository root, which installs esbuild and
// wrangler and no upstream at all.
const upstreamModules = await import(pathToFileURL(resolveEntry('@deepseek-ai/dsh-client-modules')).href)
const { bootInjections, orderByModuleGraph } = upstreamModules
if (typeof bootInjections !== 'function') {
  throw new Error('@deepseek-ai/dsh-client-modules no longer exports bootInjections; the boot protocol moved again')
}
const ordered = typeof orderByModuleGraph === 'function' ? orderByModuleGraph(entries) : entries

// One rev for the whole graph, derived from its contents rather than the clock:
// two builds of the same roster produce the same manifest, so a redeploy that
// changed nothing does not invalidate every client's cache.
const rev = hash(ordered.map((e) => `${e.id}@${e.rev}`).join('|'))
const manifest = { rev, entries: ordered }

mkdirSync('./units/edge/build', { recursive: true })
writeFileSync('./units/edge/build/boot-manifest.json', JSON.stringify(manifest, null, 2))

// The head fragment U1 injects, produced from UPSTREAM's own injection table.
//
// The boot protocol is not just the manifest. Since 0.1.0-rc.8 it is three
// things in one order: an inline queue-mode `window.__ModuleLoader__`, blocking
// classic scripts for the two bundles the parser must execute before the shell
// (dsh-client-modules, dsh-client-runtime), and only then the graph. The shell
// throws on the first one missing, and waits forever on the last.
//
// This repository once had a hand-written copy of that protocol -- one line
// injecting `__DSH_BOOT__` -- which was the whole protocol at rc.6 and a third
// of it at rc.8. Following the version broke the page, in the browser, where
// nothing here was looking. So it is generated, not written.
//
// 0.1.1 changed the shape of the generator without changing the protocol:
// `injectBootManifest(html, graph)` returned finished HTML and is gone;
// `bootInjections(graph)` returns the rows and leaves rendering to the host.
// That suits a Worker better -- U1 injects through HTMLRewriter rather than by
// string surgery -- and it deleted the sentinel-and-slice this used to need.

/** One injection row as head HTML. An unknown row kind is a protocol change. */
function renderInjection(row) {
  const attr = (value) => String(value)
    .replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  // `<` escaped inside JSON so a plugin-controlled string cannot close the
  // script element it is sitting in.
  const json = (value) => JSON.stringify(value).replaceAll('<', '\\u003c')
  switch (row.kind) {
    case 'script': return `<script>${row.text}</script>`
    case 'script-src': return `<script src="${attr(row.src)}"></script>`
    case 'global': return `<script>window.${row.name} = ${json(row.value)}</script>`
    default: throw new Error(`upstream boot injection row kind "${row.kind}" is not one this host renders`)
  }
}

const rows = bootInjections(manifest)
const bootHead = rows.filter((row) => (row.placement ?? 'head') === 'head').map(renderInjection).join('')

// Assert the result rather than trust it. A silently empty or partial fragment
// deploys the same blank page this generation replaced, and both halves of that
// outage were invisible until a browser loaded them.
const required = [
  ['the module-loader facade', '__ModuleLoader__'],
  ['the boot graph', '__DSH_BOOT__'],
  ...PARSER_PRELOADED.map((id) => [`a preload tag for ${id}`, `src="/client/${id.replace('@deepseek-ai/', '')}.js"`]),
]
const missing = required.filter(([, needle]) => !bootHead.includes(needle)).map(([what]) => what)
if (missing.length) {
  throw new Error([
    `the injected boot head is missing ${missing.join(', ')}.`,
    `upstream returned ${rows.length} row(s): ${rows.map((r) => r.kind).join(', ')}`,
    bootHead.slice(0, 300),
  ].join('\n  '))
}
writeFileSync('./units/edge/build/boot-head.json', JSON.stringify({ html: bootHead }, null, 2))

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
