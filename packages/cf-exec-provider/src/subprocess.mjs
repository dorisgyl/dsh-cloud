// cf-exec-provider/subprocess — the upstream `subprocess` seam, over a
// Cloudflare container.
//
// The seventh seam, and the one that pays for itself several times over. It has
// only three members, and filling it hands us the whole terminal stack for
// free: `dsh-terminal` (the session service), `dsh-terminal-bash` (a PTY
// backend that already does terminal emulation, viewport rendering and idle
// inference) and `dsh-tool-bash-persistent`. Writing a TerminalBackend from
// scratch would have meant reimplementing all of that; writing this instead
// means upstream keeps doing it.
//
// The PTY itself is real. `sandbox.terminal(request)` upgrades a WebSocket
// straight to a pseudo-terminal in the container, and its wire protocol is the
// one the SDK's own xterm addon speaks:
//
//   to the container    binary        keystrokes / stdin bytes
//                       JSON text     { type: 'resize', cols, rows }
//   from the container  binary        PTY output bytes
//                       JSON text     { type: 'ready' | 'error' | 'exit', ... }
import { Readable } from 'node:stream'
// `SubprocessRuntime` was `SubprocessService` on the abandoned 0.0.1 line of
// this package, which is where this file was pinned while U2 installed 0.1.0 —
// two copies of one seam, and this provider subclassing the copy nothing else
// imported. Cordis registers by service NAME, so it worked; it worked the way
// an unnoticed second copy works. The abstract surface is identical across the
// rename: resolveExecutable, spawn, spawnTerminal, all registering `subprocess`.
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/** Ctrl-C. Over a PTY an interrupt IS a keystroke, not a kill(2). */
const CONTROL_CHARS = {
  SIGINT: '\x03',
  SIGTSTP: '\x1a',
  SIGQUIT: '\x1c',
}

export class CfSubprocessService extends SubprocessRuntime {
  constructor(ctx, config) {
    super(ctx)
    if (!config?.exec) throw new Error('cf-exec-provider/subprocess requires the EXEC service binding (config.exec)')
    this.exec = config.exec
    this.sandboxId = config.sandboxId ?? 'default'
    this.cwd = config.cwd ?? '/workspace'
  }

