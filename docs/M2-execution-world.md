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

## Not done

- **Background processes** (`start`), and with them the terminal seam and
  `dsh-tool-bash-persistent`.
- **The fs tools.** The seam's granularity is now known and the provider pattern
  is proven; `dsh-tool-fs`, `dsh-tool-fs-search` and `dsh-tool-str-replace-editor`
  need the `fs` provider written the same way as `shell`.
- **Workspace lifetime.** One sandbox per session today. Design 6.3 wants a
  workspace that outlives its session, with a lease and snapshot hibernation;
  that changes only the sandbox id and the code around it.
- **Cold start.** The first command on a new sandbox took long enough to exceed
  a 90-second polling window. It is not measured, and it is what a user feels
  first.
