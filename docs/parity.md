# Parity with upstream DeepSeek Harness

**Date**: 2026-08-22
**Upstream version**: `@deepseek-ai/*` @ `0.1.1-rc.2`
**Upstream closure**: 195 packages. **U2 installs**: 99. **Browser plugins**: 37 of 42.

Every line below is derived from the repository, not from memory:
`scripts/upstream-closure.json` is the crawled upstream dependency closure,
`scripts/u2-deps.json` is what the agent Worker actually installs, and every
exclusion carries its reason in `scripts/m0-select.mjs`. Reproduce with
`node scripts/m0-select.mjs scripts/upstream-closure.json /tmp/deps.json`.

One caveat on the first number: the closure was crawled at `0.1.0-rc.6` and has
not been re-crawled, so packages upstream added since — `dsh-client-ui-reference`,
`dsh-client-ui-brand-official`, `dsh-file-reference`, `dsh-authorization` — are
absent from its count. They are no longer invisible to the roster, though: since
the outage that a stale crawl caused, the browser roster considers whatever a
unit DECLARES as well, so installing a client package is enough for it to be
seen. `dsh-client-ui-renderer` arrived that way and is staged.

What following rc.8 and then 0.1.1 did and did not change is in
`rc8-upgrade.md` and `v011-upgrade.md`.

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
| Context compaction | same | `dsh-compaction-basic`; the ENGINE was missing until 2026-08-17 — still untested |
| Subagents | same | `dsh-subagent` + spawn provider, depth limit 2 |
| Goals, todos, skills | same | `dsh-goal`, `dsh-tool-todo`, `dsh-skill`; `todo_write` was absent until 2026-08-17 |
| Plan mode | same | `exit_plan_mode`; absent until 2026-08-17 |
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

13 of upstream's tool packages; 20 tools reach the model.

```
ask_user_question  bash             create_goal  edit
exit_plan_mode     get_goal         interrupt_agent
job_kill           job_list         job_output
read               read_image       send_message
skill              subagent         todo_write   update_goal
web_fetch          web_search       write
```

| Not installed | Why |
|---|---|
| `dsh-tool-bash-persistent` | registers the same name as `dsh-tool-bash`; one must win, and the one-shot executor always recovers |
| `dsh-tool-pwsh` | no Windows execution world — and rc.8's persistent PowerShell sessions do not change that |
| `dsh-tool-cordis`, `dsh-tool-ralph`, `dsh-tool-workflow` | need a plugin host or an OS shell we do not provide |
| `dsh-tool-fs-search` | needs `subprocess.spawn`, which `cf-exec-provider` refuses on purpose, and a native ripgrep binary |
| `dsh-tool-str-replace-editor` | installable — it needs only `ctx.fs` — and left out as a choice: a second editing interface over the same files as `read`/`write`/`edit` |

Both of the last two used to be listed as "not published at this upstream
version". They are published. The reasons above are the real ones.

`web_fetch` **works**, over `cf-web-browser-run`. `web_search` works only if the
operator configures it, and the two got there by different roads — which the
earlier version of this line got wrong by giving them one:

`dsh-web` is an abstract seam, like `dsh-shell` and `dsh-fs`: it publishes
`ctx.web` and a provider registry, and `dsh-tool-web` advertises both tools over
it. Search had a provider needing a credential. **Fetch had no provider at
all** — so `web_fetch` sat in every model's tool list with every call ending in
`WEB_PROVIDER_UNAVAILABLE`. Of the twelve abstract seams this is the only one
that was empty *without saying so*: the other eleven are filled or in `SKIP`
with a recorded reason.

Filling it needed no credential. `env.BROWSER.quickAction()` is a **binding**,
so this is ADR-12's zero-configuration default applied a second time: like
Workers AI, it works on `wrangler deploy` with nothing pasted anywhere, while
every provider upstream ships (Exa, Perplexity, DeepSeek search) needs a key the
self-deployer has to go get.

