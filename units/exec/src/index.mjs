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
import { fsCommand } from './fs-script.mjs'

// Required by the SDK: the container class must be exported from the entry.
export { Sandbox } from '@cloudflare/sandbox'

/**
 * Every workspace is one sandbox; the id is the workspace's identity.
 *
 * The rules are the SDK's, read from `sanitizeSandboxId`, and they are DNS
 * label rules: at most 63 characters, no leading or trailing hyphen. This check
 * used to allow 128 characters — a number invented here — so an over-long id
 * passed our validation and failed inside the SDK on every single tool call,
 * with a message that named the platform rather than the caller. A guard that
 * enforces a limit of its own invention is worse than no guard: it reports
 * agreement it never checked.
 */
const MAX_SANDBOX_ID = 63

/**
 * How long a container stays awake after its last request.
 *
 * The SDK's default is 10 minutes, and a `lite` instance costs $0.000002015 per
 * second — so an idle window is $0.0012 at ten minutes and $0.0006 at five.
 * Neither is much: the Workers Paid plan includes 375 vCPU-minutes, 25 GiB-hours
 * and 200 GB-hours per month, which for `lite` all work out to the same 100
 * hours of runtime, or 600 ten-minute windows.
 *
 * Five minutes is a deliberate trade, not an optimisation: it halves the idle
 * window at the price of a cold start whenever a user pauses longer than that.
 * The cold start has not been measured, which is the honest caveat on this
 * number.
 */
const SLEEP_AFTER = '5m'

function sandboxFor(env, id) {
  if (!id || id.length > MAX_SANDBOX_ID) {
    throw new Error(`sandbox id must be 1-${MAX_SANDBOX_ID} characters (DNS label); got ${id ? id.length : 0}`)
  }
  if (!/^[A-Za-z0-9._][A-Za-z0-9._-]*[A-Za-z0-9._]$|^[A-Za-z0-9._]$/.test(id)) {
    throw new Error(`sandbox id must be DNS-safe and must not start or end with a hyphen: "${id}"`)
  }
  return getSandbox(env.Sandbox, id, { sleepAfter: SLEEP_AFTER })
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

/**
 * Run one command, recovering once from a dead shell. Both `exec` and `fs` go
 * through here so the recovery is not something only one of them remembers.
 */
async function runCommand(sandbox, command, options) {
  const run = () => sandbox.exec(command, options)
  try {
    return await run()
  } catch (error) {
    if (!DEAD_SHELL.test(String(error?.message ?? error))) throw error
    // Discard and retry exactly once. A second failure is a real failure and
    // is reported rather than retried into a loop.
    try { await sandbox.destroy() } catch { /* already gone */ }
    return run()
  }
}

const handlers = {
  async exec(sandbox, body) {
    const result = await runCommand(sandbox, body.command, {
      cwd: body.cwd ?? '/workspace',
      env: body.env ?? undefined,
    })

    return {
      exitCode: result.exitCode ?? (result.success ? 0 : 1),
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    }
  },

  /**
   * One filesystem seam call, executed by one process in the container.
   *
   * The op returns either `{ ...value }` or `{ error: { code, message } }`, and
   * the error codes are upstream's own `FsErrorCode` vocabulary — this Worker
   * passes them through untranslated so the provider never has to guess a code
   * from a message string.
   */
  async fs(sandbox, body) {
    const result = await runCommand(sandbox, fsCommand(body.payload), {
      cwd: body.cwd ?? '/workspace',
    })

    const stdout = String(result.stdout ?? '').trim()
    if (!stdout) {
      // No JSON at all means the container-side script never ran or died
      // before printing. stderr is the only evidence, so surface it rather
      // than reporting an empty success.
      throw new Error(`fs op produced no output: ${String(result.stderr ?? '').slice(0, 400) || 'no stderr'}`)
    }
    try {
      return JSON.parse(stdout)
    } catch {
      throw new Error(`fs op produced unparseable output: ${stdout.slice(0, 400)}`)
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

    // Where the 12 seconds go.
    //
    // One fs seam call was measured at 12292ms in production. Any fix for that
    // is a guess until the time is attributed, and the candidates have very
    // different fixes: SDK round trip (nothing to do here), process spawn (a
    // resident helper), Node startup (a smaller runtime), or the eval of a
    // ~7KB base64 script on every single call (cache it on disk).
    //
    // Each row is one `sandbox.exec`, so every row also pays the round trip;
    // the DIFFERENCES are the attribution, not the absolute numbers.
    if (url.pathname === '/fs-timing') {
      const sandbox = sandboxFor(env, url.searchParams.get('sandboxId'))
      const time = async (label, command) => {
        const t0 = Date.now()
        try {
          const r = await sandbox.exec(command, { cwd: '/workspace' })
          return { label, ms: Date.now() - t0, exitCode: r.exitCode ?? 0, out: String(r.stdout ?? '').slice(0, 60).trim() }
        } catch (error) {
          return { label, ms: Date.now() - t0, error: String(error?.message ?? error).slice(0, 120) }
        }
      }
      // Warm first: the first exec into a cold container pays for the container.
      const warmup = await time('warmup (excluded)', 'true')
      return Response.json({
        warmup,
        rows: [
          // The floor: one exec, one trivial process.
          await time('true', 'true'),
          // Add a shell that has to read and parse something.
          await time('echo', 'echo hi'),
          // Node startup alone, with no script to eval.
          await time('node -e ""', 'node -e ""'),
          // Node plus the eval of the real script, doing nothing.
          await time('node + eval(script)', fsCommand({ op: 'stat', path: '/workspace' })),
          // The same call twice in a row: a resident helper would make the
          // second one cheap, a per-call process will not.
          await time('node + eval(script) again', fsCommand({ op: 'stat', path: '/workspace' })),
        ],
        note: 'Differences attribute the cost; absolute numbers all include one SDK round trip.',
      })
    }

    if (url.pathname === '/health') {
      return Response.json({ ok: true, unit: 'dsh-exec', ops: Object.keys(handlers) })
    }

    // A real pseudo-terminal, upgraded straight through to the container.
    //
    // This is the one route that is not request/response: the SDK hands back a
    // 101 carrying the socket, and U2 holds the other end for the life of the
    // terminal session. Everything else here is deliberately coarse and
    // one-shot, but a terminal is a stream by nature and framing it as
    // request/response would be the wrong shape, not a cheaper one.
    if (url.pathname === '/terminal') {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
        return Response.json({ error: 'expected-websocket-upgrade' }, { status: 426 })
      }
      try {
        const sandbox = sandboxFor(env, url.searchParams.get('sandboxId'))
        return await sandbox.terminal(request, {
          cols: Number(url.searchParams.get('cols')) || 80,
          rows: Number(url.searchParams.get('rows')) || 24,
          shell: url.searchParams.get('shell') || undefined,
        })
      } catch (error) {
        return Response.json({ error: String(error?.message ?? error) }, { status: 500 })
      }
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
