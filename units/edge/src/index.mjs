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
import { identify, sessionObjectName } from '../../../packages/cf-identity/src/index.mjs'

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
  hint: 'Protect this Worker with Cloudflare Access (Workers dashboard > Access), '
    + 'or add an access.dev block to wrangler.jsonc for local development.',
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)

    // Everything outside /api is the UI. Assets are public: Access, when
    // configured, has already gated the whole hostname in front of the Worker.
    if (!url.pathname.startsWith(API_PREFIX)) {
      return env.ASSETS.fetch(request)
    }

    const claims = await identify(ctx, env)
    if (!claims) return Response.json(NOT_PROTECTED, { status: 403 })

    if (url.pathname === `${API_PREFIX}/whoami`) {
      return Response.json({
        tenant: claims.tenant, user: claims.user, scopes: claims.scopes,
        email: claims.email, aud: claims.aud,
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
