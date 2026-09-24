/**
 * Core logic checks.
 *
 * Runs against plain Node with no Electron and no Ollama, because the parts
 * worth testing here — the log fold, the stream assembler, the glob matcher —
 * are exactly the parts that must not depend on either.
 *
 * Imports the COMPILED output in dist/, so run `npm run build:main` first.
 * `npm run check` does both.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { BlockAssembler } from '../dist/core/llm/assembler.js'
import {
  deriveMessages,
  deriveUsage,
  deriveContextTokens,
  deriveTurnBoundary,
  resolveSessionCwd,
} from '../dist/shared/session.js'
import { validateArgs, ToolRegistry } from '../dist/core/tools/types.js'
import {
  globToRegExp,
  globTool,
  grepTool,
  readTool,
  splitGlobRoot,
  NOISE_DIRS,
} from '../dist/core/tools/files.js'
import { fileKind, formatSize, summarizeKinds, findMarkers, listTool } from '../dist/core/tools/list.js'
import {
  parsePomXml,
  parsePackageJson,
  parseJavaSource,
  buildProjectMap,
  formatProjectMap,
} from '../dist/core/tools/repo-map.js'
import { chunkFile, cosineSimilarity, createSearchTool } from '../dist/core/tools/search.js'
import { asMessageId, asToolCallId } from '../dist/shared/message.js'
import { IPC, DEFAULT_PERSONA, DEFAULT_CONFIG } from '../dist/shared/ipc.js'
import { buildSystemPrompt, buildReviewPrompt } from '../dist/core/prompt.js'
import { simplifyInlineMath } from '../dist/shared/latex.js'
import { extractText, isDocumentPath, looksBinary, extensionOf, decodeBytes } from '../dist/core/extract.js'
import os from 'node:os'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join as joinPath } from 'node:path'
import {
  detectStall,
  buildStallCorrection,
  detectCapabilityDenial,
  buildCapabilityCorrection,
  detectUnbackedClaim,
  buildClaimCorrection,
} from '../dist/core/stall.js'
import { runTurn } from '../dist/core/loop.js'
import { createDefaultRegistry } from '../dist/core/tools/index.js'
import { modelFlags, contextLengthOf } from '../dist/core/llm/ollama-adapter.js'
import { groupSessions, folderName, pathKey } from '../dist/shared/grouping.js'
import { deflateSync } from 'node:zlib'

let passed = 0
let failed = 0
/**
 * Async assertions, awaited before the summary.
 *
 * A test that returns a promise MUST be tracked here: calling an async fn without
 * awaiting it would let its rejection escape the try/catch and the test would
 * count as a pass no matter what it asserted.
 */
const pending = []

