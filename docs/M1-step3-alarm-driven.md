# M1 ③ — turns outlive the client, driven by the alarm

**Date**: 2026-08-15
**Follows**: [M1-step2-persistence.md](./M1-step2-persistence.md)
**Implements**: ADR-11

## Result: the acceptance criterion passes

```
--- 1. connect ---
   replayed 0 events on connect
--- 2. send a prompt, then drop the socket at once ---
   socket closed
--- 3. wait with nobody listening ---
   durable events now 21, queue {"total":1,"completed":1,...}, sockets 0
--- 4. reconnect ---
   replayed 21 events on reconnect
   gained 21 events while disconnected

=== verdict ===
turn ran with no client attached : YES
prompt marked completed          : YES
log contiguous, no gaps          : YES
```

A second cycle resumes rather than creates and behaves the same: 21 → 41 events,
queue 2/2 completed, still contiguous.

**With zero WebSockets attached, the agent finished the work.** This is the one
thing a local dsh cannot do — its process belongs to the terminal you closed —
and it is the property M1 is meant to demonstrate.

## Shape

```
WebSocket message ─┐
HTTP  ?q=...      ─┴─> submit()  ─> enqueue in SQLite ─> setAlarm(now) ─> return

alarm() ─> claim (marks the attempt) ─> runTurn() ─> complete
                                     └─ broadcast to whatever sockets exist
                                     └─ re-arm if more work queued

WebSocket connect ─> replay the log from seq 0
```

The request that submits a prompt does not run the turn. It stores the prompt
and arms the alarm, then returns. Nothing about the turn depends on the caller
still being there.

### The queue is durable because it has to be

`units/session-do/src/turn-queue.mjs` keeps pending prompts in SQLite, not in
memory, for two independent reasons:

1. The object can be evicted between the submit and the alarm.
2. **Alarms are retried on an uncaught exception.** A prompt must not be re-run
   just because a later part of the turn threw, so claiming is separate from
   completing: `claim()` marks the row and counts the attempt *before* any work
   begins, and a retry then observes a claimed row instead of a fresh prompt.
   Past `MAX_ATTEMPTS` the prompt is abandoned rather than looped forever.

This is ADR-11's "recover from the log, do not restart from scratch" made
concrete. It is also the part the ADR warned could not be retrofitted: written
the naive way — run the turn inside the socket handler, keep pending work in a
field — neither eviction nor retry is survivable, and both failures are silent.

### Resume, not create

Every alarm checks for durable events and resumes when they exist. Creating on
an id that already has a persisted log is rejected as an id collision (M1 ②),
and the rejection appears only inside the session log.

## Findings

### 1. A resumed turn logs differently from a first turn

First turn (21 events) vs. resumed turn (20):

| | first | resumed |
|---|---:|---:|
| `session/end-seed` | – | 1 |
| `user/message` | 3 | 2 |
| `request/context` | 1 | – |

The resume boundary is itself a log entry, and the runtime-context snapshot is
not re-injected on a resumed turn. Worth knowing before projecting memory growth
from a single-turn measurement: turns are not uniform.

### 2. `assistant/chunk` remains the dominant entry type

9 of ~20 events per turn, unchanged from ②. Every turn measured so far puts
~45% of the log into chunks. The ADR-10 decision recorded in ② is still open and
gets more expensive with every turn.

### 3. The health signal stays inside the log

`runTurn` reports `ok` from `turn/end.reason.kind === 'completed'`. Nothing
above the log distinguishes a completed turn from a failed one — the HTTP
response is 200 either way, and now the alarm makes even that invisible, because
by the time a turn fails there may be no client at all. Any monitoring has to
read the log.

## Reproduce

```bash
node scripts/m0-bundle.mjs
cd units/session-do && npx wrangler dev --port 8809 --local
# in another shell:
node scripts/m1-disconnect-demo.mjs http://127.0.0.1:8809   # exits 0 on success
```

## Not yet done

The turn is coarse-grained: one alarm invocation runs the whole turn (ADR-11's
deliberate first choice). The upgrade trigger — subrequest peak above 500, or
wall clock approaching the invocation limit — has not been reached with a stub
adapter and cannot be until a real model is wired in.
