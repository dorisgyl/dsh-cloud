# M3 — the dsh web UI

**Date**: 2026-08-15
**Status**: the UI is served and reachable. The transport behind it is not built.

## The UI does not have to be built

The single most useful discovery here: **upstream publishes the compiled SPA**.
`@deepseek-ai/dsh-web-frontend` ships a `dist/` — 89 files, 4.4 MB, `index.html`
and content-hashed assets — so U1 copies it into the assets directory rather
than compiling forty `dsh-client-*` packages through an unknown build.

That removes the largest piece of anticipated work in this milestone, and it
removes it entirely rather than reducing it.

```
GET /                    200  the real dsh web UI, behind Access
GET /api/state           200  our JSON surface
GET /api/events.mux      501  not implemented
GET /api/events.host     501  not implemented
```

Static assets and `/api` share one Worker on one origin, which is what removes
CORS and cross-origin WebSocket configuration rather than configuring around it
(design 8.3).

## What is missing, precisely

The UI talks over two WebSockets, whose paths come from
`dsh-client-connection`'s own constants:

| constant | value |
|---|---|
| `API_PATH` | `/api` |
| `MUX_EVENTS_PATH` | `/api/events.mux` |
| `HOST_EVENTS_PATH` | `/api/events.host` |

Both carry a JSON-RPC-style envelope — `client-request`, `server-response`,
`server-request`, `client-response` — plus a downlink union of eighteen message
types:

```
session/event          session/subscribed      session/queue
session/jobs           session/projection      approval/requested
approval/resolved      question/requested      question/resolved
stream/error           host/session-added      host/session-removed
host/session-status    host/agent-error        host/workspace-changed
host/workspace-removed host/workspace-order-changed
host/archived-sessions-changed                 host/remote-event
```

Design 5.4 already accounts for this work — `host/webserver` is "discard, write
our own" — but the size of it was not visible until now. It is a message
vocabulary and an RPC surface, not a socket that streams state.

### Why 501 rather than a partial implementation

`SessionAgentDO` already speaks part of this vocabulary: it answers a socket
with `session/subscribed { lastSeq }` and pushes `session/event`. Routing the
UI's paths to it would connect the socket and then behave wrongly.

Every serious failure in this project has returned 200: a turn that failed still
answered 200, an unconfigured deployment answered 403 with the wrong hint, a
Worker-level Access policy looks correctly applied and then kills every
WebSocket. A transport that connects and misbehaves belongs to that family. So
the two paths refuse, and say what is missing and where to read about it.

## What works today without the UI

The JSON surface under `/api` is complete enough to drive the agent:

```bash
curl "$U/api/whoami"
curl "$U/api/?q=Run+bash:+uname+-a"     # queue a turn
curl "$U/api/state"                     # log size, queue, tree health
curl "$U/api/history?from=0&limit=200"  # the session log, paged by cursor
```

and a WebSocket to `/api/` (not the UI's paths) speaks the subscribe/push subset
that `scripts/m1-disconnect-demo.mjs` exercises.

## Next

1. The mux envelope and a session-list RPC — enough for the UI to open.
2. Subscribe and push, which the session object already produces.
3. The five UI changes from design 8.2, none of which need a patch: the tool
   panels render from a keyed slot registry, so the minimal tier needs no change
   at all (see M1-client-questions.md).