function test(name, fn) {
  let result
  try {
    result = fn()
  } catch (error) {
    failed++
    console.log(`FAIL  ${name}`)
    console.log(`      ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (result && typeof result.then === 'function') {
    // Returned as well as tracked: a section whose results should print in
    // order awaits this, everything else lets `pending` settle it at the end.
    const settled = result.then(
      () => {
        passed++
        console.log(`  ok  ${name}`)
      },
      (error) => {
        failed++
        console.log(`FAIL  ${name}`)
        console.log(`      ${error instanceof Error ? error.message : String(error)}`)
      },
    )
    pending.push(settled)
    return settled
  }
  passed++
  console.log(`  ok  ${name}`)
}

function ev(seq, type, data) {
  return { seq, time: 1000 + seq, type, data }
}

console.log('\nassembler')

test('concatenates text deltas into one block', () => {
  const a = new BlockAssembler()
  a.accept({ type: 'block-start', index: 0, kind: 'text' })
  a.accept({ type: 'text-delta', index: 0, text: 'Hello' })
  a.accept({ type: 'text-delta', index: 0, text: ', world' })
  const { content } = a.flush()
  assert.equal(content.length, 1)
  assert.deepEqual(content[0], { type: 'text', text: 'Hello, world' })
})

test('keeps reasoning and text in separate blocks', () => {
  const a = new BlockAssembler()
  a.accept({ type: 'block-start', index: 0, kind: 'reasoning' })
  a.accept({ type: 'reasoning-delta', index: 0, text: 'hmm' })
  a.accept({ type: 'text-delta', index: 1, text: 'answer' })
  const { content } = a.flush()
  assert.equal(content.length, 2)
  assert.deepEqual(content[0], { type: 'reasoning', text: 'hmm' })
  assert.deepEqual(content[1], { type: 'text', text: 'answer' })
})

test('rejects a second kind claiming an index already in use', () => {
  // The failure this guards against: a reasoning block owns index 0, then a
  // text delta arrives on index 0. The assembler used to append it into the
  // reasoning block, so the message rendered with the answer hidden inside the
  // thinking trace and the UI reported an empty response.
  const a = new BlockAssembler()
  a.accept({ type: 'block-start', index: 0, kind: 'reasoning' })
  a.accept({ type: 'reasoning-delta', index: 0, text: 'thinking' })
  assert.throws(() => a.accept({ type: 'text-delta', index: 0, text: 'answer' }), /already holds a reasoning block/)
})

test('rejects a block-start that changes the kind of an open index', () => {
  const a = new BlockAssembler()
  a.accept({ type: 'block-start', index: 0, kind: 'reasoning' })
  assert.throws(() => a.accept({ type: 'block-start', index: 0, kind: 'text' }), /re-announced as text/)
})

test('separates reasoning and text when they arrive in the same chunk', () => {
  // Ollama announces both channels independently: some chunks carry only
  // `thinking`, some only `content`, some both. Reproduces that interleaving at
  // the assembler level using the adapter's fixed slots.
  const a = new BlockAssembler()
  const REASONING_INDEX = 0
  const TEXT_INDEX = 1
  // chunk 1: thinking only
  a.accept({ type: 'block-start', index: REASONING_INDEX, kind: 'reasoning' })
  a.accept({ type: 'reasoning-delta', index: REASONING_INDEX, text: 'Let me think. ' })
  // chunk 2: both channels
  a.accept({ type: 'reasoning-delta', index: REASONING_INDEX, text: 'Still thinking. ' })
  a.accept({ type: 'block-start', index: TEXT_INDEX, kind: 'text' })
  a.accept({ type: 'text-delta', index: TEXT_INDEX, text: '我是 Gemma 4' })
  // chunk 3: content only
  a.accept({ type: 'text-delta', index: TEXT_INDEX, text: '，一个语言模型。' })
  const { content } = a.flush()
  assert.deepEqual(content, [
    { type: 'reasoning', text: 'Let me think. Still thinking. ' },
    { type: 'text', text: '我是 Gemma 4，一个语言模型。' },
  ])
})

test('parses complete-JSON tool arguments', () => {
  const a = new BlockAssembler()
  a.accept({ type: 'block-start', index: 0, kind: 'tool-call' })
  a.accept({ type: 'tool-call-delta', index: 0, callId: 'c1', name: 'read', argumentsDelta: '{"path":"a.ts"}' })
  const { content, argumentErrors } = a.flush()
  assert.equal(argumentErrors.length, 0)
  assert.deepEqual(content[0], {
    type: 'tool-call',
    callId: asToolCallId('c1'),
    name: 'read',
    arguments: { path: 'a.ts' },
  })
})

test('accumulates fragmented tool arguments (OpenAI style)', () => {
  const a = new BlockAssembler()
  a.accept({ type: 'block-start', index: 0, kind: 'tool-call' })
  a.accept({ type: 'tool-call-delta', index: 0, callId: 'c1', name: 'read', argumentsDelta: '{"pa' })
  a.accept({ type: 'tool-call-delta', index: 0, argumentsDelta: 'th":"a.ts"}' })
  const { content, argumentErrors } = a.flush()
  assert.equal(argumentErrors.length, 0)
  assert.deepEqual(content[0].arguments, { path: 'a.ts' })
})

test('replaces complete-JSON tool arguments (Ollama style)', () => {
  const a = new BlockAssembler()
  a.accept({ type: 'block-start', index: 0, kind: 'tool-call' })
  a.accept({ type: 'tool-call-delta', index: 0, callId: 'c1', name: 'read', argumentsDelta: '{"path":"a.ts"}' })
  a.accept({ type: 'tool-call-delta', index: 0, callId: 'c1', name: 'read', argumentsDelta: '{"path":"a.ts","offset":5}' })
  const { content, argumentErrors } = a.flush()
  assert.equal(argumentErrors.length, 0)
  assert.deepEqual(content[0].arguments, { path: 'a.ts', offset: 5 })
})

test('reports unparseable tool arguments instead of dropping them', () => {
  const a = new BlockAssembler()
  a.accept({ type: 'block-start', index: 0, kind: 'tool-call' })
  a.accept({ type: 'tool-call-delta', index: 0, callId: 'c1', name: 'read', argumentsDelta: '{"path":' })
  const { content, argumentErrors } = a.flush()
  assert.equal(content.length, 0)
  assert.equal(argumentErrors.length, 1)
  assert.equal(argumentErrors[0].name, 'read')
})

test('a repeated block-start does not reset accumulated text', () => {
  const a = new BlockAssembler()
  a.accept({ type: 'block-start', index: 0, kind: 'text' })
  a.accept({ type: 'text-delta', index: 0, text: 'one' })
  a.accept({ type: 'block-start', index: 0, kind: 'text' })
  a.accept({ type: 'text-delta', index: 0, text: 'two' })
  assert.deepEqual(a.flush().content[0], { type: 'text', text: 'onetwo' })
})

console.log('\nsession fold')

test('folds a full turn into user + assistant + tool messages', () => {
  const events = [
    ev(1, 'turn/start', { turn: 1 }),
    ev(2, 'user/message', {
      message: {
        id: asMessageId('u1'),
        role: 'user',
        content: [{ type: 'text', text: 'list files' }],
        source: { kind: 'user' },
        time: 1000,
      },
    }),
    ev(3, 'step/start', { turn: 1, step: 1, model: 'qwen', provider: 'ollama' }),
    ev(4, 'step/text', { id: asMessageId('a1'), index: 0, text: 'Sure' }),
    ev(5, 'step/tool-call', { id: asMessageId('a1'), callId: asToolCallId('c1'), name: 'glob', arguments: { pattern: '*' } }),
    ev(6, 'tool/start', { callId: asToolCallId('c1'), name: 'glob', arguments: { pattern: '*' } }),
    ev(7, 'tool/end', { callId: asToolCallId('c1'), name: 'glob', isError: false, content: 'a.ts', durationMs: 5 }),
    ev(8, 'step/end', { turn: 1, step: 1, reason: { kind: 'tool-calls' } }),
  ]
  const messages = deriveMessages(events)
  assert.equal(messages.length, 3)
  assert.equal(messages[0].role, 'user')
  assert.equal(messages[1].role, 'assistant')
  assert.equal(messages[2].role, 'tool')
  assert.deepEqual(messages[1].content[0], { type: 'text', text: 'Sure' })
  assert.equal(messages[1].content[1].name, 'glob')
  assert.equal(messages[2].content[0].type, 'tool-result')
  assert.equal(messages[2].content[0].content, 'a.ts')
})

test('groups a parallel tool batch into one tool message', () => {
  const events = [
    ev(1, 'step/start', { turn: 1, step: 1, model: 'm', provider: 'ollama' }),
    ev(2, 'step/tool-call', { id: asMessageId('a'), callId: asToolCallId('c1'), name: 'read', arguments: {} }),
    ev(3, 'step/tool-call', { id: asMessageId('a'), callId: asToolCallId('c2'), name: 'read', arguments: {} }),
    ev(4, 'tool/start', { callId: asToolCallId('c1'), name: 'read', arguments: {} }),
    ev(5, 'tool/end', { callId: asToolCallId('c1'), name: 'read', isError: false, content: '1', durationMs: 1 }),
    ev(6, 'tool/start', { callId: asToolCallId('c2'), name: 'read', arguments: {} }),
    ev(7, 'tool/end', { callId: asToolCallId('c2'), name: 'read', isError: false, content: '2', durationMs: 1 }),
  ]
  const messages = deriveMessages(events)
  const toolMessages = messages.filter((m) => m.role === 'tool')
  assert.equal(toolMessages.length, 1)
  assert.equal(toolMessages[0].content.length, 2)
})

test('concatenates text arriving in several deltas across events', () => {
  const events = [
    ev(1, 'step/start', { turn: 1, step: 1, model: 'm', provider: 'ollama' }),
    ev(2, 'step/text', { id: asMessageId('a'), index: 0, text: 'The ' }),
    ev(3, 'step/text', { id: asMessageId('a'), index: 0, text: 'answer ' }),
    ev(4, 'step/text', { id: asMessageId('a'), index: 0, text: 'is 42.' }),
  ]
  const messages = deriveMessages(events)
  assert.equal(messages.length, 1)
  assert.deepEqual(messages[0].content[0], { type: 'text', text: 'The answer is 42.' })
})

test('sums token usage across steps', () => {
  const events = [
    ev(1, 'step/usage', { usage: { inputTokens: 10, outputTokens: 5 } }),
    ev(2, 'step/usage', { usage: { inputTokens: 20, outputTokens: 8, reasoningTokens: 3 } }),
  ]
  const usage = deriveUsage(events)
  assert.equal(usage.inputTokens, 30)
  assert.equal(usage.outputTokens, 13)
  assert.equal(usage.reasoningTokens, 3)
})

test('deriveContextTokens reports the LAST call, not the cumulative spend', () => {
  // Context size is what the next request carries: the last input (the whole
  // context the model saw) plus that call's output. Summing every call like
  // deriveUsage would count the same tokens over and over.
  const events = [
    ev(1, 'step/usage', { usage: { inputTokens: 100, outputTokens: 20 } }),
    ev(2, 'step/usage', { usage: { inputTokens: 500, outputTokens: 50 } }),
    ev(3, 'step/usage', { usage: { inputTokens: 200, outputTokens: 10 } }),
  ]
  assert.equal(deriveContextTokens(events), 210)
  assert.equal(deriveContextTokens([]), null)
})

test('contextLengthOf finds the window whatever arch prefix Ollama used', () => {
  // Ollama has no canonical key — llama.context_length, gemma4.context_length,
  // bert.context_length — so the rule is the suffix, and it is pinned here.
  assert.equal(contextLengthOf({ 'gemma4.context_length': 8192 }), 8192)
  assert.equal(contextLengthOf({ 'llama.context_length': 131072, other: 1 }), 131072)
  assert.equal(contextLengthOf({ context_length: 4096 }), 4096)
  assert.equal(contextLengthOf({ 'llama.attention.head_count': 32 }), undefined)
  assert.equal(contextLengthOf({ 'gemma4.context_length': '8192' }), undefined, 'a string is not a number')
  assert.equal(contextLengthOf(undefined), undefined)
})

test('detects an open turn', () => {
  assert.equal(deriveTurnBoundary([ev(1, 'turn/start', { turn: 1 })]).openTurn, 1)
  assert.equal(
    deriveTurnBoundary([
      ev(1, 'turn/start', { turn: 1 }),
      ev(2, 'turn/end', { turn: 1, reason: { kind: 'stop' } }),
    ]).openTurn,
    null,
  )
})

test('a second turn appends after the first without disturbing it', () => {
  const events = [
    ev(1, 'turn/start', { turn: 1 }),
    ev(2, 'user/message', {
      message: { id: asMessageId('u1'), role: 'user', content: [{ type: 'text', text: 'one' }], source: { kind: 'user' }, time: 1 },
    }),
    ev(3, 'step/start', { turn: 1, step: 1, model: 'm', provider: 'ollama' }),
    ev(4, 'step/text', { id: asMessageId('a1'), index: 0, text: 'first' }),
    ev(5, 'step/end', { turn: 1, step: 1, reason: { kind: 'stop' } }),
    ev(6, 'turn/end', { turn: 1, reason: { kind: 'stop' } }),
    ev(7, 'turn/start', { turn: 2 }),
    ev(8, 'user/message', {
      message: { id: asMessageId('u2'), role: 'user', content: [{ type: 'text', text: 'two' }], source: { kind: 'user' }, time: 2 },
    }),
    ev(9, 'step/start', { turn: 2, step: 1, model: 'm', provider: 'ollama' }),
    ev(10, 'step/text', { id: asMessageId('a2'), index: 0, text: 'second' }),
  ]
  const messages = deriveMessages(events)
  assert.equal(messages.length, 4)
  assert.equal(messages[0].role, 'user')
  assert.equal(messages[1].role, 'assistant')
  assert.equal(messages[2].role, 'user')
  assert.equal(messages[3].role, 'assistant')
  assert.equal(messages[3].content[0].text, 'second')
})

// --- editing an earlier prompt ---------------------------------------------

const userMsg = (id, text) => ({
  id: asMessageId(id),
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
  time: 1,
})

test('an edit replaces the text the model sees', () => {
  const events = [
    ev(1, 'turn/start', { turn: 1 }),
    ev(2, 'user/message', { message: userMsg('u1', 'origonal') }),
    ev(3, 'step/start', { turn: 1, step: 1, model: 'm', provider: 'ollama' }),
    ev(4, 'step/text', { id: asMessageId('a1'), index: 0, text: 'reply' }),
    ev(5, 'step/end', { turn: 1, step: 1, reason: { kind: 'stop' } }),
    ev(6, 'turn/end', { turn: 1, reason: { kind: 'stop' } }),
    ev(7, 'message/edit', { targetSeq: 2, text: 'original' }),
  ]
  const messages = deriveMessages(events)
  const user = messages.find((m) => m.role === 'user')
  assert.equal(user.content[0].text, 'original')
})

test('an edit does not mutate the event it targets', () => {
  const original = userMsg('u1', 'first')
  const events = [
    ev(1, 'user/message', { message: original }),
    ev(2, 'message/edit', { targetSeq: 1, text: 'second' }),
  ]
  deriveMessages(events)
  // Folding must not have side effects: replaying the same log twice has to give
  // the same answer, and mutating in place would make that order-dependent.
  assert.equal(original.content[0].text, 'first')
  assert.equal(deriveMessages(events)[0].content[0].text, 'second')
})

test('the newest edit wins when a message is edited twice', () => {
  const events = [
    ev(1, 'user/message', { message: userMsg('u1', 'a') }),
    ev(2, 'message/edit', { targetSeq: 1, text: 'b' }),
    ev(3, 'message/edit', { targetSeq: 1, text: 'c' }),
  ]
  assert.equal(deriveMessages(events)[0].content[0].text, 'c')
})

// --- compaction -------------------------------------------------------------

function twoTurnLog() {
  return [
    ev(1, 'turn/start', { turn: 1 }),
    ev(2, 'user/message', { message: userMsg('u1', 'question one') }),
    ev(3, 'step/start', { turn: 1, step: 1, model: 'm', provider: 'ollama' }),
    ev(4, 'step/text', { id: asMessageId('a1'), index: 0, text: 'answer one' }),
    ev(5, 'step/end', { turn: 1, step: 1, reason: { kind: 'stop' } }),
    ev(6, 'turn/end', { turn: 1, reason: { kind: 'stop' } }),
    ev(7, 'turn/start', { turn: 2 }),
    ev(8, 'user/message', { message: userMsg('u2', 'question two') }),
    ev(9, 'step/start', { turn: 2, step: 1, model: 'm', provider: 'ollama' }),
    ev(10, 'step/text', { id: asMessageId('a2'), index: 0, text: 'answer two' }),
    ev(11, 'step/end', { turn: 2, step: 1, reason: { kind: 'stop' } }),
    ev(12, 'turn/end', { turn: 2, reason: { kind: 'stop' } }),
  ]
}

test('compaction drops the summarised part and keeps what came after', () => {
  const events = [...twoTurnLog(), ev(13, 'session/compact', { upTo: 6, summary: 'summary of turn one' })]
  const messages = deriveMessages(events)

  const texts = messages.map((m) => m.content.map((b) => b.text ?? '').join(''))
  assert.ok(!texts.includes('question one'), 'the summarised user message should not be sent again')
  assert.ok(!texts.includes('answer one'), 'the summarised reply should not be sent again')
  assert.ok(texts.includes('question two'), 'everything after the compaction point stays')
  assert.equal(messages[0].content[0].text, 'summary of turn one')
})

test('the log itself survives compaction', () => {
  const events = [...twoTurnLog(), ev(13, 'session/compact', { upTo: 6, summary: 'summary' })]
  // Nothing is deleted — compaction is a way of reading the log, so the full
  // transcript has to still be there for the UI and for anyone reading the file.
  assert.equal(events.length, 13)
  assert.equal(events[1].data.message.content[0].text, 'question one')
})

test('an empty summary is ignored rather than sent as a message', () => {
  const events = [...twoTurnLog(), ev(13, 'session/compact', { upTo: 6, summary: '   ' })]
  const messages = deriveMessages(events)
  assert.equal(messages[0].role, 'user')
  assert.equal(messages[0].content[0].text, 'question two')
})

test('a second compaction supersedes the first', () => {
  const events = [
    ...twoTurnLog(),
    ev(13, 'session/compact', { upTo: 6, summary: 'first summary' }),
    ev(14, 'session/compact', { upTo: 12, summary: 'second summary' }),
  ]
  const messages = deriveMessages(events)
  assert.equal(messages.length, 1)
  assert.equal(messages[0].content[0].text, 'second summary')
})

test('an edit lands correctly alongside compaction', () => {
  const events = [
    ...twoTurnLog(),
    ev(13, 'session/compact', { upTo: 6, summary: 'summary' }),
    ev(14, 'message/edit', { targetSeq: 8, text: 'question two (fixed)' }),
  ]
  const messages = deriveMessages(events)
  // seq 8 is after the compaction point, so its edited text must still appear.
  const texts = messages.map((m) => m.content.map((b) => b.text ?? '').join(''))
  assert.ok(texts.includes('question two (fixed)'))
  assert.ok(!texts.includes('question two'), 'the pre-edit wording should be gone')
})

console.log('\ntool argument validation')

test('accepts a valid argument object', () => {
  const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  assert.equal(validateArgs(schema, { path: 'a.ts' }), null)
})

test('rejects a missing required argument', () => {
  const schema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  assert.match(validateArgs(schema, {}) ?? '', /missing required argument/)
})

test('rejects a wrong argument type', () => {
  const schema = { type: 'object', properties: { limit: { type: 'integer' } }, required: [] }
  assert.match(validateArgs(schema, { limit: 'ten' }) ?? '', /must be a number/)
})

test('rejects a non-object argument payload', () => {
  const schema = { type: 'object', properties: {}, required: [] }
  assert.match(validateArgs(schema, 'nope') ?? '', /must be a JSON object/)
})

console.log('\nglob matching')

test('** matches across directories', () => {
  const re = globToRegExp('**/*.ts')
  assert.ok(re.test('src/a.ts'))
  assert.ok(re.test('src/deep/nested/b.ts'))
  assert.ok(!re.test('src/a.tsx'))
})

test('* stays within one segment', () => {
  const re = globToRegExp('src/*.ts')
  assert.ok(re.test('src/a.ts'))
  assert.ok(!re.test('src/deep/a.ts'))
})

test('{a,b} alternation works', () => {
  const re = globToRegExp('**/*.{ts,tsx}')
  assert.ok(re.test('x/a.ts'))
  assert.ok(re.test('x/a.tsx'))
  assert.ok(!re.test('x/a.js'))
})

console.log('\npersona prompt')

test('omits the persona section when nothing is customised', () => {
  const prompt = buildSystemPrompt({
    cwd: '/tmp',
    model: 'm',
    platform: 'linux',
    toolNames: ['read'],
    persona: DEFAULT_PERSONA,
  })
  assert.ok(!prompt.includes('# Working with this user'))
})

test('names the user and cites the chosen tone', () => {
  const prompt = buildSystemPrompt({
    cwd: '/tmp',
    model: 'm',
    platform: 'linux',
    toolNames: ['read'],
    persona: { ...DEFAULT_PERSONA, userName: '冰宝', tone: 'blunt' },
  })
  assert.match(prompt, /# Working with this user/)
  assert.match(prompt, /冰宝/)
  assert.match(prompt, /Tone: blunt/)
})

test('appends free-form style notes verbatim', () => {
  const prompt = buildSystemPrompt({
    cwd: '/tmp',
    model: 'm',
    platform: 'linux',
    toolNames: ['read'],
    persona: { ...DEFAULT_PERSONA, customStyle: '不要打比方' },
  })
  assert.match(prompt, /不要打比方/)
})

test('a tone change alone still adds the section', () => {
  const prompt = buildSystemPrompt({
    cwd: '/tmp',
    model: 'm',
    platform: 'linux',
    toolNames: ['read'],
    persona: { ...DEFAULT_PERSONA, tone: 'concise' },
  })
  assert.match(prompt, /Tone: concise/)
})

console.log('\nreview prompt parsing')

test('reviews the request it was given, not a summary of it', () => {
  const prompt = buildReviewPrompt('把按钮改成红色')
  assert.match(prompt, /把按钮改成红色/)
  assert.match(prompt, /"verdict"/)
})

test('tells the reviewer to distrust the completion summary', () => {
  const prompt = buildReviewPrompt('x')
  assert.match(prompt, /Do not trust the final summary/)
})

test('the reviewer has a yardstick even for vague requests', () => {
  // The bug this pins: the old prompt said "Leave findings empty if the
  // request stated no concrete requirements", so 帮我查看一下这个项目 → empty
  // findings → match → a one-line "似乎是前端" guess passed the gate.
  const prompt = buildReviewPrompt('帮我查看一下这个项目')
  assert.ok(!prompt.includes('Leave findings empty'), 'the empty-findings loophole is gone')
  assert.match(prompt, /Never invent/)
  assert.match(prompt, /A vague request still has requirements/)
  assert.match(prompt, /"unclear"/)
  assert.match(prompt, /never as the raw request sentence/)
})

test('the system prompt forbids LaTeX the renderer cannot show', () => {
  // Trace: the model answered 输入食材 $\rightarrow$ AI 智能创作 and the user
  // saw raw dollars and backslashes. The prompt names the alternative now.
  const prompt = buildSystemPrompt({ cwd: '/tmp', model: 'm', platform: 'linux', toolNames: ['read'] })
  assert.match(prompt, /LaTeX/)
  assert.match(prompt, /\\rightarrow/)
})

console.log('\ninline math fallback')

test('simplifyInlineMath turns known commands into Unicode', () => {
  assert.equal(
    simplifyInlineMath('输入食材 $\\rightarrow$ AI 智能创作'),
    '输入食材 → AI 智能创作',
  )
  assert.equal(simplifyInlineMath('$2 \\times 3 \\ge 5$'), '2 × 3 ≥ 5')
  assert.equal(simplifyInlineMath('$e^{i\\pi}$'), 'e^iπ')
})

test('simplifyInlineMath leaves money and unknown commands alone', () => {
  // No backslash → not math. Swallowing "5, 纪念品" as math would corrupt prose.
  assert.equal(simplifyInlineMath('门票 $5, 纪念品 $10'), '门票 $5, 纪念品 $10')
  // Unknown command → keep it raw; a half-translated formula is worse than
  // an untranslated one.
  assert.equal(simplifyInlineMath('$\\unknowncmd{x}$'), '$\\unknowncmd{x}$')
})

console.log('\ndocument extraction')

/**
 * Build a minimal but structurally real PDF.
 *
 * The point of these tests is the parts that are easy to get subtly wrong and
 * impossible to notice from the output: the windows-1252 byte corruption in
 * zlib streams, indirect `/Resources` references, and the `/F1` name token
 * being dropped by a tokenizer that excludes the slash. A fixture that skips
 * any of those would pass while the real thing failed, so this emits an actual
 * two-object page tree with a Flate stream and a ToUnicode CMap.
 */
function buildPdf({ content, toUnicode, fontName = 'F1' }) {
  const stream = (dict, data) =>
    pdfStream(dict, deflateSync(Buffer.from(data, 'latin1')))

  // 1 content, 2 font, 3 ToUnicode, 4 page, 5 pages, 6 catalog
  const objects = [
    pdfObject('1 0 obj', stream('/Filter /FlateDecode', content)),
    pdfObject('2 0 obj', Buffer.from('<< /Type /Font /Subtype /TrueType /BaseFont /X /ToUnicode 3 0 R >>\n', 'latin1')),
    pdfObject('3 0 obj', stream('/Filter /FlateDecode', toUnicode)),
    pdfObject('4 0 obj', Buffer.from(`<< /Type /Page /Parent 5 0 R /Resources << /Font << /${fontName} 2 0 R >> >> /Contents 1 0 R >>\n`, 'latin1')),
    pdfObject('5 0 obj', Buffer.from('<< /Type /Pages /Kids [ 4 0 R ] /Count 1 >>\n', 'latin1')),
    pdfObject('6 0 obj', Buffer.from('<< /Type /Catalog /Pages 5 0 R >>\n', 'latin1')),
  ]
  return assemblePdf(objects, 6)
}

/**
 * Splice a raw byte payload into a PDF object body without letting it touch a
 * string.
 *
 * The rule this encodes is the whole reason these tests exist. Every route from
 * a Buffer to text is lossy here, and all three are easy to reach for:
 *   - `buf.toString('latin1')` is windows-1252, so 0x80–0x9F become other code
 *     points;
 *   - `new TextEncoder().encode()` is UTF-8, so those re-expand to two bytes;
 *   - plain string concatenation (`'x' + buf`) calls `buf.toString()`, which is
 *     UTF-8 DECODING — an invalid lead byte collapses to U+FFFD and the stream
 *     is both corrupted and shortened.
 * So the compressed bytes stay a Buffer the whole way to `Buffer.concat`.
 */
function pdfStream(dict, deflated) {
  return Buffer.concat([
    Buffer.from(`<< ${dict} /Length ${deflated.length} >>\nstream\n`, 'latin1'),
    deflated,
    Buffer.from('\nendstream\n', 'latin1'),
  ])
}

/** Wrap a body in `N 0 obj … endobj`, as bytes. */
function pdfObject(number, body) {
  return Buffer.concat([
    Buffer.from(`${number}\n`, 'latin1'),
    body,
    Buffer.from('endobj\n', 'latin1'),
  ])
}

/** Lay out numbered objects, an xref table and a trailer, all as bytes. */
function assemblePdf(objects, rootNumber) {
  const chunks = []
  const offsets = []
  let position = Buffer.byteLength('%PDF-1.4\n', 'latin1')

  for (const body of objects) {
    offsets.push(position)
    chunks.push(body)
    position += body.length
  }

  const xref =
    `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  const trailer = `trailer\n<< /Size ${offsets.length + 1} /Root ${rootNumber} 0 R >>\nstartxref\n${position}\n%%EOF\n`

  return new Uint8Array(
    Buffer.concat([Buffer.from('%PDF-1.4\n', 'latin1'), ...chunks, Buffer.from(xref + trailer, 'latin1')]),
  )
}

/** A one-pair ToUnicode CMap mapping glyph code 1 to the letter A. */
const SIMPLE_CMAP = [
  '/CIDInit /ProcSet findresource begin',
  '12 dict begin',
  'begincmap',
  '/CMapName /X def',
  '/CMapType 2 def',
  '1 begincodespacerange',
  '<00> <FF>',
  'endcodespacerange',
  '1 beginbfchar',
  '<01> <0041>',
  'endbfchar',
  'endcmap',
  'end',
  'end',
].join('\n')

test('extracts text from a Flate-compressed PDF page', () => {
  const pdf = buildPdf({
    content: 'BT /F1 12 Tf 10 700 Td <01> Tj ET',
    toUnicode: SIMPLE_CMAP,
  })
  const result = extractText('sample.pdf', pdf)
  assert.equal(result.error, undefined, `unexpected error: ${result.error}`)
  assert.equal(result.text, 'A', `expected "A", got ${JSON.stringify(result.text)}`)
})

test('survives zlib bytes that windows-1252 would corrupt', () => {
  // The bug this guards: TextDecoder('latin1') is windows-1252, so bytes
  // 0x80–0x9F decode to different code points and a later re-encode mangles
  // them. A longer stream is likelier to contain one of those bytes, so this
  // uses enough text to push the deflate output through that range.
  const glyphs = Array.from({ length: 40 }, (_, i) => `<${(i + 1).toString(16).padStart(2, '0')}>`).join(' ')
  const cmap = [
    'begincmap', '1 begincodespacerange', '<00> <FF>', 'endcodespacerange',
    '40 beginbfchar',
    ...Array.from({ length: 40 }, (_, i) =>
      `<${(i + 1).toString(16).padStart(2, '0')}> <${(0x41 + (i % 26)).toString(16).padStart(4, '0')}>`),
    'endbfchar', 'endcmap',
  ].join('\n')

  const pdf = buildPdf({
    content: `BT /F1 12 Tf 10 700 Td ${glyphs} Tj ${glyphs} Tj ${glyphs} Tj ET`,
    toUnicode: cmap,
  })
  const result = extractText('big.pdf', pdf)
  assert.equal(result.error, undefined, `unexpected error: ${result.error}`)
  assert.ok(result.text.length >= 100, `expected a long run of text, got ${result.text.length} chars`)
  // Every character must come from the CMap, not from raw ASCII passthrough.
  assert.match(result.text, /^[A-Z]+$/, `got ${JSON.stringify(result.text.slice(0, 60))}`)
})

test('follows an indirect /Resources reference to find the font', () => {
  // The real-world shape: the page points at a resources object, that object
  // points at a font dict, and the font dict maps /F1 to the font. Without
  // chasing all three hops the page decodes to raw glyph codes.
  const content = 'BT /F1 12 Tf 10 700 Td <01> Tj ET'
  const deflated = deflateSync(Buffer.from(content, 'latin1'))
  const cmapData = deflateSync(Buffer.from(SIMPLE_CMAP, 'latin1'))

  const objects = [
    pdfObject('1 0 obj', pdfStream('/Filter /FlateDecode', deflated)),
    pdfObject('2 0 obj', Buffer.from('<< /Type /Font /Subtype /TrueType /BaseFont /X /ToUnicode 4 0 R >>\n', 'latin1')),
    pdfObject('3 0 obj', Buffer.from('<< /Font 5 0 R >>\n', 'latin1')),
    pdfObject('4 0 obj', pdfStream('/Filter /FlateDecode', cmapData)),
    pdfObject('5 0 obj', Buffer.from('<< /F1 2 0 R >>\n', 'latin1')),
    pdfObject('6 0 obj', Buffer.from('<< /Type /Page /Parent 7 0 R /Resources 3 0 R /Contents 1 0 R >>\n', 'latin1')),
    pdfObject('7 0 obj', Buffer.from('<< /Type /Pages /Kids [ 6 0 R ] /Count 1 >>\n', 'latin1')),
    pdfObject('8 0 obj', Buffer.from('<< /Type /Catalog /Pages 7 0 R >>\n', 'latin1')),
  ]

  const pdf = assemblePdf(objects, 8)

  const result = extractText('indirect.pdf', pdf)
  assert.equal(result.error, undefined, `unexpected error: ${result.error}`)
  assert.equal(result.text, 'A', `expected "A" through the /Resources indirection, got ${JSON.stringify(result.text)}`)
})

test('recognises a PDF with no text layer as a scan rather than as empty', () => {
  // A page whose content draws nothing: the message must point at OCR, because
  // "empty file" and "scanned document" need different responses from the user.
  const pdf = buildPdf({ content: 'q 1 0 0 1 0 0 cm Q', toUnicode: SIMPLE_CMAP })
  const result = extractText('scan.pdf', pdf)
  assert.ok(result.error, 'expected an error explaining the missing text layer')
  assert.match(result.error, /扫描件|图片/)
})

test('extracts paragraphs from a docx', () => {
  // word/document.xml is one long line, so breaks have to come from the XML.
  const xml =
    '<?xml version="1.0"?><w:document><w:body>' +
    '<w:p><w:r><w:t>First paragraph</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Second</w:t></w:r><w:r><w:t xml:space="preserve"> paragraph</w:t></w:r></w:p>' +
    '</w:body></w:document>'
  const docx = buildZip({ 'word/document.xml': xml }, 'docx')
  const result = extractText('sample.docx', docx)
  assert.equal(result.error, undefined, `unexpected error: ${result.error}`)
  assert.equal(result.text, 'First paragraph\nSecond paragraph')
})

test('decodes XML entities in docx text without double-decoding', () => {
  const xml = '<w:document><w:p><w:r><w:t>a &amp;lt; b &lt; c &amp; d</w:t></w:r></w:p></w:document>'
  const result = extractText('entities.docx', buildZip({ 'word/document.xml': xml }, 'docx'))
  // `&amp;lt;` is an escaped literal "&lt;", not a tag.
  assert.equal(result.text, 'a &lt; b < c & d', `got ${JSON.stringify(result.text)}`)
})

test('reports a legacy .doc disguised as .docx instead of claiming it is empty', () => {
  const notAZip = new TextEncoder().encode('\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1' + 'old binary word file')
  const result = extractText('legacy.docx', notAZip)
  assert.ok(result.error)
  assert.match(result.error, /\.doc|ZIP/i)
})

test('refuses binary content with a message that names the format', () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
  const result = extractText('picture.png', png)
  assert.ok(result.error)
  assert.match(result.error, /图片/)
  assert.equal(result.text, '')
})

test('detects binary from bytes rather than from the extension', () => {
  // A file named .txt that is really a PNG: the extension cannot be trusted.
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])
  assert.equal(looksBinary(png), true)
  const result = extractText('misnamed.txt', png)
  assert.ok(result.error, 'expected the content check to catch this, not the extension')
})

