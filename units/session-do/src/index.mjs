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
import { WorkersAiAdapter, resolveModelId } from '../../../packages/cf-llm-transport/src/workers-ai.mjs'
import { withCoalescing } from '../../../packages/cf-llm-transport/src/coalesce.mjs'
import cfStorageDo from '../../../packages/cf-storage-do/src/index.mjs'
import { CfSessionPersistenceDo } from '../../../packages/cf-session-persistence-do/src/index.mjs'
import { CfSettingsDo } from '../../../packages/cf-settings-do/src/index.mjs'
import { CfShellExecutor } from '../../../packages/cf-exec-provider/src/shell.mjs'
import { CfFileSystem } from '../../../packages/cf-exec-provider/src/fs.mjs'
import { CfCredentialsDo } from '../../../packages/cf-credentials-do/src/index.mjs'
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
  // Same shape: dsh-jobs refuses to start unless a concrete registry is loaded,
  // and dsh-jobs-local is that registry. "local" is in-process, not on-disk.
  '@deepseek-ai/dsh-jobs',
  // Same again: dsh-settings is the abstract seam and cf-settings-do is the
  // implementation. Registering the base publishes a service whose load()
  // does not exist.
  '@deepseek-ai/dsh-settings',
  // And once more for the execution world. Three seams now follow this exact
  // shape — persistence, jobs, settings, shell — so it is a rule, not a series
  // of surprises: an abstract seam publishes a service that refuses to work,
  // and the concrete provider must be the only thing registered under its name.
  '@deepseek-ai/dsh-shell',
  // Six. dsh-fs is the abstract filesystem seam; cf-exec-provider/fs is the
  // implementation. Nothing new to learn here, which is the point of a rule.
  '@deepseek-ai/dsh-fs',
  // Five now. dsh-credentials publishes a service whose resolve() does not
  // exist; the symptom was "credentials.resolve is not a function" from a
  // web-search tool, three layers away from the cause.
  '@deepseek-ai/dsh-credentials',
  // Needs `{ backend }` config naming a live backend, so it is registered after
  // cf-storage-do rather than expanded blind.
  '@deepseek-ai/dsh-storage-domain',
]

// Config for plugins whose schema has required fields. cf-settings-do will
// supply these from TenantDO once it exists.
const CONFIG = {
  // Overridden per agent by chooseProvider(); this is only the tree-level default.
  '@deepseek-ai/dsh-agent-default-model': { provider: 'stub', model: 'stub-1' },
  '@deepseek-ai/dsh-agent-instructions': { maxBytes: 65536 },
  // Required config, not optional knobs: the service throws
  // "session-title: configuration is required" without all three, which is why
  // `sessionTitle` never published and looked like a mystery.
  '@deepseek-ai/dsh-session-title': {
    fallbackMaxWords: 8,
    fallbackMaxBytes: 128,
    maxTitleBytes: 256,
  },
}

// ADR-12's zero-configuration default: with the AI binding present the agent
// talks to a Cloudflare-hosted DeepSeek model and needs no key at all. Without
// it — local dev, or a deployment that did not add the binding — the
// deterministic stub keeps everything testable.
function chooseProvider(env, modelOverride, providerOverride) {
  // The AI binding is present locally too, but calling it fails with
  // "Binding AI needs to be run remotely" — so a measurement that wants the
  // deterministic adapter has to ask for it explicitly rather than rely on the
  // binding being absent.
  if (providerOverride === 'stub' || !env?.AI) return { provider: 'stub', model: 'stub-1' }
  return { provider: 'workers-ai', model: modelOverride || resolveModelId(env) }
}

