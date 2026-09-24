/**
 * Ollama adapter.
 *
 * Talks to `/api/chat` (streaming NDJSON, NOT SSE) and `/api/tags` for model
 * discovery. Three Ollama specifics drive this file:
 *
 * 1. The stream is newline-delimited JSON, one object per line, with no
 *    `[DONE]` sentinel. The final object carries `done: true` plus the token
 *    counters. So the flush happens on `done`, and EOF before it is truncation.
 * 2. `message.thinking` is a SEPARATE field from `message.content` on models
 *    that expose reasoning. We map it to a `reasoning` block so the UI can
 *    collapse it and so we can drop it on replay for models that reject it.
 * 3. Tool calls arrive as a COMPLETE array on one chunk — Ollama does not
 *    stream partial tool-call arguments the way OpenAI does. But we still
 *    normalize through the same delta path so the assembler stays uniform.
 */

import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  Message,
  ModelInfo,
  StreamChunk,
  ToolDefinition,
} from '../../shared/message.js'
import { asToolCallId } from '../../shared/message.js'
import { LlmAdapter, LlmError, throwIfAborted } from './adapter.js'

export interface OllamaAdapterOptions {
  baseUrl: string
  /** Sent only when the server has no keep_alive configured. */
  keepAlive?: string
}

/** Shape of one NDJSON line from `/api/chat`. */
interface OllamaChunk {
  model?: string
  created_at?: string
  message?: {
    role?: string
    content?: string
    thinking?: string
    tool_calls?: Array<{
      function?: { name?: string; arguments?: unknown }
    }>
  }
  done?: boolean
  done_reason?: string
  /** Present only on the final object. */
  prompt_eval_count?: number
  eval_count?: number
  error?: string
}

interface OllamaTagsResponse {
  models?: Array<{
    name?: string
    model?: string
    size?: number
    details?: {
      family?: string
      parameter_size?: string
      quantization_level?: string
      families?: string[] | null
    }
  }>
}

/**
 * Model families/families that accept images. Ollama exposes this through
 * `details.families` containing a projector entry like `clip` or `mllama`.
 *
 * Only used as a FALLBACK now: `/api/show` reports capabilities explicitly, and a
 * real answer beats a name guess. Kept because `/api/show` is not available on
 * every build and a failed capability probe should degrade, not guess wrong.
 */
const VISION_FAMILY_HINTS = ['clip', 'mllama', 'llava', 'vision', 'projector']

/** Families known to support tool calling on current Ollama builds. */
const TOOL_CAPABLE_HINTS = [
  'qwen', 'llama', 'mistral', 'mixtral', 'firefunction', 'command-r',
  'granite', 'nemotron', 'hermes', 'deepseek', 'smollm', 'phi', 'gemma',
]

/**
 * Names that give away an embedding model when capabilities cannot be read.
 *
 * These show up in `/api/tags` next to chat models, so offering one in a chat
 * model picker produces a session where every single message fails with
 * `400: "…" does not support chat`.
 */
const EMBEDDING_HINTS = ['embed', 'bge', 'gte-', 'e5-', 'minilm', 'jina', 'nomic', 'snowflake-arctic']

/** How long to wait for a capability probe before falling back to name hints. */
const CAPABILITY_TIMEOUT_MS = 3_000

interface OllamaShowResponse {
  capabilities?: string[]
}

/**
 * Turn a model's reported capabilities into the flags the UI reads.
 *
 * Pure and exported so it can be asserted without a live Ollama: the interesting
 * behaviour is the fallback, and that only shows up when the probe fails.
 *
 * `capabilities` is Ollama's own list (`completion`, `tools`, `vision`,
 * `thinking`, `embedding`, `audio`). When it is present it is the answer. When it
 * is absent — an older build, or a model that would not answer — the name is the
 * only evidence left, and the honest answer for `chat` in that case is
 * `undefined` ("probably fine") rather than `true`, so the UI can distinguish
 * "known usable" from "assumed usable".
 */