test('reads a UTF-8 text file with a BOM without leaking the BOM', () => {
  const bytes = new TextEncoder().encode('\ufeffhello world')
  const result = extractText('bom.txt', bytes)
  assert.equal(result.text, 'hello world')
})

test('decodes GBK text rather than returning replacement characters', () => {
  // Windows tooling still writes GBK; read as UTF-8 it is a wall of U+FFFD.
  const gbk = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3, 0xca, 0xc0, 0xbd, 0xe7]) // 你好世界
  const result = extractText('gbk.txt', gbk)
  assert.equal(result.text, '你好世界', `got ${JSON.stringify(result.text)}`)
})

test('decodeBytes recovers GBK without an extension to hint at it', () => {
  // The shell tool has no filename to inspect — it sees a byte stream from a
  // child process. Same fallback, so it must work on bytes alone.
  const gbk = new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]) // 你好
  assert.equal(decodeBytes(gbk), '你好')
  // And must not damage genuine UTF-8.
  assert.equal(decodeBytes(new TextEncoder().encode('你好')), '你好')
})

if (process.platform === 'win32') {
  test('the shell tool decodes Windows OEM console output (cp936)', async () => {
    // The real bug: `dir` on a Chinese Windows writes code page 936, so reading
    // it as UTF-8 turned "论文全文.md" into "����<0xC8><0xAB>��.md" and the model
    // faithfully reported the garbage to the user. Also covers the second half
    // of the bug: decoding per chunk rather than once, which splits multi-byte
    // characters at arbitrary write boundaries.
    const mod = await import('../dist/core/tools/bash.js')
    const ctx = {
      cwd: os.tmpdir(),
      signal: new AbortController().signal,
      callId: 'test',
      requestApproval: async () => true,
    }
    const r = await mod.bashTool.execute({ command: 'chcp' }, ctx)
    assert.ok(
      !/\ufffd/.test(r.content),
      `OEM output came back mangled: ${JSON.stringify(r.content)}`,
    )
  })
}

