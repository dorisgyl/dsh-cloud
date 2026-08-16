# Parity with upstream DeepSeek Harness

**Date**: 2026-08-16
**Upstream closure**: 195 packages. **U2 installs**: 97. **Browser plugins**: 34.

Every line below is derived from the repository, not from memory:
`scripts/upstream-closure.json` is the crawled upstream dependency closure,
`scripts/u2-deps.json` is what the agent Worker actually installs, and every
exclusion carries its reason in `scripts/m0-select.mjs`. Reproduce with
`node scripts/m0-select.mjs scripts/upstream-closure.json /tmp/deps.json`.

Status column:

| | |
|---|---|
| **same** | upstream's own package, running unmodified |
| **ours** | replaced by a `cf-*` package behind upstream's seam |
| **no** | deliberately not implemented — reason given |
| **blocked** | the platform does not allow it |

---

## The agent itself

The semantic spine is upstream's, unmodified. This is the whole point of the
port: no fork, no patched copies, no reimplemented agent loop.

| Capability | Status | Note |
|---|---|---|
| Agent loop, turns, steps | same | `dsh-agent-loop` |
| Session model and event log vocabulary | same | `dsh-session` |
| Tool registry, schemas, execution modes | same | `dsh-tools` |
| System prompt assembly | same | `dsh-agent-instructions` |
| Context compaction | same | `dsh-compaction` — **untested** |
| Subagents | same | `dsh-subagent` + spawn provider, depth limit 2 |
| Goals, todos, skills | same | `dsh-goal`, `dsh-tool-todo`, `dsh-skill` |
| Approvals and user questions | same | verified through `POST /api/respond` |
| Jobs / background work | same | `dsh-jobs-local` — "local" is in-process |
| Session projections, titles, telemetry | same | OTel exporter excluded (336 KB, no benefit) |
| Typert RPC contracts | same | referenced statically, never regenerated |

**Zero upstream source is patched.** Three build-time aliases stand in for
module-scope work that workerd forbids, and one rewrite defers a module-scope
`AbortController`. See ADR-04.

## Execution world

| Capability | Status | Note |
|---|---|---|
| `shell` — run a command | ours | `cf-exec-provider/shell` → Cloudflare container |
| `fs` — read / write / edit / list | ours | `cf-exec-provider/fs`, one request per seam call |
| `subprocess.spawnTerminal` — a real PTY | ours | WebSocket to the container's pty |
| `subprocess.spawn` — non-PTY child process | no | the seam is synchronous and returns live streams; there is no honest way to produce that across a service binding |
| Persistent shell (`bash` keeping state) | built, off | works across turns; not the default because the container gives no controlling terminal, so Ctrl-C cannot kill a foreground command |
| Sandbox confinement (landlock / seatbelt) | no | the container **is** the boundary; `sandboxMode` reports undefined rather than claiming a confinement nothing enforces |
| PowerShell | no | no Windows execution world |
| LSP | no | design 5.2: hover/completion over three hops is unusable, and the agent reads code with grep |
| Code interpreter / worker threads | blocked | `node:vm` and `worker_threads` are non-functional stubs on workerd |
| **Workspace files surviving container recycling** | **no** | the container is reclaimed after 5 idle minutes and `/workspace` returns from the image. Design 6.3's lease + snapshot hibernation is not built |

Cold start ≈ 3–4.5 s, warm call ≈ 0.8–1.0 s (`M2-execution-world.md`).

## Tools

13 of upstream's 19 tool packages; 18 tools reach the model.

```
ask_user_question  bash       create_goal  edit      get_goal
interrupt_agent    job_kill   job_list     job_output
read               read_image send_message skill     subagent
update_goal        web_fetch  web_search   write
```

| Not installed | Why |
|---|---|
| `dsh-tool-bash-persistent` | registers the same name as `dsh-tool-bash`; one must win, and the one-shot executor always recovers |
| `dsh-tool-pwsh` | no Windows execution world |
| `dsh-tool-cordis`, `dsh-tool-ralph`, `dsh-tool-workflow` | need a plugin host or an OS shell we do not provide |
| `dsh-tool-fs-search`, `dsh-tool-str-replace-editor` | not published at this upstream version |

`web_search` and `web_fetch` are registered but **untested**; they likely need a
credential this deployment has not been given.

## Model providers

| Capability | Status | Note |
|---|---|---|
| Workers AI (zero-config default) | ours | `cf-llm-transport` — no API key at all |
| DeepSeek official API | same | `dsh-llm-deepseek`, needs `DEEPSEEK_API_KEY` |
| OpenAI-compatible endpoints | same | `dsh-llm-openai` |
| pi-ai / Google GenAI | no | pulls `child_process` through the MCP SDK; 688 KB for one route |
| MCP tool servers | no | the SDK's transport is stdio; MCP over HTTP needs a different client |
| Streaming, tool calls, reasoning effort | same | tool calls required real work in the adapter — the model emitted DSML markup as prose until `tools` was actually sent |
| Image input | no | the bound model is text-only, declared as `inputModalities: ['text']` |

## The web UI

