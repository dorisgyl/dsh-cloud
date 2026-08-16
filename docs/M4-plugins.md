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

## Not done

- **`PluginHost` exposes nothing yet.** `echo` only. Tools are registered
  through `/describe`, so no plugin has needed a harness capability yet; the
  first one that wants to read a file or query the session log is what should
  decide the second method, not a guess.
- **One extension point.** Tools. Registering a seam, an LLM provider or a
  system-prompt section is the same mechanism and none of it is written.
- **No permissions.** Every plugin gets the same (empty) capability face. The
  id is carried but nothing consults it.
- **No signing, no provenance, no versioning beyond a content hash.** Installing
  a plugin means trusting whoever wrote it, and today the only real fence is
  that it has no network.
- **The isolate is per (id, rev)** and the loader's cache is opaque; there is no
  measurement of cold-start cost for a plugin call.
