// cf-plugin-host — third-party plugins, installed at runtime.
//
// Design 7, reopened (ADR-09 amendment). A plugin is a piece of code the
// harness did not ship, running in its own isolate with no network of its own,
// registering into the harness over a capability face it cannot widen.
//
// The authoring model is upstream's:
//
//     export function apply(ctx, config) {
//       ctx.tools.register({ name, description, parameters, execute })
//     }
//
// What the boundary costs is honest to state: `ctx` here is NOT upstream's
// context object. An isolate cannot hold it, so a plugin gets the extension
// points this deployment chose to expose and nothing else. That is why 7.2's
// whitelist exists — not as policy, but as whatever survives an RPC boundary.
import { RUNNER_SOURCE } from './runner.mjs'

const SCHEMA = `CREATE TABLE IF NOT EXISTS plugin (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  rev         TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  installedAt INTEGER NOT NULL
)`

/** Loading a plugin whose source changed must not reuse the old isolate. */
function revOf(source) {
  let h = 0x811c9dc5
  for (let i = 0; i < source.length; i++) {
    h ^= source.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(36)
}

export class PluginRegistry {
  constructor({ sql, loader, capability, compatibilityDate = '2026-08-14' }) {
    if (!sql) throw new Error('cf-plugin-host requires the Durable Object SQLite handle')
    this.sql = sql
    this.loader = loader
    this.capability = capability
    this.compatibilityDate = compatibilityDate
    this.sql.exec(SCHEMA)
  }

  get available() {
    return Boolean(this.loader)
  }

  list() {
    return this.sql
      .exec('SELECT id, rev, enabled, installedAt, LENGTH(source) AS bytes FROM plugin ORDER BY id')
      .toArray()
      .map((row) => ({ ...row, enabled: Boolean(row.enabled) }))
  }

  install(id, source) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(String(id ?? ''))) {
      throw new Error('plugin id must be 1-64 characters of [A-Za-z0-9._-]')
    }
    if (typeof source !== 'string' || source.length === 0) {
      throw new Error('plugin source must be a non-empty string')
    }
    const rev = revOf(source)
    this.sql.exec(
      `INSERT INTO plugin (id, source, rev, enabled, installedAt) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT (id) DO UPDATE SET source = excluded.source, rev = excluded.rev, installedAt = excluded.installedAt`,
      id, source, rev, Date.now(),
    )
    return { id, rev }
  }

  remove(id) {
    this.sql.exec('DELETE FROM plugin WHERE id = ?', String(id))
  }

  setEnabled(id, enabled) {
    this.sql.exec('UPDATE plugin SET enabled = ? WHERE id = ?', enabled ? 1 : 0, String(id))
  }

  row(id) {
    return this.sql.exec('SELECT id, source, rev, enabled FROM plugin WHERE id = ?', String(id)).toArray()[0]
  }

  /**
   * The isolate for one plugin.
   *
   * Keyed by id AND rev, so reinstalling a plugin cannot be served by the
   * isolate that was holding the previous source — the loader caches by id, and
   * a stale isolate is indistinguishable from a plugin that ignored the edit.
   *
   * `globalOutbound: null` is the whole network story: the plugin reaches
   * whatever the harness lends it and nothing else. Measured, not assumed —
   * see /api/loader-probe.
   */
  worker(row) {
    return this.loader.get(`plugin:${row.id}:${row.rev}`, async () => ({
      compatibilityDate: this.compatibilityDate,
      mainModule: 'entry.js',
      modules: {
        'entry.js': RUNNER_SOURCE,
        'plugin.js': row.source,
      },
      env: { harness: this.capability(row.id) },
      globalOutbound: null,
    }))
  }

  async call(row, path, body) {
    const response = await this.worker(row).getEntrypoint().fetch(
      new Request(`http://plugin${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }),
    )
    return response.json()
  }

  /** What one plugin provides, asked of the plugin itself. */
  async describe(id) {
    const row = this.row(id)
    if (!row) throw new Error(`no plugin "${id}" is installed`)
    return this.call(row, '/describe')
  }

  /**
   * Register every enabled plugin's tools into a live context.
   *
   * The schema is copied into the harness; `execute` is not, because a function
   * cannot outlive the execution context that produced it. Instead each call
   * re-enters the plugin, which is cheap: `apply` only registers.
   */
  async attachTools(ctx) {
    const attached = []
    const failures = []

    for (const summary of this.list()) {
      if (!summary.enabled) continue
      const row = this.row(summary.id)
      let described
      try {
        described = await this.call(row, '/describe')
      } catch (error) {
        failures.push({ id: row.id, error: String(error?.message ?? error) })
        continue
      }
      if (!described?.ok) {
        failures.push({ id: row.id, error: String(described?.error ?? 'the plugin did not describe itself') })
        continue
      }

      for (const schema of described.tools ?? []) {
        try {
          ctx.tools.register({
            ...schema,
            // Namespaced on purpose: a plugin must not be able to take over
            // `bash` by naming a tool `bash`. The prefix is what makes an
            // installed plugin unable to shadow the harness's own tools.
            name: `${row.id}__${schema.name}`,
            // Rendering is the harness's job, not the plugin's, and the
            // boundary is what makes that obvious: `render` is a function, and
            // a function cannot come back from `/describe` as data. So a plugin
            // declares the SHAPE of its result and the harness decides how a
            // result becomes UI blocks. Upstream's validator caught this by
            // refusing a tool whose output carried a schema and no render.
            output: {
              schema: schema.output?.schema ?? { type: 'string' },
              render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
            },
            execute: async (args) => {
              const result = await this.call(this.row(row.id), '/execute', { name: schema.name, args })
              if (!result?.ok) throw new Error(`plugin "${row.id}": ${result?.error ?? 'tool failed'}`)
              return result.value
            },
          })
          attached.push(`${row.id}__${schema.name}`)
        } catch (error) {
          failures.push({ id: row.id, tool: schema.name, error: String(error?.message ?? error) })
        }
      }
    }

    return { attached, failures }
  }
}

export default PluginRegistry
