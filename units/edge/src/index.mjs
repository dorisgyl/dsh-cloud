// U1 dsh-edge — the only unit that faces the public internet.
//
// It does four things and deliberately nothing else: serve the static UI,
// resolve identity, derive the shard name from the resulting claims, and hand
// the request to the session object. No agent logic lives here; that keeps the
// public surface small enough to reason about.
//
// Static assets and the API share one Worker on one origin (design 8.3), which
// removes the entire CORS and cross-origin WebSocket problem rather than
// configuring around it.
import { identify, isConfigured, sessionObjectName } from '../../../packages/cf-identity/src/index.mjs'
import BOOT_HEAD from '../build/boot-head.json'

const API_PREFIX = '/api'

// The UI transport is implemented in U2, and it is BOTH shapes over one set of
// paths. dsh-client-connection ships two client platforms: AbstractApiClient
// reads /api/events.mux and /api/events.host as Server-Sent Events (the CLI and
// automation entry, design 8.4), and WebApiClient — the browser — opens them as
// WebSockets. U2 serves each accordingly.
//
// U1 has nothing special to do for either: both forward like any other API path,
// and the upgrade passes through because the edge never terminates it.

/** A session id the caller may choose, but only within its own shard. */
function sessionIdFrom(url) {
  return url.searchParams.get('session') ?? 'default'
}

// `ctx.access` being undefined means Access did not authenticate the request —
// which is either "not signed in" or "this deployment is not protected at all".
// The second is a deployment mistake, not a user error, and answering it with a
// bare 401 wastes the self-deployer's afternoon.
/** Key names only, never values: this goes into an error a stranger can read. */
function shapeOf(value, depth = 2) {
  if (value === null || typeof value !== 'object') return typeof value
  if (Array.isArray(value)) return `array(${value.length})`
  if (depth === 0) return 'object'
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shapeOf(v, depth - 1)]))
}

/**
 * The two conditions, in the order that makes the operator's life possible.
 *
 * Admins first, and unconditionally. The repo this deployment gates on has
 * zero stars, so turning the gate on without a bypass locks out everyone
 * including whoever turned it on -- and an operator's way back in should not
 * depend on a click that can be undone by another click.
 */
