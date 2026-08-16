// cf-identity — the edge's single identity convergence point.
//
// The front door is Cloudflare Access (ADR-07): part of the platform, free
// below 50 users, and — decisively — it asks the self-deployer to own no
// account system of ours.
//
// It must be a **hostname-based** Access application, not a Worker-level one,
// because Worker-level policies do not support WebSockets and this app's entire
// public surface is WebSockets. That constraint decides how identity arrives:
//
//   * Worker-level Access populates `ctx.access` and needs no token parsing —
//     but breaks WebSocket upgrades with a 403.
//   * Hostname-based Access leaves `ctx.access` **undefined** and forwards a
//     signed assertion in `Cf-Access-Jwt-Assertion`, which the Worker verifies.
//
// Both were measured against a live deployment, not assumed. `ctx.access` is
// the nicer API and does not apply to us.
import { createRemoteJWKSet, jwtVerify } from 'jose'

const HEADER = 'cf-access-jwt-assertion'

// createRemoteJWKSet caches fetched keys internally; cache the set per team so
// a burst of requests does not refetch.
const jwks = new Map()
function keysFor(teamDomain) {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`
  let set = jwks.get(url)
  if (!set) {
    set = createRemoteJWKSet(new URL(url))
    jwks.set(url, set)
  }
  return set
}

/**
 * Reduce a verified Access assertion to `tenant` / `user` / `scopes`.
 *
 * Access issues two shapes, and they differ in every field that matters:
 *
 *   human   { sub: "<uuid>", email: "you@example.com", type: "app" }
 *   service { sub: "",       email: absent,            type: "app",
 *             common_name: "<client-id>.access" }
 *
 * A service token authenticates a machine, so it has no e-mail and an empty
 * subject; its identity is the token's client id. Mapping it to a `user` keeps
 * automation inside its own shard instead of borrowing a person's.
 *
 * `tenant` comes from configuration, never from the token: a value the caller
 * controls must not choose the shard.
 */
export function toInternalClaims(payload, config = {}) {
  const service = !payload.sub && Boolean(payload.common_name)
  const user = service ? payload.common_name : (payload.sub || payload.email)
  if (!user) return null
  return {
    tenant: config.tenant ?? 'default',
    user: String(user),
    kind: service ? 'service' : 'user',
    email: payload.email ?? null,
    scopes: ['session:read', 'session:write'],
    exp: payload.exp ?? null,
  }
}

/**
 * Resolve identity for a request.
 *
 * `DEV_IDENTITY` covers local development, where no Access sits in front of
 * `wrangler dev`. It is ignored whenever Access is configured, so a deployed
 * instance cannot fall back into it by leaving a variable set.
 */
export async function identify(request, env) {
  const teamDomain = env?.ACCESS_TEAM_DOMAIN
  const aud = env?.ACCESS_AUD

  if (teamDomain && aud) {
    const token = request.headers.get(HEADER)
    if (!token) return null
    try {
      const { payload } = await jwtVerify(token, keysFor(teamDomain), {
        issuer: `https://${teamDomain}`,
        audience: aud,
      })
      return toInternalClaims(payload, { tenant: env.TENANT })
    } catch {
      return null
    }
  }

  if (env?.DEV_IDENTITY) {
    return {
      tenant: env.TENANT ?? 'default',
      user: env.DEV_IDENTITY,
      kind: 'user',
      email: null,
      scopes: ['session:read', 'session:write'],
      exp: null,
    }
  }
  return null
}

/** True when the deployment has an identity source at all. */
export function isConfigured(env) {
  return Boolean((env?.ACCESS_TEAM_DOMAIN && env?.ACCESS_AUD) || env?.DEV_IDENTITY)
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