**`web_search` has no zero-configuration provider.** Quick Actions has no search
endpoint, and a browser is not a search engine. Fetch runs on Kitesurf, free
while in beta, selected over the REST endpoint because the binding cannot reach
it — `M5-web.md` has the measurements and the one wrong turn they caused.

What search has instead is two optional providers, neither of them on by
default. `TAVILY_API_KEY` registers `cf-web-search-tavily`, which is wired and
never exercised. `WEB_SEARCH_DUCKDUCKGO=1` registers the keyless one, which is
kept for its measurements rather than for its results: DuckDuckGo answers a bot
challenge, and `cf-web-search-duckduckgo` reports that as `WEB_PROVIDER_BLOCKED`
instead of as zero hits.

Upstream 0.1.0-rc.8 made `web_search` a batch tool — a list of queries, run
concurrently, four by default. The keyless provider serialises its own requests
against that, and where it is active `dsh-tool-web` is configured down to two
queries. `rc8-upgrade.md` has the reasoning; the short version
is that a refused batch now costs one request instead of four.

## Model providers

| Capability | Status | Note |
|---|---|---|
| Workers AI (zero-config default) | ours | `cf-llm-transport` — no API key at all |
| DeepSeek official API | same | `dsh-llm-deepseek`, needs `DEEPSEEK_API_KEY`. 0.1.1-rc.2 gave it a Files-API upload cache backed by `node:fs`, `dsh-atomic-write` and `dsh-home-paths` — two of which this deployment skips for having no cloud equivalent. Text calls are unaffected; the image-upload path writes to a disk workerd does not have |
| OpenAI-compatible endpoints | same | `dsh-llm-openai` |
| pi-ai / Google GenAI | no | pulls `child_process` through the MCP SDK; 688 KB for one route |
| MCP tool servers | no | the SDK's transport is stdio; MCP over HTTP needs a different client |
| Streaming, tool calls, reasoning effort | same | tool calls required real work in the adapter — the model emitted DSML markup as prose until `tools` was actually sent |
| Image input | no | the bound model is text-only, declared as `inputModalities: ['text']`. rc.8's `offloadRequestImages` — the bound that keeps accumulated image payloads under a provider limit — is called inside `dsh-llm-deepseek`, so `cf-llm-transport` would have to apply it itself the day a multimodal model is bound here. What it does apply, since 0.1.1, is `projectImagesForTextModel`: an image now reaches the model as a sentence saying it was omitted, where before it was filtered out and the model answered a question with no picture in it |

## The web UI

The shell is upstream's compiled build. The **composition** is ours: upstream's
host scans plugin declarations at runtime, and a Worker has no runtime
resolution, so `scripts/build-client.mjs` does the same scan at build time and
injects the graph as `window.__DSH_BOOT__`.

| Capability | Status | Note |
|---|---|---|
| The SPA itself | same | `dsh-web-frontend/dist`, served from the same origin as `/api` |
| Client plugin graph | ours | 37 of 42 browser plugins staged and listed, plus the boot prelude U1 injects. That prelude is generated from upstream's own injection table (`bootInjections`) rather than written here: the shell carries neither the module loader nor the application mount any more, and a hand-written copy of the protocol is what took the page down twice |
| RPC surface 1 — `/api/<name>` | same | `dsh-host-apiproxy`, 52 methods, one of them ours |
| RPC surface 2 — `/api/<ns>/<method>` | same | Typert RPC through `dsh-api-gateway` |
| Event downlinks | ours | WebSockets for the browser, SSE for non-browser clients — upstream ships both client platforms over the same paths |
| Web server / static file host | ours | Workers Static Assets; `node:http` has no equivalent |
| Directory picker | ours | `cf-workspace-picker` serves the `browse` capability over the container; `native` needs a desktop |
| Plugin management panel | same | read-only, and now real: 69 loader entries, all active |
| **Third-party plugins** | **ours** | installed into a running deployment, running in isolates with no network; upstream's authoring model, a narrower `ctx` (`M4-plugins.md`) |
| Agent presets | no | `dsh-agent-presets` needs the file loader; `session.create` refuses a preset rather than ignoring it. rc.8 builds Profile Bundles on top of it — Claude Code and Codex installed on demand — which needs runtime installation into a container reclaimed after 5 idle minutes |
| Attachments | ours | `cf-attachments-do` stores images beside the log — **never executed**, because the bound model takes no images. Still shape-correct: `npm run check:seams` compares its `imageLimits` against the field list upstream validates it with, which is how rc.8's new `maxImageDimension` was caught before a deploy rather than after one, and how 0.1.1's five new credential methods were. 0.1.1 also added `readImageRequest` (per-route resized variants); it is not abstract, and this provider inherits the base's honest refusal rather than pretending to derive them |
| The `@` reference menu | no | new at rc.8 (`dsh-client-ui-reference`), and it wants `dsh-file-reference` and `dsh-session-reference` in the agent Worker. Absent by omission until the closure is re-crawled, not by decision |