  /**
   * `command -v` in the container. Callers use this to fail early with a clear
   * message instead of spawning something that does not exist.
   */
  async resolveExecutable(command, env, signal) {
    const response = await this.exec.fetch('http://exec/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sandboxId: this.sandboxId,
        command: `command -v ${JSON.stringify(String(command))}`,
        cwd: this.cwd,
        env: env ?? undefined,
      }),
      signal,
    })
    const payload = await response.json()
    const path = String(payload?.result?.stdout ?? '').trim()
    if (!payload?.ok || !path) throw new Error(`executable not found in the container: ${command}`)
    return path
  }

  /**
   * Not implemented, and nothing in this deployment calls it.
   *
   * The signature is synchronous and returns live `node:stream` handles bound to
   * an already-running process — over an async service binding there is no
   * honest way to produce that. Its three upstream callers (dsh-bash-local,
   * dsh-pwsh-local, dsh-tool-fs-search) are all local providers we replace, so
   * this throws rather than returning a handle whose streams never carry
   * anything.
   */
  spawn() {
    throw new Error(
      'cf-exec-provider: subprocess.spawn is not implemented (no synchronous process handles '
      + 'across a service binding). Use ctx.shell.run, or spawnTerminal for a PTY.',
    )
  }

  async spawnTerminal(spec) {
    // PtyOptions is { cols, rows, shell } and carries no environment and no
    // argv, but the caller's env is not decoration: dsh-terminal-bash detects
    // its prompt through PS1 and an OSC 133 PROMPT_COMMAND, so a PTY started
    // without them connects, produces output, and never reports readiness --
    // "PTY shell did not reach readiness before startup timeout", which reads
    // like a slow container and is actually a dropped variable.
    //
    // So the environment and the argv go into a launcher script in the
    // container, and the PTY starts that. One extra round trip per terminal
    // session, once.
    const query = new URLSearchParams({
      sandboxId: this.sandboxId,
      cwd: spec.cwd ?? this.cwd,
      cols: String(spec.cols ?? 80),
      rows: String(spec.rows ?? 24),
    })
    // `launcher: false` starts the container's own default shell with no
    // environment of ours. It exists for the probe: when a terminal produces
    // nothing, the first question is whether the launcher is at fault or the
    // PTY, and that is not answerable without being able to remove one.
    if (spec.launcher !== false) {
      const launcher = `/tmp/dsh-pty-${crypto.randomUUID()}.sh`
      await this.writeLauncher(launcher, spec)
      query.set('shell', launcher)
    }

    const response = await this.exec.fetch(`http://exec/terminal?${query}`, {
      headers: { Upgrade: 'websocket' },
      signal: spec.signal,
    })
    const socket = response.webSocket
    if (!socket) {
      throw new Error(`terminal upgrade failed: HTTP ${response.status} ${await response.text().catch(() => '')}`)
    }
    socket.accept()
    // Binary frames arrive as Blobs by default, and a Blob has `size`, not
    // `byteLength` — so a handler written for ArrayBuffer drops every one of
    // them silently and the terminal looks like it produced nothing at all.
    // Measured: text 1, binary 0, other 4. The SDK's own xterm addon sets this
    // line too, which is the tell that it is required rather than tidy.
    try { socket.binaryType = 'arraybuffer' } catch { /* already fixed by the runtime */ }

    const handle = new CfTerminalHandle(socket, spec)
    // Do not hand back a terminal that has not started.
    //
    // The container announces `{type:'ready'}` and only then does a resize take
    // effect and the shell produce anything; sending before that is silently
    // dropped, which looks exactly like a terminal that connected fine and then
    // said nothing forever. Measured: with the writes ahead of `ready`, the
    // probe saw the ready message and zero output bytes.
    await handle.whenReady(spec.signal)
    return handle
  }

  /**
   * Write the launcher and make it executable, in one command.
   *
   * The script travels as base64 so no environment value can break out of it --
   * and one of them genuinely tries: PROMPT_COMMAND is
   * `printf "\033]133;D;%s\007" "$?"`, which carries double quotes, a backslash
   * escape and a `$?` that must survive to the shell unexpanded.
   */
  async writeLauncher(path, spec) {
    const argv = spec.argv?.length ? [...spec.argv] : ['/bin/bash', '--noprofile', '--norc', '-i']
    const lines = [
      '#!/bin/sh',
      `cd ${shellQuote(spec.cwd ?? this.cwd)} 2>/dev/null || true`,
      ...Object.entries(spec.env ?? {}).map(([k, v]) => `export ${k}=${shellQuote(String(v))}`),
      `exec ${argv.map(shellQuote).join(' ')}`,
      '',
    ]

    const script = btoa(String.fromCharCode(...new TextEncoder().encode(lines.join('\n'))))
    const response = await this.exec.fetch('http://exec/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sandboxId: this.sandboxId,
        command: `printf '%s' '${script}' | base64 -d > ${path} && chmod +x ${path}`,
        cwd: this.cwd,
      }),
      signal: spec.signal,
    })
    const payload = await response.json()
    if (!payload?.ok || payload.result?.exitCode !== 0) {
      throw new Error(`could not write the PTY launcher: ${payload?.error ?? payload?.result?.stderr ?? 'unknown'}`)
    }
  }
}

/** POSIX single-quoting: the only characters that survive are all of them. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * One PTY, held open for as long as the Durable Object stays in memory.
 *
 * The output side is a `node:stream` Readable because that is what the seam
 * declares and what `dsh-terminal-bash` reads from; the socket's binary frames
 * are pushed into it verbatim, so the emulator upstream sees exactly the bytes
 * the pseudo-terminal produced.
 */
