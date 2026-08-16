# M3 — the dsh web UI

**Date**: 2026-08-16
**Status**: the UI is served and its protocol works end to end, on the real
model.

```
POST /api/session.create   ->  {sessionId}
POST /api/session.prompt   ->  {accepted: true}
     ... the agent runs a turn on @cf/deepseek-ai/deepseek-v4-flash-0731 ...
POST /api/session.history  ->  18 events, ending "PROTOCOL-OK"
GET  /api/events.mux       ->  200 text/event-stream
```

## Neither half had to be written

**The frontend ships compiled.** `@deepseek-ai/dsh-web-frontend` publishes a
`dist/` — 89 files, 4.4 MB — so U1 copies it into the assets directory and none
of the forty `dsh-client-*` packages are built. Static assets and `/api` share
one Worker on one origin, which is what removes CORS rather than configuring
around it (design 8.3).

**The protocol ships too, and in the right shape.** `dsh-host-apiproxy` is the
whole client protocol behind `toFetchHandler(api)`: a Request in, a Response
out, no `node:http` and no webserver service. It was excluded from this build
for the entire project by `^dsh-host-`, a rule meant for the local host
packages — while design 5.4 had `host/apiproxy` marked **referenced** all along.
Too broad in exactly the way `^dsh-sandbox` was.

### Two things recorded here earlier were wrong

The previous version of this note said both event paths were WebSockets
carrying an RPC framing, and treated the eighteen-message union as a protocol
needing a socket. Neither is true:

- `/api/events.mux` and `/api/events.host` are **GET + Server-Sent Events**,
  streamed from a `ReadableStream`. Worker-native, no hibernation concerns.
- Everything else is **POST /api/&lt;method&gt;** with a JSON envelope
  (`{type: 'client-request', rpcId, method, payload}`), 52 methods.
- The eighteen message types are the SSE **frame vocabulary**, not a transport.

They were read off the client's constants and its downlink union without
checking the host side, which was sitting in the closure the whole time.

## The one method that is ours

`session.create`, out of 52.

Upstream's version runs `mkdir(cwd, {recursive: true})` on the host
filesystem — correct for a local dsh, where the host and the execution world
are the same machine. Here they are not. Measured:

```
/            ->  bundle, tmp, dev
/workspace   ->  operation not permitted
/tmp/...     ->  writable
```

The workspace is in a container reached over a service binding, not in the
Worker. The alternative was to move the workspace root under `/tmp` so the host
call would succeed; that buys a passing call and costs the thing worth having —
one root, `/workspace`, that means the same path everywhere the agent looks.

`ensureSession` has exactly one caller, so intercepting one route is enough.

## Four seams the protocol required

None of these were wanted for themselves; the protocol simply does not load
without them.

| seam | provider | note |
|---|---|---|
| `sessionQuery` | `cf-session-query-do` | LIKE scan over this object's log. Two methods returning empty pages would have loaded too, but an empty result reads as "no matches" rather than "not implemented" |
| `directoryPicker` | `cf-workspace-picker` | the `browse` capability over the container filesystem. Design 8.2 assumed a cloud deployment has no directories to pick, which is true only of `native` |
| `attachments` | `cf-attachments-do` | images beside the log, dimensions read from PNG/JPEG/WebP/GIF headers |
| `sessionPersistence` read half | (existing) | `list`/`inspect`/`readFrom`/`listSnapshots` were abstract members nobody had called |

## Failures that named the wrong layer

Every one of these reported a symptom several layers above its cause.

**"history unavailable: expected object, received undefined"**, empty path, no
unit named. The session projection registry parses every registered unit's view
through its schema; `imageLimits` reads `ctx.attachments.imageLimits`, which the
abstract base declares and does not have. One absent property failed the whole
snapshot, and the snapshot is on the path of every transcript read. Found by
enumerating the registry and calling each unit's `view()`.

**"this.ctx.sessionPersistence.list is not a function"**, surfaced as the entire
UI protocol never loading. `dsh-workspace` calls `list()`, apiproxy waits on
`dsh-workspace`. An unimplemented abstract member is not inert — it is a failure
scheduled for its first user.

**A session that answers with the test stub.** The turn path overrides the model
per agent, so the tree-level default never mattered — until the protocol arrived
and read `agentDefaultModel.currentSelection()` for every session it creates.

**A tree that looked healthy and was stale.** `/state` answered `tree: null`
when cold and described an older deployment's tree when warm, and two diagnoses
in a row were read off it. It now builds the tree before reporting on it.

## Instrumentation

The diagnosis above was only possible because the reports were fixed first.
`/state` now carries:

- `serviceNames` — not just a count
- `pending` — registered but never settled. A dormant plugin has no failure and
  publishes no service, so `failed: []` and a normal count look perfectly fine
  while a tool the user asked for does not exist
- `lateErrors` — failures from plugins registered after `assemble()`'s settle
  window, where the real error had been landing nowhere at all
- `tools` — the schemas the model is actually offered. An earlier version
  enumerated the service object's own properties and returned
  `["cancellationStates", "canonicalResults", ...]`: an answer-shaped
  non-answer, which is the failure mode the instrumentation exists to catch

Plus `/api/persistence-probe`, `/api/vfs-probe` and `/api/pty-probe`, each of
which exists because a symptom was reported by a layer that was not at fault.

## Not done

- **Not opened in a browser.** Every call above was made with a service token
  over curl; the SPA's own behaviour against this protocol is unverified.
- **`agentPresets`** is absent, so `session.create` refuses a preset rather than
  quietly ignoring it, and `agentPreset.*` methods are unserved.
- **Attachments are rows, not R2.** Design 6.4 wants presigned direct upload;
  the limits here (5 MB per image) are what a Durable Object should hold.
- **One session object per user.** The edge derives the object name from Access
  claims, so every session of a user shares one Durable Object — many sessions
  inside one object, which is what `session.list` shows. Design 6.3's per-tenant
  workspace registry is the layer above this.
