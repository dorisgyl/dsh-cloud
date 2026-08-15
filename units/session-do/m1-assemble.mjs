// M1 step 1 driver: assemble the U2 plugin tree and report what came up.
//
// Runs under plain Node for fast iteration; the same assemble() is what the
// workerd entry will call. Node and workerd can disagree (M0 found three such
// cases), so a green run here is a precondition, not a proof.
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { assemble, servicesOn, unmetInjects } from '../../packages/cf-boot/src/plugin-tree.mjs'

const specifiers = Object.keys(JSON.parse(readFileSync('../../scripts/u2-deps.json', 'utf8')))

const modules = {}
for (const s of specifiers) modules[s] = await import(s)

// Registered by nobody: these export something plugin-shaped but are not plugins.
const SKIP = [
  // Schema builder library; its default export is a callable, not a plugin.
  '@deepseek-ai/schemastery',
  // Loader-side grouping plugin. It expects to be instantiated by
  // cordis-plugin-loader, which the static tree does not use.
  '@deepseek-ai/cordis-plugin-group',
]

// Minimal config for plugins whose schema has required fields. These are the
// knobs cf-settings-do will eventually feed from TenantDO at runtime.
const CONFIG = {
  '@deepseek-ai/dsh-agent-default-model': { provider: 'deepseek', model: 'deepseek-chat' },
  '@deepseek-ai/dsh-agent-instructions': { maxBytes: 65536 },
}

const { ctx, report } = await assemble(Context, modules, { skip: SKIP, config: CONFIG, settleMs: 1500 })
const services = servicesOn(ctx)
const unmet = unmetInjects(modules, services)

console.log(`registered: ${report.registered.length}   libraries: ${report.libraries.length}   skipped: ${report.skipped.length}`)
console.log(`failed:     ${report.failed.length}       dormant: ${report.pending.length}`)

if (report.failed.length) {
  console.log('\n=== failed ===')
  for (const f of report.failed) {
    console.log(`  [${f.phase}] ${f.specifier.replace('@deepseek-ai/', '')}`)
    console.log(`         ${f.error.replace(/\s+/g, ' ').slice(0, 190)}`)
  }
}

if (report.pending.length) {
  console.log('\n=== dormant (registered, still waiting on services) ===')
  console.log('  ' + report.pending.map(s => s.replace('@deepseek-ai/', '')).join('  '))
}

console.log(`\n=== services published (${services.length}) ===`)
console.log('  ' + services.join('  '))

console.log(`\n=== injected but not published (${unmet.length}) ===`)
for (const [service, wanters] of unmet) {
  console.log(`  ${service.padEnd(20)} wanted by: ${wanters.join(', ')}`)
}
