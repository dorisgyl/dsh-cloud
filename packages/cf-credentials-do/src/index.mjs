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
    }
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
    if (!this.sql) throw new Error('cf-credentials-do: no storage configured; set the secret with `wrangler secret put`')
    this.sql.exec(
      `INSERT INTO credential (ref, value) VALUES (?, ?)
       ON CONFLICT (ref) DO UPDATE SET value = excluded.value`,
      String(ref), String(value),
    )
  }
}

export default CfCredentialsDo
