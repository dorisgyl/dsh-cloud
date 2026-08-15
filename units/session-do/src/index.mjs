// U2 SessionAgentDO — M1 ①②③.
//
// A turn is driven by the Durable Object's alarm, not by the request or socket
// that asked for it (ADR-11). Closing the browser therefore does not stop the
// agent: the prompt is durable, the alarm carries it, and a reconnecting client
// replays whatever it missed from the session log.
//
// Everything runs inside a handler, never at module scope: workerd forbids I/O,
// timers and random-number generation in global scope, and constructing Cordis
// services does all three.
import { DurableObject } from 'cloudflare:workers'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { modules } from '../build/plugins.generated.js'
import { assemble, servicesOn, unmetInjects } from '../../../packages/cf-boot/src/plugin-tree.mjs'
import { StubLlmAdapter } from '../../../packages/cf-testing/src/stub-llm-adapter.mjs'
import cfStorageDo from '../../../packages/cf-storage-do/src/index.mjs'
import { CfSessionPersistenceDo } from '../../../packages/cf-session-persistence-do/src/index.mjs'
import { TurnQueue } from './turn-queue.mjs'

// Plugin-shaped exports that are not plugins, plus the seams registered by hand.
const SKIP = [
  // Schema builder library; its default export is callable but is not a plugin.
  '@deepseek-ai/schemastery',
  // Loader-side grouping plugin: expects to be instantiated by
  // cordis-plugin-loader, which a statically expanded tree does not use.
  '@deepseek-ai/cordis-plugin-group',
  // Abstract seams: registering a base class publishes a non-functional service
  // that then collides with the concrete backend. Upstream loads the
  // implementation, never the base.
  '@deepseek-ai/dsh-session-persistence',
  // Needs `{ backend }` config naming a live backend, so it is registered after
  // cf-storage-do rather than expanded blind.
  '@deepseek-ai/dsh-storage-domain',
]

// Config for plugins whose schema has required fields. cf-settings-do will
// supply these from TenantDO once it exists.
const CONFIG = {
  '@deepseek-ai/dsh-agent-default-model': { provider: 'stub', model: 'stub-1' },
  '@deepseek-ai/dsh-agent-instructions': { maxBytes: 65536 },
}

const AGENT_OPTIONS = { provider: 'stub', model: 'stub-1' }

export class SessionAgentDO extends DurableObject {
  constructor(state, env) {
    super(state, env)
    this.state = state
    this.sql = state.storage.sql
    this.queue = new TurnQueue(this.sql)
    this.tree = null
    this.adapter = null
  }

  get sessionId() {
    return `m1-${this.state.id.toString().slice(0, 12)}`
  }

  /**
   * Build the plugin tree once per Durable Object instance.
   * This cost is paid on every cold start and every hibernation wake.
   */
  async ensureTree() {
    if (this.tree) return this.tree
    const t0 = Date.now()
    const { ctx, report } = await assemble(Context, modules, {
      skip: SKIP, config: CONFIG, settleMs: 1500,
    })

    // The two seams upstream leaves empty on workerd. Both need the Durable
    // Object's SQLite handle, which only exists here.
    await ctx.plugin(cfStorageDo, { name: 'do-sqlite', sql: this.sql })
    await ctx.plugin(CfSessionPersistenceDo, { sql: this.sql })
    // storageDomain publishes only once a named backend service exists.
    const domain = modules['@deepseek-ai/dsh-storage-domain']
    await ctx.plugin(domain.default ?? domain, { backend: 'do-sqlite' })

    this.adapter = new StubLlmAdapter({ reply: 'Hello from a Durable Object.', chunkSize: 6 })
    ctx.llm.registerAdapter(['stub'], this.adapter)

    this.tree = { ctx, report, services: servicesOn(ctx), assembleMs: Date.now() - t0 }
    return this.tree
  }

  // ---------------------------------------------------------------- transport

  async fetch(request) {
    const url = new URL(request.url)

    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair()
      const [client, server] = Object.values(pair)
      // Hibernation-aware accept: the object may be evicted between messages
      // without dropping the socket.
      this.state.acceptWebSocket(server)
      // Replay on connect. The log is the source of truth, so a client that was
      // away — or is brand new — catches up the same way.
      server.send(JSON.stringify({ type: 'replay', events: this.readLog() }))
      return new Response(null, { status: 101, webSocket: client })
    }

    if (url.pathname === '/state') {
      return Response.json(await this.snapshot())
    }

    // Enqueue over HTTP too, so the behaviour is testable without a socket.
    const prompt = url.searchParams.get('q')
    if (prompt) {
      await this.submit(prompt)
      return Response.json({ queued: true, ...(await this.snapshot()) })
    }

