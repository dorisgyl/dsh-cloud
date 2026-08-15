// Coalesce streamed text deltas before they reach the session log (ADR-10).
//
// `dsh-agent-loop` writes one `assistant/chunk` log entry per chunk the adapter
// yields, 1:1 and unbuffered:
//
//     for await (const chunk of stream) {
//       chunkSeqs.push(this.session.append("assistant/chunk", {turn, step, chunk}).seq)
//       assembler.push(chunk)
//     }
//
// So the log's granularity *is* the adapter's yield granularity, and the only
// place to change it without touching upstream is here, in the adapter.
//
// Measured (docs/ADR-10-sweep.md): an entry costs its structure whether it
// carries 8 characters or 80, so cost tracks entry count. The same 8,000
// character reply is 131.9 KB at 8-character deltas and 33.7 KB at 80 — same
// text, four times less log.
//
// Note what this does NOT do: upstream's UI streams from these same log events,
// so coarsening the log coarsens the visible typing too. There is no separate
// live channel to keep fine — ADR-10's claim that the two granularities are
// independent is true of the architecture but not of this implementation.
// The defaults are therefore chosen to stay under the eye's threshold rather
// than to minimise bytes.

/** ~a line of text: large enough to matter, small enough to look continuous. */
export const DEFAULT_MAX_CHARS = 96
/** ~8 flushes a second; below the point where streaming reads as stuttering. */
export const DEFAULT_MAX_MS = 120

/**
 * Wrap a chunk stream, merging consecutive `text-delta`s.
 *
 * Only adjacent text deltas carrying the same block index are merged. Every
 * other chunk type — block boundaries, tool-call deltas, usage, finish — passes
 * through untouched and in order, and forces a flush first so nothing is
 * reordered around it.
 */
export async function* coalesceTextDeltas(source, options = {}) {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS
  const maxMs = options.maxMs ?? DEFAULT_MAX_MS
  const now = options.now ?? (() => Date.now())

  let buffer = ''
  let index = null
  let openedAt = 0

  const flush = () => {
    if (!buffer) return null
    const chunk = { type: 'text-delta', index, text: buffer }
    buffer = ''
    index = null
    return chunk
  }

  for await (const chunk of source) {
    if (chunk?.type === 'text-delta') {
      // A delta for a different block ends the current run.
      if (index !== null && chunk.index !== index) {
        const pending = flush()
        if (pending) yield pending
      }
      if (!buffer) { index = chunk.index; openedAt = now() }
      buffer += chunk.text ?? ''

      // Flush on size, or when the buffer has been open long enough that
      // holding it would be visible. The time check runs on arrival rather than
      // on a timer: with no further delta there is nothing to flush early, and
      // the stream's end flushes anyway.
      if (buffer.length >= maxChars || now() - openedAt >= maxMs) {
        yield flush()
      }
      continue
    }

    // Anything else is a boundary: flush first so ordering is preserved.
    const pending = flush()
    if (pending) yield pending
    yield chunk
  }

  const tail = flush()
  if (tail) yield tail
}

/**
 * Wrap an adapter instance so its `stream()` coalesces.
 * Returns a proxy rather than a subclass so it works on any LlmAdapter,
 * including ones we do not own.
 */
export function withCoalescing(adapter, options = {}) {
  return new Proxy(adapter, {
    get(target, property, receiver) {
      if (property !== 'stream') return Reflect.get(target, property, receiver)
      return function stream(callOptions) {
        return coalesceTextDeltas(target.stream(callOptions), options)
      }
    },
  })
}