test('the shell tool never hands credentials to a child process', async () => {
  // `bash` runs whatever the model writes, so its inherited environment is the
  // one place a prompt-injected `env` could print the user's API keys straight
  // into the transcript. Assert the scrub's shape directly rather than trusting
  // the spawn call site to have used it.
  const { scrubbedEnv } = await import('../dist/core/tools/bash.js')
  const env = scrubbedEnv({
    PATH: '/usr/bin',
    HOME: '/home/x',
    LANG: 'en_US.UTF-8',
    SystemRoot: 'C:\\Windows',
    OPENAI_API_KEY: 'sk-leak',
    GITHUB_TOKEN: 'ghp-leak',
    MY_SECRET: 'leak',
    DB_PASSWORD: 'leak',
    AWS_SECRET_ACCESS_KEY: 'leak',
    NPM_TOKEN: 'leak',
    SSH_PASSPHRASE: 'leak',
    SOME_CREDENTIALS_FILE: 'leak',
  })
  // Essential names survive, or every command breaks.
  assert.equal(env.PATH, '/usr/bin')
  assert.equal(env.HOME, '/home/x')
  assert.equal(env.LANG, 'en_US.UTF-8')
  assert.equal(env.SystemRoot, 'C:\\Windows')
  // Credential-shaped names do not.
  const credentialNames = (o) => Object.keys(o).filter((k) => /KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL/i.test(k))
  assert.deepEqual(credentialNames(env), [], `credential names reached the child: ${credentialNames(env).join(', ')}`)
  // Pagers are pinned so a command cannot block on an interactive pager.
  assert.equal(env.GIT_PAGER, 'cat')
  assert.equal(env.PAGER, 'cat')
  // The default reads the real process environment, scrubbed — and the machine
  // running this check must not leak either.
  assert.deepEqual(
    credentialNames(scrubbedEnv()),
    [],
    `the real environment leaks: ${credentialNames(scrubbedEnv()).join(', ')}`,
  )
})

test('routes known document extensions through the decoder', () => {
  for (const path of ['a.pdf', 'a.PDF', 'a.docx', 'a.doc', 'a.odt', 'a.rtf']) {
    assert.equal(isDocumentPath(path), true, `${path} should be treated as a document`)
  }
  for (const path of ['a.txt', 'a.ts', 'a.png', 'a']) {
    assert.equal(isDocumentPath(path), false, `${path} should not be treated as a document`)
  }
})

test('reads the extension past a directory that contains dots', () => {
  assert.equal(extensionOf('C:/my.folder/notes'), '')
  assert.equal(extensionOf('C:/my.folder/notes.md'), 'md')
  assert.equal(extensionOf('C:\\dir.d\\report.PDF'), 'pdf')
})

test('falls back to the file header when the extension is wrong or missing', () => {
  // A PDF named .txt is still a PDF; the structure is the authority.
  const pdf = buildPdf({ content: 'BT /F1 12 Tf 10 700 Td <01> Tj ET', toUnicode: SIMPLE_CMAP })
  const result = extractText('mislabelled.txt', pdf)
  assert.equal(result.kind, 'pdf')
  assert.equal(result.text, 'A')
})

/**
 * Build a minimal ZIP containing the given text entries.
 *
 * Stored (method 0) rather than deflated: the extractor's job is to read the
 * central directory and split XML, and using a real deflate here would make a
 * failure ambiguous between the two.
 */
function buildZip(entries, ext) {
  const chunks = []
  const central = []
  let offset = 0

  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text, 'utf8')
    const nameBytes = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8) // method: stored
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)

    const head = Buffer.concat([local, nameBytes, data])
    chunks.push(head)

    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0, 8)
    entry.writeUInt16LE(0, 10) // method: stored
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(Buffer.concat([entry, nameBytes]))
    offset += head.length
  }

  const centralBytes = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(entries).length, 8)
  eocd.writeUInt16LE(Object.keys(entries).length, 10)
  eocd.writeUInt32LE(centralBytes.length, 12)
  eocd.writeUInt32LE(offset, 16)
  void ext
  return new Uint8Array(Buffer.concat([...chunks, centralBytes, eocd]))
}

/** CRC-32, needed because a ZIP entry declares one and readers verify it. */
function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

console.log('\nstall detection')

test('flags the real gemma4 reply that narrated a plan and stopped', () => {
  // Verbatim from a session log: the model reasoned "I will start by using
  // glob", replied "我将首先列出项目中的所有文件和目录…请稍候。", and emitted
  // zero tool calls. The loop used to treat that as a finished turn.
  const verdict = detectStall({
    text: '好的，我将开始查看您当前项目 `D:\\idea\\work\\Spring\\springboot-dify` 的全部内容。\n\n为了提供一个完整的视图，我将首先列出项目中的所有文件和目录，然后逐一读取它们的内容。请稍候。',
    reasoning: 'I will start by using `glob` to list potential files in the current directory and subdirectories.',
  })
  assert.equal(verdict.stalled, true)
  assert.match(verdict.reason ?? '', /glob/)
})

test('flags an English "let me start" with nothing behind it', () => {
  const verdict = detectStall({ text: 'Let me start by looking at the project structure.', reasoning: '' })
  assert.equal(verdict.stalled, true)
})

test('does not flag a delivered answer that happens to look forward', () => {
  // The guard must not fire on a real result: if it did, every finished turn
  // would be nudged and the loop would never end.
  const verdict = detectStall({
    text: 'The project contains 12 modules. Here is the structure:\n- src/main/java\n- src/test/java\n\n以上是完整的目录结构。',
    reasoning: '',
  })
  assert.equal(verdict.stalled, false)
})

test('does not flag a plan that also reports findings', () => {
  const verdict = detectStall({
    text: 'I have read the 40 files. Next, I will summarize what each service does.',
    reasoning: '',
  })
  assert.equal(verdict.stalled, false)
})

test('ignores tool names mentioned inside code fences', () => {
  // A message that DOCUMENTS glob is an answer, not a promise to call it.
  const verdict = detectStall({
    text: '```\nglob("**/*.ts")\n```\nThat is how you invoke it.',
    reasoning: '',
  })
  assert.equal(verdict.stalled, false)
})

test('does not flag a long explanation that merely contains 接下来', () => {
  const filler = '这是一个很长的说明段落，描述了各个模块之间的关系以及它们如何协作完成请求处理与数据流转。'.repeat(6)
  const verdict = detectStall({ text: `${filler}\n接下来是各个模块的职责划分。${filler}`, reasoning: '' })
  assert.equal(verdict.stalled, false)
})

test('treats an empty reply as something other than a stall', () => {
  // Empty is EMPTY_RESPONSE's problem; two failure modes must not be conflated.
  assert.equal(detectStall({ text: '   ', reasoning: 'thinking...' }).stalled, false)
})

test('the correction tells the model that announcing is not doing', () => {
  const message = buildStallCorrection({ stalled: true, reason: '模型只给出了"马上开始"的说法' })
  assert.match(message, /did not actually call any tool/)
  assert.match(message, /is not starting/)
  assert.match(message, /model|模型/)
})

console.log('\ncapability denial')

test('flags the real "我无法访问本地文件系统" refusal', () => {
  // Verbatim from session deaa6f81 turn 30: the model held a working glob tool
  // and told the user to run `dir` themselves instead.
  const verdict = detectCapabilityDenial({
    text: '我再次确认，作为一个语言模型，我**无法直接访问您的本地文件系统**来查看 `D:\\desktop1\\论文` 目录下有什么文件。\n\n请您使用系统命令（例如在 PowerShell 或 CMD 中运行 `dir D:\\desktop1\\论文`）获取该目录下的文件列表，然后将这个列表提供给我。',
    reasoning: '',
  })
  assert.equal(verdict.denied, true)
  assert.match(verdict.reason ?? '', /文件系统/)
})

test('flags an English filesystem denial', () => {
  const verdict = detectCapabilityDenial({
    text: "I cannot access your local file system to list that directory. Please run `dir` and tell me the output.",
    reasoning: '',
  })
  assert.equal(verdict.denied, true)
})

test('carries the path the turn was about into the correction', () => {
  const verdict = detectCapabilityDenial({
    text: '我无法访问 D:\\desktop1\\论文 目录下的内容。',
    reasoning: '',
  })
  assert.equal(verdict.denied, true)
  const message = buildCapabilityCorrection(verdict, 'C:\\Users\\me\\Documents')
  // The correction must name a concrete call, or the model just re-refuses.
  assert.match(message, /glob/)
  assert.match(message, /D:/)
  assert.match(message, /Never ask the user to run a command/)
  // It must revoke the earlier refusal, which is what makes this self-reinforcing.
  assert.match(message, /ignore\s*\n?that|were wrong/)
})

test('does not flag a normal answer that mentions a directory', () => {
  const verdict = detectCapabilityDenial({
    text: 'The directory D:\\desktop1\\论文 contains 12 files, mostly .docx. Here is the list.',
    reasoning: '',
  })
  assert.equal(verdict.denied, false)
})

test('a genuine tool error is not a capability denial', () => {
  // Reporting an error verbatim is the CORRECT behaviour; the guard must not
  // punish it, or the model learns to hide failures.
  const verdict = detectCapabilityDenial({
    text: 'glob 返回了错误：EPERM: operation not permitted。这个目录我读不了，需要你确认一下权限。',
    reasoning: '',
  })
  assert.equal(verdict.denied, false)
})

test('the system prompt states the tools and forbids delegating back', () => {
  const prompt = buildSystemPrompt({
    cwd: 'D:\\desktop1\\test',
    model: 'gemma4:e2b',
    platform: 'win32',
    toolNames: ['read', 'glob', 'grep', 'edit', 'write', 'bash'],
  })
  // The specific behaviours the guard corrects must also be pre-empted here.
  assert.match(prompt, /NOT a sandbox/)
  assert.match(prompt, /Never ask the user to run a command/)
  assert.ok(
    prompt.indexOf('Your access to this machine') < prompt.indexOf('How to work'),
    'capability facts must come before the working-style rules',
  )
})

console.log('\nmodel capability detection')

test('reads capabilities authoritatively when Ollama reports them', () => {
  // Measured from this machine: gemma4:e2b is ["completion","vision","audio",
  // "tools","thinking"], bge-m3 is ["embedding"].
  const chat = modelFlags({
    name: 'gemma4:e2b',
    families: ['gemma4'],
    capabilities: ['completion', 'vision', 'audio', 'tools', 'thinking'],
  })
  assert.equal(chat.chat, true)
  assert.equal(chat.vision, true)
  assert.equal(chat.tools, true)
  assert.equal(chat.thinking, true)

  const embed = modelFlags({ name: 'bge-m3:latest', families: ['bert'], capabilities: ['embedding'] })
  assert.equal(embed.chat, false, 'an embedding model must not be offered as a chat model')
  assert.equal(embed.tools, false)
})

test('falls back to the name when no capabilities are reported', () => {
  // An older build reports nothing, and the picker still must not offer bge-m3.
  assert.equal(modelFlags({ name: 'bge-m3:latest' }).chat, false)
  assert.equal(modelFlags({ name: 'nomic-embed-text' }).chat, false)
  // Unknown is NOT the same as unusable: guessing "cannot chat" would hide models
  // that work perfectly well.
  assert.equal(modelFlags({ name: 'some-new-model:7b' }).chat, undefined)
  assert.equal(modelFlags({ name: 'llama3.2:3b' }).tools, true)
})

test('a capabilities list that omits tools is not treated as name evidence', () => {
  // The authoritative answer wins even when it contradicts the name heuristic.
  const flags = modelFlags({ name: 'qwen2.5:7b', capabilities: ['completion'] })
  assert.equal(flags.tools, false, 'name hints must not override a real capability list')
})

console.log('\nsession grouping')

/** Minimal SessionMeta for grouping tests. */
function meta(id, cwd, updatedAt, messageCount = 2) {
  return {
    version: 1,
    sessionId: id,
    cwd,
    title: id,
    createdAt: updatedAt - 1000,
    updatedAt,
    messageCount,
  }
}

test('groups sessions under their working directory', () => {
  const groups = groupSessions([
    meta('a', 'D:\\work\\one', 100),
    meta('b', 'D:\\work\\two', 200),
    meta('c', 'D:\\work\\one', 300),
  ])
  assert.equal(groups.length, 2)
  // Newest activity first.
  assert.equal(groups[0].cwd, 'D:\\work\\one')
  assert.deepEqual(groups[0].sessions.map((s) => s.sessionId), ['c', 'a'])
  assert.equal(groups[1].sessions.length, 1)
})

test('folds paths that differ only in case, separator or trailing slash', () => {
  // The realistic mess: config stores backslashes, a model writes forward
  // slashes, a folder picker appends a separator. Three groups for one folder
  // would read as data loss.
  const groups = groupSessions([
    meta('a', 'D:\\Desktop1\\Test', 100),
    meta('b', 'D:/desktop1/test/', 200),
    meta('c', 'd:\\desktop1\\TEST', 300),
  ])
  assert.equal(groups.length, 1, `expected one group, got ${groups.length}`)
  assert.equal(groups[0].sessions.length, 3)
})