Verified in a browser: streaming render, turns surviving the tab closing, tool
cards, search, multi-session switching, workspace selection, interrupting a
turn, slash commands, `/export`, `ask_user_question`, subagents.

## Storage and identity

| Capability | Status | Note |
|---|---|---|
| Session log persistence | ours | `cf-session-persistence-do` → Durable Object SQLite. rc.8's "the storage format is incompatible" is upstream's own SQLite backend and does not reach here: this is a `PersistenceBackend` over its own DDL, and that interface did not change. No migration, and no share of the speedup either |
| Settings | ours | `cf-settings-do` |
| Credentials | ours | `cf-credentials-do` — Worker secrets, plus a SQLite tier. 0.1.1 split the seam: a reference (`DEEPSEEK_API_KEY`) layers over binding and store, a record (`<scope>/<id>`) does not. Both halves are implemented; `modifyRecord` wants read-modify-write exclusion across processes, which one Durable Object simply is |
| Authorization grants | no | new at 0.1.1. The record half that carries them is implemented, but nothing here starts an authorization — every provider offered takes an API key, and the one upstream consumer of grants is excluded for its own reasons |
| Key-value storage | ours | `cf-storage-do` |
| Cross-session search | ours | `cf-session-query-do`, a LIKE scan over this object's log |
| Attachment store | ours | `cf-attachments-do` |
| Workspace registry | same | `dsh-workspace`, with its path validation redirected to the container |
| Identity | ours | `cf-identity` verifies the Cloudflare Access JWT; upstream has an anonymous local id |
| Per-user isolation | ours | one Durable Object and one container per Access user, named from verified claims |
| R2 cold storage for old events | no | ADR-06 plans it; only the hot tier exists |
| Tenant-level settings object | no | design's U3 is not built |

## Six features that were never running

Composing the plugin tree through the loader (2026-08-17) turned a report of
perfect health into seven failed entries. Direct `ctx.plugin()` registration had
been answering `failed: []`, `pending: []`, `unmet: []` the whole time.

Reading the reasons needed one more thing: Cordis routes a plugin failure to
`ctx.logger.error` and keeps no field for it, so a log sink has to be installed
on the bare context *before anything loads*. On a Worker there is no console to
scroll, so an unread reason is a lost one.

Six of the seven wanted required config that nothing supplied, and therefore did
nothing at all:

| plugin | what was missing from this deployment |
|---|---|
| `dsh-tool-todo` | the `todo_write` tool |
| `dsh-plan-mode` | plan mode and `exit_plan_mode` |
| `dsh-compaction-basic` | the compaction **engine** — only the seam was registered, an eleventh abstract-seam collision |
| `dsh-session-projection-cache` | the cold-read cache |
| `dsh-message-feedback` | feedback notes |
| `dsh-session-title-first-prompt-llm` | model-written session titles (the fallback truncation was doing all the work) |

Upstream ships these with no defaults deliberately — the values are policy, and
a library that guesses policy is worse than one that refuses to start. The
refusal only helps if someone hears it.

Two stay excluded, each for a reason worth keeping:

- **`dsh-agent-tool-presentation`** needs an agent-scoped context (`tools.presentAs()`
  refuses a root one) and belongs with presets.
