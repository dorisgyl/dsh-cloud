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
import { createApiProxy, toFetchHandler } from '@deepseek-ai/dsh-host-apiproxy'
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
import { CfSubprocessService } from '../../../packages/cf-exec-provider/src/subprocess.mjs'
import { CfCredentialsDo } from '../../../packages/cf-credentials-do/src/index.mjs'
import { CfSessionQueryDo } from '../../../packages/cf-session-query-do/src/index.mjs'
import { CfWorkspacePicker } from '../../../packages/cf-workspace-picker/src/index.mjs'
import { CfAttachmentsDo } from '../../../packages/cf-attachments-do/src/index.mjs'
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
  // Seven, and the one that pays best: filling `subprocess` is what lets
  // dsh-terminal-bash run, which brings terminal emulation and idle inference
  // we would otherwise have had to write.
  '@deepseek-ai/dsh-subprocess',
  // Five now. dsh-credentials publishes a service whose resolve() does not
  // exist; the symptom was "credentials.resolve is not a function" from a
  // web-search tool, three layers away from the cause.
  '@deepseek-ai/dsh-credentials',
  // Eight and nine, both required by dsh-host-apiproxy rather than wanted for
  // their own sake: the client protocol injects `sessionQuery` and
  // `directoryPicker`, so neither could stay absent once the UI transport came
  // in. cf-session-query-do and cf-workspace-picker are the providers.
  '@deepseek-ai/dsh-session-query',
  '@deepseek-ai/dsh-host-directory-picker',
  // Ten. The abstract AttachmentStore declares `imageLimits` and does not have
  // it, and the session projection registry parses every unit's view through
  // its schema -- so one absent property failed the whole projection snapshot,
  // and the snapshot is on the path of every transcript read. The visible
  // symptom was `session.history` answering "expected object, received
  // undefined" with an empty path.
  '@deepseek-ai/dsh-attachment',
  // Needs `{ backend }` config naming a live backend, so it is registered after
  // cf-storage-do rather than expanded blind.
  '@deepseek-ai/dsh-storage-domain',
  // Not a seam: registered by hand only so that a failure while loading it is
  // reported. assemble() awaits each fiber for a bounded window, and this
  // plugin waits on storageDomain, which is registered afterwards -- so it
  // always loads outside that window, and an exception there was landing
  // nowhere at all.
  '@deepseek-ai/dsh-workspace',
  // Constructed by hand instead, for one field. ApiProxyService passes
  // `cwd: process.cwd()` as the default working directory for sessions it
  // creates, and on workerd that is `/bundle` -- the read-only VFS the code was
  // loaded from, which has nothing to do with the execution world. A session
  // created from the UI would carry it, and every path the agent resolved
  // afterwards would be relative to the wrong root.
  //
  // createApiProxy is exported, so the fix is to call it with the right cwd.
  // Nothing on the host side injects `apiProxy` -- only the browser client
  // names it -- so not publishing the service costs nothing here.
  '@deepseek-ai/dsh-host-apiproxy',
  // A deliberate choice between two packages that register the SAME tool name.
  //
  // dsh-tool-bash and dsh-tool-bash-persistent both register `bash`, so exactly
  // one can win and upstream expects the deployment to pick. Leaving both in
  // means the winner is decided by registration order, which is not a decision.
  //
  // The persistent one works: its PTY survives across turns (measured -- `cd
  // /tmp && export MARKER=...` in one turn, `/tmp` and `MARKER=persisted` read
  // back in the next). It is not the default anyway, for one measured reason:
  //
  //   the container gives the shell no controlling terminal ("bash: cannot set
  //   terminal process group ... no job control in this shell"), so Ctrl-C
  //   reaches the tty and is echoed but does NOT kill the foreground command.
  //   A `sleep 20` interrupted at 3s never yielded its prompt back, and every
  //   later terminal in the same sandbox inherited the wedged shell, because a
  //   sandbox has one PTY session.
  //
  // `bash` is the agent's most important tool and it has to recover on its own.
  // The one-shot executor always does: every command carries a deadline and a
  // failed command is an ordinary tool result. Swap these two lines to switch,
  // and see docs/M2-terminal.md.
  '@deepseek-ai/dsh-tool-bash-persistent',
]