async function admit(request, env, claims) {
  // ADMISSION_BYPASS_USERS, not ADMIN_USERS.
  //
  // One name was gating two unrelated powers: who may skip the star check
  // (here) and who may install a plugin for every user of the deployment (the
  // session object). An operator can easily want different answers -- this
  // deployment's owner wants their own GitHub account subject to the star
  // gate, precisely so the gate stays honest, while still being the only
  // person who can install plugins.
  //
  // Empty by default, and that is not a placeholder. Login is GitHub-only
  // here, so any bypass entry is a GitHub account that skips the gate
  // permanently -- and the operator's escape hatch is `wrangler secret delete
  // ADMISSION_REQUIRE_STAR` from their own terminal, which no misconfiguration
  // of this list can take away.
  const bypass = String(env.ADMISSION_BYPASS_USERS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (bypass.length && (bypass.includes(claims.user) || (claims.email && bypass.includes(claims.email)))) {
    return { ok: true, via: 'ADMISSION_BYPASS_USERS' }
  }

  const token = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(request.headers.get('cookie') ?? '')?.[1]
  if (!token) return { ok: false, reason: 'no CF_Authorization cookie, so no identity to resolve' }

  let identity
  try {
    const response = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/get-identity`, {
      headers: { cookie: `CF_Authorization=${token}` },
      signal: AbortSignal.timeout(5000),
    })
    identity = await response.json()
  } catch (error) {
    // Refused, not admitted. This gate exists to keep strangers off a paid
    // agent; an identity service that is down is not a reason to open it.
    return { ok: false, reason: `could not read the Access identity: ${String(error?.message ?? error)}` }
  }

  // The whole identity, not a field picked out of it.
  //
  // The first version read the login from a named key, and Cloudflare
  // documents that `get-identity` returns an `idp` block without documenting
  // its shape per provider -- so the key was a guess, and the gate could not be
  // switched on until somebody logged in and read it back. That is a feature
  // waiting on a measurement it does not actually need.
  //
  // The gate's question is not "what is this person's login" but "does this
  // identity belong to a stargazer", and that can be answered without knowing
  // which key holds the answer. cf-admission collects every login-shaped string
  // and asks whether any is in the set; the set is what keeps it safe, and the
  // matched candidate is reported so the answer stays auditable.
  const admission = env.SESSION.get(env.SESSION.idFromName(`tenant/${claims.tenant}/admission`))
  const verdict = await admission.fetch('http://session/admission', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-tenant': claims.tenant },
    body: JSON.stringify({ identity }),
  }).then((r) => r.json()).catch((error) => ({ ok: false, reason: String(error?.message ?? error) }))

  // The shape only when refused, and key names only: an operator needs them to
  // see what the identity looked like, and a stranger reading a 403 must not
  // receive somebody else's email address.
  return {
    ...verdict,
    repo: env.GITHUB_REPO || 'dorisgyl/dsh-cloud',
    ...(verdict.ok ? {} : { identityShape: shapeOf(identity) }),
  }
}

/** The SPA document, which is the only static path worth an identity lookup. */
function isDocumentPath(pathname) {
  return pathname === '/' || pathname === '/index.html'
}

/**
 * A page, not a JSON body: whoever sees this typed a URL into a browser.
 *
 * It names the repo and the reason, because the whole point of this gate is
 * that it is passable -- somebody refused here should be able to tell what to
 * do about it without reading a status code.
 */
function refusalPage(verdict, env) {
  const repo = env.GITHUB_REPO || 'dorisgyl/dsh-cloud'
  const escape = (text) => String(text ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Not admitted</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.5rem;color:#222}
code{background:#f4f4f5;padding:.15em .4em;border-radius:.25em}a{color:#0b6}</style>
<h1>Not admitted</h1>
<p>${escape(verdict.reason ?? 'this account cannot use this deployment')}</p>
<p style="color:#666;font-size:.9em">The list currently holds
${Number(verdict.stargazers ?? 0)} stargazer(s)${verdict.refreshedAt ? `, last read ${escape(new Date(verdict.refreshedAt).toISOString())}` : ' and has never loaded'}.
A star given just now takes up to a minute to appear here.</p>
<p>This deployment is open to people who have starred
<a href="https://github.com/${escape(repo)}">${escape(repo)}</a>. Star it and reload;
the list refreshes every few minutes.</p>`,
    { status: 403, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } },
  )
}

const NOT_PROTECTED = {
  error: 'access-not-configured',
  hint: 'Set ACCESS_TEAM_DOMAIN and ACCESS_AUD from a hostname-based Cloudflare '
    + 'Access application (Zero Trust > Access > Applications > Self-hosted), '
    + 'or DEV_IDENTITY for local development.',
}

/** Only the SPA document gets rewritten; every other asset passes through. */
function isIndexHtml(response) {
  return response.ok && (response.headers.get('content-type') ?? '').startsWith('text/html')
}

/**
 * Inject the boot protocol, and fix the one link that Access breaks.
 *
 * The fragment is generated at build time by upstream's own
 * `injectBootManifest` (see scripts/build-client.mjs) rather than written here.
 * It used to be written here, as one script tag setting `window.__DSH_BOOT__`,
 * and that was the entire protocol until upstream 0.1.0-rc.8 -- which lifted
 * the module loader out of the shell and made the boot protocol three ordered
 * pieces. The page went blank on "window.__ModuleLoader__ bootstrap facade is
 * missing" and no check in this repository was looking at a browser.
 *
 * `<link rel="manifest">` is fetched WITHOUT credentials by default, so the
 * cookie Access set never goes with it; Access then redirects the request to its
 * login origin and the browser reports a CORS failure on a page that is signed
 * in and working. `use-credentials` sends the cookie and the redirect never
 * happens. Harmless on its own, but it is the loudest thing in the console and
 * it points away from the real problem.
 */
