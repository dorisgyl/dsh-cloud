// Bundle U1 and stage the UI it serves.
//
// The dsh web UI does not have to be built: upstream publishes the compiled SPA
// in @deepseek-ai/dsh-web-frontend/dist — 89 files, 4.6 MB, index.html and all.
// So U1 copies it into the assets directory rather than compiling 40 client
// packages, and Workers Static Assets serves it from the same origin as /api,
// which is what removes CORS and cross-origin WebSocket configuration entirely
// (design 8.3).
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

// --- the Worker -------------------------------------------------------------
await esbuild.build({
  entryPoints: [join(root, 'units/edge/src/index.mjs')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  conditions: ['workerd', 'worker', 'browser', 'import', 'module', 'default'],
  external: ['node:*', 'cloudflare:*'],
  outfile: join(root, 'units/edge/build/edge.bundle.js'),
  logLevel: 'info',
})
console.log('edge bundled')
