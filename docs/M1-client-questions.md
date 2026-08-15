# The three client questions M0 left open

**Date**: 2026-08-15
**Why they mattered**: each could still have invalidated a design decision —
§8.2's count of five UI changes, ADR-04's cap of three patches, and §6.6's
assumption that reconnect costs nothing.

All three are now answered. Two confirm the design; one shows a piece of it is
built against the wrong protocol.

## 1. Does the upstream client run outside a browser?

**Mostly yes, with one real caveat.**

Of 40 `dsh-client-*` packages, 37 reference browser globals — but the
references sit behind guards, and the packages import cleanly under Node:

| import under Node | result |
|---|---|
| `dsh-client-connection` (host face) | **OK** — `HostConnectionService`, `API_PATH`, `MUX_EVENTS_PATH` |
| `dsh-client-runtime` | OK |
| `dsh-client-ui-tool`, `dsh-client-ui-conversation` (host faces) | OK |
| `dsh-goal/remote`, `dsh-commands/remote` (Typert contracts) | **OK** |
| `dsh-client-connection/client` (browser face) | **FAILS** |

The failure is not a browser global. It is an **ESM/CJS cycle**:

```
Cannot require() ES Module .../dsh-client-connection/lib/client.js in a cycle.
```

A bundler resolves that; a bare `import` in Node does not. So §8.4's plan —
automation tests and a CLI drive the same `/remote` clients the browser uses —
holds, with the correction that such a harness has to **bundle** its client the
way the browser build does, not import the package directly. The Typert
contracts themselves, which are the part that could not be replicated, import
fine.

## 2. What happens when the client reconnects mid-turn?

**Upstream already handles it, and the protocol is specific.**

`dsh-client-connection` carries exponential-backoff reconnect, a
`reconnecting` state, per-session replay with at most one in flight, and even a
timing hook for "a history request that was already doomed when reconnect
lands". The downlink vocabulary is explicit:

```js
{ type: "session/subscribed", sessionId, lastSeq }    // subscription ack
{ type: "session/event",      sessionId, event, view? }  // one event pushed
{ type: "approval/requested", sessionId, approvalId, toolName, ... }
```

§6.6's assumption that reconnect is free therefore holds — **for the client**.

### But our host side is built against the wrong protocol

`SessionAgentDO` currently answers a new WebSocket by sending the **entire log**
in one custom `{ type: 'replay', events: [...] }` message. That was flagged in
the growth measurement as wasteful (~6 MB at 12,565 events). It is worse than
wasteful: **the real client does not speak it.** The contract is
subscribe → `lastSeq` → incremental `session/event` pushes.

This does not change the design — §5.4 already has `host/webserver` as
"discard, write our own" — but it does size that work. What has to be built is a
message vocabulary, not a socket that dumps state.

## 3. Does the UI render tool panels from the registry, or hardcode them?

**From the registry — and the minimal tier therefore needs no UI change at all.**

Each tool row is its own Cordis plugin registering into a keyed slot:

```js
ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
  name: "tool.call.toolview",
  key: "bash",
  locale: CONVERSATION_NS
}, BashRow))
```

The key is the **tool name**. A tool that is not registered produces no tool
calls, so its key is never looked up and its row never renders. Nothing needs to
detect the tier or hide anything.

This removes the possible sixth UI change flagged in M1 ①. **§8.2 stays at five
changes and ADR-04's budget of three patches is not touched.**

It also confirms §8.1's mechanism at the level it matters: the client is a
plugin tree, and changing what it shows is changing which plugins load — not
patching upstream.

## Net effect on the design

| | |
|---|---|
| §8.2 — five UI changes | **confirmed**, the sixth does not exist |
| ADR-04 — three patches | **confirmed**, unspent |
| §6.6 — reconnect is free on the client | **confirmed** |
| §8.4 — Node harness drives `/remote` | confirmed, with a bundling caveat |
| `SessionAgentDO`'s replay-on-connect | **wrong protocol**, to be replaced by subscribe/lastSeq/push |
