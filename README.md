# dsh-cloud

Run [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) on Cloudflare.
Serverless, hibernates when idle, and **keeps working after you close the tab**.

> **Unofficial.** Not affiliated with DeepSeek. This is a third-party port of
> their open-source agent harness to Cloudflare Workers.

Deploy it to **your own** Cloudflare account. You bring the account and the model
key; nothing here asks you to sign up for anything of ours.

---

## Status: work in progress

M1 is partly done. What runs today, verified in real workerd:

| | |
|---|---|
| Upstream agent tree assembles inside a Worker | yes — 88 packages, 266 ms |
| One agent turn runs inside a Durable Object | yes |
| Session log persists to Durable Object SQLite | yes |
| Turns survive the client disconnecting | yes — `scripts/m1-disconnect-demo.mjs` |
| Edge with Cloudflare Access and per-user sharding | yes |
| A real model | yes — Workers AI, no API key |
| Shell / files / terminal | **not yet** — that is M2 |
| The dsh web UI | **not yet** — the edge serves a placeholder |

See `docs/M0-findings.md` and `docs/M1-step*.md` for what each step measured and
what it overturned.

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

Then put **Cloudflare Access** in front of the hostname (Zero Trust → Access →
Applications), and set two vars on `dsh-edge`:

```bash
npx wrangler secret put ACCESS_TEAM_DOMAIN   # <your-team>.cloudflareaccess.com
npx wrangler secret put ACCESS_AUD           # the Access application's AUD tag
```

Access gates the hostname before any request reaches the Worker, so there is no
login page to build and no account system to run. The edge verifies the
assertion, reduces it to `tenant` / `user` / `scopes`, and derives every Durable
Object name from those claims — a client never supplies any part of the name, so
it cannot address another user's session.

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
