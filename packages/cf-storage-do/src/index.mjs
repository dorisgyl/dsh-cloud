// cf-storage-do — the upstream `storage` KV backend, over Durable Object SQLite.
//
// Upstream ships two backends: `dsh-storage-json` (files) and a sqlite one.
// Neither works on workerd, so the seam has no implementation and
// `dsh-storage-domain` never publishes `storageDomain` — which in turn keeps
// dsh-message-feedback, dsh-session-projection-cache and dsh-workspace dormant.
// This package fills that gap.
//
// The contract (KvFacet / KvUnit) is opaque JSON key-value with whole-unit
// snapshot reads. Write ordering is explicitly the caller's problem: the domain
// layer runs one write chain per unit. What a unit must guarantee is that each
// individual call is atomic and durable once resolved — which DO SQLite gives
// us for free, since a Durable Object is single-threaded and its SQLite writes
// are synchronous and transactional.
import { StorageError } from '@deepseek-ai/dsh-storage'

const DDL = [
  `CREATE TABLE IF NOT EXISTS kv_record (
     unit  TEXT NOT NULL,
     tbl   TEXT NOT NULL,
     key   TEXT NOT NULL,
     value TEXT NOT NULL,
     PRIMARY KEY (unit, tbl, key)
   )`,
  `CREATE TABLE IF NOT EXISTS kv_unit (
     unit    TEXT PRIMARY KEY,
     version INTEGER NOT NULL,
     global  TEXT
   )`,
]

/**
 * One opened unit, backed by rows scoped to `descriptor.name`.
 * Units share the two physical tables; `unit` is the scoping column. That keeps
 * the schema fixed no matter how many units the tree opens, which matters
 * because DDL inside a Durable Object competes with request handling.
 */
class DoSqliteKvUnit {
  constructor(sql, descriptor, onClose) {
    this.sql = sql
    this.descriptor = descriptor
    this.onClose = onClose
    this.closed = false
    this.tables = new Set(descriptor.tables)
  }

  assertOpen() {
    if (this.closed) throw new StorageError('closed', `unit "${this.descriptor.name}" is closed`)
  }

  // Writing to an undeclared table is a caller bug, not a storage-contract
  // failure, so it is a plain Error: StorageErrorCode has no code for it and
  // inventing one would break consumers that switch on `code`.
  assertTable(table) {
    if (!this.tables.has(table)) {
      throw new Error(`cf-storage-do: unit "${this.descriptor.name}" has no table "${table}"`)
    }
  }

  async loadAll() {
    this.assertOpen()
    // Every declared table is present in the result even when empty: callers
    // read `tables[name]` unconditionally.
    const tables = Object.fromEntries([...this.tables].map((t) => [t, {}]))
    const rows = this.sql
      .exec('SELECT tbl, key, value FROM kv_record WHERE unit = ?', this.descriptor.name)
      .toArray()
    for (const row of rows) {
      if (!tables[row.tbl]) continue   // a table dropped from the descriptor
      tables[row.tbl][row.key] = parse(row.value, this.descriptor.name, row.tbl, row.key)
    }
    let global = null
    if (this.descriptor.hasGlobal) {
      const meta = this.sql
        .exec('SELECT global FROM kv_unit WHERE unit = ?', this.descriptor.name)
        .toArray()[0]
      global = meta?.global == null ? null : parse(meta.global, this.descriptor.name, '(global)', '')
    }
    return { tables, global }
  }

  async putRecord(table, key, value) {
    this.assertOpen()
    this.assertTable(table)
    this.sql.exec(
      `INSERT INTO kv_record (unit, tbl, key, value) VALUES (?, ?, ?, ?)
       ON CONFLICT (unit, tbl, key) DO UPDATE SET value = excluded.value`,
      this.descriptor.name, table, key, JSON.stringify(value ?? null),
    )
  }

  async deleteRecord(table, key) {
    this.assertOpen()
    this.assertTable(table)
    this.sql.exec(
      'DELETE FROM kv_record WHERE unit = ? AND tbl = ? AND key = ?',
      this.descriptor.name, table, key,
    )
  }

  async setGlobal(value) {
    this.assertOpen()
    if (!this.descriptor.hasGlobal) {
      throw new Error(`cf-storage-do: unit "${this.descriptor.name}" declares no global slot`)
    }
    this.sql.exec(
      'UPDATE kv_unit SET global = ? WHERE unit = ?',
      JSON.stringify(value ?? null), this.descriptor.name,
    )
  }

  async close() {
    if (this.closed) return
    this.closed = true
    this.onClose()
  }
}

function parse(raw, unit, table, key) {
  try {
    return JSON.parse(raw)
  } catch (cause) {
    throw new StorageError(
      'malformed-medium',
      `unit "${unit}" table "${table}" key "${key}" holds invalid JSON`,
      { cause },
    )
  }
}

/**
 * Build a StorageBackend over one Durable Object's SQLite handle.
 * @param sql the DO's `state.storage.sql`
 */
export function createDoSqliteBackend(sql) {
  for (const statement of DDL) sql.exec(statement)

  const open = new Set()

  return {
    kv: {
      async open(descriptor) {
        if (open.has(descriptor.name)) {
          throw new StorageError('duplicate-mount', `unit "${descriptor.name}" is already open`)
        }
        const existing = sql
          .exec('SELECT version FROM kv_unit WHERE unit = ?', descriptor.name)
          .toArray()[0]
        if (existing && existing.version !== descriptor.version) {
          throw new StorageError(
            'version-mismatch',
            `unit "${descriptor.name}" is stamped v${existing.version}, descriptor asks for v${descriptor.version}`,
          )
        }
        if (!existing) {
          // Stamp the version eagerly. The contract allows deferring
          // materialization to the first write, but stamping now is what makes
          // the version check above meaningful on the next open.
          sql.exec(
            'INSERT INTO kv_unit (unit, version, global) VALUES (?, ?, NULL)',
            descriptor.name, descriptor.version,
          )
        }
        open.add(descriptor.name)
        return new DoSqliteKvUnit(sql, descriptor, () => open.delete(descriptor.name))
      },
    },
    async close() {
      open.clear()
      // The SQLite handle belongs to the Durable Object, not to us: it outlives
      // this backend and must not be closed here.
    },
  }
}

/**
 * Cordis plugin: register the backend on the storage hub and publish it as a
 * service so `dsh-storage-domain` can inject it.
 *
 * `dsh-storage-domain` resolves its configured backend name through
 * `storageBackendServiceKey(name)` -> `storage.backend.<name>`, so registering
 * with the hub is not enough on its own — the service has to exist too.
 */
// Declared as an object plugin rather than a function: a function's `name` is a
// read-only own property, so the `plugin.name = '...'` form throws — and it
// throws at module scope, which on workerd fails the whole isolate.
export const cfStorageDoPlugin = {
  name: 'cf-storage-do',
  inject: ['storage'],
  apply(ctx, config) {
    const name = config?.name ?? 'do-sqlite'
    const sql = config?.sql
    if (!sql) throw new Error('cf-storage-do requires the Durable Object SQLite handle (config.sql)')

    const backend = createDoSqliteBackend(sql)
    ctx.effect(() => ctx.storage.backend.register(name, backend))
    ctx.effect(() => ctx.provide(`storage.backend.${name}`, backend))
  },
}

export default cfStorageDoPlugin
