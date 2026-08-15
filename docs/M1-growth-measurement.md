# M1 — how a session actually grows

**Date**: 2026-08-15
**Method**: 350 turns against one Durable Object in local workerd, with the
deterministic stub adapter. `units/session-do/src/index.mjs` → `/bench`.

## Summary: the design was worried about the wrong thing

| design's expectation | measured |
|---|---|
| memory (the log's in-memory projection) is the one shape-level risk (§6.2) | **365 KB at 1057 messages.** Not a risk at any realistic session length |
| `assistant/chunk` dominates the log (ADR-10) | chunks are **45% of entries but 10.5% of bytes** |
| — | **`request/header` is 71.9% of bytes**, one per turn at **9 KB each** |
| — | **reload, not memory, is the cost that scales** — and it is avoidable |

## The numbers

Resuming the session on every turn (what the alarm-driven loop does today):

| turn | events | log KB | proj msgs | proj KB | resume ms | run ms |
|---:|---:|---:|---:|---:|---:|---:|
| 0 | 1049 | 656 | 160 | 55 | 34 | 24 |
| 50 | 2049 | 1278 | 310 | 107 | 48 | 24 |
| 100 | 3049 | 1900 | 460 | 159 | 73 | 27 |
| 150 | 4049 | 2523 | 610 | 211 | 78 | 43 |
| 199 | 5029 | 3133 | 757 | 261 | 92 | 41 |

Holding **one live agent** across turns instead:

| turn | events | log KB | proj msgs | proj KB | run ms |
|---:|---:|---:|---:|---:|---:|
| 0 | 5049 | 3145 | 760 | 262 | 143 |
| 25 | 5499 | 3231 | 835 | 288 | 23 |
| 50 | 5949 | 3317 | 910 | 314 | 17 |
| 75 | 6399 | 3403 | 985 | 340 | 23 |
| 99 | 6831 | 3486 | 1057 | 365 | 27 |

| | resume per turn | live agent |
|---|---:|---:|
| ms per turn | ~130 at 250 turns, **climbing** | **30, flat** |
| log growth | 12.4 KB/turn | **3.4 KB/turn** |
| events per turn | ~20 | ~18 |

## What this changes

### 1. Memory is not the shape-level risk

§6.2 calls the in-memory projection "the only thing that could blow up" and
builds a four-rung mitigation ladder for it. Measured, the projection costs
**~350 bytes per message**: 365 KB at 1057 messages, so ~3.6 MB at 10,000 and
~36 MB at 100,000. A session long enough to threaten 128 MB is far beyond any
realistic one, and would hit other limits first.

The ladder is not wrong, it is just not urgent. What §6.2 should say is that the
projection is cheap and the *reload* is what scales.

### 2. Hold the agent live between turns

Resuming per turn costs twice:

- **O(n) reload.** Resume reads the whole log; at 250 turns it is 92 ms and
  climbing, already more than the turn's own 41 ms.
- **Triple the log growth.** 12.4 KB/turn versus 3.4 KB/turn, because each
  resume re-logs the ~9 KB `request/header` where a live agent does not.

So the Durable Object should keep the agent alive across turns and resume only
on a cold start or a hibernation wake — which is exactly what a Durable Object
is for. The current implementation disposes the handle after every turn, which
is the worst of both.

This is not in the design either way; the design never considered it, because it
assumed memory was the constraint that would force sessions out of memory.

### 3. ADR-10 aims at 10% of the problem

ADR-10 drops `assistant/chunk` from the durable log. Measured over 250 turns:

| type | count | KB | % bytes | avg bytes |
|---|---:|---:|---:|---:|
| **`request/header`** | 252 | **2254** | **71.9** | **9160** |
| `assistant/chunk` | 2268 | 329 | 10.5 | 148 |
| `user/message` | 505 | 255 | 8.1 | 517 |
| `assistant/message` | 252 | 103 | 3.3 | 418 |
| `agent/inbox/spliced` | 504 | 94 | 3.0 | 192 |
| everything else | ~1260 | 100 | 3.2 | — |

Dropping every chunk saves **10.5%** — and costs the `sourceEventSeqs`
integrity problem recorded in M1 ②, plus a contiguous-seq violation that makes
it unimplementable at the persistence layer at all.

`request/header` is 9 KB written once per turn, and it is nearly the same 9 KB
every time: the system prompt and tool schemas barely change. Storing a hash and
a delta would save most of **72%** with none of ADR-10's integrity cost.

**Recommendation: reopen ADR-10 against this data.** The cheap, safe win is
`request/header`; chunks are a rounding error by comparison.

### 4. §11's acceptance criterion 1 is not measurable as written

It asks for "the memory peak curve of the `SessionEvent` array plus the
`deriveMessages()` projection". **No API exposes a Worker's heap size** — not in
local workerd and not on a deployed Worker. What is measurable is what this
document measures: durable bytes, projected message count and serialized bytes,
and where time goes. The criterion should be restated in those terms, plus
"drive it until it breaks" as the ceiling test.

## Caveats

- The stub adapter produces a fixed 27-character reply. Real replies are longer,
  which raises `assistant/chunk` and `assistant/message` volume — but
  `request/header` is independent of reply length, so its 72% share is if
  anything a floor for short sessions.
- Local workerd may not enforce the production memory ceiling identically. The
  ceiling test and isolate-sharing question still need a deployed instance.
- No compaction ran during these 350 turns. `dsh-compaction-basic` is in the
  tree; at what point it triggers, and what it does to these curves, is not
  measured here.

## Reproduce

```bash
node scripts/m0-bundle.mjs
cd units/session-do && npx wrangler dev --port 8813 --local
curl "http://127.0.0.1:8813/bench?turns=200&every=50"          # resume per turn
curl "http://127.0.0.1:8813/bench?turns=100&every=25&live=1"   # one live agent
curl "http://127.0.0.1:8813/state"                             # bytes by type
```
