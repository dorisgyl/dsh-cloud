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

/**
 * GitHub's own login grammar: alphanumeric and single hyphens, no leading or
 * trailing hyphen, at most 39 characters.
 */
const LOGIN_SHAPE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i

/**
 * Keys whose values describe the SESSION, not the person.
 *
 * Measured, not imagined. A real Access identity carried, among other things:
 *
 *   idp.type          "onetimepin"
 *   amr               ["onetimepin"]
 *   devicePosture.*   rule_name "Gateway", "WARP"
 *   geo.country       "US"
 *   auth_status       "NONE"
 *
 * Every one of those satisfies GitHub's login grammar, and `warp`, `gateway`
 * and `us` are real GitHub accounts. If any of them ever starred this repo,
 * every identity on earth would match one and the gate would be open while
 * appearing shut.
 *
 * The earlier claim that "the set is what makes it safe" held for emails and
 * long UUIDs and did not hold for enumerated values. Real data said so.
 */
const STRUCTURAL_KEYS = new Set([
  'type', 'amr', 'rule_name', 'country', 'auth_status', 'version', 'account_id',
  'devicePosture', 'geo', 'common_name', 'service_token_id', 'service_token_status',
  'is_warp', 'is_gateway', 'gateway_account_id', 'device_id', 'device_sessions', 'ip',
])

/**
 * Was this identity authenticated by GitHub at all?
 *
 * The first of the two admission conditions, and until now it was assumed
 * rather than checked: the gate went straight to "has this starred the repo"
 * and would have accepted a one-time-PIN identity that happened to carry a
 * matching string. Access reports the provider in `idp.type` and `amr` -- an
 * OTP login reads "onetimepin" in both, which is how this was found.
 */
export function isGithubIdentity(identity) {
  const type = String(identity?.idp?.type ?? '').toLowerCase()
  if (type === 'github') return true
  const amr = identity?.amr
  return Array.isArray(amr) && amr.some((m) => String(m).toLowerCase() === 'github')
}

/**
 * Every string in an identity that could be a GitHub login.
 *
 * This exists to delete a dependency, not to be clever. The first version read
 * the login from a named field, and Cloudflare documents that `get-identity`
 * returns an `idp` block without documenting its shape per provider -- so the
 * field name was a guess, and the whole gate could not be switched on until
 * somebody logged in and read it back.
 *
 * The question the gate actually asks is not "what is this person's login" but
 * "does this identity belong to a stargazer". That one can be answered without
 * knowing which key holds the answer: collect every login-shaped string and ask
 * whether any of them is in the set.
 *
 * The set is what makes this safe. A false positive needs a stargazer whose
 * login is character-for-character equal to some unrelated field of a different
 * person's identity -- and emails, UUIDs with more than 39 characters, and
 * display names with spaces are all excluded by the grammar before that.
 */
export function candidateLogins(value, out = new Set(), depth = 4, key = undefined) {
  if (key !== undefined && STRUCTURAL_KEYS.has(key)) return out
  if (typeof value === 'string') {
    if (LOGIN_SHAPE.test(value)) out.add(value.toLowerCase())
    // The local part of an email is a common place for a login to appear, and
    // including it costs nothing: it only matters if it is also in the set.
    const local = /^([^@\s]+)@[^@\s]+$/.exec(value)?.[1]
    if (local && LOGIN_SHAPE.test(local)) out.add(local.toLowerCase())
    return out
  }
  if (depth === 0 || value === null || typeof value !== 'object') return out
  if (Array.isArray(value)) {
    for (const entry of value) candidateLogins(entry, out, depth - 1)
    return out
  }
  for (const [childKey, entry] of Object.entries(value)) {
    candidateLogins(entry, out, depth - 1, childKey)
  }
  return out
}

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

  /**
   * Does this identity belong to a stargazer, whatever field says so.
   *
   * Reports WHICH candidate matched, so the answer is auditable and the
   * undocumented field name becomes an observation rather than a prerequisite.
   */
  async admits(identity, now = Date.now()) {
    // Condition one, checked first and on its own. "Signed in with GitHub" and
    // "has starred the repo" are two requirements, and collapsing them into the
    // second let an identity from any provider through on a lucky string.
    if (!isGithubIdentity(identity)) {
      return {
        ok: false,
        reason: `this identity was authenticated by "${identity?.idp?.type ?? 'an unknown provider'}", not GitHub`,
      }
    }
    const state = await this.state(now)
    const candidates = [...candidateLogins(identity)]
    const matched = candidates.find((candidate) => state.logins.includes(candidate))
    return {
      ok: Boolean(matched),
      matched,
      candidatesTried: candidates.length,
      reason: matched
        ? undefined
        : `none of the ${candidates.length} identifiers in this identity has starred ${this.repo}`,
      stargazers: state.logins.length,
      truncated: state.truncated,
      refreshedAt: state.refreshedAt,
      staleBecause: state.error ?? undefined,
    }
  }
}

export default Admission