export function modelFlags(input: {
  name: string
  families?: readonly string[] | null
  capabilities?: readonly string[] | null
}): Pick<ModelInfo, 'chat' | 'vision' | 'tools' | 'thinking'> {
  const nameKey = input.name.toLowerCase()
  const haystack = (input.families ?? []).join(' ').toLowerCase()
  const caps = input.capabilities

  if (caps && caps.length > 0) {
    return {
      chat: caps.includes('completion'),
      vision: caps.includes('vision'),
      tools: caps.includes('tools'),
      thinking: caps.includes('thinking'),
    }
  }

  const looksEmbedding = EMBEDDING_HINTS.some((h) => nameKey.includes(h))
  return {
    chat: looksEmbedding ? false : undefined,
    vision: VISION_FAMILY_HINTS.some((h) => haystack.includes(h) || nameKey.includes(h)),
    tools: TOOL_CAPABLE_HINTS.some((h) => nameKey.includes(h)),
    thinking: undefined,
  }
}

/**
 * Fixed block slots for the streaming response.
 *
 * Ollama announces reasoning and content independently: a chunk may carry only
 * `thinking`, only `content`, or both. Indices therefore have to be assigned
 * statically — deriving them from the current chunk makes a content-only chunk
 * claim the reasoning block's slot, and the assembler (which looks blocks up by
 * index and ignores a later delta's kind) would then append the visible answer
 * into the reasoning block, leaving the message with no text at all.
 */
const REASONING_INDEX = 0
const TEXT_INDEX = 1
/** Tool calls follow the two reserved slots so none of the three can collide. */
const TOOL_CALL_INDEX_BASE = 2

export class OllamaAdapter extends LlmAdapter {
  readonly provider = 'ollama'
  private readonly baseUrl: string
  private readonly keepAlive: string | undefined

  constructor(private readonly options: OllamaAdapterOptions) {
    super()
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.keepAlive = options.keepAlive
  }