The shell is upstream's compiled build. The **composition** is ours: upstream's
host scans plugin declarations at runtime, and a Worker has no runtime
resolution, so `scripts/build-client.mjs` does the same scan at build time and
injects the graph as `window.__DSH_BOOT__`.

| Capability | Status | Note |
|---|---|---|
| The SPA itself | same | `dsh-web-frontend/dist`, served from the same origin as `/api` |
| Client plugin graph | ours | 34 of 40 browser plugins staged and listed |
| RPC surface 1 — `/api/<name>` | same | `dsh-host-apiproxy`, 52 methods, one of them ours |
| RPC surface 2 — `/api/<ns>/<method>` | same | Typert RPC through `dsh-api-gateway` |
| Event downlinks | ours | WebSockets for the browser, SSE for non-browser clients — upstream ships both client platforms over the same paths |
| Web server / static file host | ours | Workers Static Assets; `node:http` has no equivalent |
| Directory picker | ours | `cf-workspace-picker` serves the `browse` capability over the container; `native` needs a desktop |
| Plugin management panel | partial | the `loader` service and `pluginInventory` are live and served; the list is empty until the tree is composed THROUGH the loader |
| **Third-party plugins** | **ours** | installed into a running deployment, running in isolates with no network; upstream's authoring model, a narrower `ctx` (`M4-plugins.md`) |
| Agent presets | no | `dsh-agent-presets` needs the file loader; `session.create` refuses a preset rather than ignoring it |
| Attachments | ours | `cf-attachments-do` stores images beside the log — **never executed**, because the bound model takes no images |

Verified in a browser: streaming render, turns surviving the tab closing, tool
cards, search, multi-session switching, workspace selection, interrupting a
turn, slash commands, `/export`, `ask_user_question`, subagents.

## Storage and identity

| Capability | Status | Note |
|---|---|---|
| Session log persistence | ours | `cf-session-persistence-do` → Durable Object SQLite |
| Settings | ours | `cf-settings-do` |
| Credentials | ours | `cf-credentials-do` — Worker secrets, plus a SQLite tier |
| Key-value storage | ours | `cf-storage-do` |
| Cross-session search | ours | `cf-session-query-do`, a LIKE scan over this object's log |
| Attachment store | ours | `cf-attachments-do` |
| Workspace registry | same | `dsh-workspace`, with its path validation redirected to the container |
| Identity | ours | `cf-identity` verifies the Cloudflare Access JWT; upstream has an anonymous local id |
| Per-user isolation | ours | one Durable Object and one container per Access user, named from verified claims |
| R2 cold storage for old events | no | ADR-06 plans it; only the hot tier exists |
| Tenant-level settings object | no | design's U3 is not built |

## Runtime composition, and what is still missing from it

"Everything is a plugin" is the upstream core, and it survives here intact: ~90
plugins in the agent Worker, 34 in the browser, every tool and every seam a
plugin row, and not one line of upstream source patched. What did NOT survive
the port was the half where a deployment can **compose** plugins rather than
only run them — `dsh-agent-presets` and the plugin panel both inject `loader`,
and design 10.6 replaced the loader with a compile-time expansion.

`cf-loader` puts the service back. `cordis-plugin-loader` turns out to be 744
lines importing one Node builtin, and its only impossible step is the last one:

```js
if (this.ctx.loader.internal) return this.ctx.loader.internal.import(name, base, {})
else return await import(name)          // impossible on workerd
```

`internal` is an overridable field, so pointing it at the statically expanded
module map makes every plugin row resolve from what is already compiled in —
**runtime composition without runtime code**.

What that buys today: `loader` is live, `dsh-host-plugin-inventory` loads, and
`pluginInventory/list` answers instead of 404.

What it does not buy yet: **the answer is `{entries: []}`**. `loader.entries()`
yields rows the LOADER created, and `cf-boot` still assembles the tree with
direct `ctx.plugin()` calls that bypass it. Making the panel show anything means
composing through the loader — a change to `assemble()`, not to the loader.

The honest description of the ceiling, once that is done: **choose from the
plugins this deployment was built with.** Installing arbitrary third-party code
is a different problem needing a Dynamic Worker and its own security model, and
ADR-09's stated reason for skipping it — that no primitive existed — has expired.

## Ten seams

Upstream's abstract seams, all filled the same way: the base class publishes a
service whose methods do not exist, and the concrete provider must be the only
thing registered under that name.

```
session-persistence   jobs        settings      shell      credentials
fs                    subprocess  sessionQuery  directoryPicker  attachments
```

The last four were not wanted for their own sake — the client protocol does not
load without them.

## Not implemented, listed plainly

- **Workspace durability.** The single biggest gap. A workspace is useful within
  the session that created it.
- **A plugin PLANE.** Third-party plugins work (`M4-plugins.md`), but only for
  tools, with an empty capability face and no permission model.
- **E2B execution tier** (design 10.6.2's third tier).
- **The tenant object** (U3), and with it per-tenant settings and quotas.
- **R2 cold storage** for the session log.
- **Rate limiting, spend caps, admission control.** A public deployment pays for
  whatever it is asked to do.
- **`/compact`**, `web_search`, `web_fetch`: registered, never exercised.
