# M2 — the execution world

**Date**: 2026-08-15
**Result**: the agent runs real commands in a real Cloudflare container.

```
TOOL CALL    {"command": "echo hello-from-container && uname -s"}
TOOL RESULT  "hello-from-container\nLinux"
FINAL REPLY  "The command ran successfully ... confirming the container is running Linux."
```

The path is Access → edge → session object → alarm → tool call → U5 → container,
and back.

## The container reaches the internet

```
curl -o /dev/null -w "%{http_code}" https://example.com/    ->  200   (3.3s cold)
```

Never measured until now, and two documents depended on the answer.
`M4-plugins.md` said a third-party plugin's fence was having no network — true
of the isolate, false of any plugin granted `shell`, which runs here.

It also settles what the Worker cannot do. From a Worker, all three DuckDuckGo
endpoints answer HTTP 522 in ~19.5s with a 16-byte body, while `example.com`
answers 200 in 11ms — so the Worker's egress is healthy and there is simply no
route to that host. From the container the same URL returns HTTP 202 in 1.4s
carrying a bot challenge. Different egress, different answer, and neither is a
usable search backend.

## What one fs call costs, measured

`/api/fs-timing`, warm, each row one `sandbox.exec` so each includes one SDK
round trip. The differences are the attribution:

| | ms | attributable to |
|---|---|---|
| `true` | 64 | round trip and one trivial process — the floor |
| `echo hi` | 65 | +1, shell parsing |
| `node -e ""` | 123 | **+58, Node startup** |
| `node -e eval(FS_SCRIPT)` + payload | 127 | **+4, an 8.7 KB command line and a 7 KB eval** |
| the same call again | 129 | +2, nothing is cached and nothing needs to be |

Cold start, once per sandbox: **2670 ms**.

**One fs seam call is 127 ms.** This is written down because the number that
prompted the measurement was 12292 ms, taken from a production log, and every
theory it produced was wrong.

The suspect was the shape of `fsCommand`: 8708 characters, 99% of them a base64
copy of the whole fs worker, re-sent and re-evaluated on every `realpath`. It
looks indefensible and it costs **4 ms**. Caching the script on disk — which
`fs-script.mjs` explicitly rejected, to stay correct when a container is
destroyed under us — would have bought nothing and given up that property.

The 12 seconds was queueing. `ensureTree` had no in-flight guard, so one page
load started three tree builds, each mounting the workspace through this call;
none finished inside the client's patience; the browser retried and started
three more. A 127 ms operation reaches 12 seconds under that, and the container
never goes idle, so it never sleeps, so it stays slow.

**A saturated queue and a slow operation produce the same number.** The fix was
upstream of the seam, and nothing here needed changing.

## Shape

`units/exec` (U5) is a thin front for the Sandbox SDK, reachable only over a
service binding from U2 — it has no public route, because everything it offers
is arbitrary code execution.

`packages/cf-exec-provider` implements upstream's `shell` seam:

| seam member | where it runs |
|---|---|
| `resolve(request)` | **locally** — it is arithmetic, not I/O |
| `run(spec)` | one request to U5, one `sandbox.exec` |
| `start(spec)` | **not implemented** — throws |

`start` is background processes, which `dsh-tool-bash-persistent` and the
terminal seam need. Returning a fake process object would make every
long-running command look like it finished instantly, so it throws instead, and
`dsh-tool-bash-persistent` is not installed.

### The fs seam's granularity, finally measured

M0 left this open and it decided the shape. Upstream's `FileSystem` is
**per-file, not per-syscall**: `readText`, `writeText`, `editText`, `listDir`,
`stat` are each one complete operation, while `resolve`, `processPath` and
`contains` are pure path arithmetic with no I/O at all.

So one seam call is one request, and reading twenty files costs twenty round
trips rather than several hundred. The design's worry about syscall-level
chattiness (5.2) does not apply.

## Five things that had to be discovered

### 1. No Docker needed — a published image reference works

The SDK's documented setup builds `./Dockerfile`, which requires Docker. This
machine has none, and design 10.6.3 wants that barrier off the self-deployer
too. Pointing `image` at a published tag deploys without Docker at all.

### 2. The image tag must match the installed SDK version

With SDK `0.7.21` against image `0.7.0`, every command failed with