test('pinned sessions sort first, then by recency', () => {
  const groups = groupSessions(
    [meta('old', 'D:\\w', 100), meta('new', 'D:\\w', 900), meta('mid', 'D:\\w', 500)],
    { pinned: ['old'] },
  )
  assert.deepEqual(
    groups[0].sessions.map((s) => s.sessionId),
    ['old', 'new', 'mid'],
  )
})

test('never invents a group for a directory that has no sessions', () => {
  // A phantom group keyed off the global workdir setting is what made the
  // sidebar show a folder the user had never put a conversation in — and it
  // could not be dismissed, because it was regenerated from that setting.
  const groups = groupSessions([], { currentWorkdir: 'D:\\fresh' })
  assert.equal(groups.length, 0)
})

test('groups only the directories the sessions actually reference', () => {
  const groups = groupSessions(
    [meta('a', 'D:\\one', 100), meta('b', 'D:\\two', 200)],
    { currentWorkdir: 'D:\\unused' },
  )
  assert.deepEqual(
    groups.map((g) => g.label).sort(),
    ['one', 'two'],
  )
})

test('a session runs in its own directory, not in the default one', () => {
  // The reported bug: the sidebar files a conversation under D:\desktop1\test
  // while the agent works wherever the global workdir last pointed, so it
  // answers "the current working directory is D:\desktop1\论文" — inside a chat
  // the user opened from `test`.
  assert.equal(
    resolveSessionCwd('D:\\desktop1\\test', 'D:\\desktop1\\论文', 'C:\\x'),
    'D:\\desktop1\\test',
  )
})

test('the default folder only covers a session that has none of its own', () => {
  assert.equal(resolveSessionCwd('', 'D:\\fallback', 'C:\\x'), 'D:\\fallback')
  assert.equal(resolveSessionCwd(null, 'D:\\fallback', 'C:\\x'), 'D:\\fallback')
  // Whitespace is not a directory.
  assert.equal(resolveSessionCwd('   ', 'D:\\fallback', 'C:\\x'), 'D:\\fallback')
  assert.equal(resolveSessionCwd(undefined, '', 'C:\\x'), 'C:\\x')
})

test('drops a hidden group', () => {
  const groups = groupSessions([meta('a', 'D:\\gone', 100)], { hidden: ['d:\\gone'] })
  assert.equal(groups.length, 0)
})

test('never hides the group holding the active session', () => {
  // "Remove from list" while sitting in that group must not blank the sidebar
  // around an open conversation.
  const groups = groupSessions([meta('a', 'D:\\gone', 100)], {
    hidden: ['d:\\gone'],
    activeSessionId: 'a',
  })
  assert.equal(groups.length, 1)
  assert.equal(groups[0].active, true)
  assert.equal(groups[0].pinnedOpenByActivity, true)
})

test('an alias renames the label but never the path', () => {
  const groups = groupSessions([meta('a', 'D:\\long\\nested\\path', 100)], {
    aliases: { 'd:/long/nested/path': '我的项目' },
  })
  assert.equal(groups[0].label, '我的项目')
  assert.equal(groups[0].aliased, true)
  // The real path is what tools resolve against, so it must survive untouched.
  assert.equal(groups[0].cwd, 'D:\\long\\nested\\path')
  assert.equal(groups[0].fullPath, 'D:\\long\\nested\\path')
})

test('labels a session with no recorded directory instead of showing blank', () => {
  const groups = groupSessions([meta('a', '', 100)])
  assert.equal(groups.length, 1)
  assert.match(groups[0].label, /未指定/)
})

test('folderName handles both separators and a trailing slash', () => {
  assert.equal(folderName('D:\\work\\proj'), 'proj')
  assert.equal(folderName('D:/work/proj'), 'proj')
  assert.equal(folderName('D:/work/proj/'), 'proj')
  // A drive root has no last segment, so it is its own name.
  assert.equal(folderName('D:\\'), 'D:')
})

console.log('\ndirectory overview (`list`)')

test('classifies a file by kind from its name', () => {
  assert.equal(fileKind('a.JPG'), 'image', 'case must not matter')
  assert.equal(fileKind('notes.md'), 'doc')
  assert.equal(fileKind('index.ts'), 'code')
  assert.equal(fileKind('tsconfig.json'), 'config')
  assert.equal(fileKind('clip.mp4'), 'video')
  assert.equal(fileKind('backup.tar.gz'), 'archive')
  assert.equal(fileKind('data.csv'), 'data')
  assert.equal(fileKind('body.woff2'), 'font')
  // A leading dot counts as an extension on purpose: `.env` is config, and a
  // dotfile that matches nothing is still better off in `other` than in `code`.
  assert.equal(fileKind('.env'), 'config')
  // Extension-less markers are looked up by name, or they all fall into `other`.
  assert.equal(fileKind('LICENSE'), 'doc')
  assert.equal(fileKind('Makefile'), 'code')
  assert.equal(fileKind('mystery'), 'other')
  assert.equal(fileKind('trailing.'), 'other', 'a trailing dot is not an extension')
  // `ts` is also an MPEG transport-stream container, but TypeScript is the
  // reading that is almost never wrong in a folder a person is asking about.
  assert.equal(fileKind('stream.ts'), 'code')
})

test('no common format is left unclassified', () => {
  // Found by running the tool against a real folder rather than by reasoning
  // about it: a 37 MB .pptx and an entire WeChat mini-program (.wxml/.wxss) both
  // landed in `other` — the one bucket that tells the model nothing, and it
  // swallowed the biggest file in the folder. This is the guard against the next
  // such gap. If you add support for a format, add it here too.
  const cases = {
    code: ['a.css', 'a.scss', 'a.less', 'a.html', 'a.vue', 'a.svelte', 'a.wxml', 'a.wxss', 'a.wxs', 'a.gradle', 'a.proto', 'a.ipynb'],
    config: ['a.json', 'a.yml', 'a.toml', 'a.xml', '.gitignore'],
    doc: ['a.pptx', 'a.ppt', 'a.pdf', 'a.docx', 'a.md'],
    image: ['a.jpg', 'a.png', 'a.svg', 'a.gif', 'a.webp', 'a.heic'],
    video: ['a.mp4', 'a.mov', 'a.mkv'],
    audio: ['a.mp3', 'a.wav', 'a.flac'],
    archive: ['a.zip', 'a.7z', 'a.tar.gz', 'a.jar'],
    font: ['a.ttf', 'a.woff2'],
    data: ['a.csv', 'a.xlsx', 'a.db', 'a.parquet'],
  }
  for (const [kind, names] of Object.entries(cases)) {
    for (const name of names) {
      assert.equal(fileKind(name), kind, `${name} should be ${kind}, not ${fileKind(name)}`)
    }
  }
})

test('summarizeKinds groups, totals and orders by frequency', () => {
  const buckets = summarizeKinds([
    { name: 'a.jpg', size: 100 },
    { name: 'b.jpg', size: 300 },
    { name: 'c.png', size: 0 },
    { name: 'readme.md', size: 10 },
  ])
  assert.deepEqual(buckets.map((b) => b.kind), ['image', 'doc'], 'most common kind first')
  assert.equal(buckets[0].count, 3)
  assert.equal(buckets[0].bytes, 400)
  assert.deepEqual(buckets[0].examples, ['a.jpg', 'b.jpg', 'c.png'])
})

test('summarizeKinds caps examples so an overview stays an overview', () => {
  const entries = Array.from({ length: 50 }, (_, i) => ({
    name: `f${String(i).padStart(2, '0')}.png`,
    size: 1,
  }))
  const buckets = summarizeKinds(entries)
  assert.equal(buckets[0].count, 50, 'the COUNT is exact')
  assert.equal(buckets[0].examples.length, 4, 'only the samples are capped')
})

test('formatSize picks a unit a person can read', () => {
  assert.equal(formatSize(0), '0 B')
  assert.equal(formatSize(512), '512 B')
  assert.equal(formatSize(2048), '2.0 KB')
  assert.equal(formatSize(3 * 1024 * 1024), '3.0 MB')
  assert.equal(formatSize(2.5 * 1024 * 1024 * 1024), '2.50 GB')
})

test('findMarkers spots the files that identify what a folder is', () => {
  assert.deepEqual(
    findMarkers(['src', 'package.json', 'README.md', 'photo.jpg']),
    ['README.md', 'package.json'],
  )
  assert.deepEqual(findMarkers(['notes.txt']), [])
  // A WeChat mini-program is identified by this file alone — its absence from
  // the list would have left a real folder with no markers at all.
  assert.deepEqual(findMarkers(['project.config.json', 'app.json']), ['app.json', 'project.config.json'])
})

/** The context shape every tool receives, with approvals auto-granted. */
function toolContext(cwd) {
  return {
    cwd,
    signal: new AbortController().signal,
    callId: 'test',
    requestApproval: async () => true,
  }
}

