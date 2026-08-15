# M1 ② — storage and the session log, on Durable Object SQLite

**Date**: 2026-08-15
**Follows**: [M1-step1-turn.md](./M1-step1-turn.md)

## Result

Two of the five unfilled seams are now filled, and turns persist across calls.

| | before | after |
|---|---:|---:|
| services published | 30 | **32** |
| unmet injects | 5 | **4** |

Three turns in a row against one Durable Object:

```
resume  reply ok  durable events 29  seq 0..28  117 ms
resume  reply ok  durable events 49  seq 0..48   54 ms
resume  reply ok  durable events 69  seq 0..68   43 ms
```

Read straight out of SQLite, not from the in-memory log: one materialized
header, contiguous seq, ~20 events per turn.

`storageDomain` now publishes, which un-blocks its three consumers
(`dsh-message-feedback`, `dsh-session-projection-cache`, `dsh-workspace`).
`kv_unit` shows `dsh-workspace` has already opened a unit through the new
backend.

## What was actually needed

### `cf-storage-do`

Implements `KvFacet` / `KvUnit` over the Durable Object's SQLite handle. Units
share two physical tables (`kv_record`, `kv_unit`) with `unit` as the scoping
column, so the schema stays fixed no matter how many units the tree opens —
DDL inside a Durable Object competes with request handling.

Registering with the hub is **not** sufficient. `dsh-storage-domain` resolves
its configured backend through `storageBackendServiceKey(name)` →
`storage.backend.<name>`, so the backend must also be published as a Cordis
service under that exact name. Registering only with `ctx.storage.backend`
leaves `storageDomain` dormant with no error anywhere.

### `cf-session-persistence-do`

Much smaller than expected, because **upstream splits this seam in two**:

- `PersistenceCoordinator` owns everything backend-agnostic — per-id write
  serialization, batching, prepared-session caching, and the cold-recovery logic
  that balances an interrupted final turn.
- A backend implements `PersistenceBackend`: `loadStored`, `readStoredRevision`,
  `appendBatch`, `commitRepair`, `list`, optionally `loadStoredFrom` / `locate`.

So the service is a thin delegation and the storage half is plain SQL. Two
Durable Object properties shrink it further:

- **A DO is single-threaded and its SQLite writes are transactional**, so a batch
  lands whole or not at all. There is no torn tail: `tornMarker` is always
  `undefined` and `commitRepair` is just an append of the coordinator's closers.
- **There are no external writers**, so the revision is simply the highest
  stored seq.

## Findings

### 1. ADR-10 is not implementable at the persistence layer

`append`'s contract is explicit:

> Honors the append-only and contiguous-seq contracts: the first event's `seq`
> MUST equal the stored next-seq.

ADR-10 drops `assistant/chunk` from the durable log. Dropping them **here**
breaks seq contiguity and the coordinator rejects the next batch. So the
decision has to move:

- **(a)** stop chunks entering the session log at all, upstream of persistence —
  then seqs are contiguous by construction. This is what ADR-10 describes, but it
  is a change at the session-logging seam, not the persistence seam, and it also
  empties `assistant/message.sourceEventSeqs` (see M1 ①).
- **(b)** persist everything and prune the durable log separately, as a
  compaction step that rewrites seqs.
- **(c)** accept chunks in the durable log.

**Measured cost of (c):** chunks are **9 of every ~20 events**, i.e. **45% of all
log traffic**, for a 27-character reply. The share grows with reply length.

This needs a decision before the log is treated as final. The current
implementation does (c), because it is the only option that satisfies the
upstream contract as written.

### 2. A hibernation wake must resume, never create

Calling `ctx.agents.create()` on an id that already has a persisted log is
rejected:

```
session "m1-..." already has a persisted log on disk that does not match
this live session (id collision)
```

and — as in ① — the rejection appears **only inside the session log**, while the
request still returns 200.

`SessionAgentDO` therefore checks for durable events and picks
`ctx.agents.resume({ resumeSessionId, agentOptions })` over
`ctx.agents.create({ sessionId, agentOptions })`. This is not a detail of this
milestone: it is precisely what the alarm-driven turn loop in ③ has to do every
time a Durable Object wakes.

### 3. Abstract seams must not be registered as plugins

Registering `dsh-session-persistence` (the abstract base) publishes a
non-functional `sessionPersistence` service, and then the concrete backend
collides with it:

```
service "sessionPersistence" has been registered at <SessionPersistence>
```

Upstream loads the implementation, never the base. The same shape explains the
two remaining tree failures: `dsh-jobs` says so out loud, `dsh-settings` fails
with `this.load is not a function`.

`dsh-storage-domain` is likewise registered by hand rather than expanded blind,
because it needs `{ backend }` config naming a live backend.

### 4. A function plugin cannot carry a `name`

`plugin.name = 'cf-storage-do'` throws — a function's `name` is a read-only own
property — and it throws at **module scope**, which fails the whole isolate
before any request runs. Use the object plugin form (`{ name, inject, apply }`).

## Reproduce

```bash
node scripts/m0-bundle.mjs
cd units/session-do && npx wrangler dev --port 8807 --local
curl "http://127.0.0.1:8807/?q=turn+one"    # look at `durable` in the response
curl "http://127.0.0.1:8807/?q=turn+two"    # events grow, seq stays contiguous
```

## Still unfilled

`loader`, `sessionQuery`, `sessionTitle`, `jobs` — see
[M1-step1-plugin-tree.md](./M1-step1-plugin-tree.md) for what each needs.
