// U5 dsh-exec — the execution world.
//
// A thin front for the Sandbox SDK. U2 reaches it over a service binding; it
// has no public route, because everything it offers is arbitrary code execution
// inside a container.
//
// The protocol is deliberately coarse. Design 5.2 measured the cost of the
// alternative: the call chain is SessionAgentDO -> this Worker -> the container,
// so anything issued per syscall would pay three hops each time. The upstream
// `fs` seam is per-FILE (readText, writeText, listDir, editText), not per
// syscall, so one seam call maps to one request here and no finer.
import { getSandbox } from '@cloudflare/sandbox'

// Required by the SDK: the container class must be exported from the entry.
export { Sandbox } from '@cloudflare/sandbox'

/** Every workspace is one sandbox; the id is the workspace's identity. */
function sandboxFor(env, id) {
  if (!id || !/^[A-Za-z0-9._-]{1,128}$/.test(id)) throw new Error('invalid sandbox id')
  return getSandbox(env.Sandbox, id)
}

/**
 * A sandbox whose shell session has died stays dead: every later command fails
 * with the same message, from any caller, forever. Measured — the agent's
 * sandbox kept failing while a brand-new id worked first try, and probing the
 * broken id from a different Durable Object reproduced it exactly.
 *
 * So this state is recoverable only by discarding the container, and treating
 * it as fatal would strand a session permanently on one bad start.
 */
const DEAD_SHELL = /is not ready or shell has died/i

const handlers = {
  async exec(sandbox, body) {
    const run = () => sandbox.exec(body.command, {
      cwd: body.cwd ?? '/workspace',
      env: body.env ?? undefined,
    })

    let result
    try {
      result = await run()
    } catch (error) {
      if (!DEAD_SHELL.test(String(error?.message ?? error))) throw error
      // Discard and retry exactly once. A second failure is a real failure and
      // is reported rather than retried into a loop.
      try { await sandbox.destroy() } catch { /* already gone */ }
      result = await run()
    }

    return {
      exitCode: result.exitCode ?? (result.success ? 0 : 1),
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    }
  },

  async readFile(sandbox, body) {
    const file = await sandbox.readFile(body.path)
    return { content: file?.content ?? String(file ?? '') }
  },

  async writeFile(sandbox, body) {
    await sandbox.writeFile(body.path, body.content ?? '')
    return { ok: true }
  },

  async listFiles(sandbox, body) {
    const files = await sandbox.listFiles(body.path ?? '/workspace')
    return { files }
  },

  async mkdir(sandbox, body) {
    await sandbox.mkdir(body.path, { recursive: body.recursive !== false })
    return { ok: true }
  },
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    if (url.pathname === '/health') {
      return Response.json({ ok: true, unit: 'dsh-exec', ops: Object.keys(handlers) })
    }

    const op = url.pathname.replace(/^\//, '')
    const handler = handlers[op]
    if (!handler) return Response.json({ error: 'unknown-op', op }, { status: 404 })

    let body
    try {
      body = await request.json()
    } catch {
      return Response.json({ error: 'invalid-json' }, { status: 400 })
    }

    try {
      const sandbox = sandboxFor(env, body.sandboxId)
      return Response.json({ ok: true, result: await handler(sandbox, body) })
    } catch (error) {
      // Container failures are ordinary outcomes here — a command that cannot
      // run is data for the agent, not a crash of the request.
      return Response.json({
        ok: false,
        error: String(error?.message ?? error),
      })
    }
  },
}
