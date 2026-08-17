// cf-web-browser-run — the upstream `ctx.web` FETCH seam, over Browser Run.
//
// Named for the product, not the engine. It was `cf-web-kitesurf` until the
// probe below measured what that name asserted, and the name lost.
//
// `dsh-web` is the twelfth abstract seam, and the only one that was empty
// SILENTLY. The other eleven are either filled or in `SKIP` with a recorded
// reason. This one loaded, published `ctx.web`, and `dsh-tool-web` registered
// `web_search` and `web_fetch` into the model's tool list -- over a fetch
// provider registry with nothing in it. The model was being offered a tool
// whose every call ends in `WEB_PROVIDER_UNAVAILABLE`.
//
// `docs/parity.md` said "registered but untested; they likely need a credential
// this deployment has not been given". Half right: search needs a credential,
// fetch had no provider at all. A seam nobody filled is not the same problem as
// a seam whose provider is unconfigured, and only one of them is fixed by
// pasting a key.
//
// Why Browser Run rather than plain `fetch()`:
//
//   - A Worker CAN fetch a URL. What it cannot do is run the page. Most of what
//     an agent is asked to read today is assembled client-side, and a raw fetch
//     of such a page returns an empty shell -- which reads as "the page is
//     blank", not "this deployment cannot render".
//   - `env.BROWSER.quickAction()` is a BINDING. No API token, no account setup
//     beyond the one already required. That is ADR-12's zero-configuration
//     default applied to a second capability: like Workers AI, it works on
//     `wrangler deploy` with nothing pasted anywhere. Every alternative fetch
//     or search provider upstream ships (Exa, Perplexity, DeepSeek search)
//     needs a credential the self-deployer has to go get.
//
// Kitesurf, and why this package is not named after it.
//
// Kitesurf is Browser Run's agent-first browser: 3-7x less CPU and memory than
// Chromium at 1.7-1.8x wall time, weak exactly where this seam does not care
// (video, WebGL, bot-challenge TLS, persistent logins) and strong exactly where
// it does (one-shot page reads). It is the browser this deployment wants.
//
// It is also, through the binding, unreachable. `?browser=kitesurf` is
// documented for the REST endpoints, which the binding does not have, and every
// placement the binding does have was swept in /web-probe:
//
//   body      Unrecognized key: "browser"          -- refused outright
//   action    Invalid quick action: markdown?...   -- refused outright
//   options   accepted, and ignored
//
// "Ignored" is a measurement, not a guess. Against two control rows on their
// own URLs (267.9ms and 311.1ms of billed browser time), asking for Kitesurf
// billed 365.3ms -- above both controls, when the documented difference is
// 3-7x below them. No response header names the engine, so billed milliseconds
// are the only evidence there is, and they say Chromium ran.
//
// The two failure shapes differ in the way that matters: the body is validated
// and the options bag is not, so the one placement that looks like it worked is
// the one that silently did not. A deployment believing it ran Kitesurf while
// paying for Chromium would have had no symptom at all.
//
// So this provider asks for nothing and gets Browser Run's default browser.
// `SELECTION` keeps the candidates alive so the sweep can be re-run when
// Cloudflare documents a binding-level selector; today the honest default is
// `null`. Getting Kitesurf means the REST API and an API token, which costs
// this deployment its zero-configuration property (ADR-12) -- a trade nobody
// should make silently on a self-deployer's behalf.
import { WebError } from '@deepseek-ai/dsh-web'

/**
 * The Quick Action to run.
 *
 * `markdown`, not `content`. Both are one call and one bill, and both end at
 * markdown: `dsh-tool-web` runs turndown over an `html` body itself. The
 * difference is WHERE the conversion happens and what crosses the wire in the
 * meantime. `content` ships the page's raw HTML -- scripts, inline styles, nav
 * chrome, base64 images -- into the Durable Object, then spends the object's
 * CPU converting it. This deployment already needs the paid plan for CPU
 * reasons; paying twice for a conversion Browser Run has already done is not a
 * formatting preference.
 *
 * The seam's `WebFetchBody` is a CLOSED union of `html | text`, so markdown
 * lands in the `text` arm. That is accurate rather than convenient: markdown is
 * text. Calling it `html` would be the lie.
 */
