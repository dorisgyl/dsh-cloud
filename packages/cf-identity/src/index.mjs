// cf-identity — the edge's single identity convergence point.
//
// The front door is Cloudflare Access (ADR-07): part of the platform, free
// below 50 users, no code, and — decisively — it asks the self-deployer to own
// no account system of ours. Access authenticates before the request reaches
// the Worker.
//
// Workers expose the authenticated identity as a first-class runtime API,
// `ctx.access`, so there is no token to parse:
//
//   * `ctx.access` is `undefined` when Access did not authenticate the request
//   * `ctx.access.getIdentity()` returns the signed-in user's claims
//   * `ctx.access.aud` is the Access application's audience tag
//
// An earlier version of this file verified the `CF_Authorization` JWT by hand
// against the team's JWKS with `jose`. That worked, but it was strictly worse:
// a dependency, a JWKS fetch (a subrequest whenever the cache is cold), two
// configuration values to keep in sync, and a second code path for local
// development that the deployed path never exercised.
//
// `ctx.access` is only available on the entry Worker's `fetch(request, env, ctx)`.
// Inside a Durable Object `ctx` is the object's own state, so identity is
// resolved once at the edge and carried downwards explicitly.

/**
 * Resolve identity for a request from the Access runtime API.
 *
 * Local development uses the same API: `wrangler.jsonc` carries an
 * `access.dev` block that populates `ctx.access` without a login flow, so the
 * local and deployed code paths are identical rather than merely similar.
 *
 * @param ctx the entry Worker's execution context
 * @param env bindings, for the tenant name
 * @returns the internal claim set, or null when Access did not authenticate
 */
export async function identify(ctx, env) {
  if (!ctx?.access) return null
  let identity
  try {
    identity = await ctx.access.getIdentity()
  } catch {
    return null
  }
  return toInternalClaims(identity, { tenant: env?.TENANT, aud: ctx.access.aud })
}

/**
 * Reduce Access's identity to `tenant` / `user` / `scopes`.
 *
 * A self-deployed instance is one tenant, so `tenant` comes from configuration
 * rather than from the identity — a value the user controls must never choose
 * the shard.
 */
export function toInternalClaims(identity, config = {}) {
  const user = identity?.user_uuid || identity?.sub || identity?.email
  if (!user) return null
  return {
    tenant: config.tenant ?? 'default',
    user: String(user),
    scopes: ['session:read', 'session:write'],
    email: identity?.email ?? null,
    aud: config.aud ?? null,
  }
}

/**
 * The three-segment shard name (design 4.4). Derived entirely from claims: a
 * client cannot name someone else's object, because it never supplies any part
 * of this string except the session segment, and only inside its own prefix.
 */
export function sessionObjectName(claims, sessionId) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(sessionId)) {
    throw new Error('invalid session id')
  }
  return `tenant/${claims.tenant}/user/${claims.user}/session/${sessionId}`
}

export function tenantObjectName(claims) {
  return `tenant/${claims.tenant}/user/${claims.user}`
}
