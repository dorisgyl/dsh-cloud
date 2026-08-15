// The durable hand-off between "a prompt arrived" and "a turn ran".
//
// ADR-11 makes the alarm handler, not the WebSocket handler, the thing that
// runs a turn — so that closing the browser does not stop the agent. That means
// the prompt has to survive the gap between the two, and it has to survive the
// object being evicted in between, so it lives in SQLite rather than in memory.
//
// It also has to survive the alarm handler *failing*. Durable Object alarms are
// retried on an uncaught exception, so a prompt must not be re-run just because
// a later part of the turn threw. The queue therefore separates claiming from
// completing: `claim()` marks the row before the turn starts, and a retry sees
// an already-claimed row rather than a fresh prompt.

const DDL = [
  `CREATE TABLE IF NOT EXISTS pending_prompt (
     id        INTEGER PRIMARY KEY AUTOINCREMENT,
     session   TEXT NOT NULL,
     text      TEXT NOT NULL,
     enqueued  INTEGER NOT NULL,
     claimed   INTEGER,
     completed INTEGER,
     attempts  INTEGER NOT NULL DEFAULT 0,
     failure   TEXT
   )`,
]

/** Retries past this many attempts are abandoned rather than looped forever. */
export const MAX_ATTEMPTS = 3

export class TurnQueue {
  constructor(sql) {
    this.sql = sql
    for (const statement of DDL) sql.exec(statement)
  }

  enqueue(session, text, now) {
    this.sql.exec(
      'INSERT INTO pending_prompt (session, text, enqueued) VALUES (?, ?, ?)',
      session, text, now,
    )
  }

  /**
   * Take the oldest unfinished prompt and mark the attempt, in one step.
   * Marking before the turn runs is what makes an alarm retry safe: the retry
   * observes the incremented attempt count instead of replaying the prompt as
   * if it were new.
   */
  claim(now) {
    const row = this.sql
      .exec(
        `SELECT id, session, text, attempts FROM pending_prompt
         WHERE completed IS NULL AND attempts < ?
         ORDER BY id ASC LIMIT 1`,
        MAX_ATTEMPTS,
      )
      .toArray()[0]
    if (!row) return undefined
    this.sql.exec(
      'UPDATE pending_prompt SET claimed = ?, attempts = attempts + 1 WHERE id = ?',
      now, row.id,
    )
    return { ...row, attempts: row.attempts + 1 }
  }

  complete(id, now) {
    this.sql.exec('UPDATE pending_prompt SET completed = ? WHERE id = ?', now, id)
  }

  fail(id, message) {
    this.sql.exec('UPDATE pending_prompt SET failure = ? WHERE id = ?', String(message).slice(0, 500), id)
  }

  /** Whether another prompt is waiting, i.e. whether to re-arm the alarm. */
  hasWork() {
    const row = this.sql
      .exec(
        'SELECT COUNT(*) AS n FROM pending_prompt WHERE completed IS NULL AND attempts < ?',
        MAX_ATTEMPTS,
      )
      .toArray()[0]
    return (row?.n ?? 0) > 0
  }

  stats() {
    return this.sql
      .exec(
        `SELECT
           COUNT(*)                                                AS total,
           SUM(CASE WHEN completed IS NOT NULL THEN 1 ELSE 0 END)  AS completed,
           SUM(CASE WHEN completed IS NULL AND attempts >= ? THEN 1 ELSE 0 END) AS abandoned,
           SUM(CASE WHEN completed IS NULL AND attempts <  ? THEN 1 ELSE 0 END) AS waiting
         FROM pending_prompt`,
        MAX_ATTEMPTS, MAX_ATTEMPTS,
      )
      .toArray()[0]
  }
}
