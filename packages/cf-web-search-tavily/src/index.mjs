// cf-web-search-tavily — a second search provider on the `ctx.web` seam.
//
// Added ALONGSIDE `dsh-web-search-deepseek`, not instead of it. The seam is a
// provider registry by design, and upstream ships three of its own (Exa,
// Perplexity, DeepSeek) for the same reason: which backend a deployment can
// reach is a deployment's business, not the harness's.
//
// Why a second one is worth writing at all: upstream's DeepSeek provider is
// "an Anthropic-compatible Messages model call with the native
// `web_search_20250305` server tool", so **each search costs a model turn**.
// That is a real search, and it is also the most expensive shape a search can
// take. This one is a plain search API: one HTTP call, no model, and a free
// tier of 1000 queries a month that needs no card -- as of 2026 the only
// remaining free tier of that size, Brave having replaced its 2000/month with
// $5 of prepaid credit in February.
//
// What was measured and rejected before landing here:
//
//   DuckDuckGo Instant Answer API (api.duckduckgo.com, free, no key)
//     Three realistic agent queries -- "cloudflare durable objects sqlite",
//     "deepseek harness plugin architecture", "what is kitesurf browser" --
//     each returned AbstractText empty, Answer empty, Results 0,
//     RelatedTopics 0. It answers encyclopaedia questions; it is not web
//     search. Registering it would have produced the worst thing this codebase
//     keeps finding: a provider that registers, succeeds, returns 200, and is
//     empty. The model would answer "nothing was found" from a seam that never
//     searched -- strictly worse than today's WEB_PROVIDER_UNAVAILABLE, which
//     at least fails honestly.
//
//   DuckDuckGo HTML endpoint (html.duckduckgo.com, real results, no key)
//     Scraping. Reachable only through our fetch seam, which runs on Kitesurf
//     -- documented as unable to "negotiate a bot-challenge handshake with
//     real TLS fingerprints", which is precisely what search engines deploy.
//     Blocked, it returns a challenge page rather than an error, so it
//     degrades into the same silent-empty failure. And it would make every
//     stranger who self-deploys this repo violate a third party's terms
//     without being asked.
//
// SELECTION, which will bite: the seam picks a provider by explicit id or by
// there being exactly ONE usable one. Two usable providers is
// `WEB_PROVIDER_AMBIGUOUS`, not a priority chain -- deliberately, so selection
// never depends on registration order. `available()` is a credential check, so
// two providers with one key between them auto-select fine; two keys need
// `searchProvider` (or $DSH_WEB_SEARCH_PROVIDER) to name one.
import { WebError } from '@deepseek-ai/dsh-web'

const ENDPOINT = 'https://api.tavily.com/search'

/** Above a slow query, below the agent loop's patience for one tool call. */
const DEFAULT_TIMEOUT_MS = 20_000

/** Tavily's own cap; the seam truncates to `maxResults` again on the way back. */
const MAX_RESULTS = 20

export class TavilySearchProvider {
  constructor(config = {}) {
    this.id = config.id ?? 'tavily'
    this.apiKey = config.apiKey
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.searchDepth = config.searchDepth ?? 'basic'
    this.calls = 0
  }

  /**
   * The seam calls this during selection on every search, and forbids network
   * here -- so it is exactly one question: is there a key.
   *
   * This is also what lets two providers coexist without configuration. With
   * only a Tavily key, upstream's DeepSeek provider reports unavailable and
   * this one is the single usable provider, so the seam auto-selects it.
   */
  available() {
    return typeof this.apiKey === 'string' && this.apiKey.length > 0
  }

  async search(request, signal) {
    const query = String(request?.query ?? '').trim()
    if (!query) throw new WebError('a search needs a query', 'WEB_SEARCH_INVALID_REQUEST')
    this.calls++

    const timeout = AbortSignal.timeout(this.timeoutMs)
    const abort = signal ? AbortSignal.any([signal, timeout]) : timeout

    let response
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          query,
          // Passed through as a cost optimisation; the seam enforces the bound
          // again on the result, so this is not the thing keeping the promise.
          max_results: Math.min(request?.maxResults ?? 5, MAX_RESULTS),
          search_depth: this.searchDepth,
          // Tavily's own generated summary. It maps to the seam's optional
          // `content`, which exists because Perplexity returns an answer and
          // Exa does not -- so filling it is honest and leaving it empty would
          // be too.
          include_answer: true,
        }),
        signal: abort,
      })
    } catch (error) {
      if (signal?.aborted) throw new WebError('the caller cancelled this search', 'WEB_CANCELLED', { cause: error })
      if (error?.name === 'TimeoutError') {
        throw new WebError(`Tavily did not answer within ${this.timeoutMs}ms`, 'WEB_SEARCH_TIMEOUT', { cause: error })
      }
      throw new WebError(`Tavily request failed: ${String(error?.message ?? error)}`, 'WEB_PROVIDER_FAILED', { cause: error })
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 200)
      // 401 and 432 are the two a deployment will actually hit, and they need
      // different fixes -- a wrong key versus an exhausted month. Answering
      // both with "provider failed" would send someone to regenerate a key
      // that was never the problem.
      const code = response.status === 401 || response.status === 403
        ? 'WEB_PROVIDER_CREDENTIAL_MISSING'
        : 'WEB_PROVIDER_FAILED'
      throw new WebError(`Tavily answered ${response.status}${detail ? `: ${detail}` : ''}`, code)
    }

    const body = await response.json()
    const sources = (body?.results ?? []).map((result) => ({
      url: String(result.url),
      // Every optional field stays optional. Inventing a title from the
      // hostname here would make the seam lie about what the provider
      // returned; `dsh-tool-web` already renders `title ?? hostname(url)`.
      ...(result.title ? { title: String(result.title) } : {}),
      ...(result.content ? { snippet: String(result.content) } : {}),
      ...(result.published_date ? { publishedAt: String(result.published_date) } : {}),
    }))

    return {
      ...(body?.answer ? { content: String(body.answer) } : {}),
      sources,
      // The seam sets this when IT truncates to maxResults. A provider that
      // returned fewer than it was asked for has not truncated anything.
      truncated: false,
    }
  }
}

export function apply(ctx, config = {}) {
  const provider = new TavilySearchProvider(config)
  ctx.web.registerSearchProvider(provider)
  return provider
}

export const name = 'cf-web-search-tavily'
export default { apply, name }
