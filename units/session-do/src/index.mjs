// U2 SessionAgentDO — M1 step 1 entry.
//
// At this milestone it is not yet a Durable Object: it is the smallest thing
// that proves the upstream Cordis plugin tree assembles *inside workerd*, and
// reports which seams are still unfilled. The DO class, alarm-driven turn loop
// and session log come next.
//
// Everything happens inside `fetch`, never at module scope: workerd forbids
// I/O, timers and random-number generation in global scope, and constructing
// Cordis services does all three. (M0 found three separate module-scope
// violations in upstream packages for exactly this reason.)
import { Context } from '@deepseek-ai/cordis'
import { modules } from '../build/plugins.generated.js'
import { assemble, servicesOn, unmetInjects } from '../../../packages/cf-boot/src/plugin-tree.mjs'

// Plugin-shaped exports that are not plugins.
const SKIP = [
  // Schema builder library; its default export is callable but is not a plugin.
  '@deepseek-ai/schemastery',
  // Loader-side grouping plugin: expects to be instantiated by
  // cordis-plugin-loader, which a statically expanded tree does not use.
  '@deepseek-ai/cordis-plugin-group',
]

// Config for plugins whose schema has required fields. cf-settings-do will
// eventually supply these from TenantDO at runtime; hardcoded for now.
const CONFIG = {
  '@deepseek-ai/dsh-agent-default-model': { provider: 'deepseek', model: 'deepseek-chat' },
  '@deepseek-ai/dsh-agent-instructions': { maxBytes: 65536 },
}

export default {
  async fetch() {
    const started = Date.now()
    const { ctx, report } = await assemble(Context, modules, {
      skip: SKIP,
      config: CONFIG,
      settleMs: 1500,
    })
    const services = servicesOn(ctx)
    const unmet = unmetInjects(modules, services)

    return Response.json({
      ok: report.failed.length === 0,
      elapsedMs: Date.now() - started,
      counts: {
        modules: Object.keys(modules).length,
        registered: report.registered.length,
        libraries: report.libraries.length,
        skipped: report.skipped.length,
        failed: report.failed.length,
        dormant: report.pending.length,
        services: services.length,
      },
      services,
      failed: report.failed,
      dormant: report.pending.map(s => s.replace('@deepseek-ai/', '')),
      unmetInjects: Object.fromEntries(
        unmet.map(([service, wanters]) => [service, wanters]),
      ),
    }, { headers: { 'content-type': 'application/json; charset=utf-8' } })
  },
}
