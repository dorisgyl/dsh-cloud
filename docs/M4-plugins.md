# M4 — third-party plugins

**Date**: 2026-08-16
**Status**: a plugin can be installed into a running deployment and the agent
can call the tools it registers. No redeploy.

```
POST   /api/plugins  {id:"dice", source:"..."}   installed, rev 1disiy
GET    /api/state                                tools include dice__roll_dice
       "roll 3 d20"                              the agent calls it three times
                                                 "rolled 1d20: 5 (total 5)" …
DELETE /api/plugins?id=dice                      the tool is gone, 18 tools
```

The code that produced those rolls was never compiled into the Worker.

## Why this milestone came back

Design 7 was deleted by ADR-09, whose three reasons were: Workers for Platforms
costs $25/month, untrusted mode is a net loss on first-party code, and
in-process plugins are more compatible because they get the whole `ctx`.

Two expired. **Dynamic Workers** is a plain `worker_loaders` binding with no
subscription, and the premise behind the second reason changed: this is an
open-source self-deploy project, so third-party plugins went from a problem
that did not exist to the one being solved.

The third reason did not expire, and it is the price of this road.

## What the boundary costs, precisely

**A plugin does not get upstream's `ctx`.** An isolate cannot hold it. A plugin
gets the extension points this deployment chose to expose, and that set is
literally the method list of one `WorkerEntrypoint` — which is what design 7.2's
"extension point whitelist" turns out to mean. Not a policy: whatever survives
an RPC boundary.

**Re-entry, not residence.** RPC stubs live for one execution context, so a
plugin cannot register once and have its callbacks survive to the next turn.
`apply` is called again on every request — once to describe the plugin, once per
tool call. That is cheap, because `apply` only registers; what is impossible is
keeping it alive.

**The harness renders, the plugin declares.** `output.render` is a function, and
a function cannot come back from `/describe` as data. So a plugin declares the
shape of its result and the harness decides how a result becomes UI blocks.
Upstream's own validator found this, by refusing a tool whose output carried a
schema and no render.

## The authoring model is upstream's

That was the point of choosing this over the two cheaper roads. A plugin is
written the way a Cordis plugin is written:

```js
export function apply(ctx, config) {
  ctx.tools.register({
    name: 'roll_dice',
    description: '…',
    parameters: { sides: { type: 'number', required: true } },
    async execute(args) { return '…' },
  })
}
```

The two roads not taken, and why:

- **Client-side plugins.** The browser graph is already dynamic — a manifest of
  URLs — so third-party *frontend* plugins would have been nearly free and would
  have covered 1189 slot registrations. But they extend a UI product.
- **Container tool plugins.** The container already runs arbitrary code in any
  language, so a convention would have been almost zero work. But they extend a
  container product.

Neither extends *the harness*, and this project is a port of the harness.

## Isolation, measured

`globalOutbound: null`, and verified by attempting a real request from inside a
plugin:

```
network: "blocked: This worker is not permitted to access the internet
          via global functions like fetch"
```

The first version of that probe asked `typeof fetch === 'function'` and reported
`canFetch: true` — a security claim backed by nothing, since the global exists
even when every call throws.

Two more fences:

- **Tool names are namespaced** `<pluginId>__<name>`, so an installed plugin
  cannot take over `bash` by naming a tool `bash`.
- **An installed plugin is not a dependency.** A plugin that fails to load or
  describe is reported in `/state` and the harness boots anyway.

`props` carries the calling plugin's id into every `PluginHost` method, which is
where a permission model attaches when there is a second extension point to
permit.

## What a plugin can register, and what it can ask for

Two different faces, in opposite directions, and conflating them is the most
likely way to misread this design:

| | defined by | direction |
|---|---|---|
| what a plugin can **register** | the `ctx` in `runner.mjs` | plugin declares, harness collects |
| what a plugin can **ask the harness to do** | `PluginHost`'s methods | plugin calls, harness executes |

Today:

```
register   ctx.tools.register        ctx.commands.register    ctx.systemPrompt.section
ask        harness.readFile          harness.writeFile        harness.listDir
           harness.runCommand        harness.echo
```

Capabilities are granted per plugin at install time and default to **none**:

```json
{"id": "notes", "source": "…", "permissions": ["fs:read", "fs:write", "shell"]}
```

A refusal names the missing grant:

```
plugin "notes" was not granted "shell". Reinstall it with permissions: ["shell"]
```

