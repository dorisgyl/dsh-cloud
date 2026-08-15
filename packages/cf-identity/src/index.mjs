// cf-identity — the edge's single identity convergence point.
//
// The deployment's front door is Cloudflare Access (ADR-07): it is part of the
// platform, free below 50 users, needs no code, and — decisively — asks the
// self-deployer to own no account system of ours. Access authenticates before a
// request reaches the Worker and presents a signed assertion; everything below
// the edge sees only the internal claim set.
//
// The convergence exists even though there is exactly one upstream today. It is
// what keeps a change of identity source from reaching the other five units,
// and it is where the rule "the Durable Object name comes from claims, never
// from client input" is enforced.
import { createRemoteJWKSet, jwtVerify } from 'jose'

/** Access presents its assertion in this header, and in a cookie as a fallback. */
const HEADER = 'cf-access-jwt-assertion'
const COOKIE = 'CF_Authorization'

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

export function readAssertion(request) {
  const header = request.headers.get(HEADER)
  if (header) return header
  const cookie = request.headers.get('cookie') ?? ''
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`))
  return match?.[1] ?? null
}

/**
 * Verify an Access assertion and reduce it to the internal claim set.
 * @returns the claims, or null when the assertion is absent or invalid
 */
export async function verifyAccess(request, config) {
  const token = readAssertion(request)
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, keysFor(config.teamDomain), {
      issuer: `https://${config.teamDomain}`,
      audience: config.aud,
    })
    return toInternalClaims(payload, config)
  } catch {
    return null
  }
}

/**
 * Reduce a verified upstream payload to `tenant` / `user` / `scopes` / `exp`.
 *
 * A self-deployed instance is one tenant, so `tenant` comes from configuration
 * rather than from the token — a claim the user controls must never choose the
 * shard. `user` prefers Access's stable subject over the e-mail, which can be
 * reassigned.
 */
export function toInternalClaims(payload, config) {
  const user = payload.sub || payload.email
  if (!user) return null
  return {
    tenant: config.tenant ?? 'default',
    user: String(user),
    scopes: ['session:read', 'session:write'],
    exp: payload.exp ?? null,
    email: payload.email ?? null,
  }
}

/**
 * The three-segment shard name (design 4.4). Derived entirely from claims:
 * a client cannot name someone else's object, because it never supplies any
 * part of this string.
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

/**
 * Resolve identity for a request.
 *
 * `DEV_IDENTITY` exists because Access sits in front of the deployment, not in
 * front of `wrangler dev`; without it nothing is testable locally. It is read
 * only when Access is unconfigured, so a deployed instance cannot fall into it
 * by forgetting a flag.
 */
export async function identify(request, env) {
  const teamDomain = env.ACCESS_TEAM_DOMAIN
  const aud = env.ACCESS_AUD
  if (teamDomain && aud) {
    return verifyAccess(request, { teamDomain, aud, tenant: env.TENANT })
  }
  if (env.DEV_IDENTITY) {
    return { tenant: env.TENANT ?? 'default', user: env.DEV_IDENTITY, scopes: ['session:read', 'session:write'], exp: null, email: null }
  }
  return null
}
