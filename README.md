# dsh-cloud

Run [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) on Cloudflare.
Serverless, hibernates when idle, and **keeps working after you close the tab**.

> **Unofficial.** Not affiliated with DeepSeek. This is a third-party port of
> their open-source agent harness to Cloudflare Workers.

Deploy it to **your own** Cloudflare account. You bring the account and the model
key; nothing here asks you to sign up for anything of ours.

---

## Status: work in progress

What runs today, verified against a real deployment:

| | |
|---|---|
| Upstream agent tree assembles inside a Worker | yes — 88 packages, 266 ms |
| Turns run in a Durable Object and survive the client leaving | yes |
| Session log persists to Durable Object SQLite | yes |
| Edge with Cloudflare Access and per-user sharding | yes |
| A real model | yes — Workers AI, no API key |
| Shell — real commands in a Cloudflare container | yes |
| Files — read / write / edit, same execution world as the shell | yes |
| Terminal — a real PTY, state kept across turns | yes, but not the default `bash` (see `docs/M2-terminal.md`) |
| The dsh web UI | yes — served, and its protocol works end to end |
| Workspace files surviving container recycling | **no** — see Limitations |

See `docs/M0-findings.md`, `docs/M1-*.md`, `docs/M2-*.md` and `docs/M3-web-ui.md`
for what each step measured and what it overturned. Several of those documents
correct an earlier conclusion of their own; that is deliberate.

## Limitations

**Workspace files do not survive the container being recycled.** Cloudflare
containers sleep and are reclaimed; `/workspace` then comes back fresh from the
image. Files an agent wrote minutes earlier are simply gone, while the workspace
*record* — which lives in Durable Object SQLite — is still there, pointing at a
directory that no longer exists.

A workspace is therefore useful **within the session that created it** and not
beyond. Design 6.3 plans for this (a lease plus snapshot hibernation, which the
Sandbox SDK's `createBackup`/`restoreBackup` would carry); it is not built. The
web UI here is a demonstration, and this is the limit that matters most when
treating it as more than that.

**Every Access user is isolated, and that part is real.** The edge derives the
Durable Object name entirely from verified Access claims —
`tenant/<tenant>/user/<user>/session/<id>` — so each user gets their own object,
its own SQLite, and its own container. A user cannot address another user's
object: the caller contributes only the session segment, and only inside its own
prefix. Sessions belonging to one user share that user's container deliberately.

**One model, one region, no quotas.** There is no per-user rate limiting, no
spend cap and no admission control. Opening a deployment to the public means
paying for whatever it is asked to do.

## Tiers

Execution is pluggable, and all three tiers are the **same build** — the tier is
decided by which bindings exist, not by which code you compile.

| Tier | Execution backend | You need | Capability |
|---|---|---|---|
| **Minimal** | none | Workers Paid | chat + web tools |
| **Standard** | Cloudflare Containers | + a container image | full shell / files / terminal |
| **Alternative** | E2B | + an E2B key | full shell / files, no Containers |

Only the minimal tier exists today.

## Prerequisites

- **Node 22+, pnpm, wrangler**
- **A Cloudflare account on the Workers Paid plan** (from $5/month)

  The free plan gives each invocation **10 ms of CPU**. A measured agent turn
  against a real model costs **~49 ms**, so a free-plan deployment cannot
  complete even one turn. (A stub model fits in 4–8 ms, which is why the limit
  is easy to miss until something real is wired up.) Cloudflare-hosted DeepSeek
  models are paid-plan only as well.
- A hostname you control. **Do not deploy on `*.workers.dev`** — it is blocked
  outright on some networks, and the failure is invisible from the browser.

## Deploy

```bash
git clone <this repo> && cd dsh-cloud
pnpm install

# Expand the upstream plugin set and bundle both units
node scripts/m0-bundle.mjs
node scripts/build-edge.mjs

# Deploy the session object first — the edge binds to it by name
cd units/session-do && npx wrangler deploy && cd ../..
cd units/edge      && npx wrangler deploy && cd ../..
```

Then protect `dsh-edge` with **Cloudflare Access**. Zero Trust must be enabled
on the account.

> **Use a hostname-based application, not the Worker's Access tab.**
> Worker-level Access policies do not support WebSockets: an upgrade request to
> a Worker protected that way fails with 403. This app is WebSocket-based, so
> Worker-level Access would break it while looking correctly configured.

Create it in **Zero Trust → Access → Applications → Self-hosted**, with your
deployment's hostname as the application domain. Add an `Allow` policy for
whoever should sign in. For machine access — CI, scripted tests — add a second
policy with **Action: Service Auth** and a service token. (The `Service Token`
selector only appears once the action is `Service Auth`, which is easy to miss.)

Then point the edge at that application:

```bash
npx wrangler secret put ACCESS_TEAM_DOMAIN   # <your-team>.cloudflareaccess.com
npx wrangler secret put ACCESS_AUD           # the application's AUD tag
```

The edge verifies the assertion, reduces it to `tenant` / `user` / `scopes`, and
derives every Durable Object name from it — a client never supplies any part of
the name, so it cannot address another user's session. Human logins and service
tokens are both accepted and get separate shards.

There is nothing to configure in code. Access authenticates before the request
reaches the Worker, and the identity arrives as a runtime API:

```js
const identity = await ctx.access.getIdentity()   // undefined if not authenticated
```

So there is no login page to build, no account system to run, and no token to
verify. The edge reduces that identity to `tenant` / `user` / `scopes` and
derives every Durable Object name from it — a client never supplies any part of
the name, so it cannot address another user's session.

## Run it locally

```bash
node scripts/m0-bundle.mjs && node scripts/build-edge.mjs
npx wrangler dev -c units/edge/wrangler.jsonc -c units/session-do/wrangler.jsonc \
  --port 8811 --local --var DEV_IDENTITY:localdev

curl http://127.0.0.1:8811/api/whoami
curl "http://127.0.0.1:8811/api/?q=hello"     # queues a turn
curl http://127.0.0.1:8811/api/state          # watch the log grow
```

`DEV_IDENTITY` exists because Access sits in front of the deployment, not in
front of `wrangler dev`. It is read **only** when Access is unconfigured, so a
deployed instance cannot fall into it by forgetting a flag.

## Cost

Idle cost is close to the Workers Paid floor: Durable Objects do not bill
duration while hibernating, and the only standing cost is stored bytes.

**Idle and working are different things.** While a turn runs — including after
you have closed the tab — it bills duration, CPU, and model tokens. Idle is
nearly free; work costs what work costs.

Precise figures land with M1 and M2; the design keeps them as deliverables
rather than an afterthought.

## Model access

BYOK, in three steps of increasing effort:

1. **Nothing** — Workers AI, no key at all. Cloudflare hosts DeepSeek's own
   models, so the default needs no third-party account. Override with `AI_MODEL`
2. **`wrangler secret put`** at deploy time — the normal path
3. **In the UI**, stored encrypted per tenant — for teams and for switching often

Outbound traffic defaults to AI Gateway, which brings usage and cost visibility
for free. A custom base URL is supported for self-hosted or OpenAI-compatible
endpoints.

## Licence

MIT. See `LICENSE`.
