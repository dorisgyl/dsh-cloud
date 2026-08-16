// cf-session-query-do — the upstream `sessionQuery` seam, over the Durable
// Object's own session log.
//
// The seam is here because `dsh-host-apiproxy` injects it: the client protocol
// does not load without a search engine, so "cross-session search is out of
// scope" (design 5.3) could not stay a reason to leave the service absent. It
// could have been satisfied with two methods returning empty pages, but an
// empty result reads as "no matches" rather than "not implemented", so this
// searches for real.
//
// The base class does the work that is backend-independent — corpus listing,
// exact reads, filters, traces. Only ranking and query execution are abstract,
// and here they are a substring scan over the SQLite table the log already
// lives in.
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'

const DEFAULT_LIMIT = 20

/**
 * Wrap a query as a LIKE pattern, escaping the wildcards with `!`.
 *
 * Deliberately not a backslash. `ESCAPE '\'` has to survive a JS template
 * literal, a bundler and SQLite's own string parsing, and it did not: the clause
 * failed, the failure was swallowed, and the search reported "no matches" over a
 * table with 982 matching rows. `!` needs no escaping at any of those layers.
 */
function likePattern(query) {
  return `%${String(query ?? '').replace(/[!%_]/g, '!$&')}%`
}

/** The event's own timestamp; 0 when the row will not parse. */
function readTime(event) {
  try {
    return JSON.parse(event)?.time ?? 0
  } catch {
    return 0
  }
}
const SNIPPET_RADIUS = 90

export class CfSessionQueryDo extends SessionQueryEngine {
  constructor(ctx, config) {
    super(ctx, config)
    if (!config?.sql) throw new Error('cf-session-query-do requires the Durable Object SQLite handle (config.sql)')
    this.sql = config.sql
    this.sessionId = config.sessionId
  }

  /**
   * Rows whose serialised event contains the query, newest first.
   *
   * `LIKE` over the stored JSON rather than an index: the log of one session is
   * small enough that scanning it costs less than maintaining a second copy of
   * it, and a wrong-but-fast index is worse than an honest scan.
   */
  rowsMatching(sessionId, query, limit) {
    // No try/catch on purpose. The first version swallowed every failure and
    // returned an empty array, which reads as "no matches" -- and that is
    // exactly what it did: the query was failing while raw SQL found 982
    // matching rows in the same table at the same moment. A search that cannot
    // run has to say so.
    // `time` is not a column -- the table is (id, seq, type, event) and the
    // timestamp lives inside the serialised event. Selecting it produced
    // "no such column: time", which the swallowed catch turned into an empty
    // result set for every query.
    return this.sql.exec(
      `SELECT seq, type, event FROM session_event
        WHERE id = ? AND event LIKE ? ESCAPE '!'
        ORDER BY seq DESC LIMIT ?`,
      sessionId, likePattern(query), limit,
    ).toArray()
  }

  /** A window of the raw text around the first match, for the result list. */
  static snippet(text, query) {
    const haystack = String(text ?? '')
    const at = haystack.toLowerCase().indexOf(String(query ?? '').toLowerCase())
    if (at < 0) return haystack.slice(0, SNIPPET_RADIUS * 2)
    const start = Math.max(0, at - SNIPPET_RADIUS)
    const end = Math.min(haystack.length, at + String(query).length + SNIPPET_RADIUS)
    return `${start > 0 ? '…' : ''}${haystack.slice(start, end)}${end < haystack.length ? '…' : ''}`
  }

  hitsFor(sessionId, query, limit) {
    return this.rowsMatching(sessionId, query, limit).map((row) => ({
      sessionId,
      seq: row.seq,
      type: row.type,
      // From the event body, because the table does not carry it as a column.
      time: readTime(row.event),
      // Every row in this table is a live log entry; nothing here is shadowed
      // or log-only, because repair rewrites rows in place.
      surface: 'current',
      snippet: CfSessionQueryDo.snippet(row.event, query),
    }))
  }

  async searchEvents(request) {
    const sessionId = request.sessionId ?? this.sessionId
    const limit = request.limit ?? DEFAULT_LIMIT
    const session = this.ctx.sessions?.get?.(sessionId)
    return {
      session: session?.header ?? { id: sessionId },
      items: this.hitsFor(sessionId, request.query, limit),
    }
  }

  /**
   * Every session in this Durable Object, not just the one it was created for.
   *
   * An earlier version searched `this.sessionId` alone, which was right when a
   * Durable Object held exactly one session and wrong the moment the client
   * protocol arrived: the UI creates sessions through `session.create`, and they
   * all live in this object's SQLite. The symptom was a search that returned
   * nothing while the text was plainly in the log of a sibling session.
   *
   * What is still out of scope is the other DIRECTION: sessions belonging to
   * other tenants live in other Durable Objects, and reaching them needs a
   * tenant-level index (design 5.3). This is the true subset of that.
   */
  async searchSessions(request) {
    const limit = request.limit ?? DEFAULT_LIMIT
    const ids = this.sql.exec(
      `SELECT id, MAX(seq) AS lastSeq FROM session_event
        WHERE event LIKE ? ESCAPE '!'
        GROUP BY id ORDER BY lastSeq DESC LIMIT ?`,
      likePattern(request.query), limit,
    ).toArray()

    return {
      items: ids.flatMap((row) => {
        const hits = this.hitsFor(row.id, request.query, 1)
        if (!hits.length) return []
        const session = this.ctx.sessions?.get?.(row.id)
        return [{
          header: session?.header ?? this.headerOf(row.id) ?? { id: row.id },
          live: Boolean(session),
          persisted: true,
          bestMatch: hits[0],
        }]
      }),
    }
  }

  headerOf(sessionId) {
    const row = this.sql.exec('SELECT meta FROM session_header WHERE id = ?', sessionId).toArray()[0]
    return row ? JSON.parse(row.meta) : undefined
  }
}

export default CfSessionQueryDo
