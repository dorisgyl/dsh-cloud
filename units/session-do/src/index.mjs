// U2 SessionAgentDO — M1 step 1.
//
// Goal of this milestone: run one complete agent turn inside a Durable Object
// and measure it. The Durable Object is real (it owns the tree and the SQLite
// handle); persistence, the alarm-driven turn loop and the edge are not here
// yet.
//
// Everything happens inside a request, never at module scope: workerd forbids
// I/O, timers and random-number generation in global scope, and constructing
// Cordis services does all three. (M0 found three upstream packages violating
// exactly this.)
import { DurableObject } from 'cloudflare:workers'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { modules } from '../build/plugins.generated.js'
import { assemble, servicesOn, unmetInjects } from '../../../packages/cf-boot/src/plugin-tree.mjs'
import { StubLlmAdapter } from '../../../packages/cf-testing/src/stub-llm-adapter.mjs'
import cfStorageDo from '../../../packages/cf-storage-do/src/index.mjs'
import { CfSessionPersistenceDo } from '../../../packages/cf-session-persistence-do/src/index.mjs'

// Plugin-shaped exports that are not plugins.
const SKIP = [
  // Schema builder library; its default export is callable but is not a plugin.
  '@deepseek-ai/schemastery',
  // Loader-side grouping plugin: expects to be instantiated by
  // cordis-plugin-loader, which a statically expanded tree does not use.
  '@deepseek-ai/cordis-plugin-group',
  // Abstract seams: registering the base class publishes a non-functional
  // service and then collides with the concrete backend that should own the
  // name. Upstream loads the implementation, never the base.
  '@deepseek-ai/dsh-session-persistence',
  // The storage-domain plugin needs `{ backend }` config naming a live backend,
  // so it is registered by hand after cf-storage-do rather than expanded blind.
  '@deepseek-ai/dsh-storage-domain',
]

// Config for plugins whose schema has required fields. cf-settings-do will
// supply these from TenantDO once it exists.
const CONFIG = {
  '@deepseek-ai/dsh-agent-default-model': { provider: 'stub', model: 'stub-1' },
  '@deepseek-ai/dsh-agent-instructions': { maxBytes: 65536 },
}

/** Session events worth counting when judging whether a turn really ran. */
const TRACKED_EVENTS = [
  'turn/start', 'turn/end', 'step/start', 'step/end',
  'user/message', 'assistant/chunk', 'assistant/message',
  'tool/call', 'tool/result',
]

function hasPersistedLog(sql, sessionId) {
  try {
    const row = sql.exec('SELECT COUNT(*) AS n FROM session_event WHERE id = ?', sessionId).toArray()[0]
    return (row?.n ?? 0) > 0
  } catch {
    return false   // tables not created yet: nothing persisted
  }
}

export class SessionAgentDO extends DurableObject {
  constructor(state, env) {
    super(state, env)
    this.state = state
    this.tree = null       // { ctx, report, services, assembleMs }
    this.adapter = null
  }

  /**
   * Build the plugin tree once per Durable Object instance and keep it.
   * The cost paid here is what a cold start and every hibernation wake pay.
   */
  async ensureTree() {
    if (this.tree) return this.tree
    const t0 = Date.now()
    const { ctx, report } = await assemble(Context, modules, {
      skip: SKIP, config: CONFIG, settleMs: 1500,
    })
    const assembleMs = Date.now() - t0

    // The two seams upstream leaves empty on workerd. Both need the Durable
    // Object's SQLite handle, which only exists here, so they are registered
    // after the tree rather than expanded into it at build time.
    const sql = this.state.storage.sql
    await ctx.plugin(cfStorageDo, { name: 'do-sqlite', sql })
    await ctx.plugin(CfSessionPersistenceDo, { sql })
    // storageDomain only publishes once a named backend service exists.
    await ctx.plugin(modules['@deepseek-ai/dsh-storage-domain'].default
      ?? modules['@deepseek-ai/dsh-storage-domain'], { backend: 'do-sqlite' })

    // Register the deterministic adapter on the 'stub' provider route.
    this.adapter = new StubLlmAdapter({ reply: 'Hello from a Durable Object.', chunkSize: 6 })
    ctx.llm.registerAdapter(['stub'], this.adapter)

    this.tree = { ctx, report, services: servicesOn(ctx), assembleMs }
    return this.tree
  }

  /** Run exactly one turn and report what it cost. */
  async runTurn(prompt) {
    const { ctx, report, services, assembleMs } = await this.ensureTree()

    // NOTE: session events are LOG ENTRIES, not Cordis events. Listening on
    // `ctx.on('turn/start')` never fires. cf-session-persistence-do must
    // therefore hook the session's append path, not the event bus. Counting is
    // done by reading the log after the turn instead.
    const events = {}
    const disposers = []

    const callsBefore = this.adapter.calls
    const t0 = Date.now()
    let error = null
    let reply = null
    let logDump = null
    const trace = []

    try {
      const sessionId = `m1-${this.state.id.toString().slice(0, 12)}`
      const agentOptions = { provider: 'stub', model: 'stub-1' }

      // create() vs resume() is not a convenience choice. Creating on an id that
      // already has a persisted log is rejected outright —
      //   'already has a persisted log on disk that does not match this live
      //    session (id collision)'
      // — and, like every turn failure, that only surfaces inside the log.
      // A Durable Object woken from hibernation must therefore resume, never
      // create, which is exactly what the alarm-driven turn loop will do.
      //
      // The field is `agentOptions`, not `options`; with the wrong key the turn
      // runs to completion and fails at the model call instead.
      const persisted = hasPersistedLog(this.state.storage.sql, sessionId)
      trace.push(`session ${sessionId}: ${persisted ? 'resume' : 'create'}`)
      const handle = persisted
        ? await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions })
        : await ctx.agents.create({ sessionId, agentOptions })
      const agent = handle.agent
      trace.push(`after open: status=${agent.status}`)

