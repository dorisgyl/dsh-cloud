# M1 ① — one agent turn runs inside a Durable Object

**Date**: 2026-08-15
**Follows**: [M1-step1-plugin-tree.md](./M1-step1-plugin-tree.md), which stood the tree up. This drives it.

## Result

A complete turn runs end to end inside a real Durable Object, and the reply is
read back off the session log.

```
turn/start → step/start → user/message ×3 → request/header → request/context
→ assistant/chunk ×9 → assistant/message → step/end → turn/end{completed}
```

21 log entries. `reply: "Hello from a Durable Object."`

### The four numbers

| | value | note |
|---|---:|---|
| **tree assembly** | **266 ms** | paid once per DO instance — i.e. on every cold start and every hibernation wake |
| **turn wall clock** | **90 ms** first, **39–42 ms** warm | with a deterministic stub adapter, so this is the loop's own overhead with model latency removed |
| **model calls per turn** | **1** | one step, one call. With a real adapter this is one outbound subrequest |
| **CPU time** | **not measurable locally** | workerd does not expose it in `wrangler dev`. It has to come from Cloudflare observability on a deployed Worker. Wall clock is not a substitute — the design doc's original `limits.cpu_ms` reasoning conflated the two (see 3.1) |

The turn number is a floor, not a forecast: a real model call adds seconds of
wall clock but almost no CPU, and multi-step turns multiply the model calls.
What it does establish is that **the loop's own cost is tens of milliseconds**,
so the per-invocation budget is spent on model calls and tool calls, not on the
loop.

## Why a stub adapter

`packages/cf-testing/src/stub-llm-adapter.mjs` yields a canned stream. That
separates *"does the loop run inside a Durable Object"* from *"can we reach a
model"*, so the first question is answered locally, deterministically and
without credentials. The real transport replaces the adapter without touching
the loop.

## Findings

### 1. Session events are log entries, not Cordis events

This is the most consequential discovery for what comes next. Listening on
`ctx.on('turn/start')` **never fires** — `turn/start`, `assistant/chunk` and the
rest are records appended to `session.events`, a separate append-only log.

**`cf-session-persistence-do` must therefore hook the session's append path, not
the Cordis event bus.** Building it against `ctx.on(...)` would produce a
persistence layer that silently stores nothing.

### 2. A failing turn still returns HTTP 200

Both failures hit during this step (below) produced a successful-looking
response. The turn ran, the driver went back to idle, and the *only* record of
the failure was inside the log:

```json
{"type":"turn/end","data":{"turn":1,"reason":{"kind":"error",
 "error":{"message":"...","code":"INVALID_MODEL_INFO"}}}}
```

So the health signal for a turn is `turn/end.reason.kind === 'completed'`, read
from the log. Nothing above the log knows the difference. Any monitoring built
later has to read it there.

### 3. `sourceEventSeqs` — a consequence for ADR-10

The assembled message names the chunk entries it came from:

```json
{"type":"assistant/message","seq":18,
 "data":{"message":{...},"usage":{"inputTokens":16,"outputTokens":7}},
 "sourceEventSeqs":[9,10,11,12,13,14,15,16,17]}
```

ADR-10 drops `assistant/chunk` from the durable log. **That leaves
`sourceEventSeqs` pointing at sequence numbers the persisted log does not
contain.** A decision is needed when writing `cf-session-persistence-do`: strip
the field on write, or keep it as provenance-only and document that the
referenced entries are deliberately absent. Doing neither produces a log that
fails its own integrity check.

The chunk count also confirms ADR-10's premise directly: **9 chunk entries for a
27-character reply**. Chunk volume scales with response length, and they are the
overwhelming majority of log traffic (9 of 21 entries here, and the ratio only
grows with longer replies).

### 4. The prompt is not the only input

A single user prompt produced **three** `user/message` entries: the prompt
itself, a runtime-context snapshot (approval policy and similar), and a
time-context snapshot. Both extra entries are injected by plugins
(`dsh-time-context` and friends) at step preparation.

Worth knowing before measuring memory in M1: the log grows faster per turn than
"one message in, one message out" would suggest.

### 5. Two API details that fail silently

- **`agentOptions`, not `options`.** `ctx.agents.create({ sessionId, agentOptions })`.
  With the wrong key the turn runs to completion and fails at the model call with
  *"has no provider/model"* — only in the log.
- **`resolveModel()` must return `LlmResolvedModelInfo`**: `id` (not `model`), a
  human `name`, and capacity nested under `context: { contextWindow }`. Getting
  the shape wrong fails with `INVALID_MODEL_INFO` — again, only in the log.

## Reproduce

```bash
node scripts/m0-bundle.mjs
cd units/session-do && npx wrangler dev --port 8803 --local
curl "http://127.0.0.1:8803/?q=Say+hello"
```

## Not yet done

- The DO has a SQLite handle but writes nothing — persistence is ② .
- The turn is driven by an inbound request, not by an alarm — that is ③, and with
  it the log-recovery entry point ADR-11 requires.
- No real model is reachable yet; the adapter is a stub.
