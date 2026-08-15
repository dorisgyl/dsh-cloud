# M1 — measured on Cloudflare

**Date**: 2026-08-15
**Where**: `dsh-session-do` deployed to a real account, driven for ~210 turns
with the stub adapter. Numbers from `wrangler tail`, parsed by
`scripts/read-tail.mjs`.

## Why this had to be deployed

Two things are simply not observable in `wrangler dev`:

**CPU time.** No API exposes it, locally or in-Worker. `wrangler tail` reports
`cpuTime` per invocation, and that is the only source.

**`Date.now()` does not advance during synchronous execution on Cloudflare.**
The clock only moves on I/O, so every duration the Worker measures about itself
reads as **0** once deployed. Every timing in `/bench` is therefore valid
locally and meaningless in production. This is not a bug to fix — it is a
property of the platform, and it means self-instrumented timings can never be
the deployed measurement.

## The numbers

| | |
|---|---|
| Worker startup (module evaluation) | **45 ms** — reported at deploy |
| Upload size | 2203 KiB, **gzip 470 KiB** |
| Cold request: build the tree + one turn | **101 ms CPU**, 1526 ms wall |
| Tree assembly alone (cold minus a warm turn) | **≈ 95 ms CPU** |
| Warm turn, live agent, stub model | **4.2 – 7.7 ms CPU** |
| CPU per 25-turn batch | 106 → 126 → 161 → 114 → 170 → 193 ms |

### What this settles

**`limits.cpu_ms` does not need raising.** The design set it to 5 minutes
because "a single agent step may exceed the default 30 s" — which conflated CPU
with wall clock. A turn costs ~5 ms of CPU; the 30 s default allows roughly six
thousand of them in one invocation. The setting has already been removed from
the config, and this is the measurement that justifies it.

**The free plan really does fail the way the README claims.** The free limit is
10 ms of CPU per invocation, and one warm turn is 4.2–7.7 ms — *with a stub
model and a short log*. It fits, barely, and then stops fitting. That is exactly
the failure mode worth $5 to avoid: it works while you are evaluating it and
breaks once you rely on it.

**CPU grows with log length, mildly.** 106 → 193 ms per 25-turn batch as the log
went from ~1000 to ~3800 events. Real but not alarming; worth re-measuring once
a real model makes turns bigger.

## The log is much smaller than the local measurement said

211 turns with the live-agent fix in place, read off the deployed instance:

| type | count | KB | % bytes | avg bytes |
|---|---:|---:|---:|---:|
| **`assistant/chunk`** | 1899 | 275 | **37.0** | 148 |
| `user/message` | 423 | 208 | 28.0 | 504 |
| `assistant/message` | 211 | 86 | 11.6 | 418 |
| `agent/inbox/spliced` | 422 | 79 | 10.6 | 191 |
| **`request/header`** | **3** | 27 | 3.6 | 9159 |
| everything else | 846 | 69 | 7.2 | — |

**744 KB across 3805 events — 3.5 KB per turn.**

### This corrects the earlier finding

[The local measurement](./M1-growth-measurement.md) found `request/header` at
**71.9% of bytes**, one per turn at 9 KB, and concluded that ADR-10 was aiming
at the wrong target.

That was an artifact of resume-per-turn. `request/header` is written **once per
agent open**, not once per turn: 3 entries here across 211 turns, against 252
entries across 252 turns before the fix. Holding the agent live removed 72% of
the log without touching ADR-10 at all.

With that gone, **`assistant/chunk` is the largest type again at 37%**. So
ADR-10's instinct was right; it was measured under conditions the fix has since
removed. The obstacles recorded in [M1 ②](./M1-step2-persistence.md) still
stand — dropping chunks breaks the contiguous-seq contract and dangles
`sourceEventSeqs`, so it cannot be done at the persistence layer — but the prize
is 37%, not 10%.

**Measure, fix, measure again.** The first measurement pointed at a real problem;
fixing it moved the answer somewhere else entirely.

## One more artifact of deploying

The bench sampled 9 durable events immediately after a turn that had produced
21. Persistence batches writes, so the durable log lags the in-memory log by up
to the coordinator's batch delay. Locally the timing hid it; on Cloudflare it is
visible. Anything that reads durable state straight after a turn has to expect
this.

## Still not measured

- **Idle cost.** Needs a billing period, not a benchmark.
- **Isolate sharing between Durable Objects**, which the design needs in order to
  set a memory threshold at all (§11 acceptance 2).
- **Cold start to first token** with a real model. The 1526 ms cold wall time
  here is tree assembly plus a stub turn; a real model adds its own latency.
- **Subrequests per turn.** The stub makes no outbound call, so the count is 0.
  With a real adapter it is at least one per step.

## Deployment state

`dsh-session-do` is deployed with **`workers_dev: false`** — it is reached only
through U1 dsh-edge, and leaving a `*.workers.dev` hostname on it would expose
an unauthenticated agent. The route used for these measurements has been
removed and now returns 404.
