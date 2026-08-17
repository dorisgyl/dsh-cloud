// cf-admission — who may use this deployment.
//
// Two conditions, and they are different kinds of thing:
//
//   1. signed in with GitHub   -- authentication, enforced by Cloudflare Access
//   2. has starred the repo    -- admission policy, enforced here
//
// Access can do the first and cannot do the second, which is the whole reason
// this is code rather than configuration.
//
// A star is NOT a security boundary. It is public, free, given in one click and
// taken back in one, and this cache means a revoked star keeps working until
// the next refresh. What it does is keep a passer-by and a crawler out of an
// agent that costs money to run. The security boundary is Access; this is a
// turnstile, and reading it as anything more is the mistake this comment
// exists to prevent.
//
// Stargazers are listed rather than asked per user because the authoritative
// call -- GET /user/starred/{owner}/{repo} -- needs the USER's OAuth token, and
// Access hands us an identity, not a token. The public list needs no credential
// at all, which keeps admission inside ADR-12's zero-configuration property.

const API = 'https://api.github.com'
const PER_PAGE = 100

/**
 * How many pages to walk before giving up.
 *
 * 20 pages is 2000 stargazers. Past that the list stops being the right shape
 * for this question and the honest move is to say so rather than silently gate
 * on a prefix of it -- `truncated` is reported for exactly that reason. A
 * deployment that popular wants per-user OAuth, not a bigger cap.
 */
const MAX_PAGES = 20

const SCHEMA = `
CREATE TABLE IF NOT EXISTS admission (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
)`

/** Logins, lowercased. GitHub logins are case-insensitive and cased freely. */
export async function fetchStargazers(repo, { token, fetchImpl = fetch } = {}) {
  const logins = []
  let truncated = false
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await fetchImpl(`${API}/repos/${repo}/stargazers?per_page=${PER_PAGE}&page=${page}`, {
      headers: {
        accept: 'application/vnd.github+json',
        // Required by GitHub; a request without it is rejected outright.
        'user-agent': 'dsh-cloud-admission',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`GitHub answered ${response.status} for ${repo} page ${page}: ${body.slice(0, 200)}`)
    }
    const batch = await response.json()
    if (!Array.isArray(batch)) throw new Error(`GitHub returned ${typeof batch} instead of a stargazer array`)
    for (const entry of batch) {
      if (entry?.login) logins.push(String(entry.login).toLowerCase())
    }
    if (batch.length < PER_PAGE) return { logins, truncated }
    if (page === MAX_PAGES) truncated = true
  }
  return { logins, truncated }
}

export class Admission {
  constructor({ sql, repo, token, ttlMs = 5 * 60_000, fetchImpl }) {
    if (!sql) throw new Error('cf-admission requires the Durable Object SQLite handle')
    this.sql = sql
    this.sql.exec(SCHEMA)
    this.repo = repo
    this.token = token
    this.ttlMs = ttlMs
    this.fetchImpl = fetchImpl
  }

  read() {
    const row = this.sql.exec('SELECT v FROM admission WHERE k = ?', 'stargazers').toArray()[0]
    if (!row) return { logins: [], refreshedAt: 0, truncated: false, error: null }
    try {
      return JSON.parse(row.v)
    } catch {
      return { logins: [], refreshedAt: 0, truncated: false, error: 'stored value was not JSON' }
    }
  }

  write(state) {
    this.sql.exec(
      'INSERT INTO admission (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v',
      'stargazers', JSON.stringify(state),
    )
  }

  /**
   * The cached list, refreshed when stale.
   *
   * A failed refresh keeps the OLD list and records why. The alternative --
   * an empty set on error -- would turn a GitHub hiccup into "nobody has
   * starred this", which locks out every legitimate user at once and looks
   * exactly like a correctly-enforced policy.
   */
  async state(now = Date.now()) {
    const cached = this.read()
    if (now - cached.refreshedAt < this.ttlMs && cached.refreshedAt > 0) return cached
    try {
      const { logins, truncated } = await fetchStargazers(this.repo, { token: this.token, fetchImpl: this.fetchImpl })
      const fresh = { logins, truncated, refreshedAt: now, error: null }
      this.write(fresh)
      return fresh
    } catch (error) {
      const kept = { ...cached, error: String(error?.message ?? error), triedAt: now }
      this.write(kept)
      return kept
    }
  }

  async isStargazer(login, now = Date.now()) {
    if (!login) return { ok: false, reason: 'no GitHub login was resolved for this identity' }
    const state = await this.state(now)
    const has = state.logins.includes(String(login).toLowerCase())
    return {
      ok: has,
      reason: has ? undefined : `"${login}" has not starred ${this.repo}`,
      stargazers: state.logins.length,
      truncated: state.truncated,
      refreshedAt: state.refreshedAt,
      staleBecause: state.error ?? undefined,
    }
  }
}

export default Admission
