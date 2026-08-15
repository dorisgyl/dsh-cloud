# ADR-10, settled: the chunk share is a function, not a number

**Date**: 2026-08-15
**Method**: `scripts/adr10-sweep.mjs`, 5 turns per point, each on a fresh
Durable Object, deterministic adapter with reply length and delta size as
inputs.

## Why a sweep

Every previous answer came from one measurement, and each was overturned by the
next:

| measured | answer | why it was wrong |
|---|---:|---|
| local, resume per turn | 10.5% | `request/header` was being re-logged every turn |
| local, after the live-agent fix | 37% | one reply length, one delta size |
| deployed, real model | 19% | terse model, and a header inflated the denominator |

The two variables that actually drive it are **reply length** and **delta
size** — how finely the provider slices the stream. They matter differently: a
chunk entry costs its structure whether it carries 8 characters or 80, so the
cost is driven by the *entry count*, which is reply length divided by delta
size.

## The curve

Chunk share of durable bytes per turn:

| reply chars | delta 8 | delta 24 | delta 80 |
|---:|---:|---:|---:|
| 100 | 33.8% | 22.8% | 17.7% |
| 250 | 50.9% | 33.4% | 24.2% |
| 500 | 64.4% | 45.0% | 32.1% |
| 1000 | 75.4% | 57.9% | 42.5% |
| 2000 | 83.0% | 69.0% | 53.5% |
| 4000 | 87.3% | 76.6% | 63.0% |
| 8000 | 89.6% | 81.2% | 69.4% |

Everything that is *not* chunks costs a flat **3.8 KB per turn** — the context
snapshots, the turn and step boundaries, and the assembled message. That fixed
floor is what the share is measured against, which is why short replies look
cheap and long ones do not.

The 250 / 24 cell reads 33.4%, against 37% measured independently after the
live-agent fix. The model reproduces the real measurement.

## What it settles

**For this product's actual use, chunks dominate.** A coding agent produces
replies in the 1,000–8,000 character range, and providers stream in deltas of
roughly 8–80 characters. That is the bottom-right of the table: **58% to 90%**.
The earlier 10% and 19% readings came from conditions a real workload will not
be in.

So ADR-10's instinct was right, and it matters more than any single measurement
suggested.

## But its mechanism is wrong, and the sweep shows a better one

ADR-10 says: drop `assistant/chunk` from the durable log. M1 ② established that
this cannot be done at the persistence layer at all — `append` requires the
first event's seq to equal the stored next-seq, so removing entries breaks
contiguity — and it dangles the `sourceEventSeqs` that `assistant/message`
carries.

The sweep points at a lever that has neither problem. Compare the same 8,000
character reply across delta sizes:

| delta | entries | KB/turn |
|---:|---:|---:|
| 8 | 803 | 131.9 |
| 24 | 270 | 59.1 |
| 80 | 83 | 33.7 |

**Same text, same information, 4× less log** — purely from logging fewer, larger
entries. The text itself is only 8 KB of the 131.9; the rest is per-entry
structure paid 803 times.

And delta size is **ours to choose**. The provider decides how it streams, but
nothing requires the log to record one entry per network delta: the adapter can
buffer and emit a coalesced chunk every N characters or every X milliseconds,
exactly as the write-throttling in ADR-10 already does for partial messages.

### Recommended rewrite of ADR-10

> **Decision**: `assistant/chunk` entries are **coalesced before logging** — one
> entry per N characters or X milliseconds of stream, whichever comes first —
> rather than one per provider delta. Chunks are **not** removed from the log.
>
> **Why**: chunks are 58–90% of durable bytes at realistic reply lengths, and
> almost all of that is per-entry structure rather than text. Coalescing to
> ~80-character entries cuts the log roughly 4× on a long reply while keeping
> every invariant: seq stays contiguous, `sourceEventSeqs` keeps referring to
> entries that exist, and replay stays lossless because the text is unchanged.
>
> **Cost**: streaming granularity in the UI is bounded by the coalescing window,
> not by the provider. At ~80 characters this is imperceptible; the WebSocket
> push can stay at full granularity independently, since it is not the log.

That last point is the crux: **the log and the live stream do not have to share
a granularity.** ADR-10 conflated them, which is why removing chunks from the
log looked like the only lever.

## Implemented, and one thing the sweep got wrong

`packages/cf-llm-transport/src/coalesce.mjs` wraps any adapter so consecutive
text deltas merge before the agent loop sees them. Defaults: 96 characters or
120 ms, whichever comes first.

Measured end to end at 8-character source deltas:

| reply chars | uncoalesced | coalesced | reduction |
|---:|---:|---:|---:|
| 500 | 12.2 KB | 6.5 KB | 1.9x |
| 2000 | 34.4 KB | 11.3 KB | 3.0x |
| 8000 | 124.4 KB | 30.8 KB | **4.0x** |

Chunk entries at 8,000 characters: 753 to 66. The assembled message still
carries the full text (1,390 bytes for a 1,000-character reply), and
`scripts/test-coalesce.mjs` covers the properties that matter: text preserved
verbatim, non-text chunks keep their order and force a flush, deltas for
different blocks never merge, a slow stream flushes on time.

### The correction

This document proposed that "the log and the live stream do not have to share a
granularity — the WebSocket push can stay at full granularity independently,
since it is not the log."

Reading `dsh-agent-loop` shows that is architecturally true and **false in this
implementation**:

```js
for await (const chunk of stream) {
  chunkSeqs.push(this.session.append("assistant/chunk", {turn, step, chunk}).seq)
  assembler.push(chunk)
}
```

One log entry per adapter chunk, unbuffered — and the UI streams from those same
log events. There is no separate live channel to keep fine. Coalescing the log
coalesces the visible typing, which is why the defaults are chosen against the
eye's threshold rather than to minimise bytes.

## Reproduce

```bash
node scripts/m0-bundle.mjs
cd units/session-do && npx wrangler dev --port 8819 --local
node scripts/adr10-sweep.mjs http://127.0.0.1:8819 5
```
