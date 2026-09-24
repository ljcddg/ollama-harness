/**
 * End-to-end check of the Ollama adapter against a live server.
 *
 * The unit tests in check-core.mjs feed synthetic chunks; this one streams from
 * a real model, so it catches wire-format assumptions that a hand-written
 * fixture cannot (reasoning interleaving, done_reason, usage counts).
 *
 * Usage: node scripts/check-live.mjs [model]
 * Skips itself (exit 0) when Ollama is not reachable, so it is safe in CI.
 */

import { OllamaAdapter } from '../dist/core/llm/ollama-adapter.js'
import { BlockAssembler } from '../dist/core/llm/assembler.js'
import { buildSystemPrompt } from '../dist/core/prompt.js'
import { createDefaultRegistry } from '../dist/core/tools/index.js'

const BASE = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434'
const model = process.argv[2] ?? process.env.OLLAMA_MODEL ?? 'gemma4:e2b'

async function reachable() {
  try {
    const res = await fetch(`${BASE}/api/tags`, { signal: AbortSignal.timeout(3000) })
    return res.ok
  } catch {
    return false
  }
}

if (!(await reachable())) {
  console.log(`Ollama not reachable at ${BASE} — skipping live check.`)
  process.exit(0)
}

console.log(`live check against ${BASE} with model "${model}"\n`)

const tools = createDefaultRegistry()
const adapter = new OllamaAdapter({ baseUrl: BASE })
const systemPrompt = buildSystemPrompt({
  cwd: process.cwd(),
  model,
  platform: process.platform,
  toolNames: tools.names(),
})

const assembler = new BlockAssembler()
let sawFinish = false
let finishReason
let reasoningChars = 0
let textChars = 0
const seenIndices = new Map()

const stream = adapter.stream({
  model,
  messages: [
    { id: 'u1', role: 'user', content: [{ type: 'text', text: '你是谁' }], source: { kind: 'user' }, time: Date.now() },
  ],
  systemPrompt,
  tools: tools.definitions(),
  maxTokens: 4096,
  temperature: 0.7,
  signal: new AbortController().signal,
})

for await (const chunk of stream) {
  if (chunk.type === 'reasoning-delta') reasoningChars += chunk.text.length
  if (chunk.type === 'text-delta') textChars += chunk.text.length
  if (chunk.type === 'block-start') {
    const prev = seenIndices.get(chunk.index)
    if (prev && prev !== chunk.kind) {
      console.log(`FAIL  index ${chunk.index} used for both ${prev} and ${chunk.kind}`)
      process.exit(2)
    }
    seenIndices.set(chunk.index, chunk.kind)
  }
  if (chunk.type === 'finish') {
    sawFinish = true
    finishReason = chunk.reason
  }
  assembler.accept(chunk)
}

const { content, argumentErrors } = assembler.flush()
const hasText = content.some((b) => b.type === 'text' && b.text.trim().length > 0)
const hasReasoning = content.some((b) => b.type === 'reasoning' && b.text.trim().length > 0)

console.log('blocks:')
for (const block of content) {
  const preview = (block.text ?? JSON.stringify(block.arguments ?? {})).replace(/\s+/g, ' ').slice(0, 90)
  console.log(`  ${String(block.type).padEnd(10)} ${preview}`)
}
console.log()
console.log(`reasoning chars : ${reasoningChars}`)
console.log(`text chars      : ${textChars}`)
console.log(`finish seen     : ${sawFinish} (${finishReason ? finishReason.kind : 'none'})`)
console.log(`argument errors : ${argumentErrors.length}`)
console.log(`usage           : ${JSON.stringify(assembler.usage ?? null)}`)

const problems = []
if (!sawFinish) problems.push('stream never emitted finish')
if (finishReason?.kind === 'error') problems.push(`finish was an error: ${finishReason.failure?.code}`)
// The regression this file exists for: real content arriving but no text block.
if (reasoningChars > 0 && textChars === 0 && !hasText) {
  problems.push('model produced content but no text block — index collision again')
}

console.log()
if (problems.length > 0) {
  console.log('RESULT: FAIL')
  for (const p of problems) console.log(`  - ${p}`)
  process.exit(2)
}
console.log(`RESULT: OK (text=${hasText}, reasoning=${hasReasoning})`)
