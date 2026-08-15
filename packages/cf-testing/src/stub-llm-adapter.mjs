// A deterministic LLM adapter, used to exercise the agent turn loop without
// reaching a real model.
//
// Why this exists: the four numbers M1 needs (cold start, wall clock, CPU,
// subrequests per turn) are only meaningful once a turn actually completes.
// Separating "does the loop run inside a Durable Object" from "can we reach a
// model" lets the first question be answered locally, deterministically, and
// without credentials. The real transport (AI Gateway / Workers AI) replaces
// this adapter without touching the loop.
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

export class StubLlmAdapter extends LlmAdapter {
  /**
   * @param options.reply     text the model "produces", split into deltas
   * @param options.chunkSize characters per text-delta, to imitate streaming
   * @param options.delayMs   pause between deltas, to imitate network pacing
   */
  constructor(options = {}) {
    super()
    this.reply = options.reply ?? 'Hello from the stub adapter.'
    this.chunkSize = options.chunkSize ?? 8
    this.delayMs = options.delayMs ?? 0
    // Counting calls here stands in for counting subrequests: with a real
    // adapter each call is one outbound request, and per-invocation subrequest
    // limits are what decide the coarse/fine turn granularity in ADR-11.
    this.calls = 0
  }

  providerInfo(provider) {
    return { id: provider, name: 'Stub (deterministic)' }
  }

  async listModels(provider) {
    return [{ provider, id: 'stub-1', name: 'Stub 1' }]
  }

  // Must satisfy LlmResolvedModelInfo: `id` (not `model`), a human `name`, and
  // capacity nested under `context`. Getting this shape wrong fails the turn at
  // the model call with INVALID_MODEL_INFO, visible only in the session log.
  async resolveModel(provider, model) {
    return {
      provider,
      id: model,
      name: 'Stub 1',
      context: { contextWindow: 128000 },
      defaultMaxTokens: 1024,
    }
  }

  async *stream() {
    this.calls++
    const text = this.reply
    yield { type: 'block-start', index: 0, blockType: 'text' }
    for (let i = 0; i < text.length; i += this.chunkSize) {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs))
      yield { type: 'text-delta', index: 0, text: text.slice(i, i + this.chunkSize) }
    }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield {
      type: 'usage',
      usage: { inputTokens: 16, outputTokens: Math.ceil(text.length / 4) },
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