export class SessionAgentDO extends DurableObject {
  constructor(state, env) {
    super(state, env)
    this.state = state
    this.sql = state.storage.sql
    this.queue = new TurnQueue(this.sql)
    this.env = env
    // Set per request so a measurement can pin a model without a redeploy.
    this.modelOverride = null
    this.providerOverride = null
    // Log granularity, overridable per request so the sweep can measure the
    // curve rather than one point.
    this.coalescing = {}
    this.tree = null
    this.adapter = null
    this.stub = null
    this.workersAi = null
    // One live agent per Durable Object instance. Hibernation clears this, so
    // the next turn resumes — which is exactly the intended boundary: resume on
    // a cold start or a wake, never between two turns of a warm object.
    this.agent = null
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
    await ctx.plugin(CfSettingsDo, { sql: this.sql })
    await ctx.plugin(CfCredentialsDo, { env: this.env, sql: this.sql })

    // ADR-06: the tier is decided by which bindings exist, not by which code
    // was compiled. No EXEC binding means the minimal tier — the shell seam
    // stays unimplemented and its tools never register, so nothing has to
    // detect the tier or hide anything.
    if (this.env?.EXEC) {
      await ctx.plugin(CfShellExecutor, {
        exec: this.env.EXEC,
        // One sandbox per session for now. A workspace outliving its session
        // (design 6.3) is the next step, and changes only this id.
        sandboxId: this.sessionId,
      })
      // Same binding, same sandbox: the shell and the filesystem must see one
      // execution world, or a file written by bash would be invisible to the
      // read tool.
      await ctx.plugin(CfFileSystem, {
        exec: this.env.EXEC,
        sandboxId: this.sessionId,
      })
    }
    // storageDomain publishes only once a named backend service exists.
    const domain = modules['@deepseek-ai/dsh-storage-domain']
    await ctx.plugin(domain.default ?? domain, { backend: 'do-sqlite' })

    // Both routes are always registered; which one an agent uses is its
    // `agentOptions.provider`, decided per request rather than at build time.
    // Both adapters stream through the same coalescer (ADR-10). The agent loop
    // writes one log entry per chunk an adapter yields, so this is the only
    // place the log's granularity can be set.
    this.stub = new StubLlmAdapter({ reply: 'Hello from a Durable Object.', chunkSize: 6 })
    ctx.llm.registerAdapter(['stub'], withCoalescing(this.stub, this.coalescing))
    if (this.env?.AI) {
      this.workersAi = new WorkersAiAdapter(this.env.AI)
      ctx.llm.registerAdapter(['workers-ai'], withCoalescing(this.workersAi, this.coalescing))
    }
    this.adapter = this.workersAi ?? this.stub

    // Live push. `session/event` is a real Cordis event carrying (session,
    // event) on every append — the log-entry names like `turn/start` are not
    // Cordis events, which is what an earlier note here got wrong.
    ctx.on('session/event', (_session, event) => this.pushEvent(event))

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
      // Upstream's contract (dsh-client-connection): a subscription is
      // acknowledged with the last sequence number and nothing else. History is
      // PULLED by the client afterwards, not pushed on connect — an earlier
      // version of this object dumped the whole log here, which was both
      // unbounded (~6 MB at 12,565 events) and a message no real client speaks.
      server.send(JSON.stringify({
        type: 'session/subscribed',
        sessionId: this.sessionId,
        lastSeq: this.maxSeq() ?? -1,
      }))
      return new Response(null, { status: 101, webSocket: client })
    }

