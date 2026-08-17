// cf-loader — upstream's plugin loader, resolving against the bundle.
//
// Design 10.6 replaced the loader with a compile-time expansion, and that was
// right for booting: a Worker has no runtime module resolution, so the plugin
// set has to be decided at build time. It also removed something the expansion
// never replaced — the `loader` SERVICE, which is the seam upstream's own
// runtime composition hangs off:
//
//   dsh-agent-presets       mounts a named plugin subtree per session
//   dsh-host-plugin-inventory  lists what is mounted
//
// Both inject `loader`, so both stayed dark, and "everything is a plugin" lost
// the half where a deployment can compose plugins rather than only run them.
//
// The loader itself turns out to be portable: `cordis-plugin-loader` is 744
// lines and imports exactly one Node builtin, `node:module`, for a path this
// deployment never takes. What it cannot do here is the last step —
//
//   if (this.ctx.loader.internal) return this.ctx.loader.internal.import(name, base, {})
//   else return await import(name)        // <- impossible on workerd
//
// — and `internal` is an optional, overridable field. Pointing it at the static
// module map makes every plugin row resolve from what is already compiled in.
//
// So this restores runtime COMPOSITION without runtime CODE. The honest
// description of the result is "choose from the plugins this deployment was
// built with", which is a real capability and not the same as "install
// anything": that one needs a Dynamic Worker and its own security model
// (ADR-09).
import { Loader } from '@deepseek-ai/cordis-plugin-loader'

export function apply(ctx, config) {
  const modules = config?.modules
  if (!modules) throw new Error('cf-loader requires the statically expanded module map (config.modules)')

  const loader = new Loader(ctx, config?.loader ?? {})

  // The whole point of this package.
  //
  // `base` and the options bag are accepted and ignored: they exist to resolve
  // a specifier against a directory, and there are no directories here. A
  // specifier either names a module in the bundle or names nothing.
  loader.internal = {
    async import(specifier) {
      const module = modules[specifier]
      if (module !== undefined) return module

      // Naming the closed set is the useful part of this error. A deployment
      // that wants another plugin adds it to the roster and redeploys; there is
      // no runtime install, and saying so beats a resolution failure that reads
      // like a missing file.
      throw new Error(
        `cf-loader: "${specifier}" is not in this deployment's plugin set. `
        + 'The set is fixed at build time (scripts/u2-deps.json); add it there and redeploy.',
      )
    },
  }

  // Third-party plugins are loaded by cf-plugin-host, not by this loader, so
  // `entries()` would not see them — and `pluginInventory`, which is what the
  // settings panel reads, would report a deployment with no plugins while one
  // was demonstrably registering tools.
  //
  // They are merged in rather than hidden, because the question the panel
  // answers is "what plugins are in this deployment", and a third-party plugin
  // is one. They carry no fiber, and the shape says so (`fiber: undefined`
  // renders as a null phase) rather than inventing a lifecycle they do not
  // have.
  if (typeof config?.foreignEntries === 'function') {
    const own = loader.entries.bind(loader)
    loader.entries = function* entries() {
      // Third-party first. The panel renders in this order and does not sort,
      // so yielding them last buried the one plugin someone just installed
      // under seventy they did not choose. The list answers "what is in this
      // deployment"; the part the operator added is the part they are looking
      // for.
      yield* config.foreignEntries()
      yield* own()
    }
  }

  return loader
}

export const name = 'cf-loader'
export default { apply, name }