test('list describes a directory instead of dumping its names', async () => {
  const root = await mkdtemp(joinPath(os.tmpdir(), 'harness-list-'))
  try {
    await mkdir(joinPath(root, '风景摄影'), { recursive: true })
    await mkdir(joinPath(root, '图标'), { recursive: true })
    await mkdir(joinPath(root, 'node_modules'), { recursive: true })
    await writeFile(joinPath(root, 'README.md'), 'hello')
    await writeFile(joinPath(root, 'package.json'), '{}')
    await writeFile(joinPath(root, '风景摄影', 'a.jpg'), 'x'.repeat(2048))
    await writeFile(joinPath(root, '风景摄影', 'b.jpg'), 'x'.repeat(1024))
    await writeFile(joinPath(root, '图标', 'i.png'), 'x')
    await writeFile(joinPath(root, 'node_modules', 'junk.js'), 'x')

    const r = await listTool.execute({ path: root }, toolContext(root))
    assert.ok(!r.isError, `list errored: ${r.content}`)

    // The whole point of the tool: what the model gets back is a SHAPE, so that
    // "explain this folder" stops being a synthesis task it cannot perform.
    assert.match(r.content, /风景摄影\/ — 2 files/)
    assert.match(r.content, /5 files/)
    // Where the files live is part of the shape: the root holds two loose files
    // AND two directories, and saying only "5 files" would let the model report
    // that everything sits inside those directories.
    assert.match(r.content, /2 files directly here, 2 subdirectories/)
    assert.match(r.content, /File kinds \(most common first\)/)
    assert.match(r.content, /image\s+3 files/)
    assert.match(r.content, /Marker files at the top level: README\.md, package\.json/)
    // Noise is named and excluded, not silently walked — and not counted.
    assert.match(r.content, /Skipped \(dependency\/build noise/)
    assert.match(r.content, /node_modules\//)
    assert.doesNotMatch(r.content, /junk\.js/, 'node_modules contents must not be walked')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

console.log('\nrepo map (L0 deterministic project facts)')

test('parsePomXml reads the project artifactId, not the parent block', () => {
  // The bug this pins: the FIRST <artifactId> in a pom is the parent's, so a
  // naive read names every Spring Boot project "spring-boot-starter-parent".
  const pom = `<?xml version="1.0"?>
<project>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.2.5</version>
  </parent>
  <groupId>com.example</groupId>
  <artifactId>recipe-backend</artifactId>
  <version>0.0.1</version>
  <packaging>jar</packaging>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-web</artifactId>
    </dependency>
    <dependency>
      <groupId>com.baomidou</groupId>
      <artifactId>mybatis-plus-boot-starter</artifactId>
    </dependency>
    <dependency>
      <groupId>junit</groupId>
      <artifactId>junit</artifactId>
      <scope>test</scope>
    </dependency>
  </dependencies>
</project>`
  const facts = parsePomXml(pom)
  assert.equal(facts.artifactId, 'recipe-backend')
  assert.equal(facts.parentArtifactId, 'spring-boot-starter-parent')
  assert.equal(facts.parentVersion, '3.2.5')
  assert.equal(facts.packaging, 'jar')
  assert.ok(facts.dependencies.some((d) => d.endsWith('mybatis-plus-boot-starter')))
  assert.ok(!facts.dependencies.some((d) => d.endsWith('junit')), 'test-scope deps are not key facts')
})

test('parsePomXml spots a multi-module parent', () => {
  const facts = parsePomXml(
    '<project><artifactId>parent</artifactId><packaging>pom</packaging>' +
      '<modules><module>backend</module><module>frontend-vue</module></modules></project>',
  )
  assert.equal(facts.packaging, 'pom')
  assert.deepEqual(facts.modules, ['backend', 'frontend-vue'])
})

test('parsePackageJson names frameworks a dependency proves', () => {
  const facts = parsePackageJson(
    JSON.stringify({
      name: 'frontend-vue',
      dependencies: { vue: '^3.4.0', axios: '^1.6.0', 'element-plus': '^2.5.0', pinia: '^2.1.0' },
      devDependencies: { vite: '^5.0.0' },
    }),
  )
  assert.equal(facts.name, 'frontend-vue')
  assert.ok(facts.frameworks.includes('Vue 3'), `frameworks: ${facts.frameworks.join(', ')}`)
  assert.ok(facts.frameworks.includes('Vite'))
  assert.ok(facts.notableDeps.includes('axios'))
  assert.ok(facts.notableDeps.includes('element-plus'))

  const bad = parsePackageJson('{not json')
  assert.deepEqual(bad.frameworks, [], 'a malformed package.json is not a crash')
})

test('parseJavaSource collects what a class IS, not every @Override', () => {
  const src = `package com.example.controller;

import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/recipe")
public class RecipeController {
    @Override
    public String toString() { return "x"; }
}
`
  const facts = parseJavaSource(src)
  assert.equal(facts.packageName, 'com.example.controller')
  assert.equal(facts.className, 'RecipeController')
  assert.equal(facts.kind, 'class')
  assert.deepEqual(facts.annotations, ['RestController'])

  const entry = parseJavaSource(
    '@SpringBootApplication\npublic class RecipeApplication {\n  public static void main(String[] a) {}\n}',
  )
  assert.deepEqual(entry.annotations, ['SpringBootApplication'])
  assert.equal(entry.hasMain, true)
})

test('buildProjectMap states facts a list of directory names cannot', async () => {
  // The trace that motivated the whole module: a Maven backend next to a Vue
  // frontend, described by the model as "frontend-vue/: 似乎是前端部分".
  const root = await mkdtemp(joinPath(os.tmpdir(), 'harness-repomap-'))
  try {
    const javaDir = joinPath(root, 'backend', 'src', 'main', 'java', 'com', 'example')
    const ctrlDir = joinPath(javaDir, 'controller')
    await mkdir(ctrlDir, { recursive: true })
    await writeFile(
      joinPath(root, 'backend', 'pom.xml'),
      `<project>
        <parent>
          <artifactId>spring-boot-starter-parent</artifactId>
          <version>3.2.5</version>
        </parent>
        <artifactId>recipe-backend</artifactId>
        <dependencies>
          <dependency><groupId>com.baomidou</groupId><artifactId>mybatis-plus-boot-starter</artifactId></dependency>
        </dependencies>
      </project>`,
    )
    await writeFile(
      joinPath(javaDir, 'RecipeApplication.java'),
      'package com.example;\n@SpringBootApplication\npublic class RecipeApplication {}\n',
    )
    await writeFile(
      joinPath(ctrlDir, 'RecipeController.java'),
      'package com.example.controller;\n@RestController\npublic class RecipeController {}\n',
    )
    await writeFile(
      joinPath(ctrlDir, 'UserController.java'),
      'package com.example.controller;\n@RestController\npublic class UserController {}\n',
    )

    const vueDir = joinPath(root, 'frontend-vue', 'src')
    await mkdir(vueDir, { recursive: true })
    await writeFile(
      joinPath(root, 'frontend-vue', 'package.json'),
      JSON.stringify({
        name: 'frontend-vue',
        dependencies: { vue: '^3.4.0', axios: '^1.0.0', 'element-plus': '^2.0.0' },
        devDependencies: { vite: '^5.0.0' },
      }),
    )
    await writeFile(joinPath(vueDir, 'App.vue'), '<template><div/></template>')
    await writeFile(joinPath(vueDir, 'main.ts'), "import { createApp } from 'vue'")
    await writeFile(joinPath(root, 'README.md'), '# AI 智能做菜系统\n\n输入食材，AI 推荐菜谱。')

    const map = await buildProjectMap(root, new AbortController().signal)
    assert.ok(map, 'a Maven + Vue folder is a project')
    const text = formatProjectMap(map).join('\n')

    // Java side: the build, the framework, and the annotation counts are facts
    // read from files, in the output, with no guesswork required of the model.
    assert.match(text, /Maven Java project/)
    assert.match(text, /recipe-backend/)
    assert.match(text, /Spring Boot 3\.2\.5/)
    assert.match(text, /mybatis-plus/)
    assert.match(text, /RecipeApplication/)
    assert.match(text, /2 @RestController \(RecipeController, UserController\)/)
    // Vue side: framework + version + deps, replacing "似乎是前端部分".
    assert.match(text, /Vue 3 \+ Vite/)
    assert.match(text, /element-plus/)
    assert.match(text, /1 \.vue/)
    assert.match(text, /README title: AI 智能做菜系统/)

    // `list` output carries the map, so whichever discovery path the model
    // takes, the facts are already in its context.
    const r = await listTool.execute({ path: root }, toolContext(root))
    assert.ok(!r.isError, `list errored: ${r.content}`)
    assert.match(r.content, /Project map/)
    assert.match(r.content, /Spring Boot 3\.2\.5/)
    assert.match(r.content, /Vue 3/)

    // Not a project: null, so a plain photo folder never sees this section.
    const plain = await mkdtemp(joinPath(os.tmpdir(), 'harness-repomap-plain-'))
    try {
      await writeFile(joinPath(plain, 'a.jpg'), 'x')
      assert.equal(await buildProjectMap(plain, new AbortController().signal), null)
    } finally {
      await rm(plain, { recursive: true, force: true })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

console.log('\nsemantic search (embedding tool)')

test('chunkFile splits by line ranges and skips blank tails', () => {
  const content = Array.from({ length: 90 }, (_, i) => `line ${i + 1}`).join('\n')
  const chunks = chunkFile('a.ts', content)
  assert.equal(chunks.length, 2)
  assert.equal(chunks[0].startLine, 1)
  assert.equal(chunks[0].endLine, 60)
  assert.equal(chunks[1].startLine, 61)
  assert.equal(chunks[1].endLine, 90)
  assert.equal(chunkFile('b.ts', '\n\n\n').length, 0, 'blank content has nothing to index')
})

test('cosineSimilarity ranks direction, not magnitude', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1)
  assert.equal(cosineSimilarity([2, 0], [1, 0]), 1)
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0, 'a zero vector matches nothing')
})

test('search matches meaning, not words: a Chinese query finds English code', async () => {
  // The gap this tool exists for: 问 "做菜流程是怎么实现的", grep 无论换什么
  // 关键词都接不上 RecipeService —— 没有共享 token。The stub embedder stands
  // in for bge-m3: recipe-ish texts one way, everything else the other.
  const root = await mkdtemp(joinPath(os.tmpdir(), 'harness-search-'))
  try {
    await writeFile(
      joinPath(root, 'RecipeService.java'),
      'public class RecipeService {\n  public Flow generateRecipeFlow(String ingredients) {\n    // validates ingredients, then composes the cooking steps\n  }\n}\n',
    )
    await writeFile(
      joinPath(root, 'travel.md'),
      'Kyoto in autumn: the temples, the maples, where to stay and what to book early.\n',
    )

    const tool = createSearchTool({
      listModels: async () => [
        { id: 'bge-m3:latest', label: 'bge-m3', provider: 'ollama', chat: false, embedding: true },
      ],
      embed: async (_model, input) => input.map((t) => (/recipe|做菜/i.test(t) ? [1, 0] : [0, 1])),
    })

    const r = await tool.execute({ query: '做菜流程是怎么实现的', path: root }, toolContext(root))
    assert.ok(!r.isError, `search errored: ${r.content}`)
    assert.match(r.content, /bge-m3/)
    assert.match(r.content, /RecipeService\.java:1-/)
    assert.doesNotMatch(r.content, /travel\.md/, 'an unrelated chunk must not outrank the match')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('search says what to do when no embedding model exists', async () => {
  const tool = createSearchTool({
    listModels: async () => [
      { id: 'gemma4:latest', label: 'gemma4', provider: 'ollama', chat: true },
    ],
    embed: async () => {
      throw new Error('must not be called when there is no embedding model')
    },
  })
  const r = await tool.execute({ query: 'x' }, toolContext(os.tmpdir()))
  assert.ok(r.isError)
  assert.match(r.content, /ollama pull bge-m3/, 'the error names the fix, not just the failure')
})

test('the registry only carries search when the provider is wired', () => {
  // Without deps the tool is absent: a dead entry still costs every step its
  // tokens in the prompt, and a small model WILL call it.
  assert.ok(!createDefaultRegistry().has('search'))
  const withSearch = createDefaultRegistry({
    search: { listModels: async () => [], embed: async () => [] },
  })
  assert.ok(withSearch.has('search'))
})

test('glob reports the real total when it has to truncate', async () => {
  // The bug this pins down: `glob` used to return 200 paths and say "200 files
  // matched", so the model told the user a 240-file folder held 200 files.
  const root = await mkdtemp(joinPath(os.tmpdir(), 'harness-glob-'))
  try {
    await Promise.all(
      Array.from({ length: 240 }, (_, i) =>
        writeFile(joinPath(root, `f${String(i).padStart(3, '0')}.txt`), 'x'),
      ),
    )
    const ctx = toolContext(root)

    const big = await globTool.execute({ pattern: '**/*.txt' }, ctx)
    assert.match(big.content, /Matched 240 files for/)
    assert.match(big.content, /Showing the 200 most recently modified/)
    assert.match(big.content, /NOT returned/, 'the model must be told this is a sample')

    const small = await globTool.execute({ pattern: '**/f000.txt' }, ctx)
    assert.match(small.content, /^1 file matched/)
    assert.doesNotMatch(small.content, /NOT returned/, 'an exact answer carries no warning')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('glob answers "list everything" with structure, not a wall of paths', async () => {
  // The bug this pins down: asked "what is in this folder", the model reaches for
  // `glob` with `*` out of habit, gets a flat list of 116 paths, and pastes them
  // back because it cannot synthesise them. `*`/`**` must therefore return the
  // same structured overview as `list`, while a specific pattern still gets the
  // flat list it needs to locate files.
  const root = await mkdtemp(joinPath(os.tmpdir(), 'harness-glob-broad-'))
  try {
    await mkdir(joinPath(root, 'src'), { recursive: true })
    await writeFile(joinPath(root, 'README.md'), 'hi')
    await writeFile(joinPath(root, 'package.json'), '{}')
    await writeFile(joinPath(root, 'src', 'a.ts'), 'x')
    await writeFile(joinPath(root, 'src', 'b.ts'), 'x')
    await writeFile(joinPath(root, 'photo.jpg'), 'x')
    const ctx = toolContext(root)

    const broad = await globTool.execute({ pattern: '*' }, ctx)
    assert.ok(!broad.isError, `broad glob errored: ${broad.content}`)
    assert.match(broad.content, /structured overview instead of a flat list/)
    assert.match(broad.content, /File kinds \(most common first\)/)
    assert.match(broad.content, /code\s+2 files/, 'the two .ts files are grouped, not listed')
    assert.doesNotMatch(broad.content, /\bsrc[\\/]a\.ts\b/, 'a flat path wall must not come back')

    const specific = await globTool.execute({ pattern: '**/*.ts' }, ctx)
    assert.ok(!specific.isError)
    assert.match(specific.content, /^2 files matched/)
    assert.doesNotMatch(specific.content, /structured overview/, 'a specific pattern stays a flat list')
    assert.match(specific.content, /a\.ts/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('every scanning tool agrees on what counts as noise', async () => {
  // The bug: a real project carried 2,069 files under `.workbuddy/` (Chromium
  // profiles for browser automation) — 90% of its 206.7 MB. `glob`/`grep`/`list`
  // each had their own (short) skip list, so a search swept 2,572 files, buried
  // every source file, and the model reported that the code did not exist.
  assert.ok(NOISE_DIRS.has('.workbuddy'), 'browser-automation profiles must be skipped')
  for (const name of ['.git', 'node_modules', '.idea', 'target', 'dist']) {
    assert.ok(NOISE_DIRS.has(name), `${name} must be skipped`)
  }

  const root = await mkdtemp(joinPath(os.tmpdir(), 'harness-noise-'))
  try {
    await mkdir(joinPath(root, '.workbuddy', 'cdp-profile'), { recursive: true })
    await mkdir(joinPath(root, 'src'), { recursive: true })
    await writeFile(joinPath(root, '.workbuddy', 'cdp-profile', 'Cache.bin'), 'cache')
    await writeFile(joinPath(root, 'src', 'Main.java'), 'public class Main {}\n')
    const ctx = toolContext(root)

    const g = await globTool.execute({ pattern: '**/*' }, ctx)
    assert.match(g.content, /Main\.java/, 'the source file must be reported')
    assert.doesNotMatch(g.content, /Cache\.bin|cdp-profile/, 'the profile must not be walked')

    const s = await grepTool.execute({ pattern: 'class Main' }, ctx)
    assert.match(s.content, /Main\.java/)
    assert.doesNotMatch(s.content, /Cache\.bin/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("grep restates a model's English search logic as a real regex", async () => {
  // Verbatim from session 6b36e419 turn 11: the model searched
  // `AI OR retry OR error OR fail AND (dish OR order)`. That is a valid regex,
  // so it silently looked for that literal sentence, found nothing, and told the
  // user the retry logic did not exist — while `maxAttempts` sat in the tree.
  const root = await mkdtemp(joinPath(os.tmpdir(), 'harness-grep-logic-'))
  try {
    await writeFile(joinPath(root, 'A.java'), '// AI retry dish handling\n')
    await writeFile(joinPath(root, 'B.java'), '// AI but no food noun here\n')
    const r = await grepTool.execute({ pattern: 'AI OR retry AND dish' }, toolContext(root))
    assert.ok(!r.isError, `errored: ${r.content}`)
    assert.match(r.content, /interpreted/, 'the rewrite must be stated, not silent')
    assert.match(r.content, /alternation|OR becomes/)
    assert.match(r.content, /A\.java/, 'the translated expression must actually match')
    assert.doesNotMatch(r.content, /B\.java/, 'AND means every part is required, not any')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('grep says what to try next instead of only "no matches"', async () => {
  // "No matches" is where a small model gives up and asks the user to paste the
  // file. Each line must be a concrete next move.
  const root = await mkdtemp(joinPath(os.tmpdir(), 'harness-grep-miss-'))
  try {
    // The Chinese tip is evidence-led, so the fixture must actually be Chinese:
    // the model searches English words and the source is not written in them.
    await writeFile(joinPath(root, 'a.ts'), '// 这是中文注释\nconst x = 1\n')
    const r = await grepTool.execute({ pattern: 'nowhere_in_this_file' }, toolContext(root))
    assert.match(r.content, /No matches/)
    assert.match(r.content, /ignoreCase/, 'the case mismatch is the one nobody thinks of')
    assert.match(r.content, /WRITTEN IN CHINESE/, 'a Chinese project needs a Chinese suggestion')
    assert.match(r.content, /重试/, 'and the concrete term, not just the idea')
    assert.match(r.content, /list/, 'point at the layout before searching again')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('grep reaches files when the directory is inside the glob', async () => {
  // Live false negative (session 6b36e419). The model sent
  //   grep({ glob: "D:/idea/work/project0914/dish-service/src/**/*.java",
  //          pattern: "重试" })
  // The filter was tested against a base name and a working-directory relative
  // path, so an absolute glob matched neither, zero files were scanned, and the
  // tool answered "No matches ... in 0 files" -- which the model relayed as
  // "that feature is not implemented", while 18 matches sat in the tree.
  const root = await mkdtemp(joinPath(os.tmpdir(), 'harness-grep-globroot-'))
  try {
    const nested = joinPath(root, 'svc', 'src', 'main', 'ai')
    await mkdir(nested, { recursive: true })
    await writeFile(joinPath(nested, 'Gen.java'), '// 重试两次\n')
    await writeFile(joinPath(root, 'package.json'), '{}\n')

    const absolute = joinPath(root, 'svc', 'src', '**', '*.java').split('\\').join('/')
    const r = await grepTool.execute({ glob: absolute, pattern: '重试' }, toolContext(root))
    assert.ok(!r.isError, `errored: ${r.content}`)
    assert.match(r.content, /Gen\.java/, 'the glob names the directory, so the search must happen')
    assert.doesNotMatch(r.content, /in 0 files/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a glob that excludes everything says nothing was searched', async () => {
  // The distinction is the whole point. "No matches" tells the model the term is
  // absent from the code; the truth is that no file was ever opened. A model
  // acts on the first reading and reports an existing feature as missing.
  const root = await mkdtemp(joinPath(os.tmpdir(), 'harness-grep-empty-'))
  try {
    await writeFile(joinPath(root, 'a.java'), '重试\n')
    const r = await grepTool.execute({ glob: '*.rs', pattern: '重试' }, toolContext(root))
    assert.match(r.content, /Nothing was searched/)
    assert.match(r.content, /NOT evidence/)
    assert.doesNotMatch(r.content, /No matches/, 'the wrong reading must not be offered')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('splitGlobRoot only splits when the glob names a directory', () => {
  assert.deepEqual(splitGlobRoot('src/**/*.java'), { root: 'src', glob: '**/*.java' })
  assert.deepEqual(splitGlobRoot('D:/x/svc/**/*.java'), { root: 'D:/x/svc', glob: '**/*.java' })
  assert.deepEqual(splitGlobRoot('D:\\x\\svc\\**\\*.java'), { root: 'D:/x/svc', glob: '**/*.java' })
  // No directory component: the filter must be left alone.
  assert.equal(splitGlobRoot('**/*.java'), null)
  assert.equal(splitGlobRoot('*.ts'), null)
  assert.equal(splitGlobRoot('**/*'), null)
  // A directory plus a catch-all still means "everything under here", so the
  // root is narrowed and the remainder matches the rest.
  assert.deepEqual(splitGlobRoot('src/**'), { root: 'src', glob: '**' })
  assert.deepEqual(splitGlobRoot('a/*.java'), { root: 'a', glob: '*.java' })
})

test('read serves the right file when only the directory is wrong', async () => {
  // Live failure (session 6b36e419): the model assembled a directory tree by
  // hand and asked for `.../com/apesource/AiDishGenerator.java`, one level short
  // of where the file lives. read answered "not found" plus a suggestion — but
  // flagged isError, which the model read as a dead end. It abandoned the file
  // and never saw the retry logic inside it, then told the user the code did not
  // exist. A correction the model will not act on is not a correction.
  const root = await mkdtemp(joinPath(os.tmpdir(), 'harness-read-path-'))
  try {
    await mkdir(joinPath(root, 'com', 'apesource', 'dishservice', 'ai'), { recursive: true })
    await writeFile(joinPath(root, 'com', 'apesource', 'dishservice', 'ai', 'Gen.java'), 'RETRY_LOGIC\n')
    const ctx = toolContext(root)
    const mistyped = joinPath(root, 'com', 'apesource', 'Gen.java')

    // Exactly one candidate: the read is unambiguous, so it must simply work.
    const r = await readTool.execute({ path: mistyped }, ctx)
    assert.ok(!r.isError, `should have recovered, got: ${String(r.content).slice(0, 200)}`)
    assert.match(r.content, /does not exist/, 'the correction must be stated, not silent')
    assert.match(r.content, /RETRY_LOGIC/, 'the model must actually receive the file')

    // Two candidates: that is genuine ambiguity and stays an error.
    await mkdir(joinPath(root, 'com', 'apesource', 'other'), { recursive: true })
    await writeFile(joinPath(root, 'com', 'apesource', 'other', 'Gen.java'), 'SOMETHING_ELSE\n')
    const ambiguous = await readTool.execute({ path: mistyped }, ctx)
    assert.equal(ambiguous.isError, true, 'an ambiguous name must not be guessed')
    assert.match(ambiguous.content, /different files are named/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the Chinese tip stays silent for an English-only project', async () => {
  // A hint that fires when it does not apply is noise the model learns to skip.
  const root = await mkdtemp(joinPath(os.tmpdir(), 'harness-grep-en-'))
  try {
    await writeFile(joinPath(root, 'a.ts'), 'const x = 1\n')
    const r = await grepTool.execute({ pattern: 'nowhere_in_this_file' }, toolContext(root))
    assert.match(r.content, /No matches/)
    assert.doesNotMatch(r.content, /WRITTEN IN CHINESE/, 'no CJK in the source, no Chinese tip')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a Chinese search reports no language tip of its own', async () => {
  // Once the model searches Chinese, telling it to search Chinese is a loop.
  const root = await mkdtemp(joinPath(os.tmpdir(), 'harness-grep-zh-'))
  try {
    await writeFile(joinPath(root, 'a.ts'), '// 重试\nconst x = 1\n')
    const hit = await grepTool.execute({ pattern: '重试' }, toolContext(root))
    assert.match(hit.content, /1 match/)
    assert.doesNotMatch(hit.content, /WRITTEN IN CHINESE/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('detects a claim of prior inspection made without any tool call', () => {
  // Verbatim from session 6b36e419. The model never called a tool, yet described
  // the project from memory and attributed a directory belonging to an EARLIER,
  // unrelated project to this one. detectStall missed it: the reply was long and
  // reported a negative result, so both of its guards said "this is a real answer".
  const live = {
    text: '正如我之前所分析的，在对 D:\\idea\\work\\project0914 目录进行全面的文件扫描后，我没有找到直接明确定义重试逻辑的代码。我将尝试读取几个核心文件。',
    reasoning: 'I previously listed the directory contents using `list` and then searched for keywords using `grep`.',
    userText: 'D:\\idea\\work\\project0914查看一下当前项目是如何我的项目ai做菜错误后会如何错误重试',
  }
  const verdict = detectUnbackedClaim(live)
  assert.equal(verdict.claimed, true, 'a recited answer must be flagged')
  assert.match(verdict.reason, /没有调用任何工具/)

  // The other live shape: a structural description with no reading behind it.
  assert.equal(
    detectUnbackedClaim({
      text: '根据文件结构来看，这是一个基于微服务架构的复杂应用系统。',
      reasoning: 'Based on the file structure I examined earlier.',
      userText: '帮我分析一下这个目录下的项目',
    }).claimed,
    true,
  )
})

test('stays quiet for a genuine answer and for "continue"', () => {
  // Fire too readily and the nudge becomes noise the model learns to skip — and
  // "请继续完成未完成的任务" is this user's standard way to advance a task.
  assert.equal(
    detectUnbackedClaim({
      text: 'MD5 是一种哈希算法，把任意长度的输入映射成 128 位摘要。',
      reasoning: 'The user wants a general explanation of MD5.',
      userText: '帮我写一个md5加密算法',
    }).claimed,
    false,
  )
  assert.equal(
    detectUnbackedClaim({
      text: '好的，我接着上面的第三点说。',
      reasoning: 'continuing the previous explanation',
      userText: '请继续完成未完成的任务',
    }).claimed,
    false,
  )
})

test('a request naming a path cannot be answered without a tool call', () => {
  const verdict = detectUnbackedClaim({
    text: '好的，我来看看。',
    reasoning: '',
    userText: '看看 D:\\desktop1\\论文 里有什么',
  })
  assert.equal(verdict.claimed, true)
  assert.match(verdict.reason, /具体路径/)
})

test('the correction tells the model to read rather than to ask the user', () => {
  const text = buildClaimCorrection({ reason: '说了「根据文件结构来看」，但这一轮没有调用任何工具' })
  assert.match(text, /没有调用任何工具/)
  assert.match(text, /list/)
  assert.match(text, /read/)
  assert.match(text, /grep/)
  // The failure this guards against ends with the model asking the user to paste
  // the file. The correction has to close that door explicitly.
  assert.match(text, /不要反过来要求用户提供/)
})

test('the claim guard re-invokes the model instead of ending the turn', async () => {
  // Unit-testing the detector is not enough: it has to be WIRED IN. A stub
  // adapter scripts the failure (a claim, no tool call) and then a plain reply.
  // If the guard works, the model is asked again — so the adapter is called
  // twice and step 1 must not end the turn.
  class StubAdapter {
    constructor(script) {
      this.script = script
      this.calls = 0
    }
    get provider() {
      return 'stub'
    }
    async listModels() {
      return []
    }
    async *stream() {
      const step = this.script[Math.min(this.calls, this.script.length - 1)]
      this.calls++
      for (const chunk of step) yield chunk
    }
  }

  const adapter = new StubAdapter([
    [
      { type: 'block-start', index: 0, kind: 'text' },
      { type: 'text-delta', text: '正如我之前所分析的，在对项目目录进行全面的文件扫描后，我没有找到重试逻辑。' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
    [
      { type: 'block-start', index: 0, kind: 'text' },
      { type: 'text-delta', text: '好的。' },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  ])

  const events = []
  await runTurn({
    cwd: '.',
    model: 'stub',
    config: { ...DEFAULT_CONFIG, model: 'stub', maxStepsPerTurn: 6 },
    adapter,
    tools: createDefaultRegistry(),
    history: [],
    // No path, so only the claim patterns can fire.
    userText: '帮我分析一下这个项目',
    events: {
      onEvent: (e) => events.push(e),
      onPhase: () => {},
      requestApproval: async () => true,
    },
    signal: new AbortController().signal,
  })

  const corrections = events.filter(
    (e) => e.type === 'user/message' && e.data.message.source?.name === 'claim-guard',
  )
  assert.equal(adapter.calls, 2, 'the model must be asked again, not cut off')
  assert.equal(corrections.length, 1, 'exactly one correction, then it stops nudging')
  const endings = events.filter((e) => e.type === 'step/end').map((e) => e.data.reason.kind)
  assert.equal(endings[0], 'tool-calls', 'step 1 must continue, not finish the turn')
})

console.log('\nself-review gate')

// Awaited one at a time rather than left to `pending`. Every case below is
// async, so without the awaits the header would print with nothing under it and
// the results would surface under whichever heading happened to print next —
// a report that misplaces its own evidence.

/**
 * A registry with one hermetic tool.
 *
 * The gate tests must not touch the disk. What is under test is the loop's exit
 * condition, and a real `read` would make the assertion depend on a file that
 * has nothing to do with it. One tool that always succeeds is enough to make
 * `toolsRanThisTurn` true, which is the only fact the gate reads.
 */
function gateTools() {
  const registry = new ToolRegistry()
  registry.register({
    name: 'stub_read',
    description: 'Read a stub file.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    async execute() {
      return { content: 'stub contents' }
    },
  })
  return registry
}

/** A scripted step that emits text and stops, with no tool call. */
const textStep = (text) => [
  { type: 'block-start', index: 0, kind: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'finish', reason: { kind: 'stop' } },
]

/** A scripted step that emits one tool call and stops. */
const toolStep = (callId) => [
  { type: 'tool-call-delta', index: 0, callId, name: 'stub_read', argumentsDelta: '{"path":"a.txt"}' },
  { type: 'finish', reason: { kind: 'tool-calls' } },
]

/** The reviewer's reply, in the JSON shape `buildReviewPrompt` asks for. */
const reviewSays = (verdict, findings = []) =>
  JSON.stringify({ verdict, summary: `verdict is ${verdict}`, findings })

/** The gate's verdicts, in order, exactly as the log recorded them. */
const reviewOutcomes = (events) =>
  events.filter((e) => e.type === 'review/result').map((e) => e.data.outcome)

/**
 * One adapter driving both halves of the gate.
 *
 * The coding model and the reviewer are told apart by `generate.tools`: the loop
 * always offers the registry, while the reviewer is handed an empty one on
 * purpose (it audits the record instead of re-running the work). Dispatching on
 * that keeps the two scripts independent, so a test states what the reviewer
 * replies without having to interleave it into the model's step list by hand.
 */
class GateAdapter {
  constructor({ steps, reviews }) {
    this.steps = steps
    this.reviews = reviews
    this.stepCalls = 0
    this.reviewCalls = 0
  }
  get provider() {
    return 'stub'
  }
  async listModels() {
    return []
  }
  async *stream(generate) {
    if (generate.tools.length === 0) {
      const scripted = this.reviews[Math.min(this.reviewCalls, this.reviews.length - 1)]
      this.reviewCalls++
      if (scripted.error) {
        // The reviewer itself failed to run. `runSelfReview` reports that as
        // null rather than as a verdict, which is a different thing.
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { message: 'reviewer exploded', code: 'STREAM_FAILED' } },
        }
        return
      }
      yield { type: 'block-start', index: 0, kind: 'text' }
      yield { type: 'text-delta', index: 0, text: scripted }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const step = this.steps[Math.min(this.stepCalls, this.steps.length - 1)]
    this.stepCalls++
    for (const chunk of step) yield chunk
  }
}

/** Run a whole turn against the stub and hand back everything it appended. */
async function runGateTurn({ steps, reviews, userText, maxSteps = 8 }) {
  const adapter = new GateAdapter({ steps, reviews })
  const events = []
  await runTurn({
    cwd: '.',
    model: 'stub',
    config: { ...DEFAULT_CONFIG, model: 'stub', maxStepsPerTurn: maxSteps },
    adapter,
    tools: gateTools(),
    history: [],
    userText,
    events: {
      onEvent: (e) => events.push(e),
      onPhase: () => {},
      requestApproval: async () => true,
    },
    signal: new AbortController().signal,
  })
  return {
    adapter,
    events,
    end: events.find((e) => e.type === 'turn/end'),
    /** One entry per consultation, in order. Empty means never consulted. */
    verdicts: reviewOutcomes(events),
    corrections: (name) =>
      events.filter((e) => e.type === 'user/message' && e.data.message.source?.name === name),
  }
}

await test('a turn that did work ends when the reviewer agrees, not when tools stop', async () => {
  // The regression this locks: the request names a path, so before the
  // turn-level PATH_HINT fix a turn like this died as UNBACKED_CLAIM no matter
  // how much work it did. A tool ran and the reviewer said match — so it ends.
  const { adapter, events, end, corrections, verdicts } = await runGateTurn({
    steps: [toolStep('call-1'), textStep('目录里有两个文件：a.txt 和 b.txt。')],
    reviews: [reviewSays('match', [{ requirement: '列出目录', status: 'met', evidence: 'stub_read' }])],
    userText: '看看 D:\\desktop1\\论文 里有什么',
  })

  assert.equal(end.data.reason.kind, 'stop', 'a reviewed turn ends as stop')
  assert.equal(adapter.stepCalls, 2, 'one tool step, then one answering step')
  assert.equal(adapter.reviewCalls, 1, 'the gate reviewed exactly once')
  assert.deepEqual(verdicts, ['match'], 'the verdict is in the log, not only in memory')
  assert.deepEqual(corrections('review-gate'), [], 'a passing review corrects nothing')
  assert.deepEqual(
    corrections('claim-guard'),
    [],
    'a path in the request must not kill a turn that actually ran tools',
  )

  // What the user sees is the model's answer, not the reviewer's JSON.
  const said = events.filter((e) => e.type === 'step/text').map((e) => e.data.text).join('')
  assert.match(said, /a\.txt 和 b\.txt/)
})

await test('a rejected review is fed back and the next attempt can pass', async () => {
  const { adapter, end, corrections, verdicts } = await runGateTurn({
    steps: [
      toolStep('call-1'),
      textStep('任务已经完成了。'),
      toolStep('call-2'),
      textStep('报告写好了，这次真的完成了。'),
    ],
    reviews: [
      reviewSays('partial', [{ requirement: '创建报告', status: 'missing', evidence: '没有 write 调用' }]),
      reviewSays('match', [{ requirement: '创建报告', status: 'met', evidence: '已写入 report.md' }]),
    ],
    userText: '分析这个项目并写一份报告',
  })

  const gate = corrections('review-gate')
  assert.equal(gate.length, 1, 'exactly one correction, then the second review passed')
  assert.match(
    gate[0].data.message.content[0].text,
    /创建报告/,
    'the open finding is named back to the model',
  )
  assert.equal(adapter.stepCalls, 4, 'the model got to work again instead of the turn ending')
  assert.deepEqual(verdicts, ['partial', 'match'], 'both rounds are recorded, in order')
  assert.equal(end.data.reason.kind, 'stop', 'the turn ends once the reviewer agrees')
})

await test('a reviewer that never agrees hands the findings over instead of faking success', async () => {
  const stallReview = reviewSays('mismatch', [
    { requirement: '跑通测试', status: 'missing', evidence: '没有看到测试输出' },
  ])
  const { adapter, end, corrections, verdicts } = await runGateTurn({
    steps: [
      toolStep('call-1'),
      textStep('全部完成了。'),
      textStep('全部完成了。'),
      textStep('全部完成了。'),
      textStep('全部完成了。'),
    ],
    reviews: [stallReview, stallReview, stallReview, stallReview],
    userText: '改掉这个 bug 并跑测试',
  })

  assert.equal(end.data.reason.kind, 'error', 'the turn is reported as unfinished')
  assert.equal(end.data.reason.failure.code, 'REVIEW_INCOMPLETE')
  // The answer after the correction is byte-identical to the one already
  // reviewed: the correction provably changed nothing, so the loop escalates
  // at the SECOND verdict instead of burning all remaining rounds to reach
  // the same place.
  assert.equal(adapter.reviewCalls, 2, 'an unchanged answer escalates immediately')
  assert.equal(corrections('review-gate').length, 1, 'one chance, then it escalates')
  assert.deepEqual(
    verdicts,
    ['mismatch', 'mismatch'],
    'every refusal is on the record, including the one that stopped it',
  )
  // The message has to carry what is missing, not just the fact of failure.
  assert.match(end.data.reason.failure.message, /跑通测试/)
})

await test('identical objections to a CHANGED answer converge instead of looping', async () => {
  // Live trace (2026-09-24): the model searched the project, concluded the
  // MySQL credentials live in Nacos, and said so in detail — and the reviewer
  // rejected three times with the same finding whose own evidence read
  // "(已完成)". The reviewer is the same model as the worker; once it repeats
  // an objection to a re-written answer, re-asking adds nothing.
  const driftReview = reviewSays('partial', [
    {
      requirement: 'Search YAML files for the MySQL password',
      status: 'partial',
      evidence: 'the direct search concluded the credentials are in Nacos (已完成)',
    },
  ])
  const { adapter, end, corrections, verdicts } = await runGateTurn({
    steps: [
      toolStep('call-1'),
      textStep('我在 yaml 里没有找到，密码应该是 Nacos 配置的。'),
      textStep('补充细节：搜过 application.yml、bootstrap.yml 和 config 目录，都没有，确认来自 Nacos。'),
    ],
    reviews: [driftReview, driftReview],
    userText: '项目里的 MySQL 密码是多少',
  })

  assert.equal(adapter.reviewCalls, 2, 'reviewed twice, then converged')
  assert.equal(corrections('review-gate').length, 1, 'one correction, not three')
  assert.deepEqual(verdicts, ['partial', 'partial'])
  assert.equal(
    end.data.reason.kind,
    'stop',
    'a repeated objection to a changed answer accepts the answer the user can see',
  )
})

await test('a conversational answer is not routed through the gate', async () => {
  // The boundary, pinned so nobody removes it by accident: an evidence-based
  // reviewer answers "无法确认" to a purely conversational reply, so gating one
  // would correct a perfectly good answer until the rounds ran out.
  const { adapter, end, verdicts } = await runGateTurn({
    steps: [textStep('MD5 是一种哈希算法，把任意长度的输入映射成 128 位摘要。')],
    reviews: [reviewSays('mismatch')],
    userText: '什么是 MD5',
  })

  assert.equal(adapter.reviewCalls, 0, 'no tool ran, so there was nothing to review')
  assert.deepEqual(
    verdicts,
    ['skipped'],
    'the log says the gate stood down, which is not the same as it never running',
  )
  assert.equal(end.data.reason.kind, 'stop', 'the answer is returned as-is')
})

await test('a guard out of nudges defers to the reviewer when the turn did work', async () => {
  const denial = '我无法直接访问您的本地文件系统。'
  const { adapter, end, corrections, verdicts } = await runGateTurn({
    steps: [toolStep('call-1'), textStep(denial), textStep(denial), textStep(denial)],
    reviews: [reviewSays('match')],
    userText: '分析这个项目',
  })

  assert.equal(corrections('capability-guard').length, 2, 'the guard still gets its two nudges')
  assert.equal(adapter.stepCalls, 4, 'the third denial did not end the turn')
  assert.equal(adapter.reviewCalls, 1, 'it was deferred to the reviewer instead')
  assert.deepEqual(verdicts, ['match'], 'the deferral shows up as a real consultation')
  assert.equal(
    end.data.reason.kind,
    'stop',
    'work behind the turn means the guard has no authority to kill it',
  )
})

await test('a guard out of nudges with no work still reports the original failure', async () => {
  // The other half of the deferral rule: with nothing behind it there is no work
  // to review, so the guard's diagnosis stands and the loop does not spend a
  // reviewer call on an empty turn.
  const denial = '我无法直接访问您的本地文件系统。'
  const { adapter, end, verdicts } = await runGateTurn({
    steps: [textStep(denial), textStep(denial), textStep(denial)],
    reviews: [reviewSays('match')],
    userText: '分析这个项目',
  })

  assert.equal(end.data.reason.kind, 'error')
  assert.equal(end.data.reason.failure.code, 'CAPABILITY_DENIED')
  assert.equal(adapter.reviewCalls, 0, 'nothing ran, so there was nothing to review')
  assert.deepEqual(
    verdicts,
    [],
    'the guard ended the turn before the gate was ever consulted — no verdict at all',
  )
})

await test('a reviewer that fails to run lets the turn end instead of trapping it', async () => {
  // `runSelfReview` returns null when the reviewer itself errored or was
  // aborted. That is not a rejection: holding the turn open would punish the
  // model for a harness failure, on a turn that may well be finished.
  const { adapter, end, verdicts } = await runGateTurn({
    steps: [toolStep('call-1'), textStep('分析完了，这个项目有三个模块。')],
    reviews: [{ error: true }],
    userText: '分析这个项目',
  })

  assert.equal(adapter.reviewCalls, 1, 'the gate did run — this is not the no-tool path')
  assert.deepEqual(verdicts, ['unavailable'], 'recorded as unavailable, never as a pass')
  assert.equal(end.data.reason.kind, 'stop', 'a broken reviewer does not hold the turn open')
})

console.log('\npreload / IPC channel agreement')

test('preload CH table matches IPC in shared/ipc.js', () => {
  // src/main/preload.ts cannot import the channel names (it must stay a
  // self-contained CommonJS file so Electron can require() it), so the names are
  // duplicated there. This assertion is what keeps the two copies honest: rename
  // a channel in src/shared/ipc.ts without updating preload.ts and the build
  // fails here instead of silently breaking IPC at runtime.
  const preloadSrc = readFileSync(new URL('../src/main/preload.ts', import.meta.url), 'utf8')
  const table = preloadSrc.slice(preloadSrc.indexOf('const CH = {'), preloadSrc.indexOf('} as const'))
  const inlined = new Set([...table.matchAll(/'([a-z]+:[a-z-]+)'/g)].map((m) => m[1]))

  const canonical = new Set([...Object.values(IPC.invoke), ...Object.values(IPC.push)])

  const missing = [...canonical].filter((c) => !inlined.has(c))
  const extra = [...inlined].filter((c) => !canonical.has(c))
  assert.deepEqual(missing, [], `preload.ts is missing channels: ${missing.join(', ')}`)
  assert.deepEqual(extra, [], `preload.ts declares unknown channels: ${extra.join(', ')}`)
})

test('preload compiles to a self-contained .cjs bundle', () => {
  // Whatever else changes, the preload must stay CommonJS and dependency-free;
  // require()ing an ES module throws ERR_REQUIRE_ESM and blanks the window.
  const cjs = new URL('../dist/preload/main/preload.cjs', import.meta.url)
  assert.ok(existsSync(cjs), 'dist/preload/main/preload.cjs is missing — run npm run build:main')
  const source = readFileSync(cjs, 'utf8')
  assert.ok(!/^\s*import\s/m.test(source), 'preload.cjs contains ESM import syntax')
  assert.ok(/require\("electron"\)/.test(source), 'preload.cjs does not require electron')
})

// Settle the async assertions before reporting. Without this the async ones
// would still be in flight when the summary prints, and a rejection would be an
// unhandled promise rather than a failure.
await Promise.all(pending)

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)