- **`dsh-permission-presets`** needs a bash executor that confines, and
  `cf-exec-provider` reports no `sandboxMode` precisely because the container is
  the boundary and nothing narrower is enforced inside it. Claiming a mode to
  satisfy this plugin would be the dishonest fix.

47 services, 20 tools, and a boot with nothing in `failed`, `entryErrors` or the
log sink.

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

And composing the whole tree through it (2026-08-17) is what made the panel
real: `pluginInventory` went from `{entries: []}` to 69 rows, every one active. Every
upstream plugin is a loader entry, so the deployment is inspectable as a plugin
tree rather than as an opaque set of fibers — and third-party plugins are merged
into the same list, marked `(<scope>, rev …)` with a null phase, because they
have no fiber and inventing one would be worse than saying so.

The honest description of the ceiling, once that is done: **choose from the
plugins this deployment was built with.** Installing arbitrary third-party code
is a different problem needing a Dynamic Worker and its own security model, and
ADR-09's stated reason for skipping it — that no primitive existed — has expired.

## Plugin scope, which upstream does not have to think about

Upstream runs on one machine for one person, so "installed" needs no qualifier.
Here it does, and the first version got it wrong by omission rather than by
decision: session objects are named from verified Access claims, so the plugin
table is per user by construction. A plugin installed with a service token
registered its tools and ran, while the same deployment's web UI listed
sixty-eight plugins and not that one.

| | upstream | ours |
|---|---|---|
| install for yourself | `~/.dsh/plugins` | `POST /api/plugins` |
| install for everyone | the same directory — there is only one user | `POST /api/plugins?scope=deployment`, `ADMIN_USERS` only |
| where it lives | the filesystem | the session object, or `tenant/<t>/plugins` |
| conflict | there cannot be one | the user's row wins on id |

The shared store is one more Durable Object of the same class under a fixed
name. No client can address it: every object name a request can produce is built
by U1 out of claims, and this one is built out of none of them.

Writes to that scope are gated on `ADMIN_USERS`, a **secret** rather than a
`var` so it survives a deploy. Unset refuses — the alternative default is "any
signed-in user may install code for every other user of this deployment", which
is not something a deployment should acquire by omission. See `M4-plugins.md`.

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
- **A plugin PLANE.** Third-party plugins work (`M4-plugins.md`) — tools,
  commands, prompt sections, a five-method capability face, per-plugin
  permissions, and two scopes. What is missing is signing and provenance:
  installing one is still trusting whoever wrote it.
- **Storage retention**: sessions idle for `SESSION_RETENTION_DAYS` (3) are
  dropped whole, never trimmed event-by-event — the agent replays its log, so a
  truncated one resumes with its beginning missing and says nothing. Storage is
  reported on `/api/usage` rather than capped; retention is what bounds it.
- **E2B execution tier** (design 10.6.2's third tier).
- **The tenant object** (U3), and with it per-tenant settings and quotas.
- **R2 cold storage** for the session log.
- ~~**Rate limiting, spend caps, admission control.**~~ Done, `M6-limits.md`.
  Four meters on a per-USER ledger (requests, model turns, container ms, browser
  ms), because the session segment of an object name is caller-chosen and a
  ledger attached there resets with a query parameter. Admission is a GitHub
  login that has starred the repo — off by default, since a stranger who clones
  this repo inherits its code, not its guest list. What remains: storage is on
  no ledger, and limits are per user with no per-tenant ceiling above them.
- **`/compact`** and **`web_search`**: registered, never exercised. `web_fetch`
  now is — the model fetched the Kitesurf documentation through it and answered
  from the page, including sections and figures that were not in its training
  data. See `M5-web.md`.
- **Attachments**, for the same reason as `web_search`: the code path is filled,
  shape-checked and unrun, because the bound model takes no images.
- **Anything rc.8 added that needs a re-crawled closure.** The `@` reference
  menu is the first of these. Absent by omission is still absent, and this list
  is where that has to be said rather than in the roster's silence.
