// Bundle U1 and stage the UI it serves.
//
// Half the UI does not have to be built: upstream publishes the compiled SHELL
// in @deepseek-ai/dsh-web-frontend/dist — index.html, the React shell, KaTeX
// fonts and lazy syntax-highlight chunks. What it does NOT publish is the
// composition: its dependencies are react, react-dom and dsh-client-web, not one
// dsh-client-* plugin, and its README says so plainly — "composition is entirely
// the host graph's". scripts/build-client.mjs stages that half.
//
// Workers Static Assets serves both from the same origin as /api, which is what
// removes CORS and cross-origin WebSocket configuration entirely (design 8.3).
import { cpSync, mkdirSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import * as esbuild from 'esbuild'

const require = createRequire(import.meta.url)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const publicDir = join(root, 'units/edge/public')

// --- the UI -----------------------------------------------------------------
const frontendPkg = require.resolve('@deepseek-ai/dsh-web-frontend/package.json', {
  paths: [join(root, 'units/edge')],
})
const dist = join(dirname(frontendPkg), 'dist')
if (!existsSync(dist)) throw new Error(`no built frontend at ${dist}`)

// Overwrite rather than clear. On Windows the asset directories are routinely
// held open by a watcher and rmdir fails with EBUSY, which has nothing to do
// with the build. The frontend's filenames are content-hashed, so a stale file
// is unreferenced rather than wrong; `pnpm clean` is the way to reclaim them.
mkdirSync(publicDir, { recursive: true })
cpSync(dist, publicDir, { recursive: true, force: true })

const count = (dir) => readdirSync(dir, { withFileTypes: true })
  .reduce((n, e) => n + (e.isDirectory() ? count(join(dir, e.name)) : 1), 0)
const bytes = (dir) => readdirSync(dir, { withFileTypes: true })
  .reduce((n, e) => n + (e.isDirectory() ? bytes(join(dir, e.name)) : statSync(join(dir, e.name)).size), 0)
console.log(`ui: ${count(publicDir)} files, ${(bytes(publicDir) / 1048576).toFixed(1)} MB`)

// --- the client plugin graph -------------------------------------------------
// After the shell is staged, because it writes into the same public directory.
await import('./build-client.mjs')

// --- the Worker -------------------------------------------------------------
await esbuild.build({
  entryPoints: [join(root, 'units/edge/src/index.mjs')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  conditions: ['workerd', 'worker', 'browser', 'import', 'module', 'default'],
  external: ['node:*', 'cloudflare:*'],
  // The boot manifest is compiled into the Worker rather than fetched: it is a
  // build artifact of the same build, and reading it at request time would add
  // a subrequest to every page load for a file that cannot change between them.
  loader: { '.json': 'json' },
  outfile: join(root, 'units/edge/build/edge.bundle.js'),
  logLevel: 'info',
})
console.log('edge bundled')