// The one workspace root, and it is a path in the CONTAINER, not in this
// Worker. workerd's virtual filesystem holds only /bundle (read-only), /tmp and
// /dev, so nothing here can create it — which is correct, because nothing here
// should: the execution world is where files live.
const WORKSPACE_ROOT = '/workspace'

// Config for plugins whose schema has required fields. cf-settings-do will
// supply these from TenantDO once it exists.
const CONFIG = {
  // Overridden per agent by chooseProvider(); this is only the tree-level default.
  '@deepseek-ai/dsh-agent-default-model': { provider: 'stub', model: 'stub-1' },
  '@deepseek-ai/dsh-agent-instructions': { maxBytes: 65536 },
  // The confinement model, stated once for the deployment.
  //
  // `danger-full-access` is the honest answer here, not a shortcut. The other
  // two modes make dsh-terminal-bash call `ctx.sandbox.confine()` to wrap the
  // shell in an OS-level jail (landlock, seatbelt) -- and there is no such jail
  // to apply INSIDE the container, nor anything narrower worth enforcing there.
  // The container is the boundary: it is disposable, holds no credentials, and
  // has no path back into the account. Claiming `read-only` would advertise a
  // confinement nothing implements, which is worse than naming the real one.
  '@deepseek-ai/dsh-sandbox-policy': { mode: 'danger-full-access', workspaceRoot: '/workspace' },
  // The client protocol. `nativeOpen: false` is the truth here -- there is no
  // desktop to reveal a path on -- and it is also why dsh-native-command can be
  // aliased away at build time without removing a reachable feature.
  '@deepseek-ai/dsh-host-apiproxy': { nativeOpen: false },
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

/**
 * Wait, bounded, until every named service exists.
 *
 * Not a fixed sleep: it returns the moment the cascade settles, and it returns
 * anyway when it does not — a missing service is then reported by the tree's
 * own `unmet` rather than hidden behind a hang.
 */
async function settleFor(ctx, names, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (names.every((name) => ctx.get(name) !== undefined)) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return false
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
   * The container this object owns, named from the WHOLE Durable Object id.
   *
   * Not `sessionId`: that one truncates the id to 12 hex characters because it
   * is a readable log key, and 48 bits is fine for a label. It is not fine for
   * an isolation boundary — two users whose object ids happened to share a
   * 12-character prefix would have shared one container, and with it one
   * filesystem.
   *
   * 60 hex characters, not 64: a sandbox id is a DNS LABEL, so the real limit
   * is 63 and `ws-` plus a whole object id is 67. The first version of this
   * used the whole id, checked it against a 128-character regex, and shipped —
   * and that regex was ours, invented in U5, not the platform's. Every tool
   * call then failed with "Sandbox ID must be 1-63 characters long." Validating
   * against a limit you made up proves nothing about the one that applies.
   *
   * 240 bits is still far past any collision that matters. Every session inside
   * this object shares the container deliberately: one object is one user, and
   * a user's sessions are meant to see each other's files.
   */
  get sandboxId() {
    return `ws-${this.state.id.toString().slice(0, 60)}`
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
    // Search over this object's own log. Required by the client protocol, so it
    // could no longer be deferred; see the class for why it searches for real
    // rather than answering with an empty page.
    await ctx.plugin(CfSessionQueryDo, { sql: this.sql, sessionId: this.sessionId })
    await ctx.plugin(CfAttachmentsDo, { sql: this.sql })

    // ADR-06: the tier is decided by which bindings exist, not by which code
    // was compiled. No EXEC binding means the minimal tier — the shell seam
    // stays unimplemented and its tools never register, so nothing has to
    // detect the tier or hide anything.
    if (this.env?.EXEC) {
      await ctx.plugin(CfShellExecutor, {
        exec: this.env.EXEC,
        // One sandbox per session for now. A workspace outliving its session
        // (design 6.3) is the next step, and changes only this id.
        sandboxId: this.sandboxId,
      })
      // Same binding, same sandbox: the shell and the filesystem must see one
      // execution world, or a file written by bash would be invisible to the
      // read tool.
      await ctx.plugin(CfFileSystem, {
        exec: this.env.EXEC,
        sandboxId: this.sandboxId,
      })
      // The PTY seam. dsh-terminal-bash waits on `subprocess`, so registering
      // this is what makes the whole terminal stack come alive.
      await ctx.plugin(CfSubprocessService, {
        exec: this.env.EXEC,
        sandboxId: this.sandboxId,
      })
      // A directory picker onto the execution world. Without an EXEC binding
      // there is no filesystem to browse, so the minimal tier registers none and
      // the client protocol will report the picker as unavailable rather than
      // offer one that answers nothing.
      await ctx.plugin(CfWorkspacePicker, {
        exec: this.env.EXEC,
        sandboxId: this.sandboxId,
      })
    }
    // storageDomain publishes only once a named backend service exists.
    const domain = modules['@deepseek-ai/dsh-storage-domain']
    await ctx.plugin(domain.default ?? domain, { backend: 'do-sqlite' })

    // The filesystem dsh-workspace validates against, redirected to the one the
    // workspace is actually on. Its node:fs/promises import is replaced at build
    // time (scripts/m0-bundle.mjs) with a shim that calls this bridge, so path
    // checks still happen -- they just happen in the container.
    //
    // Installed before the plugin loads, because the registry validates during
    // its own construction.
    globalThis.__DSH_WORKSPACE_FS__ = this.env?.EXEC ? this.workspaceFsBridge() : undefined

    // dsh-workspace publishes `workspaceRegistry`, which dsh-host-apiproxy --
    // the whole client protocol -- injects. Awaited here so a failure is an
    // error with a message rather than a service that silently never appears.
    this.lateErrors = []
    const workspace = modules['@deepseek-ai/dsh-workspace']
    try {
      await ctx.plugin(workspace.default ?? workspace)
    } catch (error) {
      this.lateErrors.push({ specifier: 'dsh-workspace', error: String(error?.message ?? error) })
    }

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

    // Upstream renamed this service `pty` -> `terminals` between
    // dsh-tool-bash-persistent@0.0.1-rc.1 and dsh-terminal@0.0.1-rc.3, and the
    // tool was never republished: it still injects `pty` and calls
    // ctx.pty.{spawn,startSend,read,kill,list}, which is exactly the surface
    // TerminalSessionService exposes.
    //
    // Left alone the tool waits forever on a service nobody provides and simply
    // never registers, with nothing anywhere reporting a problem. One alias in
    // our own tree fixes it without touching upstream source (ADR-04), and it
    // disappears the day the tool is republished.
    if (ctx.terminals && !ctx.pty) {
      ctx.effect(() => ctx.provide('pty', ctx.terminals))
    }

    // Let the cascade finish before calling the tree assembled.
    //
    // The seams registered by hand above arrive AFTER assemble()'s settle
    // window, and plugins waiting on them then load in turn: storageDomain
    // releases dsh-workspace, which publishes `workspaceRegistry`, which
    // releases dsh-host-apiproxy. Snapshotting the service list immediately
    // reported `workspaceRegistry` as unmet and left ctx.apiProxy undefined --
    // a tree that was fine and had simply not finished.
    await settleFor(ctx, ['workspaceRegistry'], 3000)

    // Align the tree-level default model with the binding that actually exists.
    //
    // CONFIG's `{provider: 'stub'}` is a compile-time value and the turn path
    // overrides it per agent, so it never mattered -- until the client protocol
    // arrived, which reads `agentDefaultModel.currentSelection()` for every
    // session IT creates. A session started from the UI was answering with the
    // test stub on a deployment with a real model bound.
    try {
      const selection = chooseProvider(this.env, this.modelOverride, this.providerOverride)
      if (ctx.agentDefaultModel?.currentSelection()?.provider !== selection.provider) {
        await ctx.agentDefaultModel.saveSelection(selection)
      }
    } catch (error) {
      this.lateErrors.push({ specifier: 'agent-default-model', error: String(error?.message ?? error) })
    }

    // The dsh web UI's protocol, over upstream's own implementation of it.
    try {
      this.api = createApiProxy(ctx, {
        cwd: WORKSPACE_ROOT,
        defaultModelSelection: () => ctx.agentDefaultModel.currentSelection(),
        saveDefaultModelSelection: (selection) => ctx.agentDefaultModel.saveSelection(selection),
        // No desktop: there is nothing to reveal a path in.
        canOpenPath: () => false,
      })
    } catch (error) {
      this.lateErrors.push({ specifier: 'api-proxy', error: String(error?.message ?? error) })
    }

    this.tree = { ctx, report, services: servicesOn(ctx), assembleMs: Date.now() - t0 }
    return this.tree
  }

  // ---------------------------------------------------------------- transport

  async fetch(request) {
    const url = new URL(request.url)

    // The browser's two downlinks, which are WebSockets and NOT the socket
    // below.
    //
    // dsh-client-connection ships two client platforms over one set of paths:
    // AbstractApiClient reads them as SSE (the CLI and automation entry, design
    // 8.4), and WebApiClient -- "Browser platform subclass: unary/respond use
    // fetch; mux/host use downlink-only WebSockets" -- opens them as sockets.
    // Both notes this file has carried about the transport were half right.
    //
    // Left to fall through, these upgrades met the generic handler below and got
    // this object's own `session/subscribed` protocol. The client parses every
    // message through serverRequestSchema, so every one failed, the stream never
    // yielded a frame, and the page stayed blank with no error anywhere. A
    // socket that connects and speaks the wrong protocol is the exact failure a
    // 501 here used to prevent.
    if (request.headers.get('Upgrade') === 'websocket'
      && (url.pathname === '/events.mux' || url.pathname === '/events.host')) {
      return this.openEventSocket(url.pathname === '/events.mux' ? 'mux' : 'host')
    }

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
    // Direct evidence for the PTY path. The agent-level symptom is always the
    // same sentence ("did not reach readiness"), which says a marker never
    // arrived but nothing about what did -- so this dumps the raw bytes the
    // pseudo-terminal actually produced.
    if (url.pathname === '/pty-probe') {
      if (!this.env?.EXEC) return Response.json({ error: 'no EXEC binding' }, { status: 503 })
      const { ctx } = await this.ensureTree()
      const waitMs = Number(url.searchParams.get('waitMs') ?? 6000)
      const chunks = []
      const control = []
      try {
        const handle = await ctx.subprocess.spawnTerminal({
          launcher: url.searchParams.get('launcher') !== '0',
          argv: ['/bin/bash', '--noprofile', '--norc', '-i'],
          cwd: '/workspace',
          rows: 40,
          cols: 160,
          graceMs: 3000,
          env: {
            TERM: 'dumb',
            PAGER: 'cat',
            PS1: 'dsh> ',
            // Backslash-zero-three-three as LITERAL characters: printf is what
            // interprets them, so this must not be a JS escape.
            PROMPT_COMMAND: 'printf "\\033]133;D;%s\\007" "$?"',
            DSH_SHELL: '1',
          },
        })
        handle.output.on('data', (c) => chunks.push(c))
        handle.onControlSeen = (m) => control.push(m)
        control.push({ type: 'ready-consumed-during-spawn' })
        if (url.searchParams.get('send')) await handle.write(`${url.searchParams.get('send')}\n`)
        // Interrupt path. Without a controlling terminal the tty line discipline
        // may never turn Ctrl-C into a signal, and a persistent shell that
        // cannot be interrupted is a shell one bad command wedges for good.
        const interruptAfterMs = Number(url.searchParams.get('interruptAfterMs') ?? 0)
        if (interruptAfterMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, interruptAfterMs))
          control.push({ type: 'sent-SIGINT', delivered: await handle.signalForeground('SIGINT') })
        }
        await new Promise((resolve) => setTimeout(resolve, waitMs))
        const bytes = Buffer.concat(chunks.map((c) => Buffer.from(c)))
        await handle.terminate()
        return Response.json({
          ok: true,
          byteCount: bytes.length,
          frames: handle.frames,
          text: bytes.toString('utf8').slice(0, 4000),
          escaped: JSON.stringify(bytes.toString('utf8').slice(0, 1200)),
          control,
        })
      } catch (error) {
        return Response.json({ ok: false, error: String(error?.message ?? error), stack: String(error?.stack ?? '').slice(0, 800) })
      }
    }

    // Call the persistence seam directly, so a failure reported three layers
    // away ("history unavailable for session ...") can be attributed to the
    // layer that actually produced it.
    // What the Worker's own virtual filesystem allows. Upstream assumes the host
    // and the execution world share a filesystem; here they do not, and
    // session.create fails on a mkdir of the project directory. Which paths are
    // writable decides how that is fixed, so measure rather than assume.
    if (url.pathname === '/vfs-probe') {
      const { mkdir, writeFile, readdir } = await import('node:fs/promises')
      const out = {}
      for (const dir of ['/workspace', '/tmp/workspace', '/tmp/probe', '/bundle/x']) {
        try {
          await mkdir(dir, { recursive: true })
          await writeFile(`${dir}/probe.txt`, 'ok')
          out[dir] = { mkdir: true, write: true, entries: (await readdir(dir)).slice(0, 5) }
        } catch (error) {
          out[dir] = { ok: false, error: String(error?.message ?? error) }
        }
      }
      try { out.root = (await readdir('/')).slice(0, 20) } catch (e) { out.root = String(e?.message ?? e) }
      return Response.json(out)
    }

    if (url.pathname === '/persistence-probe') {
      const { ctx } = await this.ensureTree()
      const id = url.searchParams.get('id') ?? this.sessionId
      const out = {}
      // Which projection unit's view() returns undefined. snapshot() parses every
      // registered unit's view through its schema, so one bad unit fails the
      // whole snapshot and the error names neither the unit nor the key.
      out.projections = (() => {
        try {
          const registry = ctx.get('sessionProjections')
          const session = ctx.sessions.get(id)
          if (!registry || !session) return { note: 'no registry or session not attached' }
          const rows = []
          for (const registration of registry.registrations.values()) {
            const key = registration.def.key
            try {
              const cell = registry.cellFor(registration, session)
              const view = registration.def.view(cell.state)
              rows.push({ key, view: view === undefined ? 'UNDEFINED' : typeof view })
            } catch (error) {
              rows.push({ key, error: String(error?.message ?? error).slice(0, 200) })
            }
          }
          return rows
        } catch (error) {
          return { error: String(error?.message ?? error) }
        }
      })()

      // Raw SQL beside the seam call: when a search returns nothing, the two
      // answers together say whether the rows are missing or the query is.
      out.search = await (async () => {
        const q = url.searchParams.get('q') ?? 'turn'
        const result = {}
        try {
          result.tables = this.sql.exec("SELECT name FROM sqlite_master WHERE type='table'").toArray().map((r) => r.name)
        } catch (error) { result.tables = String(error?.message ?? error) }
        try {
          result.totalRows = this.sql.exec('SELECT COUNT(*) AS n FROM session_event').toArray()[0]?.n
          result.distinctIds = this.sql.exec('SELECT id, COUNT(*) AS n FROM session_event GROUP BY id').toArray()
          result.likeRows = this.sql.exec(
            "SELECT id, COUNT(*) AS n FROM session_event WHERE event LIKE ? GROUP BY id", `%${q}%`,
          ).toArray()
        } catch (error) { result.sqlError = String(error?.message ?? error) }
        try {
          result.viaSeam = await ctx.sessionQuery.searchSessions({ query: q })
        } catch (error) { result.seamError = String(error?.message ?? error) }
        return result
      })()

      out.rawHistory = await (async () => {
        try {
          return await this.api.sessions.history({ rpcId: 'raw', payload: { sessionId: id } })
        } catch (error) {
          return { threw: String(error?.message ?? error), stack: String(error?.stack ?? '').slice(0, 1200) }
        }
      })()
      for (const [name, run] of [
        ['list', () => ctx.sessionPersistence.list()],
        ['inspect', () => ctx.sessionPersistence.inspect(id)],
        ['readFrom', () => ctx.sessionPersistence.readFrom(id, 0)],
        // The protocol call that keeps failing, invoked directly so the stack
        // survives. The routed version reports only String(error), which for a
        // schema failure prints the issues and hides the function that raised
        // them -- the message names the symptom and nothing above it.
        ['history', async () => {
          const response = await this.api.sessions.history({ rpcId: 'probe', payload: { sessionId: id } })
          if (response?.result?.ok === false) {
            const err = new Error(response.result.error.message)
            err.stack = JSON.stringify(response.result.error)
            throw err
          }
          return response?.result?.value
        }],
      ]) {
        try {
          const value = await run()
          out[name] = {
            ok: true,
            summary: Array.isArray(value)
              ? { length: value.length, first: value[0] }
              : { keys: Object.keys(value ?? {}), events: value?.events?.length, meta: value?.meta },
          }
        } catch (error) {
          out[name] = { ok: false, error: String(error?.message ?? error), stack: String(error?.stack ?? '').slice(0, 900) }
        }
      }
      return Response.json(out)
    }

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
      // Build the tree before reporting on it. A cold object has none, so this
      // route used to answer `tree: null` on a cold read and describe whatever
      // an earlier deployment had built on a warm one -- which is how a stale
      // service list got read as evidence about new code twice in a row. A
      // diagnostic that only works on a warm object is not a diagnostic.
      if (url.searchParams.get('tree') !== '0') await this.ensureTree()
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

    // The dsh web UI's own protocol, served by upstream's implementation of it.
    //
    // `dsh-host-apiproxy` was excluded from this build for most of the project
    // under a rule meant for the local host packages, and design 5.4 had it
    // marked "referenced" all along. It turns out to be the entire client
    // protocol behind `toFetchHandler(api)`: a Request in, a Response out, no
    // node:http and no webserver service. The two event streams are GET + SSE
    // over a ReadableStream, not WebSockets as an earlier note here recorded,
    // and everything else is POST /api/<method> with a JSON envelope.
    //
    // This runs LAST so the diagnostic routes above keep their names; the
    // protocol's own methods are POSTs and do not collide with them.
    //
    // U1 strips `/api` before forwarding, and the handler matches on the full
    // client paths, so the prefix goes back on here rather than U1 learning
    // which of its paths are protocol and which are ours.
    if (url.pathname !== '/') {
      await this.ensureTree()
      if (!this.api) {
        return Response.json({
          error: 'api-proxy-unavailable',
          hint: 'the client protocol service did not load; check /state for pending plugins and unmet injects',
        }, { status: 503 })
      }
      // One method of fifty-two is ours, for an architectural difference rather
      // than a preference.
      //
      // Upstream's session.create runs `mkdir(cwd, {recursive:true})` on the
      // HOST filesystem, because in a local dsh the host and the execution
      // world are the same machine. Here they are not: the Worker's virtual
      // filesystem has exactly three entries -- bundle, tmp, dev -- and `mkdir
      // /workspace` answers "operation not permitted", while the real workspace
      // lives in a container reached over a service binding.
      //
      // The alternative was to move the workspace root under /tmp so the host
      // mkdir would succeed. That buys a passing call and costs the thing worth
      // having: one root, `/workspace`, that means the same path everywhere the
      // agent looks.
      if (url.pathname === '/session.create') {
        return this.createSession(request)
      }

      const forwarded = new Request(
        new URL(`/api${url.pathname}${url.search}`, url.origin),
        request,
      )
      return toFetchHandler(this.api).fetch(forwarded)
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
      : await ctx.agents.create({
        sessionId: this.sessionId,
        // The session's working directory, stamped on its creation header.
        //
        // Left unset the header is just {version, id, createdAt}, and upstream
        // treats a session without a cwd as one that does not exist:
        // inspectApiRemoteSession rejects it outright, the workspace registry
        // has nothing to group it under, and the sandbox policy falls back to
        // process.cwd(), which on workerd is `/bundle` -- a read-only VFS path
        // that has nothing to do with the execution world.
        meta: { cwd: WORKSPACE_ROOT },
        agentOptions: chooseProvider(this.env, this.modelOverride, this.providerOverride),
      })
    return { agent: this.agent.agent, openedMs: Date.now() - tOpen }
  }

  /**
   * `realpath` and `stat` for dsh-workspace, answered by the execution world.
   *
   * Only these two, and only the parts the registry uses: a resolved path and
   * "is this a directory". Errors keep node's `code` so upstream's own ENOENT
   * handling still recognises them.
   */
  workspaceFsBridge() {
    const call = async (payload) => {
      const response = await this.env.EXEC.fetch('http://exec/fs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sandboxId: this.sandboxId, cwd: WORKSPACE_ROOT, payload }),
      })
      const body = await response.json()
      if (!body?.ok) throw new Error(String(body?.error ?? 'the execution world did not answer'))
      return body.result
    }

    const notFound = (path, op) => {
      const error = new Error(`no such file or directory, ${op} '${path}'`)
      error.code = 'ENOENT'
      return error
    }

    return {
      realpath: async (path) => {
        const result = await call({ op: 'realpath', path })
        if (result?.error) throw notFound(path, 'readlink')
        return result.path
      },
      stat: async (path) => {
        const { info } = await call({ op: 'stat', path })
        if (!info) throw notFound(path, 'stat')
        return {
          isDirectory: () => info.type === 'directory',
          isFile: () => info.type === 'file',
          size: info.size ?? 0,
        }
      },
    }
  }

  /**
   * One browser downlink: the same frames the SSE path emits, over a socket.
   *
   * The frame envelope is upstream's `fullFrame` — the client parses each
   * message with `serverRequestSchema` and then the payload with the mux or host
   * frame schema, so the shape is not ours to choose.
   *
   * The socket is accepted directly rather than through `acceptWebSocket`: this
   * one is pumped by a generator running in this object, so the object has to
   * stay in memory for as long as the stream is open. Hibernation is for sockets
   * that only react to inbound messages, and nothing is ever sent up this one.
   */
  async openEventSocket(kind) {
    await this.ensureTree()
    if (!this.api) {
      return Response.json({
        error: 'api-proxy-unavailable',
        hint: 'the client protocol service did not load; check /state',
      }, { status: 503 })
    }

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    server.accept()

    const abort = new AbortController()
    server.addEventListener('close', () => abort.abort())
    server.addEventListener('error', () => abort.abort())

    const rpcId = crypto.randomUUID()
    const frames = kind === 'mux'
      ? this.api.events.mux({ rpcId, payload: {} }, abort.signal)
      : this.api.events.host({ rpcId, payload: {} }, abort.signal)

    // The stream yields NARROW envelopes -- `{rpcId, payload}`, one rpcId per
    // frame, not the stream's. Sending the narrow object as the payload and the
    // stream's rpcId produced 43 well-formed-looking frames with `method`
    // undefined, which serverRequestSchema rejects one by one: a socket that
    // streams perfectly and renders nothing.
    const send = (narrow) => {
      try {
        server.send(JSON.stringify({
          type: 'server-request',
          rpcId: narrow.rpcId,
          method: narrow.payload.type,
          payload: narrow.payload,
        }))
      } catch { /* the client went away */ }
    }

    // Not awaited: the 101 has to go back now, and the pump outlives it.
    ;(async () => {
      try {
        for await (const narrow of frames) send(narrow)
      } catch (error) {
        // One stream/error frame, then close — the client has a schema for this
        // and will show it, which beats a socket that simply stops.
        if (!abort.signal.aborted) {
          send({
            rpcId,
            payload: {
              type: 'stream/error',
              error: { code: 'internal', message: String(error?.message ?? error), details: {} },
            },
          })
        }
      } finally {
        try { server.close(1000, 'stream ended') } catch { /* already closed */ }
      }
    })()

    return new Response(null, { status: 101, webSocket: client })
  }

  /**
   * `session.create`, without the host-filesystem step. See the routing comment
   * for why this one method is ours.
   */
  async createSession(request) {
    let body
    try {
      body = await request.json()
    } catch {
      return new Response('body is not JSON', { status: 400 })
    }
    const rpcId = body?.rpcId ?? 'session.create'
    const reply = (result) => Response.json({ type: 'server-response', rpcId, result })

    const payload = body?.payload ?? {}
    if (payload.agentPreset !== undefined) {
      // Preset composition lives in upstream's create path, which this replaces.
      // Refusing is the honest answer; quietly creating a session without the
      // preset would look like it worked.
      return reply({
        ok: false,
        error: { code: 'bad-request', message: 'agent presets are not supported by this deployment yet', details: {} },
      })
    }

    const sessionId = payload.sessionId ?? `session-${crypto.randomUUID()}`
    const { ctx } = await this.ensureTree()

    // The workspace the caller chose, and the two things that follow from it.
    //
    // The first version of this method dropped both: it ignored `workspaceId`
    // and `cwd` and hardcoded /workspace, so a session created for a chosen
    // folder pointed somewhere else and was never attached to the workspace at
    // all. The UI then had a session with no workspace, kept the composer
    // gated, and reopened the picker on every click — a loop with no error in
    // it anywhere.
    //
    // Reimplementing one method means owning all of its inputs, not the ones
    // that were convenient.
    let workspace
    if (payload.workspaceId !== undefined) {
      workspace = ctx.workspaceRegistry?.get?.(payload.workspaceId)
      if (workspace === undefined) {
        return reply({
          ok: false,
          error: {
            code: 'workspace-not-found',
            message: `workspace "${payload.workspaceId}" not found`,
            details: { workspaceId: payload.workspaceId },
          },
        })
      }
    }
    const cwd = workspace?.path ?? payload.cwd ?? WORKSPACE_ROOT

    try {
      const existing = ctx.sessions.get(sessionId)
      if (existing === undefined) {
        await ctx.agents.create({
          sessionId,
          meta: { cwd },
          agentOptions: chooseProvider(this.env, this.modelOverride, this.providerOverride),
        })
      } else if (existing.header?.cwd !== undefined && existing.header.cwd !== cwd) {
        // Upstream raises SessionCwdConflict here and this used to skip the
        // check entirely: an existing session was left at its old cwd and then
        // attached to a workspace whose path did not match it. That is not a
        // half-success, it is a session and a workspace disagreeing about where
        // the work happens, which nothing downstream can reconcile.
        return reply({
          ok: false,
          error: {
            code: 'session-conflict',
            message: `session "${sessionId}" already runs in "${existing.header.cwd}" and cannot be moved to "${cwd}"`,
            details: { sessionId, requestedCwd: cwd, existingCwd: existing.header.cwd },
          },
        })
      }
    } catch (error) {
      return reply({
        ok: false,
        error: { code: 'internal', message: `failed to create session "${sessionId}": ${String(error?.message ?? error)}`, details: {} },
      })
    }

    if (workspace !== undefined) {
      try {
        await workspace.attachSession(sessionId)
      } catch (error) {
        // Reported separately from creation, as upstream does: the session
        // exists, and saying so is what lets the client recover rather than
        // create a second one.
        return reply({
          ok: false,
          error: {
            code: 'workspace-attach-failed',
            message: `session "${sessionId}" was created but could not attach to workspace "${workspace.id}": ${String(error?.message ?? error)}`,
            details: { sessionId, workspaceId: workspace.id },
          },
        })
      }
    }

    return reply({ ok: true, value: { sessionId } })
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
            serviceNames: this.tree.services,
            failed: this.tree.report.failed.map((f) => f.specifier.replace('@deepseek-ai/', '')),
            unmet: unmetInjects(modules, this.tree.services).map(([service, wanters]) => ({ service, wanters })),
            // Registered but never settled: its `inject` list is still unmet, so
            // Cordis is holding it dormant. This is the signal that was missing
            // twice over -- a dormant plugin has no failure and publishes no
            // service, so both `failed` and a service count look perfectly fine
            // while a tool the user asked for simply does not exist.
            pending: this.tree.report.pending.map((x) => x.replace('@deepseek-ai/', '')),
            // Failures from plugins registered after assemble()'s settle window.
            // Nothing was collecting these, so they simply did not exist as far
            // as any report was concerned.
            lateErrors: this.lateErrors ?? [],
            // The end of the chain, and the only thing the model can actually
            // see. Everything above is plumbing; this is the outcome.
            // `schemas()` is what the model is actually offered -- the same
            // list the adapter turns into function tools. Enumerating the
            // service object's own properties (an earlier attempt here) returns
            // its internals and looks like an answer.
            tools: (() => {
              try { return this.tree.ctx.tools.schemas().map((t) => t.name).sort() } catch { return null }
            })(),
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
