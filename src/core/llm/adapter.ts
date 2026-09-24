/**
 * Adapter base class.
 *
 * One adapter per provider wire protocol. Adapters do exactly three things:
 * translate harness messages into the wire format, translate the wire stream
 * back into `StreamChunk`s, and report what models they serve. Nothing about
 * the agent loop, tools, or sessions lives here — that keeps provider quirks
 * from leaking into the core.
 */

import type {
  GenerateOptions,
  ModelInfo,
  StreamChunk,
  ToolDefinition,
} from '../../shared/message.js'
import type { LlmFailure } from '../../shared/message.js'

export class LlmError extends Error {
  readonly failure: LlmFailure

  constructor(message: string, code: string, options?: { status?: number; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'LlmError'
    this.failure = {
      message,
      code,
      ...(options?.status === undefined ? {} : { status: options.status }),
    }
  }
}

export abstract class LlmAdapter {
  /** Stable provider id used in message sources and settings. */
  abstract readonly provider: string

  /**
   * Stream one model turn.
   *
   * Implementations MUST yield a terminal `finish` chunk on success and MUST
   * throw `LlmError` rather than ending the stream silently — a stream that
   * stops without `finish` is a truncation and cannot be trusted.
   */
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>

  /** Models this adapter can serve. Used to populate the model picker. */
  abstract listModels(signal?: AbortSignal): Promise<ModelInfo[]>

  /**
   * Batch text embeddings, when the provider offers them. Implemented by
   * OllamaAdapter via `/api/embed`; the semantic search tool depends on it.
   * Kept on the adapter — not a free function — so wire-format translation
   * stays entirely inside the provider boundary.
   */
  embed?(model: string, input: readonly string[], signal?: AbortSignal): Promise<number[][]>

  /**
   * Provider-specific tool schema wrapper. Ollama's `/api/chat` accepts plain
   * JSON Schema, but other providers want `{ type: 'function', function: {...} }`.
   * Default: assume the provider wants the OpenAI envelope.
   */
  protected encodeTools(tools: readonly ToolDefinition[]): unknown[] {
    return tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }
}

/** Throws if the signal is already aborted, so adapters can share one guard. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new LlmError('Request aborted', 'ABORTED')
  }
}
