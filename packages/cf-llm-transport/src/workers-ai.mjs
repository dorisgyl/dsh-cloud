// cf-llm-transport — the Workers AI adapter.
//
// ADR-12's zero-configuration default: `wrangler deploy` and the thing talks,
// with no API key anywhere. Cloudflare hosts DeepSeek models, so the default
// runs DeepSeek's own model against DeepSeek's own harness without the
// self-deployer signing up for anything.
//
// Tool calls are the reason this file is longer than a text-only adapter would
// be. Without them the model still tries: the harness advertises its tools in
// the system prompt, and the model answers with DeepSeek's DSML markup as plain
// prose, which nothing downstream parses. The agent then looks like it replied
// when in fact it asked to run something. So tools go out in the request and
// tool calls come back as `tool-call` blocks, not text.
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

// Cloudflare hosts DeepSeek's own models, which is the right default for
// DeepSeek's own harness. They are paid-plan only, and the error says so only
// at the first model call:
//   5035: Model ... is not available on the Workers Free plan
// The deployment already requires the paid plan for CPU reasons (see README),
// so this stays the default; `AI_MODEL` overrides it.
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
    const blocks = message.content ?? []

    // A tool result is its own message, correlated by the call id. Folding it
    // into text would lose the correlation and the model would answer as if it
    // had never run anything.
    const results = blocks.filter((b) => b?.type === 'tool-result')
    if (results.length) {
      for (const result of results) {
        messages.push({
          role: 'tool',
          tool_call_id: result.toolCallId,
          content: (result.content ?? [])
            .filter((b) => b?.type === 'text').map((b) => b.text).join('') || '(no output)',
        })
      }
      continue
    }

    const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('')
    const calls = blocks.filter((b) => b?.type === 'tool-call')

    if (calls.length) {
      messages.push({
        role: 'assistant',
        content: text || null,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      })
      continue
    }

    if (text) messages.push({ role: message.role === 'assistant' ? 'assistant' : 'user', content: text })
  }
  return messages
}

/** Upstream's ToolSchema -> the OpenAI function-tool shape. */
function toChatTools(tools) {
  if (!tools?.length) return undefined
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
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

  // Must satisfy LlmResolvedModelInfo: `id` (not `model`), a human `name`, and
  // capacity nested under `context`. Getting the shape wrong fails the turn at
  // the model call with INVALID_MODEL_INFO, visible only in the session log.
  async resolveModel(provider, model) {
    return {
      provider,
      id: model,
      name: model.replace(/^@cf\//, ''),
      context: { contextWindow: 128000 },
      defaultMaxTokens: 2048,
      // Text only, said explicitly.
      //
      // The seam reads an ABSENT list as "unknown" and a present-but-omitting
      // list as a negative capability, so leaving it out is not the same as
      // saying no — it is saying nothing. The difference is visible in the web
      // UI: with the list absent, dragging an image in fails somewhere in the
      // send path; with it present, the composer can say "the current model
      // does not support images" before the user tries.
      //
      // Cloudflare's catalogue lists @cf/deepseek-ai/deepseek-v4-flash-0731 as
      // Text Generation, with no vision capability. When a multimodal model is
      // bound here, this is the one line that has to change with it.
      inputModalities: ['text'],
    }
  }

  async *stream(options) {
    this.calls++
    const body = {
      messages: toChatMessages(options),
      stream: true,
      max_tokens: options.maxTokens ?? 2048,
    }
    const tools = toChatTools(options.tools)
    if (tools) body.tools = tools
    if (options.temperature !== undefined) body.temperature = options.temperature

    const result = await this.ai.run(options.model, body, { signal: options.signal })

    // Block 0 is text; tool calls take their own indexes after it.
    yield { type: 'block-start', index: 0, blockType: 'text' }
    let text = ''
    let usage = null
    // index -> { id, name, args, blockIndex }
    const calls = new Map()
    let nextBlockIndex = 1

    const openCall = (slot) => {
      if (slot.blockIndex !== undefined) return []
      slot.blockIndex = nextBlockIndex++
      return [{ type: 'block-start', index: slot.blockIndex, blockType: 'tool-call' }]
    }

    if (result && typeof result.getReader === 'function') {
      for await (const payload of sseEvents(result, options.signal)) {
        let event
        try { event = JSON.parse(payload) } catch { continue }

        const choice = event.choices?.[0]
        const delta = event.response ?? choice?.delta?.content ?? ''
        if (delta) {
          text += delta
          yield { type: 'text-delta', index: 0, text: delta }
        }

        for (const call of choice?.delta?.tool_calls ?? event.tool_calls ?? []) {
          const key = call.index ?? call.id ?? 0
          if (!calls.has(key)) calls.set(key, { id: call.id, name: '', args: '' })
          const slot = calls.get(key)
          if (call.id) slot.id = call.id
          if (call.function?.name) slot.name = call.function.name
          const argsDelta = call.function?.arguments ?? ''
          if (argsDelta) slot.args += argsDelta

          for (const chunk of openCall(slot)) yield chunk
          yield {
            type: 'tool-call-delta',
            index: slot.blockIndex,
            id: slot.id ?? `call_${key}`,
            name: slot.name || undefined,
            argumentsDelta: argsDelta,
          }
        }

        if (event.usage) usage = event.usage
      }
    } else {
      const message = result?.choices?.[0]?.message
      const whole = result?.response ?? message?.content ?? ''
      if (whole) {
        text = String(whole)
        yield { type: 'text-delta', index: 0, text }
      }
      for (const call of message?.tool_calls ?? []) {
        const slot = { id: call.id, name: call.function?.name ?? '', args: call.function?.arguments ?? '' }
        for (const chunk of openCall(slot)) yield chunk
        yield {
          type: 'tool-call-delta',
          index: slot.blockIndex,
          id: slot.id,
          name: slot.name,
          argumentsDelta: slot.args,
        }
        calls.set(slot.id, slot)
      }
      usage = result?.usage ?? null
    }

    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    for (const slot of calls.values()) {
      if (slot.blockIndex === undefined) continue
      yield {
        type: 'block-end',
        index: slot.blockIndex,
        block: { type: 'tool-call', id: slot.id, name: slot.name, arguments: slot.args || '{}' },
      }
    }

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
    yield { type: 'finish', reason: { kind: calls.size ? 'tool-calls' : 'stop' } }
  }
}

function estimateTokens(messages) {
  return Math.ceil(messages.reduce((total, m) => total + String(m.content ?? '').length, 0) / 4)
}

export default WorkersAiAdapter
