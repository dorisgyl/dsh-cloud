# M2 — the filesystem and the terminal

**Date**: 2026-08-16
**Result**: all three execution seams are filled. `shell` and `fs` are live for
the agent; the PTY works and is deliberately not the default `bash`.

## The fs seam

`cf-exec-provider/fs` implements all twelve members over one U5 route.

Verified end to end in one turn: `write` created `/workspace/fs2.txt`, `read`
returned it, `edit` replaced `beta` with `BETA`, and then `bash cat -A` showed
the edited bytes. **Shell and filesystem are one execution world**, which is the
property that actually matters — a file written by bash has to be visible to the
read tool.

Three decisions worth keeping:

**`editText` is one process in the container.** Upstream keeps edit at the seam
so "version check, literal match and rewrite share one critical section".
Splitting it into a Worker-side read and write would let two edits interleave
and lose one. Writes publish through a temp file and `rename`, so a reader sees
the whole old file or the whole new one.

**`resolve()` stays local.** The seam permits a round trip to realpath, but
every operation already costs one request and resolving first would double that
for every file the agent touches. The cost: symlink aliases get distinct target
keys, weakening staleness detection between them. It cannot corrupt anything —
every mutation re-checks the version inside the container, against the real
file.

**`streamText` is not streaming.** It fetches the whole file and yields slices,
so the iterable contract holds and the memory profile does not improve. Real
streaming needs a chunked protocol through U5, worth building when something
reads files large enough to need it.

## The subprocess seam, and what it bought

`SubprocessService` has three members. Filling it brings the entire terminal
stack for free: `dsh-terminal` (session service), `dsh-terminal-bash` (terminal
emulation, viewport rendering, idle inference — 800 lines we did not write) and
`dsh-tool-bash-persistent`.

`sandbox.terminal(request)` upgrades a WebSocket straight to a pseudo-terminal.
Its protocol is the one the SDK's own xterm addon speaks:

| direction | frame | meaning |
|---|---|---|
| to container | binary | keystrokes / stdin bytes |
| to container | JSON text | `{ type: 'resize', cols, rows }` |
| from container | binary | PTY output |
| from container | JSON text | `{ type: 'ready' \| 'error' \| 'exit' }` |

**It works.** In one turn:

```
cd /tmp && export MARKER=persisted        ->  (no output)
```

and in the **next** turn, a separate alarm invocation:

```
pwd; echo MARKER=$MARKER                  ->  /tmp
                                              MARKER=persisted
```

### Three failures that each looked like something else

**1. A dropped variable that reads as a slow container.** `PtyOptions` is
`{cols, rows, shell}` and carries no environment — but `dsh-terminal-bash` finds
its prompt through `PS1` and an OSC 133 `PROMPT_COMMAND`. Without them the
terminal connects, runs, and reports

```
PTY shell did not reach readiness before startup timeout
```

The environment and argv now go into a launcher script written into the
container, base64-encoded so that `printf "\033]133;D;%s\007" "$?"` survives
intact.

**2. Binary frames arrive as Blobs.** A `Blob` has `size`, not `byteLength`, so
a handler written for `ArrayBuffer` dropped every output frame silently — the
terminal looked like it produced nothing at all. Frame counters settled it in
one shot:

```
{ text: 1, binary: 0, other: 4, bytes: 0 }
```

`socket.binaryType = 'arraybuffer'` — the same line the xterm addon sets — is
required, not tidy. This is the third time in this project that the fix was one
line and finding it took everything.

**3. Writes before `ready` are discarded.** Ready first, then resize, then
input, which is the addon's own order.

## Why the PTY is not the default `bash`

`dsh-tool-bash` and `dsh-tool-bash-persistent` **register the same tool name**,
so exactly one can win. Left alone the winner is decided by registration order,
which is not a decision; U2 now skips one explicitly.

The default is the one-shot executor, for one measured reason:

```
bash: cannot set terminal process group (1): Inappropriate ioctl for device
bash: no job control in this shell
```

The container gives the shell no controlling terminal, so Ctrl-C reaches the tty
and is echoed but **does not kill the foreground command**. A `sleep 20`
interrupted at 3 s never gave its prompt back, and every later terminal in the
same sandbox inherited the wedged shell — a sandbox has one PTY session.

`bash` is the agent's most important tool and has to recover on its own. The
one-shot executor always does: every command carries a deadline, and a failed
command is an ordinary tool result rather than a stuck session.

Switching is one line in `units/session-do/src/index.mjs` (`SKIP`). What would
make the persistent shell safe by default is a controlling terminal, or a
kill-and-respawn path the tool does not expose.

## Instrumentation, because the tree kept looking healthy

Two failures in a row were invisible to the health report: a plugin missing from
the build, then a plugin registered but dormant. Both showed `failed: []`,
`unmet: []` and a normal service count while a tool the user asked for simply
did not exist.

`/api/state` now reports `serviceNames`, `pending` (registered, never settled)
and `tools` — the schemas the model is actually offered, which is the only claim
that matters. `/api/pty-probe` dumps raw PTY bytes and frame counts.

An earlier version of the `tools` field enumerated the service object's own
properties and returned `["cancellationStates", "canonicalResults", ...]` — an
answer-shaped non-answer, which is exactly the failure mode this instrumentation
exists to catch.

## An upstream version skew, worked around without a patch

`dsh-tool-bash-persistent@0.0.1-rc.1` injects `pty` and calls
`ctx.pty.{spawn,startSend,read,kill,list}`. `dsh-terminal@0.0.1-rc.3` publishes
exactly that surface as **`terminals`** — the service was renamed and the tool
was never republished. Left alone the tool waits forever on a service nobody
provides and never registers, reporting nothing.

One alias in our own tree (`ctx.provide('pty', ctx.terminals)`) fixes it without
touching upstream source, and disappears the day the tool is republished.

## Not done

- **`subprocess.spawn`** (non-PTY processes with live stdio). Its signature is
  synchronous and returns streams bound to a running process; there is no honest
  way to produce that across an async service binding. All three upstream
  callers are local providers we replace, so it throws.
- **`inspectForeground`** returns `undefined` — the foreground process group
  needs the pty device or the shell's pid, and the SDK hands out neither.
  Upstream falls back to a timing heuristic.
- **One PTY per sandbox.** `dsh-terminal` supports named sessions; the SDK's
  terminal endpoint takes no session id, so concurrent terminals share a shell.
- **Cold start** is still unmeasured, and it is what a user feels first.
