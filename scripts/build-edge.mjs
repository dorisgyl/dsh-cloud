// Bundle U1. Much simpler than the session unit: the edge deliberately carries
// no upstream agent code, so none of the workerd compatibility shims apply.
import * as esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['./units/edge/src/index.mjs'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  conditions: ['workerd', 'worker', 'browser', 'import', 'module', 'default'],
  external: ['node:*', 'cloudflare:*'],
  outfile: './units/edge/build/edge.bundle.js',
  logLevel: 'info',
})
console.log('edge bundled')
