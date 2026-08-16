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

const API_PREFIX = '/api'

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    // Everything outside /api is the UI. Assets are public: Access, when
    // configured, has already gated the whole hostname in front of the Worker.
    if (!url.pathname.startsWith(API_PREFIX)) {
      return env.ASSETS.fetch(request)
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