  /**
   * Ollama expects `tools[].function.parameters` as a plain JSON Schema object,
   * which is exactly what `ToolDefinition.parameters` already is. The base class
   * default wraps it in the OpenAI envelope, which is also accepted — so we only
   * need to strip anything the server would reject.
   */
  protected override encodeTools(tools: readonly ToolDefinition[]): unknown[] {
    return tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }))
  }

  override async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/api/tags`, signal ? { signal } : {})
    } catch (cause) {
      throw new LlmError(
        `Cannot reach Ollama at ${this.baseUrl}. Is it running?`,
        'CONNECTION_REFUSED',
        { cause },
      )
    }
    if (!response.ok) {
      throw new LlmError(
        `Ollama returned ${response.status} for /api/tags`,
        'PROVIDER_ERROR',
        { status: response.status },
      )
    }
    const body = (await response.json()) as OllamaTagsResponse
    const models = body.models ?? []
    const names = models
      .map((m) => m.name ?? m.model ?? '')
      .filter((name) => name.length > 0)

    // Ask each model what it can do. This is one extra round trip per model, so
    // it runs in parallel and is allowed to fail: a build without `/api/show`, or
    // a model that will not answer, falls back to the name heuristics below
    // rather than blocking the picker.
    const capabilities = await Promise.all(
      names.map(async (name) => {
        try {
          const probe = await fetch(`${this.baseUrl}/api/show`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: name }),
            signal: signal ?? AbortSignal.timeout(CAPABILITY_TIMEOUT_MS),
          })
          if (!probe.ok) return null
          const detail = (await probe.json()) as OllamaShowResponse
          return Array.isArray(detail.capabilities) ? detail.capabilities : null
        } catch {
          return null
        }
      }),
    )

    return names.map((name, i) => {
      const raw = models.find((m) => (m.name ?? m.model) === name)
      // Some Ollama builds report `families: null` instead of omitting it.
      const families = raw?.details?.families ?? []
      return {
        id: name,
        label: name,
        provider: this.provider,
        ...modelFlags({ name, families, capabilities: capabilities[i] }),
      } satisfies ModelInfo
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    throwIfAborted(options.signal)

    const body = this.buildRequestBody(options)

    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(options.signal ? { signal: options.signal } : {}),
      })
    } catch (cause) {
      if (options.signal?.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted' } }
        return
      }
      throw new LlmError(
        `Cannot reach Ollama at ${this.baseUrl}. Is it running?`,
        'CONNECTION_REFUSED',
        { cause },
      )
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      // Ollama's 400 for an embedding model is accurate but opaque to anyone who
      // does not already know that `bge-m3` is not a chat model. The picker can
      // now mark those, but a stale selection or an older build still gets here,
      // and "does not support chat" should say what to do about it.
      if (/does not support (chat|completion)/i.test(detail)) {
        throw new LlmError(
          `「${options.model}」是嵌入模型（只用来做向量检索），不能对话。` +
            '请在左侧「模型」里换一个对话模型，例如 gemma4、qwen 或 llama 系列。',
          'MODEL_NOT_CHAT_CAPABLE',
          { status: response.status },
        )
      }
      throw new LlmError(
        `Ollama returned ${response.status}${detail ? `: ${detail.slice(0, 400)}` : ''}`,
        response.status === 404 ? 'MODEL_NOT_FOUND' : 'PROVIDER_ERROR',
        { status: response.status },
      )
    }
    if (!response.body) {
      throw new LlmError('Ollama returned an empty body', 'EMPTY_RESPONSE')
    }

    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    /** Leftover bytes that did not end on a newline yet. */
    let buffer = ''
    let sawDone = false
    let toolCallIndex = 0
    /** Ollama reports usage only on the last object; hold finish until then. */
    let pendingReason: FinishReason | undefined
    let sawAnyBlock = false

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // Ollama writes one complete JSON object per line. Split on newlines and
        // keep the trailing partial line in the buffer.
        let newlineIndex: number
        while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIndex).trim()
          buffer = buffer.slice(newlineIndex + 1)
          if (line.length === 0) continue

          let chunk: OllamaChunk
          try {
            chunk = JSON.parse(line) as OllamaChunk
          } catch {
            // A malformed line is a real protocol violation, not something to skip.
            throw new LlmError(`Malformed NDJSON line from Ollama: ${line.slice(0, 200)}`, 'INVALID_STREAM')
          }

          if (chunk.error) {
            throw new LlmError(chunk.error, 'PROVIDER_ERROR')
          }

          const text = chunk.message?.content ?? ''
          const reasoning = chunk.message?.thinking ?? ''

          // Reasoning and text land in fixed, distinct slots — see the index
          // constants above for why they cannot be derived per chunk.
          if (reasoning.length > 0) {
            sawAnyBlock = true
            yield { type: 'block-start', index: REASONING_INDEX, kind: 'reasoning' }
            yield { type: 'reasoning-delta', index: REASONING_INDEX, text: reasoning }
          }

          if (text.length > 0) {
            sawAnyBlock = true
            yield { type: 'block-start', index: TEXT_INDEX, kind: 'text' }
            yield { type: 'text-delta', index: TEXT_INDEX, text }
          }

          const calls = chunk.message?.tool_calls ?? []
          if (calls.length > 0) {
            sawAnyBlock = true
            for (const call of calls) {
              // Tool calls start after the reserved reasoning/text slots so they
              // cannot collide with either.
              const index = TOOL_CALL_INDEX_BASE + toolCallIndex++
              const name = call.function?.name ?? ''
              if (name.length === 0) continue
              // Ollama gives a complete arguments object, not a string. Assign a
              // synthetic id because the wire carries none.
              const callId = asToolCallId(`ollama-call-${index}-${Date.now().toString(36)}`)
              yield { type: 'block-start', index, kind: 'tool-call' }
              yield { type: 'tool-call-delta', index, callId, name, argumentsDelta: JSON.stringify(call.function?.arguments ?? {}) }
            }
          }

          if (chunk.done === true) {
            sawDone = true
            pendingReason = mapDoneReason(chunk.done_reason, toolCallIndex > 0)
            const promptCount = chunk.prompt_eval_count ?? 0
            const evalCount = chunk.eval_count ?? 0
            yield {
              type: 'usage',
              usage: {
                inputTokens: promptCount,
                outputTokens: evalCount,
                totalTokens: promptCount + evalCount,
              },
            }
            break
          }
        }
        if (sawDone) break
      }
    } catch (cause) {
      if (options.signal?.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted' } }
        return
      }
      throw cause
    } finally {
      reader.releaseLock?.()
    }

    if (!sawDone) {
      // The connection dropped mid-generation. Reporting `stop` here would make
      // a truncated answer look complete.
      throw new LlmError(
        'Ollama stream ended without a done flag — response was truncated',
        'STREAM_CLOSED',
      )
    }

    if (!sawAnyBlock) {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'model produced no content', code: 'EMPTY_RESPONSE' } } }
      return
    }

    yield { type: 'finish', reason: pendingReason ?? { kind: 'stop' } }
  }

  private buildRequestBody(options: GenerateOptions): Record<string, unknown> {
    const messages: unknown[] = []
    if (options.systemPrompt && options.systemPrompt.trim().length > 0) {
      messages.push({ role: 'system', content: options.systemPrompt })
    }
    for (const message of options.messages) {
      messages.push(...encodeMessage(message))
    }

    return {
      model: options.model,
      messages,
      stream: true,
      ...(this.keepAlive === undefined ? {} : { keep_alive: this.keepAlive }),
      options: {
        temperature: options.temperature ?? 0.7,
        num_predict: options.maxTokens ?? 4096,
      },
      ...(options.tools && options.tools.length > 0
        ? { tools: this.encodeTools(options.tools) }
        : {}),
    }
  }
}

/**
 * Map one harness message onto Ollama chat shapes.
 *
 * Returns an ARRAY because a parallel tool batch must become one `tool`-role
 * message per result — Ollama keys results by `tool_name` and has no call id to
 * group by. Messages that carry nothing sendable (e.g. an assistant message
 * whose only block was dropped reasoning) map to an empty array.
 */
function encodeMessage(message: Message): Record<string, unknown>[] {
  if (message.role === 'tool') {
    return message.content
      .filter((b): b is Extract<ContentBlock, { type: 'tool-result' }> => b.type === 'tool-result')
      .map((r) => ({ role: 'tool', content: r.content, tool_name: r.name }))
  }

  const text = message.content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')

  const calls = message.content.filter(
    (b): b is Extract<ContentBlock, { type: 'tool-call' }> => b.type === 'tool-call',
  )

  if (calls.length > 0) {
    return [{
      role: 'assistant',
      content: text,
      tool_calls: calls.map((c) => ({
        function: { name: c.name, arguments: c.arguments },
      })),
    }]
  }

  if (text.length === 0) return []
  return [{ role: message.role === 'assistant' ? 'assistant' : 'user', content: text }]
}

/**
 * Ollama's `done_reason` is coarser than the harness vocabulary: it reports
 * `stop` or `length`, and says nothing about tool calls — which we infer from
 * whether the turn produced any.
 */
function mapDoneReason(reason: string | undefined, sawToolCall: boolean): FinishReason {
  if (sawToolCall) return { kind: 'tool-calls' }
  switch (reason) {
    case 'length':
      return { kind: 'max-tokens' }
    case 'stop':
    case undefined:
    case '':
      return { kind: 'stop' }
    case 'load':
      // The model was still loading when generation ended.
      return { kind: 'error', failure: { message: 'model failed to load', code: 'MODEL_LOAD_FAILED' } }
    default:
      return { kind: 'stop' }
  }
}