class CfTerminalHandle {
  constructor(socket, spec) {
    this.socket = socket
    this.closed = false
    this.exited = false

    // No backpressure: `read()` is a no-op because the source is a socket we do
    // not control the rate of. The consumer is a terminal emulator that keeps a
    // bounded scrollback, so unbounded buffering here is not a real risk.
    this.output = new Readable({ read() {} })

    this.done = new Promise((resolve) => { this.settle = resolve })
    this.ready = new Promise((resolve) => { this.markReady = resolve })
    this.spec = spec

    // Frame counters, kept because "no output" has two very different causes:
    // no frames arrived at all, or frames arrived in a shape this handler drops.
    // Without the counters both look identical from the consumer's end.
    this.frames = { text: 0, binary: 0, other: 0, closed: false, bytes: 0 }

    socket.addEventListener('message', (event) => {
      if (typeof event.data === 'string') { this.frames.text++; return this.onControl(event.data) }
      this.frames.binary++
      // Accept every binary shape rather than testing for one. `instanceof`
      // is unreliable across an isolate boundary anyway, and a frame this
      // handler cannot classify must never be dropped in silence.
      const data = event.data
      if (typeof data?.arrayBuffer === 'function') {
        data.arrayBuffer().then((buffer) => this.pushBytes(new Uint8Array(buffer)))
      } else if (ArrayBuffer.isView(data)) {
        this.pushBytes(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
      } else {
        this.pushBytes(new Uint8Array(data))
      }
    })

    // A closed socket is an exit even without an `exit` control message —
    // otherwise a container that dies mid-session leaves `done` pending
    // forever and the terminal session never reports it is gone.
    socket.addEventListener('close', (e) => {
      this.frames.closed = { code: e?.code, reason: String(e?.reason ?? '').slice(0, 200) }
      this.finish({ exitCode: null, signal: null })
    })
    socket.addEventListener('error', () => this.finish({ exitCode: null, signal: null }))

  }

  pushBytes(bytes) {
    this.frames.bytes += bytes.byteLength
    if (!this.exited) this.output.push(bytes)
  }

  onControl(text) {
    let message
    try { message = JSON.parse(text) } catch { return }
    this.onControlSeen?.(message)
    if (message?.type === 'ready') {
      // Resize on ready, in that order — the same sequence the SDK's own xterm
      // addon uses. A resize sent before ready has no effect.
      this.resize(this.spec?.cols ?? 80, this.spec?.rows ?? 24)
      this.markReady()
    } else if (message?.type === 'exit') {
      this.finish({ exitCode: message.code ?? null, signal: message.signal ?? null })
    } else if (message?.type === 'error') {
      this.output.push(new TextEncoder().encode(`\r\n[terminal error: ${message.message ?? 'unknown'}]\r\n`))
    }
  }

  finish(outcome) {
    if (this.exited) return
    this.exited = true
    this.output.push(null)
    this.settle(outcome)
  }

  /**
   * Resolve once the container says the terminal is up, or reject with a
   * message that names what was seen. A silent hang here would surface far
   * downstream as "the shell never printed a prompt".
   */
  whenReady(signal, timeoutMs = 15000) {
    return Promise.race([
      this.ready,
      this.done.then(() => { throw new Error('the terminal exited before it became ready') }),
      new Promise((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`the container did not report the terminal ready within ${timeoutMs} ms`)),
          timeoutMs,
        )
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) })
      }),
    ])
  }

  /** The seam has no pid to give: the PTY arrives as a socket, not a process. */
  get pid() { return 0 }

  resize(cols, rows) {
    if (this.exited) return
    try { this.socket.send(JSON.stringify({ type: 'resize', cols, rows })) } catch { /* closed */ }
  }

  async write(data) {
    if (this.exited) return
    this.socket.send(new TextEncoder().encode(String(data)))
  }

  /**
   * Not available, and `undefined` is the contract's own way of saying so.
   *
   * Foreground inspection needs the tty's foreground process group, which means
   * knowing the pty device or the shell's pid inside the container. The SDK
   * hands out a WebSocket and neither of those. Upstream falls back to a timing
   * heuristic for idleness, which is weaker than asking the kernel but is the
   * honest answer here — inventing a process group id would make the caller
   * confident about something we cannot see.
   */
  async inspectForeground() { return undefined }

  /**
   * Deliver a signal the only way a terminal can: as a control character.
   *
   * SIGINT and SIGTSTP have keystrokes and the tty line discipline turns them
   * into real signals for the foreground group, so those work exactly as they
   * would for a human. SIGTERM, SIGKILL and SIGHUP have no keystroke; reporting
   * 0 delivered says so rather than pretending.
   */
  async signalForeground(signal) {
    const char = CONTROL_CHARS[signal]
    if (!char || this.exited) return 0
    await this.write(char)
    return 1
  }

  async terminate() {
    if (this.closed) return
    this.closed = true
    try { this.socket.close(1000, 'terminated') } catch { /* already gone */ }
    this.finish({ exitCode: null, signal: 'SIGTERM' })
  }
}

export default CfSubprocessService