## Against upstream's 44 services

An in-process upstream plugin injects any of ~44 live services. A plugin here
gets 3 registration points and 5 capability methods. The gap is not evenly
spread, and where it falls is the point:

- **Data in, data out** — `fs`, `shell`, `sessionQuery`, `settings`, `storage`,
  `web`, `skills`, `jobs` … roughly 20 services. These cross fine; the work is
  the authorisation, not the transport. Three are done.
- **Registration** — `tools`, `commands`, `systemPrompt`, `sessionProjections`,
  `llm`, `userQuestions` … about 7. These cross as declarations plus a
  re-entrant callback. Three are done. `sessionProjections` would fire per
  event and `llm` needs streams, so both are real work rather than more of the
  same.
- **Live objects and synchronous contracts** — `sessions`, `agents`,
  `agentLoop`, `loader`, `invariants`, `typert`, `terminals`,
  `subprocess.spawn`, and `ctx.effect`. About 12, and they **cannot** cross.

So: **a plugin can extend the harness's periphery and cannot reach its core.**
That is the honest summary of the difference from "everything is a plugin"
upstream — not a smaller number of hooks, but a boundary at the agent loop.

## Two scopes: the deployment's and yours

Verified end to end. `notes` installed once at deployment scope, then a **new
session** — a different Durable Object, its own empty plugin table, no part in
the install — reported:

```
/api/state  tools   ["notes__list_notes", "notes__save_note"]
/api/plugins        {id: "notes", scope: "deployment", rows: 1}
```

The session that performed the install proves nothing on its own: its tree is
dropped and rebuilt by the install itself. A session that was not there is the
only observer whose answer can only have come from the shared object.


A plugin installed through `/api/plugins` was, at first, visible to exactly one
person — and nobody decided that. Session objects are named from verified Access
claims (`tenant/<t>/user/<u>/session/<s>`), so the plugin table is per user by
construction. It surfaced the way this kind of thing does: a plugin installed
with a service token registered its tools and ran, and the same deployment's web
UI listed sixty-eight plugins and not that one. Two objects, two tables, one
install.

Per-user is right for isolation and wrong for provisioning. An operator
installing a plugin means installing it *for the deployment*.

```
POST /api/plugins                      -> this user only
POST /api/plugins?scope=deployment     -> everyone, admins only
GET  /api/plugins                      -> both, each row labelled with its scope
```

Deployment-level plugins live in one more object of the same class, addressed by
a fixed name:

```
tenant/<tenant>/plugins
```

A client cannot reach it. Every object name a request can produce is built out
of claims by U1, and this name is built out of none of them; only a session
object addresses it, server-side, over the `SESSION` binding it already has.
It is design's U3 in miniature — a shared object per tenant — without a new
Worker, a new binding or a new deploy target.

**The user's row wins on id.** An operator provisions `notes` for everyone; a
user who has their own `notes` keeps theirs. The other direction would let a
deployment-wide install silently replace something a user was relying on.

**A store is a store.** `/plugin-store` reads and writes the table without
building the agent tree — one shared object assembling ninety plugins to answer
a list would become the slowest thing in every session's boot.

**An unreadable store does not stop a session.** The fetch is wrapped; a failure
lands in `lateErrors` and the session boots with the user's own plugins. Nothing
in the harness depends on the shared object existing.

### Who may install for everyone

The one operation here that affects other people is the one that needs saying
who may do it:

```sh
echo "you@example.com" | npx wrangler secret put ADMIN_USERS
```

A secret, not a `var`, because a var declared in `wrangler.jsonc` is rewritten on
every deploy and an operator list should survive one. Access subjects or emails,
comma separated; U1 forwards both (`x-dsh-user` is the subject that object names
are built from, `x-dsh-email` is the one a human can type).

**Unset means nobody**, and the refusal says so:

```json
{"error": "deployment-scope-not-configured",
 "hint": "Set ADMIN_USERS ... then redeploy."}
```

The alternative default is "any signed-in user may install code for every other
user of this deployment". That is not something anyone should get by omission.

## Not done
- **No signing, no provenance, no versioning beyond a content hash.** Installing
  a plugin means trusting whoever wrote it, and today the only real fence is
  that it has no network.
- **The isolate is per (id, rev)** and the loader's cache is opaque; there is no
  measurement of cold-start cost for a plugin call.
