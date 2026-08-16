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
    const needle = `%${String(query ?? '').replace(/[\\%_]/g, '\\$&')}%`
    try {
      return this.sql.exec(
        `SELECT seq, type, time, event FROM session_event
          WHERE id = ? AND event LIKE ? ESCAPE '\\'
          ORDER BY seq DESC LIMIT ?`,
        sessionId, needle, limit,
      ).toArray()
    } catch {
      return []
    }
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
      time: row.time,
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
   * One Durable Object holds one session, so "search across sessions" is a
   * search of this one.
   *
   * Reaching the others means fanning out across Durable Objects, which needs a
   * tenant-level index that does not exist yet (design 5.3). Returning this
   * session's hits is the true subset; returning nothing would be a different
   * claim.
   */
  async searchSessions(request) {
    const limit = request.limit ?? DEFAULT_LIMIT
    const sessionId = this.sessionId
    const items = this.hitsFor(sessionId, request.query, limit)
    if (!items.length) return { items: [] }

    const session = this.ctx.sessions?.get?.(sessionId)
    return {
      items: [{
        header: session?.header ?? { id: sessionId },
        live: Boolean(session),
        persisted: true,
        bestMatch: items[0],
      }],
    }
  }
}

export default CfSessionQueryDo