const ACTION = 'markdown'

/**
 * Where a browser choice might go, given that the docs place it in a query
 * string that the binding does not have.
 *
 * All three were swept and none of them works today; see the note at the top of
 * this file. They stay because the sweep is the only way to notice if that
 * changes, and a capability this deployment is billed for should not be
 * re-guessed from documentation later.
 */
export const SELECTION = {
  options: 'options',
  body: 'body',
  action: 'action',
}

/** Cap on what one page may contribute, before the model's own budget. */
const MAX_BODY_BYTES = 256 * 1024

/**
 * Above a cold browser start, below the client's patience. A fetch that hangs
 * is worse than one that fails: the agent loop has no way to tell a slow page
 * from a wedged capability, and the turn stalls with no message.
 */
const DEFAULT_TIMEOUT_MS = 45_000

/**
 * Only http(s), and said here rather than left to the browser.
 *
 * The seam's error taxonomy has a code for this because the alternative is a
 * provider that lets `file://` or `data:` through to whatever the backend does
 * with them. Browser Run is not this deployment's trust boundary.
 */
function requireHttpUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new WebError(`not a URL: ${String(raw).slice(0, 200)}`, 'WEB_FETCH_INVALID_URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebError(`only http and https are fetchable, not "${url.protocol}"`, 'WEB_FETCH_INVALID_URL')
  }
  return url.toString()
}

export class BrowserRunFetchProvider {
  constructor(config = {}) {
    this.id = config.id ?? 'browser-run'
    this.browser = config.browser
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxBodyBytes = config.maxBodyBytes ?? MAX_BODY_BYTES
    // Which placement to try, or null to ask for nothing. Defaults to null:
    // every placement is either refused or ignored (see the note at the top),
    // and sending a field that does nothing would leave a false claim in every
    // request forever.
    this.selection = config.selection ?? null
    // Browser-milliseconds, reported by the platform on every response. Kept so
    // the cost of this capability is a measurement rather than an estimate.
    this.browserMs = 0
    this.calls = 0
  }

  /**
   * Cheap, local, and no network -- the seam requires all three, because this
   * runs during provider selection on every call.
   *
   * The binding's presence IS the switch, exactly as with EXEC in ADR-06:
   * remove `browser` from wrangler.jsonc and this provider stops being usable,
   * `ctx.web.fetch` reports `WEB_PROVIDER_UNAVAILABLE`, and nothing else in the
   * tree changes.
   */
  available() {
    return typeof this.browser?.quickAction === 'function'
  }

  async fetch(request, signal) {
    const url = requireHttpUrl(request?.url)
    this.calls++

    let response
    try {
      const action = this.selection === SELECTION.action ? `${ACTION}?browser=kitesurf` : ACTION
      const body = { url, ...(this.selection === SELECTION.body ? { browser: 'kitesurf' } : {}) }
      const options = this.selection === SELECTION.options ? { browser: 'kitesurf' } : undefined
      response = await this.withDeadline(
        options ? this.browser.quickAction(action, body, options) : this.browser.quickAction(action, body),
        signal,
      )
    } catch (error) {
      if (error instanceof WebError) throw error
      if (signal?.aborted) throw new WebError('the caller cancelled this fetch', 'WEB_CANCELLED', { cause: error })
      throw new WebError(`Browser Run failed: ${String(error?.message ?? error)}`, 'WEB_PROVIDER_FAILED', { cause: error })
    }

    // Reported by the platform on every response. Recorded rather than logged,
    // so /web-probe can answer "what did this cost" with a number.
    const used = Number(response.headers?.get?.('X-Browser-Ms-Used'))
    if (Number.isFinite(used)) this.browserMs += used
    // Every header, not a guessed one. Browser Run reports the bill in
    // `X-Browser-Ms-Used` and may or may not name the engine anywhere; asking
    // for two header names I invented and reporting `null` would be a
    // measurement of my own guesses.
    this.lastHeaders = Object.fromEntries(response.headers?.entries?.() ?? [])

    const payload = await this.readPayload(response, url)

    // A non-2xx is a RESULT, not a throw -- the seam is explicit about it, and
    // the status code is part of what the model asked to see. Only a failure to
    // retrieve or represent the page is a WebError.
    const content = String(payload.content ?? '')
    const truncated = content.length > this.maxBodyBytes
    return {
      url: payload.url ?? url,
      statusCode: payload.statusCode ?? response.status ?? 200,
      body: { kind: 'text', content: truncated ? content.slice(0, this.maxBodyBytes) : content },
      truncated,
    }
  }

