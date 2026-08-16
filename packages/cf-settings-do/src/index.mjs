// cf-settings-do — the upstream `settings` provider, over Durable Object SQLite.
//
// `dsh-settings` is an abstract seam: it publishes the service but throws
// "this.load is not a function" unless a concrete provider subclasses it. The
// only upstream implementation is `dsh-settings-file`, which reads from disk.
//
// The contract is small — three members:
//
//   writable                     whether settings can be changed at runtime
//   load()                       the whole settings document, namespace-keyed
//   persist(namespace, section)  one namespace's section, durably
//
// Settings are per-tenant rather than per-session in the design, so this
// eventually belongs in TenantDO. It lives on whichever SQLite handle it is
// given, which is the same code either way.
import { SettingsProvider } from '@deepseek-ai/dsh-settings'

const DDL = `CREATE TABLE IF NOT EXISTS settings_section (
  namespace TEXT PRIMARY KEY,
  section   TEXT NOT NULL
)`

export class CfSettingsDo extends SettingsProvider {
  constructor(ctx, config) {
    super(ctx)
    const sql = config?.sql
    if (!sql) throw new Error('cf-settings-do requires the Durable Object SQLite handle (config.sql)')
    this.sql = sql
    this.sql.exec(DDL)
    // Seed values a deployment supplies at build or deploy time. They are the
    // floor, not an override: anything persisted wins, so a runtime change is
    // not silently reverted on the next restart.
    this.defaults = config?.defaults ?? {}
  }

  /** Runtime edits are allowed; the UI writes here through TenantDO. */
  get writable() { return true }

  async load() {
    const document = { ...this.defaults }
    for (const row of this.sql.exec('SELECT namespace, section FROM settings_section').toArray()) {
      try {
        document[row.namespace] = JSON.parse(row.section)
      } catch {
        // A section that will not parse is worse than a missing one: it would
        // fail every read. Drop it and fall back to the default.
        delete document[row.namespace]
      }
    }
    return document
  }

  async persist(namespace, section) {
    this.sql.exec(
      `INSERT INTO settings_section (namespace, section) VALUES (?, ?)
       ON CONFLICT (namespace) DO UPDATE SET section = excluded.section`,
      String(namespace), JSON.stringify(section ?? {}),
    )
  }
}

export default CfSettingsDo
