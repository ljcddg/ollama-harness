/**
 * Provider-neutral message vocabulary.
 *
 * This is the harness's canonical language. Adapters are the ONLY place that
 * knows a provider's wire format — everything upstream (agent loop, session
 * log, UI) speaks these types. Adding a provider never changes this file.
 */

export type MessageId = string & { readonly __brand: 'MessageId' }
export type ToolCallId = string & { readonly __brand: 'ToolCallId' }
export type SessionId = string & { readonly __brand: 'SessionId' }

export const asMessageId = (v: string) => v as MessageId
export const asToolCallId = (v: string) => v as ToolCallId
export const asSessionId = (v: string) => v as SessionId

/** Visible text the user reads. */
export interface TextBlock {
  type: 'text'
  text: string
}

/**
 * Reasoning / thinking content, kept separate from visible text so the UI can
 * collapse it and so it can be dropped when a model does not accept it back.
 */
export interface ReasoningBlock {
  type: 'reasoning'
  text: string
}

/** A request from the model to run a tool. Arguments are provider-parsed JSON. */
export interface ToolCallBlock {
  type: 'tool-call'
  callId: ToolCallId
  name: string
  arguments: unknown
}

/** The outcome of a tool call, fed back to the model on the next step. */
export interface ToolResultBlock {
  type: 'tool-result'
  callId: ToolCallId
  name: string
  content: string
  isError: boolean
}

export type ContentBlock = TextBlock | ReasoningBlock | ToolCallBlock | ToolResultBlock

/** Who produced a message. Kept independent from `form` on purpose. */
export type MessageSource =
  | { kind: 'user' }
  | { kind: 'model'; provider: string; model: string }
  | { kind: 'tool'; callId: ToolCallId }
  | { kind: 'system'; name: string }

export interface Message {
  id: MessageId
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: ContentBlock[]
  source: MessageSource
  /** Epoch millis. */
  time: number
}

/** Why a model turn stopped. */
export type FinishReason =
  | { kind: 'stop' }
  | { kind: 'tool-calls' }
  | { kind: 'max-tokens' }
  | { kind: 'aborted' }
  | { kind: 'error'; failure: LlmFailure }

/** Disjoint token accounting — cache reads are NOT included in inputTokens. */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
}

/**
 * The unit of streaming. An adapter yields these; the assembler folds them into
 * a Message. Index identifies which block a delta belongs to within one step.
 */
export type StreamChunk =
  | { type: 'block-start'; index: number; kind: 'text' | 'reasoning' | 'tool-call' }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; callId?: string; name?: string; argumentsDelta: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason }

/** Serializable failure facts. Policy decides whether they are retryable. */
export interface LlmFailure {
  message: string
  code: string
  status?: number
}

export interface ModelInfo {
  /** Provider-scoped id, e.g. `qwen2.5:7b`. */
  id: string
  /** Human-facing label. */
  label: string
  /** Provider that serves it. */
  provider: string
  contextWindow?: number
  /**
   * Whether the model can hold a conversation at all.
   *
   * Embedding models (`bge-m3`, `nomic-embed-text`, …) appear in `/api/tags`
   * alongside chat models, so a model picker built from that list will happily
   * offer one — and then every request fails with
   * `400: "bge-m3:latest" does not support chat`. Ollama reports this
   * authoritatively as the `embedding` capability in `/api/show`, so it is a fact
   * to read rather than a name to pattern-match. `undefined` means "not
   * determined"; treat that as usable rather than hiding a model on a guess.
   */
  chat?: boolean
  /** Whether the model accepts images. */
  vision?: boolean
  /** Whether the model can emit tool calls. */
  tools?: boolean
  /** Whether the model emits a separate reasoning stream. */
  thinking?: boolean
}

/** One request to a provider. Frozen by the loop before it reaches an adapter. */
export interface GenerateOptions {
  model: string
  messages: readonly Message[]
  systemPrompt?: string
  tools?: readonly ToolDefinition[]
  maxTokens?: number
  temperature?: number
  signal?: AbortSignal
}

export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema for the arguments object. */
  parameters: Record<string, unknown>
}