      // `whenIdle()` follows the driver that `followup()` wakes. `followup` sets
      // status to 'running' synchronously, so calling it straight afterwards is
      // safe; a bounded fallback guards against a driver that never retires.
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      }))
      trace.push(`after followup: status=${agent.status}`)

      const outcome = await Promise.race([
        agent.whenIdle().then(() => 'idle'),
        new Promise((r) => setTimeout(() => r('timeout'), 30000)),
      ])
      trace.push(`wait outcome: ${outcome}, status=${agent.status}`)

      // Read the assistant's reply back off the session — the log is the source
      // of truth, so this also checks the turn was recorded.
      reply = summariseReply(agent)
      logDump = dumpLog(agent.session)

      await handle.dispose()
    } catch (err) {
      error = { message: String(err?.message ?? err), stack: String(err?.stack ?? '').split('\n').slice(0, 6) }
    } finally {
      for (const d of disposers) { try { d() } catch { /* already disposed */ } }
    }

    return {
      ok: !error,
      error,
      reply,
      trace,
      log: logDump,
      measurements: {
        // Cold start: building the whole plugin tree.
        assembleMs,
        // Wall clock for one turn. CPU time is NOT wall clock and workerd does
        // not expose it locally; it has to come from Cloudflare observability
        // on a deployed Worker.
        turnWallMs: Date.now() - t0,
        // One adapter call == one outbound request with a real adapter. This is
        // the per-invocation subrequest budget that ADR-11's coarse/fine
        // decision turns on.
        modelCalls: this.adapter.calls - callsBefore,
      },
      events,
      // Read straight out of SQLite: the in-memory session log proves the turn
      // ran, only the tables prove it was persisted.
      durable: this.durableSnapshot(),
      tree: {
        registered: report.registered.length,
        failed: report.failed,
        dormant: report.pending.map((s) => s.replace('@deepseek-ai/', '')),
        services: services.length,
        unmetInjects: Object.fromEntries(unmetInjects(modules, services)),
      },
    }
  }

  /** Whether this session already has durable events, i.e. resume rather than create. */
/** What actually reached SQLite, read back through a separate query path. */
  durableSnapshot() {
    const sql = this.state.storage.sql
    const one = (q, ...a) => { try { return sql.exec(q, ...a).toArray() } catch (e) { return [{ error: String(e.message) }] } }
    return {
      headers: one('SELECT id, materialized FROM session_header'),
      eventCount: one('SELECT COUNT(*) AS n FROM session_event')[0],
      byType: one('SELECT type, COUNT(*) AS n FROM session_event GROUP BY type ORDER BY n DESC'),
      seqRange: one('SELECT MIN(seq) AS lo, MAX(seq) AS hi FROM session_event')[0],
      kvUnits: one('SELECT unit, version FROM kv_unit'),
      kvRecords: one('SELECT COUNT(*) AS n FROM kv_record')[0],
    }
  }

  async fetch(request) {
    const url = new URL(request.url)
    const prompt = url.searchParams.get('q') ?? 'Say hello.'
    const result = await this.runTurn(prompt)
    return Response.json(result, {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
  }
}

/**
 * Pull the assistant's text out of the session log.
 * Log entries are `{ type, seq, time, data }` records, not messages — the
 * message lives under `data` of the `assistant/message` entry.
 */
function summariseReply(agent) {
  try {
    const entries = [...(agent?.session?.events ?? [])]
    const last = entries.reverse().find((e) => e?.type === 'assistant/message')
    // The message sits at `data.message`, and the entry also carries
    // `sourceEventSeqs` listing the assistant/chunk entries it was assembled
    // from — see the note on ADR-10 in docs/M1-step1-turn.md.
    return last?.data?.message?.content
      ?.filter((b) => b?.type === 'text').map((b) => b.text).join('') ?? null
  } catch {
    return null
  }
}

/**
 * Dump the session log. The log is the source of truth for what a turn did, so
 * it is also the most direct way to see how far a failing turn got.
 */
function dumpLog(session) {
  try {
    const entries = [...(session?.events ?? session?.log ?? [])]
    return {
      count: entries.length,
      types: entries.map((e) => e?.type ?? e?.kind ?? '(untyped)'),
      tail: entries.slice(-6).map((e) => JSON.stringify(e).slice(0, 300)),
      chunkCount: entries.filter((e) => e?.type === 'assistant/chunk').length,
      // The assembled message names the chunk entries it came from. Dropping
      // chunks from the durable log (ADR-10) leaves these dangling.
      sourceEventSeqs: entries.find((e) => e?.type === 'assistant/message')?.sourceEventSeqs ?? null,
    }
  } catch (err) {
    return { error: String(err?.message ?? err) }
  }
}

export default {
  async fetch(request, env) {
    // One object per session; this milestone uses a single fixed name.
    const id = env.SESSION.idFromName('m1-step1')
    return env.SESSION.get(id).fetch(request)
  },
}
