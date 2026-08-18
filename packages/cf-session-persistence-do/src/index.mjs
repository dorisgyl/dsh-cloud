// cf-session-persistence-do — the session log, on Durable Object SQLite.
//
// Upstream splits this seam in two: `SessionPersistence` is the service, and
// `PersistenceCoordinator` owns everything backend-agnostic — per-id write
// serialization, batching, prepared-session caching, and the cold-recovery
// logic that balances an interrupted final turn. A backend implements the much
// smaller `PersistenceBackend`: read a prefix, read a revision, append a batch,
// commit a repair, list headers.
//
// Two properties of a Durable Object make this backend simpler than the file
// backends upstream ships:
//
//   * A DO is single-threaded and its SQLite writes are transactional, so a
//     batch either lands whole or not at all. There is no torn tail, hence
//     `tornMarker` is always undefined and `commitRepair` is a plain append.
//   * There are no external writers, so the revision can just be the highest
//     stored seq.
import { SessionPersistence, PersistenceCoordinator, SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'

const DDL = [
  `CREATE TABLE IF NOT EXISTS session_header (
     id           TEXT PRIMARY KEY,
     meta         TEXT NOT NULL,
     materialized INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS session_event (
     id    TEXT NOT NULL,
     seq   INTEGER NOT NULL,
     type  TEXT NOT NULL,
     event TEXT NOT NULL,
     PRIMARY KEY (id, seq)
   )`,
  `CREATE INDEX IF NOT EXISTS session_event_by_id ON session_event (id, seq)`,
]

/**
 * When each row was written, for retention.
 *
 * A separate statement because `CREATE TABLE IF NOT EXISTS` does not add a
 * column to a table that already exists, and this deployment has tables that
 * predate the column. Durable Object SQLite has no `ADD COLUMN IF NOT EXISTS`,
 * so the duplicate is caught and ignored -- the same shape as the plugin
 * permissions migration, and for the same reason.
 *
 * The time is stored here rather than read out of the event JSON because
 * retention has to scan it. `session_event` has no `time` column and never did;
 * a query that assumed one is what produced `no such column: time` from a
 * search that then reported "no matches" over 982 matching rows.
 */
const MIGRATIONS = [
  'ALTER TABLE session_event ADD COLUMN at INTEGER NOT NULL DEFAULT 0',
]

/**
 * Delete whole sessions that have been idle longer than `retentionMs`.
 *
 * WHOLE sessions, deliberately. Deleting events older than a cutoff would
 * truncate a long-running conversation from the front: the agent replays its
 * log to rebuild history, so it would resume with the beginning missing, carry
 * on confidently, and report nothing wrong. A session either exists complete or
 * does not exist.
 *
 * Idleness is `MAX(at)` per session, not creation time -- a conversation
 * someone returns to every day should not expire on its third day.
 *
 * Rows written before the `at` column existed carry 0 and would look infinitely
 * old. They are excluded rather than swept: an unknown timestamp is not
 * evidence of age, and using it as one would delete exactly the oldest and most
 * likely wanted history the first time this ran.
 */
export function sweepExpiredSessions(sql, { now = Date.now(), retentionMs, keepIds = [] } = {}) {
  if (!Number.isFinite(retentionMs) || retentionMs <= 0) return { swept: [], skipped: 'retention disabled' }
  const cutoff = now - retentionMs
  const rows = sql
    .exec('SELECT id, MAX(at) AS lastAt, COUNT(*) AS events FROM session_event GROUP BY id')
    .toArray()

  const swept = []
  for (const row of rows) {
    const lastAt = Number(row.lastAt ?? 0)
    if (lastAt === 0) continue
    if (lastAt >= cutoff) continue
    if (keepIds.includes(row.id)) continue
    sql.exec('DELETE FROM session_event WHERE id = ?', row.id)
    sql.exec('DELETE FROM session_header WHERE id = ?', row.id)
    swept.push({ id: row.id, events: Number(row.events), lastAt: new Date(lastAt).toISOString() })
  }
  return { swept, cutoff: new Date(cutoff).toISOString(), examined: rows.length }
}

/** The storage half: everything the coordinator delegates downwards. */
export class DoSqlitePersistenceBackend {
  constructor(sql) {
    this.name = 'do-sqlite'
    this.sql = sql
    for (const statement of DDL) sql.exec(statement)
    for (const statement of MIGRATIONS) {
      try {
        sql.exec(statement)
      } catch (error) {
        if (!/duplicate column/i.test(String(error?.message ?? error))) throw error
      }
    }
  }

  maxSeq(id) {
    const row = this.sql.exec('SELECT MAX(seq) AS m FROM session_event WHERE id = ?', id).toArray()[0]
    return row?.m ?? null
  }

  header(id) {
    const row = this.sql.exec('SELECT meta FROM session_header WHERE id = ?', id).toArray()[0]
    return row ? JSON.parse(row.meta) : undefined
  }

  async loadStored(id) {
    const meta = this.header(id)
    if (!meta) return undefined
    const rows = this.sql
      .exec('SELECT event FROM session_event WHERE id = ? ORDER BY seq ASC', id)
      .toArray()
    return {
      meta,
      events: rows.map((r) => JSON.parse(r.event)),
      revision: this.revisionOf(id),
      // No torn tail is possible: DO SQLite writes are transactional.
      tornMarker: undefined,
    }
  }

  async loadStoredFrom(id, fromSeq) {
    const meta = this.header(id)
    if (!meta) return undefined
    const rows = this.sql
      .exec('SELECT event FROM session_event WHERE id = ? AND seq >= ? ORDER BY seq ASC', id, fromSeq)
      .toArray()
    return { meta, events: rows.map((r) => JSON.parse(r.event)) }
  }

  async readStoredRevision(id) {
    if (!this.header(id)) return undefined
    return this.revisionOf(id)
  }

  /** With no external writers, the highest stored seq identifies the state exactly. */
  revisionOf(id) {
    return SessionPersistenceRevision(`${this.maxSeq(id) ?? -1}`)
  }

  async appendBatch(meta, events, isMaterialized) {
    // `create()` may defer the physical write, so the header is written on the
    // first batch that materializes the session.
    this.sql.exec(
      `INSERT INTO session_header (id, meta, materialized) VALUES (?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET meta = excluded.meta,
                                      materialized = MAX(session_header.materialized, excluded.materialized)`,
      meta.id, JSON.stringify(meta), isMaterialized ? 1 : 0,
    )
    for (const event of events) {
      let serialized
      try {
        serialized = JSON.stringify(event)
      } catch (cause) {
        // The contract asks that a non-serializable payload name its event type.
        throw new Error(`cf-session-persistence-do: event "${event?.type}" is not JSON-serializable`, { cause })
      }
      this.sql.exec(
        'INSERT INTO session_event (id, seq, type, event, at) VALUES (?, ?, ?, ?, ?)',
        meta.id, event.seq, event.type, serialized, Date.now(),
      )
    }
  }

  /**
   * Close an interrupted turn. There is never a torn record to discard here,
   * so this is exactly an append of the coordinator's synthetic closers.
   */
  async commitRepair(meta, _tornMarker, closers) {
    if (!closers.length) return
    await this.appendBatch(meta, closers, true)
  }

  async list() {
    return this.sql
      .exec('SELECT meta FROM session_header WHERE materialized = 1 ORDER BY id ASC')
      .toArray()
      .map((r) => JSON.parse(r.meta))
  }

  /** No per-session artifact exists; sessions are rows, not files. */
  locate() {
    return undefined
  }
}

/** The service half: a thin delegation to the coordinator. */
export class CfSessionPersistenceDo extends SessionPersistence {
  static inject = ['sessions']

  constructor(ctx, config) {
    super(ctx)
    const sql = config?.sql
    if (!sql) throw new Error('cf-session-persistence-do requires the Durable Object SQLite handle (config.sql)')
    this.backend = new DoSqlitePersistenceBackend(sql)
    this.coordinator = new PersistenceCoordinator(ctx, this.backend)
  }

  /** Rows, not files — so there is nothing to point at and no raw artifact. */
  locate() { return undefined }
  get supportsRawArtifacts() { return false }

  create(meta) { return this.coordinator.create(meta) }
  append(id, events) { return this.coordinator.append(id, events) }
  load(id) { return this.coordinator.load(id) }
  prepare(id, signal) { return this.coordinator.prepare(id, signal) }

  // The read half of the seam. These were missing for as long as nothing called
  // them, and the first caller was three layers away: dsh-workspace asks for
  // `list()` to enumerate sessions, dsh-host-apiproxy waits on dsh-workspace,
  // and the visible symptom was the entire web UI protocol never loading.
  //
  // An abstract member with no implementation is not inert. It is a failure
  // scheduled for whenever someone first needs it, and the report it produces
  // names the wrong layer.
  inspect(id, signal) { return this.coordinator.inspect(id, signal) }
  readFrom(id, fromSeq, signal) { return this.coordinator.readFrom(id, fromSeq, signal) }
  list() { return this.backend.list() }

  /**
   * No snapshots. Sessions are rows in this object's SQLite, and the Durable
   * Object's own storage is what makes them durable — there is no separate
   * snapshot artifact to enumerate, so the honest answer is an empty list
   * rather than an unimplemented method.
   */
  async listSnapshots() { return [] }
}

export default CfSessionPersistenceDo
