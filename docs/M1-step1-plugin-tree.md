# M1 step 1 — the Cordis plugin tree assembles inside workerd

**Date**: 2026-08-15
**Baseline**: upstream `@deepseek-ai/*` @ `0.1.0-rc.6`
**Follows**: [M0-findings.md](./M0-findings.md), which proved the packages *import*. This proves they *assemble*.

## Result: the tree comes up

| | |
|---|---|
| modules handed to `assemble()` | 88 |
| registered as plugins | **76** |
| libraries (export no plugin) | 10 |
| deliberately skipped | 2 |
| failed to start | **2** |
| dormant (registered, `inject` unmet) | **0** |
| services published | **30** |
| **time to assemble, in workerd** | **276 ms** |

Node and workerd produce **identical** reports for this step. That is worth stating, because it did *not* hold during M0's import phase — three upstream packages behaved differently there.

The 276 ms is the first real datapoint for M1 acceptance criterion 4 (cold start to first token): assembling the tree is the fixed cost paid on every cold start and after every hibernation wake.

### Services published

```
agentDefaultModel  agentLoop  agents  approval  attachments  commands  compaction
credentials  fs  goals  invariants  llm  sessionPersistence  sessionProjections
sessions  shell  shellEnv  skills  spillStore  storage  subagents  systemPrompt
tokenMeter  toolResultPruner  tools  typert  typertGateway  userQuestions  web
workflowEngine
```

`agentLoop`, `sessions`, `tools`, `llm`, `systemPrompt` and `subagents` are all up — the agent spine is live.

## How it works

Upstream boots by reading `cordis.yml` from disk and resolving plugin specifiers at
runtime through `cordis-plugin-loader`. Neither is available on workerd: there is no
dynamic module resolution, and `node:vm` is a non-functional stub. So the plugin set
is expanded statically at build time (design doc 10.6) into `build/plugins.generated.js`,
and `packages/cf-boot/src/plugin-tree.mjs` registers the lot.

**Registration order does not matter.** Every Cordis plugin declares `inject` — the
services it needs — and stays dormant until all of them exist. The set only has to be
closed under `inject`. Anything still dormant at the end is a genuine gap, which is
what makes this a useful measurement rather than a smoke test.

Assembly runs inside `fetch`, never at module scope: workerd forbids I/O, timers and
random-number generation in global scope, and constructing Cordis services does all
three.

## The five unfilled seams

Each is a real gap, and each has a decision attached.

| Service | Wanted by | Status |
|---|---|---|
| **`storageDomain`** | `dsh-message-feedback`, `dsh-session-projection-cache`, `dsh-workspace` | Needs a **storage backend** plus config naming it. `dsh-storage-domain` does `ctx.inject(backendServices, ...)` where the backend comes from `config.backend`. The only upstream backend is `dsh-storage-json` (fs-based, excluded). **This is exactly `cf-storage-do`** — already in the design's package list, now confirmed as blocking three consumers |
| **`settings`** | the seam itself fails: `this.load is not a function` | `dsh-settings` is a seam with no provider installed; the upstream provider is `dsh-settings-file` (fs, excluded). **This is `cf-settings-do`** — already in the design's list, now confirmed mandatory |
| **`jobs`** | `dsh-tool-jobs` | `dsh-jobs` fails loudly and helpfully: *"is the abstract job registry seam; load an implementation such as `@deepseek-ai/dsh-jobs-local` instead"*. `dsh-jobs-local` uses fs. **Not in the design's cf-* list** — needs a decision: write a provider, or drop the jobs feature from M1 |
| **`loader`** | `dsh-agent-presets` | Provided by `cordis-plugin-loader`, deliberately excluded because the tree is static. **Needs a decision**: drop `dsh-agent-presets`, or have `cf-boot` publish a minimal `loader` shim that resolves only the statically bundled names |
| **`sessionQuery`** | `dsh-session-reference` | Cross-session search is out of scope by design (5.3). `dsh-session-reference` will not activate. Expected; record it rather than fix it |

Two further notes:

- **`sessionTitle` is unexplained.** `dsh-session-title` registers cleanly (`static inject = ["sessions"]`, and `sessions` is up) and does `super(ctx, "sessionTitle")`, yet the service never appears and the plugin is neither dormant nor failed. Its only consumer is `dsh-session-title-first-prompt-llm`. **Open question** — likely a missing config, worth five minutes before M1 proper.
- **Two modules are registered by nobody**, and this is deliberate: `schemastery` (a schema builder whose default export is callable but is not a plugin) and `cordis-plugin-group` (loader-side grouping, expects to be instantiated by `cordis-plugin-loader`).

## Config already required

Two plugins have schemas with required fields and fail without config. These are the
first knobs `cf-settings-do` will feed from `TenantDO`:

```js
'@deepseek-ai/dsh-agent-default-model': { provider: 'deepseek', model: 'deepseek-chat' }
'@deepseek-ai/dsh-agent-instructions':  { maxBytes: 65536 }
```

## Reproduce

```bash
node scripts/m0-bundle.mjs                       # regenerate plugins.generated.js + bundle
cd units/session-do && node m1-assemble.mjs      # assemble under Node (fast iteration)
npx wrangler dev --port 8801 --local             # assemble under workerd (authoritative)
curl http://127.0.0.1:8801/                      # JSON report
```

## Not yet done

This proves the tree stands up and which seams are missing. Still ahead in M1:

- `cf-storage-do` and `cf-settings-do`, the two confirmed blocking seams
- the `SessionAgentDO` class itself — this entry is still a plain Worker
- the session event log on DO SQLite, and `cf-session-persistence-do`
- the alarm-driven turn loop (ADR-11) and the log-recovery entry point it requires
- decisions on `jobs` and `loader`
