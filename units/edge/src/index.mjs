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
import BOOT_MANIFEST from '../build/boot-manifest.json'

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
 * Inject the boot manifest, and fix the one link that Access breaks.
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
        head.prepend(
          `<script>window.__DSH_BOOT__ = ${JSON.stringify(BOOT_MANIFEST).replaceAll('<', '\\u003c')}</script>`,
          { html: true },
        )
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

    const stub = env.SESSION.get(env.SESSION.idFromName(name))

    // Forward verbatim, including a WebSocket upgrade: the session object owns
    // the socket for its whole life, so the edge must not terminate it.
    const forwarded = new Request(
      new URL(url.pathname.slice(API_PREFIX.length) + url.search, 'http://session'),
      request,
    )
    forwarded.headers.set('x-dsh-tenant', claims.tenant)
    forwarded.headers.set('x-dsh-user', claims.user)
    return stub.fetch(forwarded)
  },
}
