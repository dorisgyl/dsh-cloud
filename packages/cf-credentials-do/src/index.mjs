// cf-credentials-do — the upstream `credentials` seam.
//
// The fifth abstract seam in this codebase to follow the same shape: the base
// class publishes a service whose methods do not exist, and a concrete provider
// must be the only thing registered under its name. Here the symptom was
// "credentials.resolve is not a function", surfaced by a web-search tool.
//
// Design 6.5 grades credential storage by how much trouble it costs the
// self-deployer:
//
//   zero      no credential at all      Workers AI, the default
//   default   `wrangler secret put`     one command, no encryption to manage
//   optional  encrypted per tenant      a UI, a master key, deferred past M3
//
// This implements the first two. Secrets arrive as Worker bindings, which are
// already encrypted at rest and never reach the session log. The optional tier
// adds a SQLite table here and nothing else changes.
// Upstream 0.1.1 split this seam in two, and the halves answer different
// questions. A REFERENCE (`DEEPSEEK_API_KEY`) asks "what is behind this
// environment-variable name", and layers: stored value, then binding. A RECORD
// (`<scope>/<id>`) asks "what credential does this plugin hold for this id",
// and cannot layer -- an authorization grant has no environment to be read
// from, so presence of the row is the whole fact.
//
// Two tables rather than one. The grammars are disjoint by construction (a
// reference is a POSIX identifier, a key always contains `/`), so a shared
// table could not collide -- but the two halves have different rules about
// what emptiness means, and one table would invite code that forgets which
// half it is holding.
import { CredentialProvider } from '@deepseek-ai/dsh-credentials'

/** `deepseek.apiKey` -> `DEEPSEEK_API_KEY`, so a reference maps to one secret. */
function envNameFor(ref) {
  return String(ref)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[.\-\s]+/g, '_')
    .toUpperCase()
}

export class CfCredentialsDo extends CredentialProvider {
  constructor(ctx, config) {
    super(ctx)
    this.env = config?.env ?? {}
    this.sql = config?.sql ?? null
    if (this.sql) {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS credential (
        ref   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`)
      this.sql.exec(`CREATE TABLE IF NOT EXISTS credential_record (
        key    TEXT PRIMARY KEY,
        kind   TEXT NOT NULL,
        record TEXT NOT NULL
      )`)
    }
    // Serialises modifyRecord. A Durable Object supplies the hard half of
    // upstream's requirement for free -- there is one object and one thread, so
    // no second process can be rotating the same token -- but `mutate` is async
    // and every await inside it yields, so two overlapping calls on THIS object
    // would still interleave read and write. The chain closes that gap.
    this.recordGate = Promise.resolve()
  }

  stored(ref) {
    if (!this.sql) return undefined
    const row = this.sql.exec('SELECT value FROM credential WHERE ref = ?', String(ref)).toArray()[0]
    return row?.value
  }

  async resolve(ref) {
    // Stored values win over deploy-time secrets: a runtime change should not
    // be silently reverted by a binding that is still present.
    const value = this.stored(ref)
    if (value) return { value, source: 'tenant' }
    const fromEnv = this.env[envNameFor(ref)]
    if (fromEnv) return { value: String(fromEnv), source: 'env' }
    return undefined
  }

  async describe(ref) {
    // Never the value — this feeds configuration UIs.
    if (this.stored(ref)) return { configured: true, source: 'tenant', writable: Boolean(this.sql) }
    if (this.env[envNameFor(ref)]) return { configured: true, source: 'env', writable: Boolean(this.sql) }
    return { configured: false, writable: Boolean(this.sql) }
  }

  async set(ref, value) {
    this.requireStorage()
    this.sql.exec(
      `INSERT INTO credential (ref, value) VALUES (?, ?)
       ON CONFLICT (ref) DO UPDATE SET value = excluded.value`,
      String(ref), String(value),
    )
    this.notifyUpdated(ref)
  }

  /**
   * Remove a stored value, which is not the same as removing the credential.
   *
   * A binding of the same name survives this and `resolve` will find it again
   * -- correctly, because `wrangler secret put` is the deploy-time tier and a
   * runtime delete cannot reach it. Reporting otherwise would tell an operator
   * they had removed a key that is still in use.
   */
  async unset(ref) {
    this.requireStorage()
    this.sql.exec('DELETE FROM credential WHERE ref = ?', String(ref))
    this.notifyUpdated(ref)
  }

  // ------------------------------------------------------------- the record half

  async readRecord(key) {
    if (!this.sql) return undefined
    const row = this.sql.exec('SELECT record FROM credential_record WHERE key = ?', String(key)).toArray()[0]
    if (!row) return undefined
    try {
      return JSON.parse(row.record)
    } catch (error) {
      // Loud, unlike the settings provider, which drops a section it cannot
      // parse and falls back to a default. There is no default credential. A
      // caller that receives `undefined` here would conclude it is not
      // authorized and start an authorization it does not need, so a row that
      // will not parse is a storage fault and says so.
      throw new Error(`cf-credentials-do: the record at "${key}" is not valid JSON`, { cause: error })
    }
  }

  async describeRecord(key) {
    const writable = Boolean(this.sql)
    if (!this.sql) return { configured: false, writable }
    const row = this.sql.exec('SELECT kind FROM credential_record WHERE key = ?', String(key)).toArray()[0]
    // Presence alone is the answer. An api-key record carrying neither a key
    // nor env values means its owner confirmed the route authenticates from
    // ambient discovery -- configured, not blank.
    if (!row) return { configured: false, writable }
    return { configured: true, kind: row.kind, writable }
  }

  async listRecords() {
    if (!this.sql) return []
    // The kind is a column rather than a field read back out of the JSON,
    // because enumeration must survive a row this provider cannot parse: a
    // configuration surface that cannot list an orphan cannot offer to remove
    // it, which is the one thing a corrupt record still needs.
    return this.sql.exec('SELECT key, kind FROM credential_record ORDER BY key').toArray()
      .map((row) => ({ key: row.key, kind: row.kind }))
  }

  async modifyRecord(key, mutate) {
    this.requireStorage()
    const previous = this.recordGate
    let release
    this.recordGate = new Promise((resolve) => { release = resolve })
    await previous
    try {
      const current = await this.readRecord(key)
      const next = await mutate(current)
      // Declining is not deleting. `undefined` from `mutate` leaves the entry
      // exactly as it stands, which is what makes a refresh that decides the
      // token is still good a no-op rather than a logout.
      if (next === undefined) return current
      this.sql.exec(
        `INSERT INTO credential_record (key, kind, record) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET kind = excluded.kind, record = excluded.record`,
        String(key), String(next.kind), JSON.stringify(next),
      )
      this.notifyRecordUpdated(key)
      return next
    } finally {
      release()
    }
  }

  async deleteRecord(key) {
    this.requireStorage()
    this.sql.exec('DELETE FROM credential_record WHERE key = ?', String(key))
    this.notifyRecordUpdated(key)
  }

  /** Writes need a table; reads do not, and a binding-only deployment is valid. */
  requireStorage() {
    if (!this.sql) {
      throw new Error('cf-credentials-do: no storage configured; set the secret with `wrangler secret put`')
    }
  }
}

export default CfCredentialsDo
