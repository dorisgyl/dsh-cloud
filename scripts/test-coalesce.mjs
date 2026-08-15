// Correctness checks for the ADR-10 coalescer.
//
// Saving bytes is worthless if the text changes. The properties that must hold:
// the concatenated text is identical, non-text chunks keep their order and
// their neighbours, and block boundaries are never merged across.
import { coalesceTextDeltas } from '../packages/cf-llm-transport/src/coalesce.mjs'

let failures = 0
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) { failures++; console.log(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`) }
  else console.log(`ok   ${name}`)
}

async function collect(chunks, options) {
  const out = []
  for await (const chunk of coalesceTextDeltas((async function* () { yield* chunks })(), options)) out.push(chunk)
  return out
}

const text = (chunks) => chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('')

// 1. Text survives exactly.
{
  const source = Array.from({ length: 100 }, (_, i) => ({ type: 'text-delta', index: 0, text: `${i % 10}` }))
  const out = await collect(source, { maxChars: 16, maxMs: 1e9 })
  check('text preserved', text(out), text(source))
  check('fewer entries', out.length < source.length, true)
}

// 2. Non-text chunks keep position, and force a flush so nothing reorders.
{
  const source = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'ab' },
    { type: 'text-delta', index: 0, text: 'cd' },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const out = await collect(source, { maxChars: 1000, maxMs: 1e9 })
  check('order preserved', out.map((c) => c.type), ['block-start', 'text-delta', 'usage', 'finish'])
  check('merged before boundary', out[1], { type: 'text-delta', index: 0, text: 'abcd' })
}

// 3. Deltas for different blocks are never merged together.
{
  const source = [
    { type: 'text-delta', index: 0, text: 'aa' },
    { type: 'text-delta', index: 1, text: 'bb' },
  ]
  const out = await collect(source, { maxChars: 1000, maxMs: 1e9 })
  check('blocks stay separate', out, [
    { type: 'text-delta', index: 0, text: 'aa' },
    { type: 'text-delta', index: 1, text: 'bb' },
  ])
}

// 4. A slow stream flushes on time rather than waiting to fill.
{
  let clock = 0
  const source = [
    { type: 'text-delta', index: 0, text: 'a' },
    { type: 'text-delta', index: 0, text: 'b' },
    { type: 'text-delta', index: 0, text: 'c' },
  ]
  // Each arrival advances the clock past the window, so each flushes.
  const out = await collect(source, { maxChars: 1000, maxMs: 10, now: () => (clock += 50) })
  check('time flush', out.length, 3)
  check('time flush text', text(out), 'abc')
}

// 5. Nothing in, nothing out.
{
  check('empty stream', await collect([], {}), [])
}

console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed')
process.exit(failures ? 1 : 0)
