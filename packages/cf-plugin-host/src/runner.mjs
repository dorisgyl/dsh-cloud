// The module the harness wraps around every third-party plugin.
//
// A plugin is authored the way an upstream Cordis plugin is authored:
//
//     export function apply(ctx, config) {
//       ctx.tools.register({ name, description, parameters, execute })
//     }
//
// and this runner is what makes that shape work across an isolate boundary.
//
// The boundary forces one thing the author never sees: **re-entry**. An RPC
// stub lives only for one execution context, so a plugin cannot register once
// and have its callbacks survive to the next turn. Instead `apply` is called
// again on every request — once to describe what the plugin provides, once per
// tool call to run it. `apply` is a registration function, so calling it twice
// costs nothing and calling it a thousand times costs nothing; what would be
// expensive is keeping it alive, which is exactly what is not possible.
//
// Everything else the author sees is ordinary: a `ctx` with the extension
// points this deployment allows, and `env.harness` for capabilities that live
// in the harness rather than in the plugin.
export const RUNNER_SOURCE = String.raw`
import * as plugin from './plugin.js'

/**
 * The ctx a plugin registers against.
 *
 * Deliberately not a proxy of the harness's real ctx: that object cannot cross
 * an isolate boundary, and pretending otherwise would mean a plugin compiling
 * against an API that silently does nothing. What is here is what works.
 */
function makeContext(collected, harness) {
  return {
    tools: {
      register(definition) {
        if (!definition || typeof definition.name !== 'string') {
          throw new Error('ctx.tools.register: a tool needs a string name')
        }
        if (typeof definition.execute !== 'function') {
          throw new Error('ctx.tools.register: tool "' + definition.name + '" has no execute()')
        }
        collected.set(definition.name, definition)
        return () => collected.delete(definition.name)
      },
    },
    // Capabilities that live in the harness. A plugin reaches the session, the
    // filesystem and the shell through here or not at all -- it has no network
    // of its own, by construction.
    harness,
  }
}

async function enter(env) {
  const collected = new Map()
  const apply = plugin.apply ?? plugin.default?.apply ?? plugin.default
  if (typeof apply !== 'function') {
    throw new Error('plugin exports no apply(ctx, config): export a function named apply, or a default export')
  }
  await apply(makeContext(collected, env.harness), env.config ?? {})
  return collected
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    try {
      const collected = await enter(env)

      if (url.pathname === '/describe') {
        // Schemas only. execute() is a function and stays on this side.
        const tools = [...collected.values()].map(({ execute, ...schema }) => schema)
        return Response.json({ ok: true, tools })
      }

      if (url.pathname === '/execute') {
        const { name, args } = await request.json()
        const definition = collected.get(name)
        if (!definition) {
          return Response.json({ ok: false, error: 'this plugin registers no tool named "' + name + '"' })
        }
        return Response.json({ ok: true, value: await definition.execute(args ?? {}) })
      }

      return Response.json({ ok: false, error: 'unknown plugin route ' + url.pathname }, { status: 404 })
    } catch (error) {
      // A plugin that throws is data about the plugin, not a failure of the
      // harness. It is reported with its stack so the person who installed it
      // can act on it.
      return Response.json({
        ok: false,
        error: String(error?.message ?? error),
        stack: String(error?.stack ?? '').slice(0, 1200),
      })
    }
  },
}
`