  /**
   * Stop waiting, which is not the same as stopping the work.
   *
   * The obvious implementation -- hand `quickAction` an AbortSignal -- does not
   * exist here: the binding is RPC, and an AbortSignal does not cross that
   * boundary. It fails at the call with
   *
   *   Browser Run failed: AbortSignal serialization is not enabled.
   *
   * and there is no compatibility flag for it. So the deadline is enforced on
   * this side of the wire.
   *
   * The honest consequence, recorded because it costs money: a fetch this
   * method gives up on is still running in Browser Run, and still billed. What
   * a timeout buys is a turn that ends with a message instead of one that
   * hangs -- not a browser that stops.
   */
  withDeadline(promise, signal) {
    let timer
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new WebError(`no answer within ${this.timeoutMs}ms`, 'WEB_FETCH_TIMEOUT')),
        this.timeoutMs,
      )
    })
    const cancelled = signal
      ? new Promise((_, reject) => {
          if (signal.aborted) reject(new WebError('the caller cancelled this fetch', 'WEB_CANCELLED'))
          signal.addEventListener('abort', () => reject(new WebError('the caller cancelled this fetch', 'WEB_CANCELLED')), { once: true })
        })
      : undefined
    // Cleared on every path: a live timer keeps the invocation alive after the
    // answer has already been returned, which turns a fast fetch into a
    // long-billed one.
    return Promise.race(cancelled ? [promise, deadline, cancelled] : [promise, deadline])
      .finally(() => clearTimeout(timer))
  }

  /**
   * Quick Actions answer `{success, result}` for JSON actions, but the binding
   * hands back a `Response`, and a failure comes back as a body rather than a
   * thrown error. Reading it as text first means a non-JSON failure (an HTML
   * error page, an empty body) produces a message that names what arrived,
   * instead of a `SyntaxError` naming a character offset.
   */
  async readPayload(response, url) {
    const text = await response.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      if (response.ok && text) return { content: text, statusCode: response.status, url }
      throw new WebError(
        `Browser Run answered ${response.status} with ${text ? text.slice(0, 300) : 'an empty body'}`,
        'WEB_PROVIDER_FAILED',
      )
    }
    if (parsed?.success === false || parsed?.errors?.length) {
      const detail = parsed.errors?.map((e) => e.message ?? String(e)).join('; ') || 'no reason given'
      throw new WebError(`Browser Run refused ${url}: ${detail}`, 'WEB_PROVIDER_FAILED')
    }
    const result = parsed?.result ?? parsed
    if (typeof result === 'string') return { content: result, statusCode: response.status, url }
    return {
      content: result?.markdown ?? result?.content ?? result?.text ?? '',
      statusCode: result?.status ?? result?.statusCode ?? response.status,
      url: result?.url ?? url,
    }
  }
}

/**
 * Register the provider. `ctx.web` returns a disposer bound to the calling
 * fiber, so this follows the tree's lifetime without any teardown of its own.
 */
export function apply(ctx, config = {}) {
  if (!config.browser) throw new Error('cf-web-browser-run requires the BROWSER binding (config.browser)')
  const provider = new BrowserRunFetchProvider(config)
  ctx.web.registerFetchProvider(provider)
  // Handed back so a probe can read `browserMs` and `lastBrowser` without
  // reaching into the seam's private registry.
  return provider
}

export const name = 'cf-web-browser-run'
export default { apply, name }
