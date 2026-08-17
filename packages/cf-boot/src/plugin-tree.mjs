// cf-boot: assemble the Cordis plugin tree for SessionAgentDO.
//
// Upstream boots by reading cordis.yml from disk and resolving plugin
// specifiers at runtime through cordis-plugin-loader. Neither is available on
// workerd: there is no dynamic module resolution, and `node:vm` is a
// non-functional stub. So the plugin set is expanded statically at build time
// (design doc 10.6) and handed to `assemble()` as an already-imported map.
//
// Cordis does the wiring itself. Every plugin declares `inject` (services it
// needs) and stays dormant until all of them exist, so the registration order
// here does not matter — what matters is that the set is closed under `inject`.
// Anything still dormant at the end is a real gap: either a seam that needs a
// cf-* provider, or a package that was wrongly excluded.

/** Plugin shapes Cordis accepts, in the order we probe a module for them. */
function findPlugin(mod) {
  for (const [origin, value] of [['default', mod?.default], ['namespace', mod]]) {
    if (!value) continue
    if (typeof value === 'function') return { origin, value }
    // An object plugin owns an `apply`; guard against inheriting Function.prototype.apply.
    if (typeof value === 'object' && typeof value.apply === 'function' &&
        value.apply !== Function.prototype.apply) {
      return { origin, value }
    }
  }
  return null
}

/**
 * Build a Cordis context from a statically expanded plugin map.
 *
 * @param Context  the Cordis `Context` class (injected so this module stays
 *                 free of a direct upstream import and is easy to test)
 * @param modules  specifier -> imported module namespace
 * @param options.config  specifier -> plugin config, for plugins that need one
 * @param options.skip    specifiers to register nothing for
 * @returns { ctx, report }
 */
export async function assemble(Context, modules, options = {}) {
  const config = options.config ?? {}
  const skip = new Set(options.skip ?? [])

  const ctx = new Context()

  // Compose THROUGH the loader when there is one.
  //
  // Design 10.6 replaced the loader with a compile-time expansion, and the
  // expansion is still what decides the set — but going through `ctx.plugin()`
  // directly meant no plugin was a loader ENTRY, and everything that reads
  // `loader.entries()` saw an empty deployment: the plugin inventory the
  // settings panel renders, and the audit that tells a preset whether its
  // subtree reached a usable state.
  //
  // `loader.create({name, config})` resolves `name` through the loader's
  // `internal.import`, which cf-loader points at this same module map. So the
  // set is identical and the plugins become inspectable, disableable entries
  // rather than anonymous fibers.
  // A hook for anything that must be installed on the bare context before any
  // plugin loads — a log sink, most usefully, since a plugin that fails during
  // load has already logged and moved on by the time assemble() returns.
  options.onContext?.(ctx)

  const loader = options.createLoader ? await options.createLoader(ctx) : undefined

  const registered = []
  const libraries = []
  const skipped = []
  const failed = []
  const pending = []

  for (const [specifier, mod] of Object.entries(modules)) {
    if (skip.has(specifier)) { skipped.push(specifier); continue }
    const found = findPlugin(mod)
    // Still filtered here rather than left to the loader: a module that is not
    // plugin-shaped would become an entry that fails to unwrap, turning a
    // library into a reported error on every boot.
    if (!found) { libraries.push(specifier); continue }

    if (loader) {
      try {
        await loader.create({ name: specifier, ...(config[specifier] === undefined ? {} : { config: config[specifier] }) })
        registered.push({ specifier, fiber: undefined, origin: found.origin })
      } catch (error) {
        failed.push({ specifier, phase: 'register', error: String(error?.message ?? error) })
      }
      continue
    }

    let fiber
    try {
      fiber = ctx.plugin(found.value, config[specifier])
    } catch (error) {
      failed.push({ specifier, phase: 'register', error: String(error?.message ?? error) })
      continue
    }
    registered.push({ specifier, fiber, origin: found.origin })
  }

  // Awaiting a fiber settles once that plugin finished loading. A plugin whose
  // `inject` is unmet never settles, so each fiber gets a bounded wait and is
  // reported as dormant rather than hanging the boot.
  await Promise.all(registered.map(async (entry) => {
    // A loader entry has no fiber to await here; `create` already awaited its
    // update, and readiness is reported by the entry audit instead.
    if (!entry.fiber) return
    try {
      await Promise.race([
        entry.fiber,
        new Promise((resolve) => setTimeout(() => resolve('__timeout__'), options.settleMs ?? 2000)),
      ]).then((outcome) => {
        if (outcome === '__timeout__') pending.push(entry.specifier)
      })
    } catch (error) {
      failed.push({ specifier: entry.specifier, phase: 'start', error: String(error?.message ?? error) })
    }
  }))

  return {
    ctx,
    report: {
      composedVia: loader ? 'loader' : 'direct',
      registered: registered.map(e => e.specifier),
      libraries,
      skipped,
      failed,
      pending,
    },
  }
}

/**
 * Enumerate the services actually published on a context.
 *
 * Cordis services take their name at construction time (`super(ctx, 'sessions')`),
 * so the name cannot be read off the class statically — only off a live context.
 * `ctx.reflect.store` is that registry.
 */
export function servicesOn(ctx) {
  // `reflect.store` is keyed by symbol; `reflect.props` carries the readable
  // names, mixed in with Cordis's own context methods.
  const BUILTIN = new Set([
    'get', 'set', 'provide', 'accessor', 'mixin', 'runtime', 'effect', 'inject', 'plugin',
    'on', 'once', 'parallel', 'emit', 'serial', 'bail', 'waterfall',
    'timer', 'timeout', 'interval', 'throttle', 'debounce', 'setTimeout', 'setInterval',
  ])
  const props = ctx.reflect?.props ?? {}
  return Object.keys(props)
    .filter((name) => {
      if (BUILTIN.has(name) || name.startsWith('$') || name.startsWith('_')) return false
      let value
      try { value = ctx.get(name) } catch { return false }
      return value !== undefined && value !== null
    })
    .sort()
}

/** Services some plugin declared it needs but nothing in the set publishes. */
export function unmetInjects(modules, servicePresent) {
  const wanted = new Map()   // service -> [specifier]
  for (const [specifier, mod] of Object.entries(modules)) {
    const found = findPlugin(mod)
    if (!found) continue
    const raw = found.value.inject ?? mod.inject
    const names = !raw ? [] : Array.isArray(raw) ? raw : typeof raw === 'object' ? Object.keys(raw) : [String(raw)]
    for (const n of names) {
      if (servicePresent.includes(n)) continue
      if (!wanted.has(n)) wanted.set(n, [])
      wanted.get(n).push(specifier.replace('@deepseek-ai/', ''))
    }
  }
  return [...wanted].sort((a, b) => b[1].length - a[1].length)
}
