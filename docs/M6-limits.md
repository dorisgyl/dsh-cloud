# M6 — who may use this, and how much

**Date**: 2026-08-17
**Status**: rate limits and spend caps enforced. Admission built, gate off
pending one measurement.

`docs/parity.md` carried this line from before there was anything to spend:

> **Rate limiting, spend caps, admission control.** A public deployment pays for
> whatever it is asked to do.

There are now three meters, and they fail differently enough that one number
cannot cover them.

| meter | default | why this shape |
|---|---|---|
| `requests` | 60/minute | the cheap meter, to catch a loop before it reaches an expensive one |
| `modelTurns` | 100/day | cents each |
| `containerMs` | 15 min/day | billed by runtime — `sleep 600` costs what 600 seconds of work costs |
| `browserMs` | 5 min/day | 150–900 ms per fetch |

Every one is overridable (`LIMIT_REQUESTS_PER_MINUTE`, …), and **0 means off**:
a deployment that has not set a cap should not have one invented for it.

## The ledger hangs off the user, not the session

```
sessionIdFrom(url) { return url.searchParams.get('session') ?? 'default' }
sessionObjectName  -> tenant/<t>/user/<u>/session/<s>
```

The session segment is **caller-chosen**. `?session=1`, `?session=2`, … each
name a different Durable Object, and `sandboxId` derives from the object id, so
each one also wants its own container. A ledger attached to the session object
is reset by incrementing a query parameter.

So the ledger lives in `tenant/<t>/user/<u>` — the deepest name a caller cannot
vary while remaining themselves, because U1 builds it from verified claims.

That unbounded-object-creation vector is itself part of what the request limit
now covers: the objects differ, the user does not.

## Metering at the door, twice learned

Both meters were first written where the calls were *visible*, and both were
wrong in the same way.

**Container milliseconds** started as timers at the four `EXEC.fetch` sites in
`units/session-do/src/index.mjs`. But `cf-exec-provider` is *handed* the binding
and calls it from inside the shell, fs and subprocess seams. Those four sites
are all probes. The meter would have counted diagnostics and missed every tool
call an agent makes — a counter that is always low, which reads as a quiet user.
Fixed by wrapping the binding itself (`meteredExec()`), so there is one door.

**Model turns** started as a check in `runTurn()`. The web UI does not call
`runTurn`: it drives the agent loop through `dsh-host-apiproxy`. Two doors, one
guard, and the unguarded one was the one people use. Fixed by wrapping the LLM
adapter (`withMetering`), which is the one thing a model call cannot avoid.

The check is *before* the work for turns and *after* it for container and
browser time, because a turn is one unit that refusing actually saves, while the
other two are not known until they are spent.

Spend is accumulated in the object and flushed, not reported per event: a turn
yields hundreds of chunks and a fetch bills in fractions of a millisecond, and a
Durable Object round trip per unit would cost more than the unit. A failed flush
puts the amount back. An isolate that dies mid-window under-bills rather than
over-bills — the right direction for a meter whose failure mode is refusing a
paying user.

**An unreachable ledger admits.** A metering outage that refused every request
would turn an accounting fault into a total outage, which is the worse failure.

## Admission: a GitHub login that has starred the repo

Two conditions, and they are different kinds of thing:

1. **signed in with GitHub** — authentication, enforced by Cloudflare Access
2. **has starred the repo** — admission policy, enforced in `cf-admission`

Access can do the first and cannot do the second, which is the whole reason this
is code and not configuration.

**A star is not a security boundary.** It is public, free, given in one click and
taken back in one, and the cache means a revoked star keeps working until the
next refresh. It keeps a passer-by and a crawler off an agent that costs money.
The boundary is Access; this is a turnstile.

Stargazers are listed rather than asked per user because the authoritative call —
`GET /user/starred/{owner}/{repo}` — needs the **user's** OAuth token, and Access
hands us an identity, not a token. The public list needs no credential, which
keeps admission inside ADR-12's zero-configuration property: unauthenticated
GitHub allows 60 requests an hour and a five-minute TTL spends twelve.

Three defaults, each for a reason:

- **`ADMIN_USERS` bypasses the star check, first and unconditionally.** The repo
  has zero stars, so opening the gate without a bypass locks out everyone
  including whoever opened it — and an operator's way back in should not depend
  on a click that another click can undo.
- **The gate is off unless `ADMISSION_REQUIRE_STAR=1`.** A stranger who clones
  this repository inherits its code, not its guest list. Their repo is not
  `dorisgyl/dsh-cloud`, and a gate checking someone else's stargazers is an
  absurd default for an open-source project.
- **`GITHUB_REPO` is a variable**, for the same reason.

**A GitHub outage keeps the old list.** Emptying the set on error would turn a
hiccup into "nobody has starred this", locking out every legitimate user at once
and looking exactly like a correctly enforced policy.

### The one thing not yet measured

Cloudflare documents that `get-identity` returns an `idp` block and does not
document its shape per provider, so **where a GitHub login lives is a guess**.
`LOGIN_PATHS` in `units/edge/src/index.mjs` walks eight candidates and
`/api/identity-probe` prints the real thing; whichever key is right belongs at
the front of that list with the rest deleted.

Until then, failing to resolve a login **refuses**. Both silent failures were
available — `undefined` compared against a login admits nobody, compared against
`undefined` admits everybody — and only one of them is safe to get wrong. The
refusal carries `identityShape`: key names only, never values, because an
operator needs the keys to fix it and a stranger reading a 403 must not receive
somebody's email address.

## Turning it on, in the order that cannot lock you out

```
1. star dorisgyl/dsh-cloud
2. confirm you are in ADMIN_USERS
3. echo "1" | npx wrangler secret put ADMISSION_REQUIRE_STAR      # units/edge
4. verify in a private window
5. only then widen the Access policy: Emails -> Login Methods = GitHub
```

Step 5 is the one that opens the door to the internet. Steps 1–4 affect only the
operator.

## Not done
- **The gate is unmeasured against a real GitHub identity.** See above.
- **`get-identity` is called per request** when the gate is on. It should be
  cached against the user object the edge already contacts for the request
  meter; today it is an extra round trip on every admitted request.
- **No per-tenant limits**, only per-user. U3 is where that belongs.
- **Nothing meters storage.** Durable Object SQLite and the session log grow
  without a cap, and neither is on any ledger here.
