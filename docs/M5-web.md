# M5 — the web seam

**Date**: 2026-08-17
**Status**: `web_fetch` works. `web_search` does not, and cannot be made to by
this route.

```
POST /api/web-probe?url=https://example.com
  default (binding)   291ms wall / 136 billed browser-ms
  "---\ntitle: \"Example Domain\"\n---\n\n# Example Domain\n\n..."
```

## The seam that was empty without saying so

`@deepseek-ai/dsh-web` is an abstract seam, the same shape as `dsh-shell` and
`dsh-fs`: it publishes `ctx.web` plus a provider registry, and a concrete
provider must register. `dsh-tool-web` advertises `web_search` and `web_fetch`
to the model over it.

Twelve abstract seams, eleven accounted for — filled, or in `SKIP` with a
recorded reason. This was the twelfth. It loaded, published `ctx.web`, and put
`web_fetch` in every model's tool list **over a fetch provider registry with
nothing in it**. Every call ended in `WEB_PROVIDER_UNAVAILABLE`.

`docs/parity.md` had said both web tools were "registered but untested; they
likely need a credential this deployment has not been given." That was true of
search and wrong about fetch, and the error is worth naming: **it gave two
different failures one explanation.** Search had a provider missing a key. Fetch
had no provider. Only one of those is fixed by pasting a credential.

## No credential needed

`env.BROWSER.quickAction()` is a **binding**. That makes this ADR-12's
zero-configuration default applied a second time: like Workers AI, it works on
`wrangler deploy` with nothing pasted anywhere, where every provider upstream
ships — Exa, Perplexity, DeepSeek search — needs a key the self-deployer has to
go and get.

## Markdown, not HTML

`WebFetchBody` is a closed union of `html | text`, and `dsh-tool-web` runs
turndown over the `html` arm itself. So both roads end at markdown; the
difference is where the conversion happens. `/content` ships raw HTML — scripts,
inline styles, nav chrome, base64 images — into the Durable Object and spends
the object's CPU converting it. This deployment already needs the paid plan for
CPU reasons. `/markdown` lands in the `text` arm, which is accurate rather than
convenient: markdown is text.

## Kitesurf: measured, and not adopted

Kitesurf is Browser Run's agent-first browser, documented at 3–7× less CPU and
memory than Chromium and 1.7–1.8× slower, free while in beta. Its weaknesses
(video, WebGL, bot-challenge TLS, persistent logins) are all things this seam
does not need. It looked like an obvious win.

**The binding cannot select it.** `?browser=kitesurf` is a query parameter, and
the binding has no query string. All three placements it does have were swept:

| placement | result |
|---|---|
| body field | `Unrecognized key: "browser"` — refused |
| action string | `Invalid quick action: markdown?browser=kitesurf` — refused |
| options bag | **accepted, and ignored** |

The two refusals are the safe failures. The third is the dangerous one, and it
is the reason this package is named `cf-web-browser-run` rather than
`cf-web-kitesurf`: the body is validated and the options bag is not, so the one
placement that looked like it worked is the one that silently did not. No
response header names the engine, so billed milliseconds are the only evidence
there is — and against controls of 268ms and 311ms, asking for Kitesurf billed
365ms. Above both, when the documented difference is far below.

A deployment believing it ran Kitesurf while paying for Chromium would have had
no symptom at all.

### Over REST, where it does work

| transport | billed browser-ms | wall |
|---|---|---|
| kitesurf (REST) | 876, 899 | 1612, 1024ms |
| default (binding) | 136, 489, 297 | 291, 611, 468ms |

The first REST call billed 2140ms and is excluded: it was a cold browser
session, and the row that runs first pays for it. That correction mattered —
2140 against 136 is 14×, and the warm number is 2.9×.

**Kitesurf meters ~2.9× MORE, not 3–7× less.** The docs are not wrong; the
mapping was. "3–7× less CPU and memory" is a resource claim, and the meter is
**time**. A browser that uses less CPU and takes longer bills more of it. The
other half of the claim — 1.7–1.8× slower — shows up as ~2.5× and is roughly
right.

Whether those metered milliseconds are actually *charged* during the beta is not
visible from here: `x-browser-ms-used` is reported identically either way. Only
a bill can answer it.

### Why the default stayed on the binding

The Workers Paid plan includes 10 browser-hours per month. At the binding's
~150–300ms per fetch that is on the order of **a hundred thousand fetches a
month** before anything is billed at all. At this deployment's volume both roads
are free, so Kitesurf's beta exemption buys nothing — and costs ~2.5× the
latency on every fetch the model makes.

So the credential does not decide it. `WEB_TRANSPORT` does:

```sh
npx wrangler secret put CF_ACCOUNT_ID          # both are needed by the choice,
npx wrangler secret put BROWSER_RUN_TOKEN      # neither of them makes it
wrangler.jsonc: "vars": { "WEB_TRANSPORT": "kitesurf" }
```

Having a token must not be the same as choosing to use it. Wired the other way,
configuring a credential would have made every model fetch 2.5× slower as a
side effect — which is not a decision anyone would have made on purpose.

A REST failure falls back to the binding rather than failing the fetch, because
a beta service with per-account limits will refuse sometimes and losing a
model's fetch over that is worse. `lastTransport` records which road actually
ran, and `restFallbackReason` records why, because a silent fallback would
recreate the exact bug this package was renamed for.

## `web_search` is not filled

Quick Actions has `/content`, `/screenshot`, `/pdf`, `/markdown`, `/snapshot`,
`/accessibilityTree`, `/scrape`, `/json`, `/links` and `/crawl`. It has no
search. A browser is not a search engine, and no amount of it becomes one.
`web_search` still needs a credentialed provider — `dsh-web-search-deepseek` is
already in the bundle and wants a key.

## Not done
- **Third-party plugins cannot reach the web.** A plugin granted `shell` can
  probably already reach it through the container, which would mean "plugins
  have no network" is conditional rather than true — unmeasured, and named in
  `M4-plugins.md` as such. If it holds, a `web:fetch` capability would *narrow*
  the permission model rather than widen it: today the only way to let a plugin
  read a page is to hand it the whole container.
- **One page, one origin.** Every number here is `example.com`, which is
  trivial to render. The engines' difference should be larger on a page that
  actually needs a browser, and nothing here measures that.