    // Talk to U5 directly, bypassing the agent loop, so a container problem can
    // be told apart from a tool-calling problem.
    if (url.pathname === '/exec-selftest') {
      if (!this.env?.EXEC) return Response.json({ error: 'no EXEC binding' }, { status: 503 })
      const op = url.searchParams.get('op') ?? 'exec'
      const payload = {
        sandboxId: url.searchParams.get('sandbox') ?? this.sessionId,
        command: url.searchParams.get('cmd') ?? 'echo selftest',
        path: url.searchParams.get('path') ?? '/workspace',
        content: 'selftest',
      }
      // The agent path sends cwd and env; the bare selftest did not, and only
      // the agent path failed. Make the difference testable.
      if (url.searchParams.has('cwd')) payload.cwd = url.searchParams.get('cwd')
      if (url.searchParams.get('withEnv') === '1') payload.env = { TERM: 'dumb', NO_COLOR: '1' }
      try {
        const response = await this.env.EXEC.fetch(`http://exec/${op}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
        return Response.json({ status: response.status, body: await response.json() })
      } catch (error) {
        return Response.json({ threw: String(error?.message ?? error) })
      }
    }

    if (url.pathname === '/history') {
      const from = Number(url.searchParams.get('from') ?? 0)
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 200), 1000)
      return Response.json(this.history(from, limit))
    }

    if (url.pathname === '/state') {
      return Response.json(await this.snapshot())
    }

    if (url.pathname === '/sweep') {
      return Response.json(await this.sweep({
        replyChars: Number(url.searchParams.get('reply') ?? 250),
        chunkChars: Number(url.searchParams.get('chunk') ?? 24),
        turns: Number(url.searchParams.get('turns') ?? 5),
        coalesce: url.searchParams.get('coalesce') === 'off'
          ? { maxChars: 1, maxMs: 0 }
          : url.searchParams.has('maxChars')
            ? { maxChars: Number(url.searchParams.get('maxChars')), maxMs: Number(url.searchParams.get('maxMs') ?? 120) }
            : {},
      }))
    }

    if (url.pathname === '/bench') {
      const turns = Number(url.searchParams.get('turns') ?? 50)
      const every = Number(url.searchParams.get('every') ?? 10)
      const fresh = url.searchParams.get('fresh') === '1'
      // The AI binding cannot be called from `wrangler dev` in single-config
      // mode ("Binding AI needs to be run remotely"), so local runs need a way
      // to ask for the deterministic adapter explicitly.
      const provider = url.searchParams.get('provider')
      if (provider && provider !== this.providerOverride) {
        this.providerOverride = provider
        await this.releaseAgent()
      }
      const model = url.searchParams.get('model')
      if (model && model !== this.modelOverride) {
        // Changing model changes agentOptions, so the live agent is reopened.
        this.modelOverride = model
        await this.releaseAgent()
      }
      return Response.json(await this.bench(turns, every, fresh))
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

  /**
   * The live agent for this object, opened at most once per instance.
   *
   * Measured (docs/M1-growth-measurement.md): opening per turn costs twice —
   * resume reads the whole log, which is O(n) and passed the turn's own cost by
   * 250 turns, and each resume re-logs the ~9 KB `request/header`, tripling log
   * growth from 3.4 to 12.4 KB per turn. Holding the agent is flat at ~30 ms a
   * turn out to 6831 events.
   */
  async ensureAgent(ctx) {
    if (this.agent) return { agent: this.agent.agent, openedMs: 0 }

    // A Durable Object woken from hibernation must resume: create() on an id
    // that already has a persisted log is rejected as an id collision, and the
    // rejection surfaces only inside the session log.
    const persisted = this.maxSeq() !== null
    const tOpen = Date.now()
    this.agent = persisted
      ? await ctx.agents.resume({ resumeSessionId: this.sessionId, agentOptions: chooseProvider(this.env, this.modelOverride, this.providerOverride) })
      : await ctx.agents.create({ sessionId: this.sessionId, agentOptions: chooseProvider(this.env, this.modelOverride, this.providerOverride) })
    return { agent: this.agent.agent, openedMs: Date.now() - tOpen }
  }

  /** Drop the live agent so the next turn opens a clean one. */
  async releaseAgent() {
    const held = this.agent
    this.agent = null
    if (held) { try { await held.dispose() } catch { /* already gone */ } }
  }

  async runTurn(prompt) {
    const { ctx, assembleMs } = await this.ensureTree()
    const seqBefore = this.maxSeq()
    const callsBefore = this.adapter.calls
    const t0 = Date.now()

    const { agent, openedMs } = await this.ensureAgent(ctx)
    const resumeMs = openedMs
    const tRun = Date.now()

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
          // Split deliberately: `resume` reloads the whole log, so if anything
          // degrades with session length it shows up here rather than in the
          // turn itself.
          resumeMs,
          runMs: Date.now() - tRun,
          turnWallMs: Date.now() - t0,
          modelCalls: this.adapter.calls - callsBefore,
          eventsAppended: (this.maxSeq() ?? -1) - (seqBefore ?? -1),
          projection: this.projectionSize(agent),
        },
      }
    } catch (error) {
      // A failed turn may leave the agent in a state the next turn should not
      // inherit, so the handle is dropped and the next turn resumes from the
      // durable log instead.
      await this.releaseAgent()
      throw error
    }
  }

  // ------------------------------------------------------------------- bench

  /**
   * Drive many turns and sample how the session grows.
   *
   * This calls runTurn directly rather than going through the queue and alarm:
   * the alarm path is what production uses, but it serialises one turn per
   * invocation, and the question here is how cost scales with log length, not
   * how the driver behaves.
   *
   * No API exposes a Worker's heap size — not locally and not deployed — so
   * this measures the things that *are* observable and that heap tracks:
   * durable bytes, projected message bytes, and where time goes.
   */
  async bench(turns, sampleEvery, fresh = false) {
    await this.ensureTree()
    const samples = []
    const t0 = Date.now()
    for (let i = 0; i < turns; i++) {
      // `fresh` reproduces the pre-optimisation behaviour — open the agent per
      // turn — so the two paths can be compared in one run.
      if (fresh) await this.releaseAgent()
      const result = await this.runTurn(`bench turn ${i}`)
      if (!result.ok) {
        samples.push({ turn: i, failed: true, reason: result.reason })
        break
      }
      if (i % sampleEvery === 0 || i === turns - 1) {
        samples.push({
          turn: i,
          ...this.durableSize(),
          resumeMs: result.measurements.resumeMs,
          runMs: result.measurements.runMs,
          projection: result.measurements.projection,
        })
      }
    }
    return { turns, mode: fresh ? 'resume-per-turn' : 'live-agent', elapsedMs: Date.now() - t0, samples }
  }

  /**
   * Reply-length sweep for the ADR-10 decision.
   *
   * ADR-10 drops `assistant/chunk` from the durable log. Whether that is worth
   * its costs depends on what share of the log chunks actually are — and every
   * measurement so far gave a different answer, because each was a single point
   * under conditions that turned out not to generalise. A curve is harder to
   * mislead with than a point.
   *
   * The two variables are the reply length and the provider's delta size, and
   * they matter differently: an entry costs ~120 bytes of structure regardless
   * of how few characters it carries, so chunk cost is driven by the number of
   * entries, which is reply length divided by delta size.
   */
  async sweep({ replyChars, chunkChars, turns, coalesce }) {
    const { ctx } = await this.ensureTree()
    // Reconfigure the deterministic adapter for this point, and reopen the
    // agent so nothing from a previous configuration leaks in.
    await this.releaseAgent()
    // Changing coalescing changes the registered adapters, so the tree is
    // rebuilt rather than mutated underneath a live agent.
    if (JSON.stringify(coalesce ?? {}) !== JSON.stringify(this.coalescing)) {
      this.coalescing = coalesce ?? {}
      this.tree = null
    }
    await this.ensureTree()
    this.stub.reply = 'x'.repeat(replyChars)
    this.stub.chunkSize = chunkChars
    this.modelOverride = null
    // The sweep is about log shape, not about any particular model, so it runs
    // on the deterministic adapter where reply length is an input.
    this.providerOverride = 'stub'

    const before = this.byType()
    for (let i = 0; i < turns; i++) {
      const result = await this.runTurn(`sweep ${i}`)
      if (!result.ok) return { replyChars, chunkChars, turns, failed: result.reason }
    }
    const after = this.byType()

    const delta = {}
    let total = 0
    for (const [type, row] of Object.entries(after)) {
      const prev = before[type] ?? { n: 0, bytes: 0 }
      const bytes = row.bytes - prev.bytes
      const count = row.n - prev.n
      if (bytes || count) { delta[type] = { count, bytes }; total += bytes }
    }
    const chunk = delta['assistant/chunk'] ?? { count: 0, bytes: 0 }
    return {
      replyChars, chunkChars, turns,
      bytesPerTurn: Math.round(total / turns),
      chunkEntriesPerTurn: Math.round(chunk.count / turns),
      chunkBytesPerTurn: Math.round(chunk.bytes / turns),
      chunkShare: total ? +(100 * chunk.bytes / total).toFixed(1) : 0,
      delta,
    }
  }

  byType() {
    try {
      const rows = this.sql
        .exec('SELECT type, COUNT(*) AS n, SUM(LENGTH(event)) AS bytes FROM session_event WHERE id = ? GROUP BY type', this.sessionId)
        .toArray()
      return Object.fromEntries(rows.map((r) => [r.type, r]))
    } catch {
      return {}
    }
  }

  /** Bytes and rows actually on disk for this session. */
  durableSize() {
    try {
      const row = this.sql
        .exec(
          `SELECT COUNT(*) AS events, SUM(LENGTH(event)) AS bytes,
                  SUM(CASE WHEN type = 'assistant/chunk' THEN LENGTH(event) ELSE 0 END) AS chunkBytes
           FROM session_event WHERE id = ?`,
          this.sessionId,
        )
        .toArray()[0]
      return { events: row?.events ?? 0, bytes: row?.bytes ?? 0, chunkBytes: row?.chunkBytes ?? 0 }
    } catch {
      return { events: 0, bytes: 0, chunkBytes: 0 }
    }
  }

  /** What the model-facing projection costs, which is what actually sits in memory. */
  projectionSize(agent) {
    try {
      const messages = agent.session.deriveMessages?.()
      const list = messages ? [...messages] : []
      return { messages: list.length, bytes: JSON.stringify(list).length }
    } catch (error) {
      return { error: String(error?.message ?? error).slice(0, 120) }
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

  /** One appended event, pushed to every attached socket in upstream's shape. */
  pushEvent(event) {
    this.broadcast({ type: 'session/event', sessionId: this.sessionId, event })
  }

  /**
   * The backlog, paged. Bounded by construction: a client asks for what it is
   * missing rather than being handed everything on connect.
   */
  history(from, limit) {
    try {
      const events = this.sql
        .exec(
          'SELECT event FROM session_event WHERE id = ? AND seq >= ? ORDER BY seq ASC LIMIT ?',
          this.sessionId, from, limit,
        )
        .toArray()
        .map((row) => JSON.parse(row.event))
      const lastSeq = this.maxSeq() ?? -1
      const nextFrom = events.length ? events[events.length - 1].seq + 1 : from
      return { sessionId: this.sessionId, from, lastSeq, events, nextFrom, done: nextFrom > lastSeq }
    } catch (error) {
      return { sessionId: this.sessionId, from, lastSeq: -1, events: [], nextFrom: from, done: true, error: String(error?.message ?? error) }
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
          .exec('SELECT type, COUNT(*) AS n, SUM(LENGTH(event)) AS bytes FROM session_event WHERE id = ? GROUP BY type ORDER BY bytes DESC', this.sessionId)
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
    // One object per session. `?obj=` exists so a measurement can start from a
    // clean log instead of inheriting whatever the previous run left behind.
    const url = new URL(request.url)
    const id = env.SESSION.idFromName(url.searchParams.get('obj') ?? 'm1-step3')
    return env.SESSION.get(id).fetch(request)
  },
}