function withBootManifest(response) {
  return new HTMLRewriter()
    .on('head', {
      element(head) {
        head.prepend(BOOT_HEAD.html, { html: true })
      },
    })
    .on('link[rel="manifest"]', {
      element(link) { link.setAttribute('crossorigin', 'use-credentials') },
    })
    .transform(response)
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    // An unprotected deployment serves nothing, not even the shell.
    //
    // The 503 below existed only on /api, so a deployment with no Access
    // application answered `access-not-configured` to its API and served its
    // entire UI to the internet. Found by deploying this repository from a
    // clean clone, which is the only way it could have been: every existing
    // deployment has Access configured, so the unconfigured path had never run
    // anywhere.
    //
    // The same shape as the admission gate one commit earlier -- the assets
    // branch runs before every check, so any guard written after it guards
    // nothing that a browser actually loads.
    //
    // This stops the document and the API. It does NOT stop the other ~120
    // static files: `run_worker_first` lists two paths, so everything else is
    // answered by the asset server before this Worker runs, and no check here
    // can reach them. Listing them all would buy a Worker invocation per
    // stylesheet to protect compiled artifacts that are already in the public
    // repository -- and with Access configured, which is the only supported
    // state, Access gates the hostname ahead of all of it.
    if (!isConfigured(env)) {
      return Response.json(NOT_PROTECTED, {
        status: 503,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      })
    }

    // The gate, before the document.
    //
    // It used to live inside the /api branch below, which meant the entire UI
    // loaded for anyone Access authenticated: the app appeared, navigated, and
    // failed only when it called an API. Nothing chargeable is behind a static
    // file, so the bill was safe and the door was not -- and a door that looks
    // open is a wrong answer regardless of what it protects.
    //
    // Checked for the DOCUMENT and for /api, not for the other 120 static
    // files. Each check costs a `get-identity` round trip, and a stylesheet
    // fetched by a page that was already refused buys nothing.
    if (env.ADMISSION_REQUIRE_STAR === '1' && isDocumentPath(url.pathname) && isConfigured(env)) {
      const claims = await identify(request, env)
      if (!claims) return new Response('unauthorized', { status: 401 })
      if (claims.kind === 'user') {
        const verdict = await admit(request, env, claims)
        if (!verdict.ok) return refusalPage(verdict, env)
      }
    }

    // Everything outside /api is the UI. Assets are public: Access, when
    // configured, has already gated the whole hostname in front of the Worker.
    if (!url.pathname.startsWith(API_PREFIX)) {
      const response = await env.ASSETS.fetch(request)
      // Whether the Worker saw this request at all, and what it decided. Asset
      // requests can short-circuit to the asset server before the Worker runs,
      // and when that happens a rewrite here simply does not occur — no error,
      // no log, an unchanged page.
      const trace = new Headers(response.headers)
      trace.set('x-dsh-edge', isIndexHtml(response) ? 'rewriting' : `passthrough:${response.status}:${response.headers.get('content-type') ?? 'none'}`)
      // The shell needs its plugin graph pushed into the page.
      //
      // dsh-web-frontend ships the compiled SHELL and nothing else — its
      // dependencies are react, react-dom and dsh-client-web, not one
      // dsh-client-* plugin — and its README is explicit that "composition is
      // entirely the host graph's". Served verbatim, index.html throws
      // "window.__DSH_BOOT__ is missing or not an object" before rendering a
      // pixel, which is precisely what it did.
      if (isIndexHtml(response)) return withBootManifest(new Response(response.body, { status: response.status, headers: trace }))
      return new Response(response.body, { status: response.status, headers: trace })
    }

    // Distinguish the two ways identity can be missing. They are different
    // problems with different fixes, and answering both with one 403 sent this
    // deployment on a long detour.
    // Two different problems with two different fixes: an unprotected
    // deployment, and a request that simply is not signed in. Answering both
    // with one 403 sent this deployment on a long detour.
    if (!isConfigured(env)) return Response.json(NOT_PROTECTED, { status: 503 })

    const claims = await identify(request, env)
    if (!claims) return Response.json({ error: 'unauthorized' }, { status: 401 })

    // What the JWT does not carry.
    //
    // Admission is to be "logged in with GitHub, and that account has starred
    // the repo", and the second half needs a GitHub LOGIN. The application
    // token has `email`, `sub`, `identity_nonce` and nothing else identifying;
    // the full identity lives behind a second call, and the documentation does
    // not say what an `idp` block looks like for GitHub specifically.
    //
    // So this dumps it rather than assuming a field name. Writing
    // `identity.idp.github_login` from memory and shipping it is how a gate
    // ends up admitting everyone or no one, silently, depending on which way
    // the undefined compares.
    if (url.pathname === `${API_PREFIX}/identity-probe`) {
      const cookie = request.headers.get('cookie') ?? ''
      const token = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie)?.[1]
      if (!token) {
        return Response.json({
          error: 'no-cf-authorization-cookie',
          hint: 'a service token has no identity to look up; open this in a signed-in browser',
        }, { status: 400 })
      }
      const response = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/get-identity`, {
        headers: { cookie: `CF_Authorization=${token}` },
      })
      const identity = await response.json().catch(() => null)
      return Response.json({
        status: response.status,
        // The whole thing. Which field carries a GitHub login is the question,
        // and a filtered answer cannot answer it.
        identity,
        jwtClaims: { tenant: claims.tenant, user: claims.user, email: claims.email, kind: claims.kind },
      })
    }

    // Which build is answering.
    //
    // "Is my change live" came up repeatedly, and once the answer was no while
    // every symptom said yes: a build failed, `wrangler deploy` ran anyway
    // because the shell chain did not stop, and the old bundle stayed up. A
    // deployment that cannot name its own routes cannot answer that question,
    // and every diagnosis after it is guesswork about the wrong code.
    if (url.pathname === `${API_PREFIX}/version`) {
      return Response.json({
        unit: 'dsh-edge',
        routes: ['/api/version', '/api/identity-probe', '/api/whoami', '/api/usage', '(everything else forwards to the session object)'],
        admission: {
          enabled: env.ADMISSION_REQUIRE_STAR === '1',
          repo: env.GITHUB_REPO || 'dorisgyl/dsh-cloud',
          bypassUsers: String(env.ADMISSION_BYPASS_USERS ?? '').split(',').filter(Boolean).length,
        },
      })
    }

    // What the gate decides, and by which route -- without enforcing it.
    //
    // Needed because the two ways in are indistinguishable from outside: an
    // operator who is in ADMIN_USERS is admitted whether or not they have
    // starred anything, so "I got in" proves nothing about the star check.
    // `via` is the field that separates them.
    if (url.pathname === `${API_PREFIX}/admission-check`) {
      const verdict = await admit(request, env, claims)
      return Response.json({
        enforced: env.ADMISSION_REQUIRE_STAR === '1',
        verdict,
        note: verdict.via === 'ADMIN_USERS'
          ? 'admitted by the operator bypass, NOT by a star. Remove yourself from ADMIN_USERS, or use another GitHub account, to exercise the star requirement.'
          : 'this is the star check answering.',
      })
    }

    // What the gate decides, and by which route -- without enforcing it.
    //
    // Two reasons this is not just "turn it on and see". Turning it on locks
    // out whoever is currently signed in if they do not pass, which is a poor
    // way to learn that they do not. And the two ways in are indistinguishable
    // from outside: an operator in ADMIN_USERS is admitted whether or not they
    // have starred anything, so "I got in" says nothing about the star check.
    // `via` is the field that separates them.
    if (url.pathname === `${API_PREFIX}/admission-check`) {
      const verdict = await admit(request, env, claims)
      return Response.json({
        enforced: env.ADMISSION_REQUIRE_STAR === '1',
        wouldAdmit: verdict.ok,
        verdict,
        note: verdict.via === 'ADMIN_USERS'
          ? 'admitted by ADMISSION_BYPASS_USERS, NOT by a star -- this says nothing about the star check'
          : 'this is the star check answering',
      })
    }

    if (url.pathname === `${API_PREFIX}/whoami`) {
      return Response.json({
        tenant: claims.tenant, user: claims.user, kind: claims.kind,
        email: claims.email, scopes: claims.scopes,
      })
    }

    // The object name is built entirely from verified claims; the caller
    // contributes only the session segment, and only inside its own prefix.
    // A client therefore cannot address another tenant's or user's object.
    let name
    try {
      name = sessionObjectName(claims, sessionIdFrom(url))
    } catch (error) {
      return Response.json({ error: String(error.message) }, { status: 400 })
    }

    // Admission: a GitHub login that has starred the repo.
    //
    // OFF unless ADMISSION_REQUIRE_STAR is set, and that default is not
    // timidity. A stranger who clones this repository and deploys it inherits
    // its code, not its guest list -- their repo is not dorisgyl/dsh-cloud, and
    // a gate that checks somebody else's stargazers is an absurd default for an
    // open-source project.
    // Exempt: the routes that explain the refusal.
    //
    // A gate that also hides its own diagnostics locks out the person best
    // placed to fix it, and does so precisely when something is wrong. These
    // read; they spend nothing; and the stargazer list they expose is public
    // data on github.com. Being refused must not mean being unable to find out
    // why.
    const DIAGNOSTIC = ['/admission-check', '/admission-state', '/version', '/whoami', '/identity-probe']
      .map((p) => `${API_PREFIX}${p}`)
    if (env.ADMISSION_REQUIRE_STAR === '1' && claims.kind === 'user' && !DIAGNOSTIC.includes(url.pathname)) {
      const verdict = await admit(request, env, claims)
      if (!verdict.ok) {
        return Response.json({ error: 'not-admitted', ...verdict }, { status: 403 })
      }
    }

    // The cached stargazer list itself, and a way to refresh it now.
    //
    // The list has a TTL, so a star given a minute ago is not in it yet, and
    // "I starred it and still cannot get in" has two very different causes --
    // a stale cache and a failed match -- that look identical from a refusal.
    if (url.pathname === `${API_PREFIX}/admission-state`) {
      const admission = env.SESSION.get(env.SESSION.idFromName(`tenant/${claims.tenant}/admission`))
      const response = await admission.fetch('http://session/admission-state' + url.search, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-dsh-tenant': claims.tenant },
        body: '{}',
      })
      return new Response(response.body, { status: response.status, headers: { 'content-type': 'application/json' } })
    }

    // The cheap meter, checked before anything expensive is reached.
    //
    // At the edge rather than in the session object, because the thing it
    // guards against is a flood of REQUESTS, and a flood that has already
    // reached a Durable Object has already woken it, built its tree, and
    // started its container. It is also the only guard that catches
    // `?session=1,2,3...`: the session id is caller-chosen, so each value is a
    // different object with its own everything -- but they all share one user.
    //
    // Skipped for the ledger's own routes, which would otherwise spend the
    // budget they exist to report.
    if (!url.pathname.startsWith(`${API_PREFIX}/usage`)) {
      const ledgerId = env.SESSION.idFromName(`tenant/${claims.tenant}/user/${claims.user}`)
      try {
        const verdict = await env.SESSION.get(ledgerId).fetch('http://session/budget/check', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-dsh-tenant': claims.tenant },
          body: JSON.stringify({ meter: 'requests', amount: 1, consume: true }),
          signal: AbortSignal.timeout(3000),
        }).then((r) => r.json())
        if (verdict?.ok === false) {
          return Response.json({ error: 'rate-limited', ...verdict }, {
            status: 429,
            headers: { 'retry-after': String(Math.max(1, Math.ceil((Date.parse(verdict.resetsAt) - Date.now()) / 1000))) },
          })
        }
      } catch {
        // Admitted, not refused. A ledger that cannot be reached is an outage
        // of the accounting; refusing every request during one turns a
        // metering fault into a total outage, which is the worse failure.
      }
    }

    const stub = env.SESSION.get(env.SESSION.idFromName(name))

    // Forward verbatim, including a WebSocket upgrade: the session object owns
    // the socket for its whole life, so the edge must not terminate it.
    const forwarded = new Request(
      new URL(url.pathname.slice(API_PREFIX.length) + url.search, 'http://session'),
      request,
    )
    forwarded.headers.set('x-dsh-tenant', claims.tenant)
    forwarded.headers.set('x-dsh-user', claims.user)
    // The email is not identity here -- `user` is, and object names are built
    // from it. This is carried only so a human-readable operator list is
    // possible: `claims.user` is an Access subject UUID, and asking a
    // self-deployer to paste one into their config to name themselves an admin
    // is a worse door than their own address.
    if (claims.email) forwarded.headers.set('x-dsh-email', claims.email)
    return stub.fetch(forwarded)
  },
}
