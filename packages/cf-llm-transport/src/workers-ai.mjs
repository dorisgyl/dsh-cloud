// cf-llm-transport — the Workers AI adapter.
//
// This is ADR-12's zero-configuration default: `wrangler deploy` and the thing
// talks, with no API key anywhere. Cloudflare hosts DeepSeek models, so the
// default runs DeepSeek's own model against DeepSeek's own harness without the
// self-deployer signing up for anything.
//
// The other path in ADR-12 — AI Gateway, for any provider plus a custom base
// URL — is a separate adapter. They differ in transport, not in this mapping.
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

// Cloudflare hosts DeepSeek's own models, which is the right default for
// DeepSeek's own harness — but they are paid-plan only, and the error says so
// only at the first model call:
//   5035: Model ... is not available on the Workers Free plan
// The deployment already requires the paid plan for CPU reasons (see README),
// so this stays the default; `AI_MODEL` overrides it for anyone who wants
// something smaller or cheaper.
export const DEFAULT_MODEL = '@cf/deepseek-ai/deepseek-v4-flash-0731'

/** A model available without the paid plan, for smoke tests and free tiers. */
export const FREE_TIER_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8'

export function resolveModelId(env) {
  return env?.AI_MODEL || DEFAULT_MODEL
}

/** Upstream's provider-neutral messages -> the chat-completions shape. */
function toChatMessages(options) {
  const messages = []
  if (options.system) messages.push({ role: 'system', content: options.system })
  for (const message of options.messages ?? []) {
    const text = (message.content ?? [])
      .filter((block) => block?.type === 'text')
      .map((block) => block.text)
      .join('')
    // Tool calls and results have no place in this minimal mapping yet; they are
    // dropped rather than mangled, so a turn that needs them fails visibly at
    // the model rather than silently losing correlation.
    if (text) messages.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: text })
  }
  return messages
}

/** Read an SSE body into `data:` payload strings. */
async function* sseEvents(stream, signal) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      if (signal?.aborted) return
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload && payload !== '[DONE]') yield payload
        }
      }
    }
  } finally {
    try { reader.releaseLock() } catch { /* already released */ }
  }
}

export class WorkersAiAdapter extends LlmAdapter {
  /**
   * @param ai      the `AI` binding
   * @param models  model ids to advertise; the first is the default
   */
  constructor(ai, models = [DEFAULT_MODEL]) {
    super()
    this.ai = ai
    this.models = models
    // One `AI.run` is one outbound call. Counting them here is how the
    // per-invocation subrequest budget behind ADR-11 gets measured.
    this.calls = 0
  }

  providerInfo(provider) {
    return { id: provider, name: 'Workers AI' }
  }

  async listModels(provider) {
    return this.models.map((id) => ({ provider, id, name: id.replace(/^@cf\//, '') }))
  }

  async resolveModel(provider, model) {
    return {
      provider,
      id: model,
      name: model.replace(/^@cf\//, ''),
      context: { contextWindow: 128000 },
      defaultMaxTokens: 2048,
    }
  }

  async *stream(options) {
    this.calls++
    const body = {
      messages: toChatMessages(options),
      stream: true,
      max_tokens: options.maxTokens ?? 2048,
    }
    if (options.temperature !== undefined) body.temperature = options.temperature

    const result = await this.ai.run(options.model, body, { signal: options.signal })

    yield { type: 'block-start', index: 0, blockType: 'text' }
    let text = ''
    let usage = null

    // With `stream: true` the binding answers with an SSE ReadableStream; some
    // model families answer with a plain object instead, so both are handled.
    if (result && typeof result.getReader === 'function') {
      for await (const payload of sseEvents(result, options.signal)) {
        let event
        try { event = JSON.parse(payload) } catch { continue }
        const delta = event.response ?? event.choices?.[0]?.delta?.content ?? ''
        if (delta) {
          text += delta
          yield { type: 'text-delta', index: 0, text: delta }
        }
        if (event.usage) usage = event.usage
      }
    } else {
      const whole = result?.response ?? result?.choices?.[0]?.message?.content ?? ''
      if (whole) {
        text = String(whole)
        yield { type: 'text-delta', index: 0, text }
      }
      usage = result?.usage ?? null
    }

    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield {
      type: 'usage',
      usage: {
        // Workers AI reports OpenAI-style counts when it reports any; fall back
        // to a rough estimate rather than claiming zero, which would silently
        // break every token budget downstream.
        inputTokens: usage?.prompt_tokens ?? estimateTokens(body.messages),
        outputTokens: usage?.completion_tokens ?? Math.ceil(text.length / 4),
      },
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function estimateTokens(messages) {
  return Math.ceil(messages.reduce((total, m) => total + String(m.content ?? '').length, 0) / 4)
}

export default WorkersAiAdapter
