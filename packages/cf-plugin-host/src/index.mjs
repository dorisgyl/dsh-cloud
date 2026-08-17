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
import { defineTool } from '@deepseek-ai/dsh-tools'
import { RUNNER_SOURCE } from './runner.mjs'

const SCHEMA = `CREATE TABLE IF NOT EXISTS plugin (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  rev         TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  permissions TEXT NOT NULL DEFAULT '[]',
  installedAt INTEGER NOT NULL
)`

/**
 * What a plugin may ask the harness to do, granted per plugin at install time.
 *
 * Default is none. Every capability on PluginHost is a hole opened for code the
 * deployment did not write, so the grant is explicit and the plugin is told
 * which permission it lacked rather than being given a silent empty result.
 */
export const PERMISSIONS = {
  'fs:read': 'read files and list directories in the workspace',
  'fs:write': 'create and overwrite files in the workspace',
  'shell': 'run commands in the execution world',
}

/** A namespaced command name inside upstream's alphabet. */
function commandName(pluginId, name) {
  const fold = (text) => String(text).toLowerCase().replace(/[^a-z0-9_-]/g, '-')
  return `${fold(pluginId)}-${fold(name)}`.replace(/^[^a-z]+/, '')
}

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

    // `CREATE TABLE IF NOT EXISTS` does not add a column to a table that is
    // already there, so a deployment that installed a plugin before permissions
    // existed keeps the old shape and every SELECT naming the new column throws
    // — which surfaces as a bare 1101 from the Worker, naming nothing.
    //
    // Durable Object SQLite has no `ADD COLUMN IF NOT EXISTS`, so the duplicate
    // is caught and ignored. That is the whole migration; it stays here rather
    // than in a migration framework because there is exactly one of them.
    try {
      this.sql.exec("ALTER TABLE plugin ADD COLUMN permissions TEXT NOT NULL DEFAULT '[]'")
    } catch (error) {
      if (!/duplicate column/i.test(String(error?.message ?? error))) throw error
    }
  }

  get available() {
    return Boolean(this.loader)
  }

  list() {
    return this.sql
      .exec('SELECT id, rev, enabled, permissions, installedAt, LENGTH(source) AS bytes FROM plugin ORDER BY id')
      .toArray()
      .map((row) => ({ ...row, enabled: Boolean(row.enabled), permissions: JSON.parse(row.permissions || '[]') }))
  }

  install(id, source, permissions = []) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(String(id ?? ''))) {
      throw new Error('plugin id must be 1-64 characters of [A-Za-z0-9._-]')
    }
    if (typeof source !== 'string' || source.length === 0) {
      throw new Error('plugin source must be a non-empty string')
    }
    const granted = [...new Set(permissions ?? [])].map(String)
    const unknown = granted.filter((p) => !(p in PERMISSIONS))
    if (unknown.length) {
      throw new Error(`unknown permission(s): ${unknown.join(', ')}. Known: ${Object.keys(PERMISSIONS).join(', ')}`)
    }
    const rev = revOf(source)
    this.sql.exec(
      `INSERT INTO plugin (id, source, rev, enabled, permissions, installedAt) VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT (id) DO UPDATE SET source = excluded.source, rev = excluded.rev,
         permissions = excluded.permissions, installedAt = excluded.installedAt`,
      id, source, rev, JSON.stringify(granted), Date.now(),
    )
    return { id, rev, permissions: granted }
  }

  remove(id) {
    this.sql.exec('DELETE FROM plugin WHERE id = ?', String(id))
  }

  setEnabled(id, enabled) {
    this.sql.exec('UPDATE plugin SET enabled = ? WHERE id = ?', enabled ? 1 : 0, String(id))
  }

  row(id) {
    const row = this.sql
      .exec('SELECT id, source, rev, enabled, permissions FROM plugin WHERE id = ?', String(id))
      .toArray()[0]
    return row ? { ...row, permissions: JSON.parse(row.permissions || '[]') } : undefined
  }

  /**
   * The isolate for one plugin.
   *
   * Keyed by everything that goes INTO the load, which is the source and the
   * permissions — not just the source.
   *
   * The first version keyed on the source hash alone, and regranting a
   * plugin's permissions therefore changed nothing: the loader served the
   * cached isolate, whose `env.harness` still carried the old grants, and the
   * plugin kept reporting "was not granted" after being reinstalled with the
   * grant. A stale isolate is indistinguishable from a plugin that ignored the
   * change, which is why the key has to cover the whole load and not the part
   * that is easy to hash.
   *
   * `globalOutbound: null` is the whole network story: the plugin reaches
   * whatever the harness lends it and nothing else. Measured, not assumed —
   * see /api/loader-probe.
   */
  worker(row) {
    const key = `plugin:${row.id}:${row.rev}:${revOf(JSON.stringify(row.permissions ?? []))}`
    return this.loader.get(key, async () => ({
      compatibilityDate: this.compatibilityDate,
      mainModule: 'entry.js',
      modules: {
        'entry.js': RUNNER_SOURCE,
        'plugin.js': row.source,
      },
      env: { harness: this.capability(row.id, row.permissions ?? []) },
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
   * Register every enabled plugin's declarations into a live context.
   *
   * Declarations are copied into the harness; callbacks are not, because a
   * function cannot outlive the execution context that produced it. Instead
   * each invocation re-enters the plugin, which is cheap: `apply` only
   * registers.
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
          // Through `defineTool`, not around it.
          //
          // The friendly `parameters: {name: {type, required, description}}`
          // map a tool author writes is NOT a JSON Schema; defineTool converts
          // it. Registering the raw map reached the provider as
          // `{"title": {...}}` with no `type`, and the request failed for every
          // tool in it — visible only as "Tool 18 function has invalid
          // 'parameters'". Upstream's own tools all go through defineTool, so
          // nothing in the harness could have shown this until a plugin
          // registered the first tool that did not.
          ctx.tools.register(defineTool({
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
          }))
          attached.push(`tool:${row.id}__${schema.name}`)
        } catch (error) {
          failures.push({ id: row.id, tool: schema.name, error: String(error?.message ?? error) })
        }
      }

      // Slash commands: the same declaration-plus-callback shape as a tool.
      for (const schema of described.commands ?? []) {
        try {
          ctx.commands?.register({
            ...schema,
            // Upstream constrains command names to /^[a-z][a-z0-9_-]*$/, so the
            // namespace separator cannot be `:` the way it can for tools. The
            // id is folded into the same alphabet rather than assumed to fit.
            name: commandName(row.id, schema.name),
            // Upstream's field is `handler`, not `execute`, and its invocation
            // carries a live Agent and an AbortSignal — neither of which
            // crosses. The plugin gets the raw input, which is the part that is
            // data, and returns a CommandResult the harness shapes.
            handler: async (invocation) => {
              const result = await this.call(this.row(row.id), '/execute', {
                kind: 'command',
                name: schema.name,
                args: { rawInput: invocation?.rawInput ?? '' },
              })
              if (!result?.ok) return { kind: 'error', text: `plugin "${row.id}": ${result?.error ?? 'command failed'}` }
              return { kind: 'success', text: String(result.value ?? '') }
            },
          })
          attached.push(`command:${commandName(row.id, schema.name)}`)
        } catch (error) {
          failures.push({ id: row.id, command: schema.name, error: String(error?.message ?? error) })
        }
      }

      // System prompt sections, as a SNAPSHOT taken now.
      //
      // Upstream's section text may be a function, but a synchronous one: the
      // assembler calls it and immediately does string work on the result. An
      // async function returns a promise, and the turn dies with
      // "text2.indexOf is not a function" — the third time today that a
      // synchronous contract refused to cross an asynchronous boundary.
      //
      // So a plugin computing its section is asked once, here, and the answer
      // is registered as a plain string. A plugin cannot recompute its section
      // per assembly; what it can do is be re-entered when the tree is rebuilt.
      // Saying that plainly beats a `dynamic` flag that silently means "once".
      for (const schema of described.sections ?? []) {
        try {
          let text = String(schema.text ?? '')
          if (schema.dynamic) {
            const result = await this.call(this.row(row.id), '/section', {
              name: schema.name,
              // Only what crosses as data, and deliberately little of it: a
              // section gets no handle on the agent it is decorating.
              context: { sessionId: null },
            })
            if (!result?.ok) throw new Error(String(result?.error ?? 'the section did not render'))
            text = String(result.value ?? '')
          }
          if (text.length === 0) continue

          ctx.systemPrompt?.section({
            name: `plugin:${row.id}:${schema.name}`,
            order: typeof schema.order === 'number' ? schema.order : 500,
            text,
          })
          attached.push(`section:${row.id}:${schema.name}`)
        } catch (error) {
          failures.push({ id: row.id, section: schema.name, error: String(error?.message ?? error) })
        }
      }
    }

    return { attached, failures }
  }
}

export default PluginRegistry
