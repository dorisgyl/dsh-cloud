# Cloudflare Access: the fork in the road, measured

**Date**: 2026-08-15
**Why this document exists**: the identity design was changed twice on the
strength of documentation and corrected both times by measurement against a
live deployment.

## The fork

Access can protect a Worker two ways, and they differ in more than convenience.

| | Worker-level (Workers dashboard → Access tab) | **Hostname-based** (Zero Trust → Access → Applications → Self-hosted) |
|---|---|---|
| WebSocket upgrades | **403** — documented limitation | **work** (measured) |
| `ctx.access` | populated | **undefined** (measured) |
| identity arrives as | a runtime API, no parsing | `Cf-Access-Jwt-Assertion`, verified by the Worker |
| service tokens | not configurable from the panel | full policy editor |

**This project's entire public surface is WebSockets**, so the choice is made
for us: hostname-based, and therefore verify the assertion.

Cloudflare's Workers documentation states the WebSocket limitation plainly and
names Durable Objects specifically. It is easy to miss, and nothing fails at
configuration time — a Worker-level policy looks correctly applied and then
every upgrade returns 403.

## What was measured, not assumed

### `ctx.access` does not apply here

```json
{ "ctxAccess": "undefined",
  "jwtAssertionHeader": "present (877 chars)" }
```

The `ctx.access` API is real, pleasant, and belongs to the Worker-level and
account-level integration. Under a hostname-based application it is `undefined`
and the classic assertion header is present instead.

An earlier commit removed the JWT verification path on the strength of the
Workers documentation page, which describes that other integration. It has been
restored — the measurement, not the page, decides which integration we are in.

### The service-token assertion is a machine identity

```json
{ "type": "app",
  "sub": "",
  "common_name": "bb587db5….access",
  "iss": "https://<team>.cloudflareaccess.com" }
```

No e-mail, and an **empty** subject. The identity is the token's client id in
`common_name`. A human login carries `email` and a real `sub` instead.

So the claim mapping has to recognise both, and `cf-identity` now marks which:

```json
{ "tenant": "default",
  "user": "bb587db53da0111e4c6eb260ee5a0bf3.access",
  "kind": "service",
  "email": null }
```

`kind` matters because a machine principal gets its own shard rather than
borrowing a person's — automation and its owner do not share session state.

### WebSockets survive hostname-based Access

`scripts/ws-access-check.mjs`, against the live deployment with a service token:

```
upgrade OK
received: {"type":"session/subscribed","sessionId":"m1-…","lastSeq":106}
WebSocket through Access: WORKS
```

This is the check the whole choice rests on, and it had not been run.

## Real-model measurements, now unblocked

The paid-plan upgrade and a reachable protected endpoint together unblocked what
had been stuck. Five turns against `@cf/deepseek-ai/deepseek-v4-flash-0731`,
from `wrangler tail`:

| | CPU | wall |
|---|---:|---:|
| enqueue (`?q=` → store prompt, arm alarm, return) | **1–5 ms** | 67–139 ms |
| the turn itself (alarm invocation) | **23–49 ms** | 1.2–2.5 s |
| first turn, including tree assembly | 106 ms | 1.56 s |

Three things follow:

- **The submit path is essentially free**, which is what ADR-11 wanted: a prompt
  arrives, is stored, arms the alarm, and returns in single-digit CPU
  milliseconds. Nothing about the turn depends on the caller staying.
- **A real turn is 5–10× the CPU of a stub turn** (23–49 ms against 4.2–7.7 ms),
  consistent with the earlier llama measurement of ~49 ms. The free plan's 10 ms
  remains impossible for one turn, now confirmed on two model families.
- **`limits.cpu_ms` still does not need raising.** At 49 ms a turn, the 30 s
  default allows roughly six hundred turns in one invocation.

Cold start to a finished answer is **~1.5 s wall**, of which the plugin tree is
about 100 ms of CPU and the rest is the model.

## Still not measurable

- **Idle cost** needs a billing period, not a benchmark.
- **Isolate sharing between Durable Objects** — no API exposes it, and the only
  indirect signal is pushing to OOM. §11's acceptance criterion 2 asks for a
  memory threshold derived from it; it may have to be stated as a policy rather
  than a measurement.
- **Subrequests per turn.** The adapter records one `AI.run` per turn, but
  `wrangler tail` does not report a subrequest count, so whether a binding call
  counts against the per-invocation budget is unresolved. ADR-11's upgrade
  trigger is written in those terms.

## Deployment state

- `dsh-session-do` — no route; reachable only through the edge.
- `dsh-edge` — on `workers.dev` for now, protected by a hostname-based Access
  application with two policies: `Allow` for a human, `Service Auth` for the
  automation token. Unauthenticated requests get Access's own 403; the static
  placeholder page is public by design.
- Local development uses `DEV_IDENTITY`, which `cf-identity` ignores whenever
  `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` are set, so a deployment cannot fall
  back into it.
