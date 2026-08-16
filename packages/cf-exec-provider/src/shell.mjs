// cf-exec-provider — the upstream `shell` seam, over a Cloudflare container.
//
// `dsh-shell` is an abstract executor with three members:
//
//   resolve(request) -> spec    pure: apply defaults and caps
//   run(spec)        -> result  one-shot foreground execution
//   start(spec)      -> process background process with incremental reads
//
// `resolve` stays local — it is arithmetic, not I/O — so only `run` and `start`
// cross the wire. The upstream reference executor (`dsh-bash-local`) runs
// `bash -c` in a managed process group; this one hands the same command to a
// container over U5.
import { ShellExecutor } from '@deepseek-ai/dsh-shell'

const DEFAULT_WORKDIR = '/workspace'
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const DEFAULT_STDOUT_MAX_BYTES = 64 * 1024

/**
 * Model-friendly defaults, matching what the local executor sets: no colour, no
 * pager, no interactive prompts. A command that opens a pager in a sandbox with
 * no TTY hangs until the timeout, and the agent has no way to tell why.
 */
const BASE_ENV = {
  TERM: 'dumb',
  NO_COLOR: '1',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
  DEBIAN_FRONTEND: 'noninteractive',
  CI: '1',
}

export class CfShellExecutor extends ShellExecutor {
  constructor(ctx, config) {
    super(ctx)
    if (!config?.exec) throw new Error('cf-exec-provider requires the EXEC service binding (config.exec)')
    this.exec = config.exec
    this.sandboxId = config.sandboxId ?? 'default'
    this.workdir = config.workdir ?? DEFAULT_WORKDIR
  }

  /** Pure: defaults and caps, no I/O. */
  resolve(request) {
    return {
      command: request.command,
      workdir: request.workdir ?? this.workdir,
      timeoutMs: Math.min(request.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
      stdoutMaxBytes: request.stdoutMaxBytes ?? DEFAULT_STDOUT_MAX_BYTES,
      signal: request.signal,
      stdin: request.stdin,
      env: { ...BASE_ENV, ...(request.env ?? {}) },
      sandboxPolicy: undefined,
    }
  }

  async run(spec) {
    const started = Date.now()
    let payload

    // The spec carries a timeout and nothing was enforcing it: a container that
    // never answers held the alarm invocation open until the platform killed it,
    // which leaves no turn/end in the log and no record in the tail — the turn
    // simply stops. Combine the caller's signal with a deadline of our own.
    const deadline = AbortSignal.timeout(spec.timeoutMs)
    const signal = spec.signal
      ? AbortSignal.any([spec.signal, deadline])
      : deadline

    try {
      const response = await this.exec.fetch('http://exec/exec', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sandboxId: this.sandboxId,
          command: spec.command,
          cwd: spec.workdir,
          env: spec.env,
        }),
        signal,
      })
      payload = await response.json()
    } catch (error) {
      // An unreachable or unresponsive execution world is an outcome the agent
      // can read and act on, not an exception that aborts its turn.
      if (deadline.aborted) {
        return { ...failed(spec, `command exceeded ${spec.timeoutMs} ms`), timedOut: true }
      }
      return failed(spec, `exec unreachable: ${String(error?.message ?? error)}`)
    }

    if (!payload?.ok) return failed(spec, payload?.error ?? 'exec failed')

    const { exitCode, stdout, stderr } = payload.result
    const timedOut = Date.now() - started >= spec.timeoutMs
    return {
      exitCode: exitCode ?? null,
      signal: null,
      timedOut,
      aborted: Boolean(spec.signal?.aborted),
      timeoutMs: spec.timeoutMs,
      stdout: collect(stdout, spec.stdoutMaxBytes),
      stderr: collect(stderr, spec.stdoutMaxBytes),
      // `sandbox` is deliberately absent. ShellSandboxInfo is { mode, denied,
      // enforcement?, runnerFailed? } — a shape describing OS-level
      // confinement, not "which container ran this". Filling it with something
      // else failed the seam's own check with "value is not lossless JSON",
      // and the field is optional precisely for executors that do not confine
      // in those terms.
    }
  }

  /**
   * Background processes are not implemented yet.
   *
   * They are what `dsh-tool-bash-persistent` and the terminal seam need, and
   * they require the container-side process API rather than one-shot exec.
   * Throwing here is deliberate: returning a fake process object would make
   * every long-running command look like it succeeded instantly.
   */
  start() {
    throw new Error(
      'cf-exec-provider: background processes are not implemented; '
      + 'install only the one-shot bash tool for now',
    )
  }
}

/** Tail-truncate to the seam's contract: `text` holds the END of the stream. */
function collect(text, maxBytes) {
  const value = String(text ?? '')
  if (value.length <= maxBytes) return { text: value, truncated: false }
  return { text: value.slice(value.length - maxBytes), truncated: true }
}

function failed(spec, message) {
  return {
    exitCode: null,
    signal: null,
    timedOut: false,
    aborted: Boolean(spec.signal?.aborted),
    timeoutMs: spec.timeoutMs,
    stdout: { text: '', truncated: false },
    stderr: { text: message, truncated: false },
  }
}

export default CfShellExecutor
