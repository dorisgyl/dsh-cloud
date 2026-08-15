# M1 — a real model, and what it costs

**Date**: 2026-08-15
**Follows**: [M1-deployed-measurements.md](./M1-deployed-measurements.md)
**Implements**: ADR-12's zero-configuration default

## What was built

`packages/cf-llm-transport/src/workers-ai.mjs` — an `LlmAdapter` over the `AI`
binding. No API key anywhere: `wrangler deploy` and the agent talks.

The session object registers **both** routes and picks per request: `workers-ai`
when the `AI` binding is present, the deterministic stub otherwise. So local dev
(where Workers AI is unavailable) keeps working unchanged, and a deployment
needs no configuration to be useful.

**Cloudflare hosts DeepSeek's own models** — `@cf/deepseek-ai/deepseek-v4-flash-0731`
and `-pro-0813` — which makes the right default for DeepSeek's own harness a
model that needs no third-party account at all. That is the default.

## The numbers

Measured on a deployed Worker with `@cf/meta/llama-3.1-8b-instruct-fp8`
(the DeepSeek models are paid-plan only; see below), four turns:

| | stub | **real model** |
|---|---:|---:|
| CPU per turn | 4.2 – 7.7 ms | **≈ 49 ms** (148 ms for 3 turns) |
| wall per turn | 40 ms | **6.4 – 7.4 s** |
| events per turn | ~19 | 21.3 |
| bytes per turn | 3.5 KB | 8.3 KB |
| cold start to a finished turn | 1.5 s | **7.45 s** |

### The free-plan finding is worse than the README says

The README currently says a free-plan deployment works for the first few turns
and then fails as the log grows. **Measured, it cannot complete even one turn:**
a real turn costs ~49 ms of CPU against the free plan's 10 ms per invocation.

The earlier stub measurement (4.2–7.7 ms) fit under the limit, which is why
everything appeared fine — the account used for all of these measurements *is*
on the free plan. The stub was hiding the wall.

The paid default of 30 s still allows roughly 600 turns in one invocation, so
`limits.cpu_ms` still does not need raising.

### Two model families, one gate

```
5035: Model @cf/deepseek-ai/deepseek-v4-flash-0731 is not available on the
      Workers Free plan. Upgrade to access this model
```

The error arrives at the **first model call**, i.e. inside the session log,
which by now is the expected place for everything to fail quietly. Since the
deployment already requires the paid plan on CPU grounds, keeping the DeepSeek
model as the default is consistent — and `AI_MODEL` overrides it.

### `Date.now()`, refined

[The previous note](./M1-deployed-measurements.md) said the clock never advances
on Cloudflare. More precisely: **it advances on I/O**. A span containing a model
call measures correctly (`runMs: 6930`); a purely synchronous span still reads
0. Self-instrumentation is therefore usable for anything that crosses I/O, and
useless for anything that does not.

## What this did NOT answer

**The chunk share is still open, and ADR-10 still needs it.** `llama-3.1-8b` is
terse: 11 chunk entries per turn against the stub's 9. The hoped-for "real
replies are 10–100× longer, so chunks dominate" was not observable with this
model on these prompts. A verbose model, or a task that produces real output,
would settle it.

**`request/header` was inflated by the measurement itself.** It shows as 54% of
the delta over these four turns because switching models forced the live agent
to reopen, and a header is written per agent open. Steady state is one per agent
lifetime, as [the previous measurement](./M1-deployed-measurements.md) found.

**Subrequests per turn remain uncounted.** The adapter records one `AI.run` per
turn, but whether a binding call counts against the per-invocation subrequest
budget is not visible in `wrangler tail`. ADR-11's upgrade trigger is written in
terms of that budget, so it stays unverified.

## Deployment state

`dsh-session-do` is deployed with the `AI` binding and **`workers_dev: false`**.
The measurement route was open for the duration of this measurement and now
returns 404.