    return Response.json(await this.snapshot())
  }

  async webSocketMessage(ws, raw) {
    let prompt = null
    try {
      const parsed = JSON.parse(String(raw))
      prompt = parsed?.prompt ?? null
    } catch {
      prompt = String(raw)
    }
    if (!prompt) return
    await this.submit(prompt)
    ws.send(JSON.stringify({ type: 'queued' }))
  }

  /**
   * Accept a prompt and hand it to the alarm. This returns immediately: the
   * turn does not run on the caller's lifetime, which is the whole point.
   */
  async submit(prompt) {
    this.queue.enqueue(this.sessionId, prompt, Date.now())
    await this.state.storage.setAlarm(Date.now())
  }

  // ------------------------------------------------------------------- driver

  /**
   * Run one queued prompt. Alarms are retried on an uncaught exception, so the
   * prompt is claimed (and its attempt counted) before any work begins;
   * a retry then sees a claimed row rather than replaying the prompt.
   */
  async alarm() {
    const claim = this.queue.claim(Date.now())
    if (!claim) return

    try {
      const result = await this.runTurn(claim.text)
      this.queue.complete(claim.id, Date.now())
      this.broadcast({ type: 'turn', ok: result.ok, reply: result.reply, measurements: result.measurements })
    } catch (error) {
      this.queue.fail(claim.id, error?.message ?? error)
      this.broadcast({ type: 'turn-failed', attempt: claim.attempts, error: String(error?.message ?? error) })
      // Re-throw only while retries remain, so the platform's retry does the
      // waiting for us; past the cap the prompt is abandoned rather than looped.
      if (claim.attempts < 3) throw error
    } finally {
      // Chain to the next prompt, if any arrived while this one ran.
      if (this.queue.hasWork()) await this.state.storage.setAlarm(Date.now())
    }
  }

  async runTurn(prompt) {
    const { ctx, assembleMs } = await this.ensureTree()
    const seqBefore = this.maxSeq()
    const callsBefore = this.adapter.calls
    const t0 = Date.now()

    // A Durable Object woken from hibernation must resume: create() on an id
    // that already has a persisted log is rejected as an id collision, and the
    // rejection surfaces only inside the session log.
    const persisted = seqBefore !== null
    const handle = persisted
      ? await ctx.agents.resume({ resumeSessionId: this.sessionId, agentOptions: AGENT_OPTIONS })
      : await ctx.agents.create({ sessionId: this.sessionId, agentOptions: AGENT_OPTIONS })
    const agent = handle.agent

    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()

      const events = [...(agent.session?.events ?? [])]
      const last = [...events].reverse().find((e) => e?.type === 'assistant/message')
      const ended = [...events].reverse().find((e) => e?.type === 'turn/end')
      return {
        // The only honest health signal: a turn that failed still returns 200
        // everywhere else, and says so only here.
        ok: ended?.data?.reason?.kind === 'completed',
        reason: ended?.data?.reason ?? null,
        reply: last?.data?.message?.content?.filter((b) => b?.type === 'text').map((b) => b.text).join('') ?? null,
        measurements: {
          assembleMs,
          turnWallMs: Date.now() - t0,
          modelCalls: this.adapter.calls - callsBefore,
          eventsAppended: (this.maxSeq() ?? -1) - (seqBefore ?? -1),
        },
      }
    } finally {
      await handle.dispose()
    }
  }

  // -------------------------------------------------------------- observation

  maxSeq() {
    try {
      const row = this.sql
        .exec('SELECT MAX(seq) AS m FROM session_event WHERE id = ?', this.sessionId)
        .toArray()[0]
      return row?.m ?? null
    } catch {
      return null   // tables not created yet
    }
  }

  readLog(fromSeq = 0) {
    try {
      return this.sql
        .exec(
          'SELECT seq, type FROM session_event WHERE id = ? AND seq >= ? ORDER BY seq ASC',
          this.sessionId, fromSeq,
        )
        .toArray()
    } catch {
      return []
    }
  }

  broadcast(message) {
    const payload = JSON.stringify(message)
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(payload) } catch { /* going away */ }
    }
  }

  async snapshot() {
    const byType = (() => {
      try {
        return this.sql
          .exec('SELECT type, COUNT(*) AS n FROM session_event WHERE id = ? GROUP BY type ORDER BY n DESC', this.sessionId)
          .toArray()
      } catch { return [] }
    })()
    return {
      session: this.sessionId,
      durable: {
        maxSeq: this.maxSeq(),
        eventCount: this.readLog().length,
        byType,
      },
      queue: this.queue.stats(),
      sockets: this.state.getWebSockets().length,
      alarm: await this.state.storage.getAlarm(),
      tree: this.tree
        ? {
            services: this.tree.services.length,
            failed: this.tree.report.failed.map((f) => f.specifier.replace('@deepseek-ai/', '')),
            unmet: Object.keys(unmetInjects(modules, this.tree.services)),
          }
        : null,
    }
  }
}

export default {
  async fetch(request, env) {
    // One object per session; this milestone uses a single fixed name.
    const id = env.SESSION.idFromName('m1-step3')
    return env.SESSION.get(id).fetch(request)
  },
}
