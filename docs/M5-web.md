# M5 — the web seam

**Date**: 2026-08-17
**Status**: `web_fetch` works. `web_search` does not, and cannot be made to by
this route.

```
POST /api/web-probe?url=https://example.com
  live: { configured: "kitesurf", lastUsed: "rest-kitesurf" }
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

## Kitesurf: adopted, over one wrong turn

Kitesurf is Browser Run's agent-first browser, documented at 3–7× less CPU and
memory than Chromium and 1.7–1.8× slower, free while in beta. Its weaknesses
(video, WebGL, bot-challenge TLS, persistent logins) are all things this seam
does not need — `fetch(url)` is one-shot by contract, and the request type
carries no auth, no cookies and no session.

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
there is — and against controls of 268ms and 311ms, asking for Kitesurf metered
365ms. Above both, where a browser that had actually changed should have moved
the number.

A deployment believing it ran Kitesurf while paying for Chromium would have had
no symptom at all.

### Over REST, where it does work

| transport | metered browser-ms | wall |
|---|---|---|
| kitesurf (REST) | 876, 899 | 1612, 1024ms |
| default (binding) | 136, 489, 297 | 291, 611, 468ms |

The first REST call metered 2140ms and is excluded: it was a cold browser
session, and the row that runs first pays for it. That correction mattered —
2140 against 136 is 14×, and the warm number is 2.9×.

### The comparison above is invalid for cost, and it decided the default anyway

For one release these numbers put the default on the binding. That was wrong,
and the error is worth keeping because it is a subtle one: **the two columns are
not the same kind of number.** Kitesurf is free while in beta, so its metered
milliseconds are a *reading*; the binding's are a *bill*. Subtracting one from
the other answers a question nobody asked. For cost, free beats any positive
number at every volume.

Two supporting arguments were also wrong:

- *"Both are free at this volume anyway"* — the 10 included browser-hours are
  per **account**, and that reasoning quietly assumed this deployment stays a
  one-person demo. It is meant to be self-deployed by strangers and opened to
  their users.
- *"Kitesurf meters 2.9× more, not 3–7× less"* — this contradicts nothing. The
  documented claim is **CPU and memory**; `x-browser-ms-used` is **time**, and
  no CPU or memory figure is observable from inside a Worker at all. The
  measurement never tested what it was cited against.

What the numbers do establish is the latency price: **~2.5× slower per fetch**,
close to the documented 1.7–1.8×. That is what the cheaper road costs.

### The switch

```sh
npx wrangler secret put CF_ACCOUNT_ID
npx wrangler secret put BROWSER_RUN_TOKEN      # permission: Browser Run: Edit
```

Credentials present means Kitesurf: there is no reason to configure a Browser
Run token except to use it. A deployment that would rather pay money than wait
sets `WEB_TRANSPORT=binding` to decline. A deployment with no token has only
the binding, which is why the repo ships no `WEB_TRANSPORT` at all and this
whole section is optional.

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
