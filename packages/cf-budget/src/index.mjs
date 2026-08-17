// cf-budget — what one user may spend, and how fast.
//
// `docs/parity.md` has carried "Rate limiting, spend caps, admission control:
// a public deployment pays for whatever it is asked to do" since before there
// was anything to spend. There now are three separate meters, and they fail
// differently enough that one number cannot cover them:
//
//   model turns      a few cents each, bounded by how fast a person types
//   container ms     billed by runtime, and a `sleep 600` costs the same as
//                    600 seconds of real work
//   browser ms       billed by browser time; one fetch is ~150-900ms
//
// PER USER, not per session object. `sessionObjectName` puts the session id in
// the object name and the edge reads it from `?session=`, so a caller can mint
// unlimited Durable Objects -- and each one derives its own `sandboxId`, so
// each one wants its own container. A ledger attached to the session object
// would be reset by incrementing a query parameter.
//
// The ledger therefore lives in an object named for the USER alone, which is
// the one name a caller cannot vary while remaining themselves: U1 builds it
// from verified Access claims.

/** A resource, its unit, and what a stranger may have in one period. */
export const LIMITS = {
  // Requests are the cheap meter, and the one that catches a runaway loop
  // before it reaches an expensive one.
  // 240/minute, not 60. The first number was one request per second, and a
  // web UI opening a page spends a burst of them -- two socket upgrades, a
  // describe, and a handful of RPC calls -- so it would have throttled a human
  // on page load. This meter exists to catch a loop doing thousands, and the
  // gap between a person and a loop is wide enough that the threshold does not
  // need to be tight to sit inside it.
  requests: { unit: 'requests', window: 'minute', fallback: 240 },
  modelTurns: { unit: 'turns', window: 'day', fallback: 100 },
  containerMs: { unit: 'ms of container runtime', window: 'day', fallback: 15 * 60_000 },
  browserMs: { unit: 'ms of browser time', window: 'day', fallback: 5 * 60_000 },
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS budget (
  meter TEXT PRIMARY KEY,
  used INTEGER NOT NULL DEFAULT 0,
  periodStart INTEGER NOT NULL
)`

/** UTC day and minute boundaries. Deliberately absolute, not rolling. */
export function periodStart(window, now) {
  if (window === 'minute') return Math.floor(now / 60_000) * 60_000
  return Math.floor(now / 86_400_000) * 86_400_000
}

export function periodEnd(window, now) {
  return periodStart(window, now) + (window === 'minute' ? 60_000 : 86_400_000)
}

/**
 * A fixed window, not a sliding one.
 *
 * A sliding window is fairer and needs the timestamp of every event; a fixed
 * one needs a counter and a boundary. This is a spend cap, and the failure it
 * exists to prevent is a bill, not an unfair rejection at a boundary. When
 * "twice the limit across one boundary" starts mattering, the shape to reach
 * for is a sliding window, not a smaller number.
 */
export class Budget {
  constructor({ sql, limits = {} }) {
    if (!sql) throw new Error('cf-budget requires the Durable Object SQLite handle')
    this.sql = sql
    this.sql.exec(SCHEMA)
    this.limits = {}
    for (const [meter, spec] of Object.entries(LIMITS)) {
      const configured = Number(limits[meter])
      this.limits[meter] = Number.isFinite(configured) && configured >= 0 ? configured : spec.fallback
    }
  }

  /** Current usage, resetting the row when its period has rolled over. */
  read(meter, now) {
    const spec = LIMITS[meter]
    if (!spec) throw new Error(`unknown meter: ${meter}`)
    const start = periodStart(spec.window, now)
    const row = this.sql.exec('SELECT used, periodStart FROM budget WHERE meter = ?', meter).toArray()[0]
    // A stale row is not deleted; it is overwritten on the next write. Reading
    // it as zero is what makes the reset lazy and therefore free -- nothing has
    // to run at midnight for the day to turn over.
    if (!row || row.periodStart !== start) return { used: 0, periodStart: start }
    return { used: Number(row.used), periodStart: start }
  }

  /**
   * Check and, if it fits, spend -- in one call.
   *
   * For callers that will not report back. The edge's request meter is one:
   * it knows the cost up front (one request) and has nothing to add later, so
   * splitting it put two round trips to the same Durable Object on the path of
   * every request, to account for that request. Combining them also closes the
   * gap between them, where two callers could both pass a check that only one
   * of them had room for.
   */
  consume(meter, now, amount = 1) {
    const verdict = this.check(meter, now, amount)
    if (verdict.ok && !verdict.unlimited) this.spend(meter, now, amount)
    return verdict
  }

  /**
   * Would `amount` more fit?
   *
   * Separate from `spend` for the callers that DO report back: a turn asks
   * before it starts and tells the ledger afterwards, because what it actually
   * cost in container and browser time is not known until then.
   */
  check(meter, now, amount = 1) {
    const limit = this.limits[meter]
    // 0 means "off". A deployment that has not set a cap should not have one
    // invented for it, and this is the value that says so out loud.
    if (limit === 0) return { ok: true, unlimited: true }
    const { used } = this.read(meter, now)
    const remaining = Math.max(0, limit - used)
    if (used + amount > limit) {
      const spec = LIMITS[meter]
      return {
        ok: false,
        meter,
        used,
        limit,
        remaining,
        resetsAt: new Date(periodEnd(spec.window, now)).toISOString(),
        message: `${meter} limit reached: ${used}/${limit} ${spec.unit} this ${spec.window}`,
      }
    }
    return { ok: true, used, limit, remaining: remaining - amount }
  }

  /** Record what was actually spent. Always recorded, even past the limit. */
  spend(meter, now, amount = 1) {
    if (!LIMITS[meter]) throw new Error(`unknown meter: ${meter}`)
    if (!Number.isFinite(amount) || amount < 0) return this.read(meter, now)
    const { used, periodStart: start } = this.read(meter, now)
    const total = used + Math.round(amount)
    this.sql.exec(
      `INSERT INTO budget (meter, used, periodStart) VALUES (?, ?, ?)
       ON CONFLICT (meter) DO UPDATE SET used = excluded.used, periodStart = excluded.periodStart`,
      meter, total, start,
    )
    return { used: total, periodStart: start }
  }

  /** Everything, for a status page or a probe. */
  report(now) {
    const meters = {}
    for (const [meter, spec] of Object.entries(LIMITS)) {
      const { used } = this.read(meter, now)
      const limit = this.limits[meter]
      meters[meter] = {
        used,
        limit: limit === 0 ? null : limit,
        unit: spec.unit,
        window: spec.window,
        remaining: limit === 0 ? null : Math.max(0, limit - used),
        resetsAt: new Date(periodEnd(spec.window, now)).toISOString(),
      }
    }
    return meters
  }
}

export default Budget