```
Session 'sandbox-...' is not ready or shell has died
```

which reads like a container problem and is not one. They are one protocol split
across a client and a server.

### 3. A dead shell stays dead, and only a fresh container recovers it

Once a sandbox reached that state it failed **forever**, for every caller — the
same id probed from a different Durable Object reproduced it exactly, while a
brand-new id worked first try. U5 now treats the message as recoverable:
`destroy()` and retry exactly once. A second failure is reported rather than
retried into a loop.

Confirmed against the sandbox that had been failing for an hour:

```json
{"ok":true,"result":{"exitCode":0,"stdout":"recovered"}}
```

### 4. Without tool support in the adapter, the model answers in markup

Before the Workers AI adapter sent `tools` and parsed tool calls, the model
still tried — the harness advertises its tools in the system prompt — and
replied with DeepSeek's DSML markup **as prose**, naming the tool and its
arguments in text that nothing downstream parses.

The turn then looked like a normal answer while the agent had actually asked to
run something. The adapter now maps `ToolSchema` to function tools, accumulates
streamed `tool_calls` deltas into `tool-call` blocks, and sends tool results
back as `tool` messages correlated by call id.

### 5. A seam's optional field is not a free-form field

`ShellRunResult.sandbox` is `ShellSandboxInfo` — `{ mode, denied, enforcement?,
runnerFailed? }`, describing OS-level confinement. Filling it with
`{ kind: 'container', id }` failed the seam's own validation:

```
Error: tool "bash" returned invalid output: value is not lossless JSON
```

The field is optional precisely for executors that do not confine in those
terms, so it is now absent.

## A bug of our own, worth recording

`resolve()` computed a timeout and `run()` never applied it. A container that
did not answer held the alarm invocation open until the platform killed it,
which leaves **no `turn/end` in the log and no record in the tail** — the turn
simply stops, with nothing anywhere saying why. `run()` now combines the
caller's signal with `AbortSignal.timeout(spec.timeoutMs)` and reports a timeout
as an ordinary tool result.

## Five seams, one rule

`session-persistence`, `jobs`, `settings`, `shell` and now `credentials` all
behave identically: the abstract base publishes a service whose methods do not
exist, and the concrete provider must be the only thing registered under that
name. The symptoms differ wildly — an explicit message, `this.load is not a
function`, `credentials.resolve is not a function`, a service-name collision —
but the cause and the fix never change.

`packages/cf-credentials-do` fills the last of them: Worker secrets by default
(design 6.5's "default tier"), with a SQLite table for the per-tenant tier that
is still deferred.

> The three items this section used to list — background processes, the fs
> tools, and workspace lifetime — are settled elsewhere. `fs` and the PTY are
> done (`M2-terminal.md`); the container itself is now named from the whole
> Durable Object id, so it is one per USER rather than per session, which is the
> grain design 6.3 wants. What remains of 6.3 is the lease and the hibernation,
> below.

## Cold start, measured — and an earlier note here was wrong

This document used to say "the first command on a new sandbox took long enough
to exceed a 90-second polling window", which read as a cold-start figure. It was
not one. That run was the image/SDK version mismatch above, compounded by a dead
shell; cold start was never involved.

Forcing a fresh container by using a sandbox id that has never been seen:

| | cold | warm |
|---|---:|---:|
| after a redeploy | 3073 ms | 814 ms |
| fresh id | 2908 ms | 826 ms |
| fresh id | 4512 ms | 990 ms |

**Roughly 3–4.5 s cold, 0.8–1.0 s warm.** Using a fresh id is what makes this
repeatable — there is no need to wait out a sleep window to measure it again.

The container sleeps 5 minutes after its last request (`SLEEP_AFTER` in
`units/exec/src/index.mjs`; the SDK's default is 10). So a user who pauses
longer than five minutes pays about three seconds on their next command, and one
who keeps working never sees it.

## Not done

- **Workspace files do not survive the container being recycled**, which makes a
  workspace useful only within the session that created it. Measured the hard
  way: `/workspace` came back empty carrying the image's own build timestamp,
  while the workspace record in Durable Object SQLite still pointed at it. Two
  storage layers, two lifetimes, nothing reconciling them. Design 6.3's lease
  and snapshot hibernation is where that stops being true.
