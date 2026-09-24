/**
 * Session event log.
 *
 * The log is the single source of truth. Nothing in this harness mutates
 * conversation state directly — the loop appends events, and every derived view
 * (messages for the model, UI node tree, token totals) is a pure fold over the
 * log. That is what makes resume, fork, and replay cheap: you replay the log.
 */

import type {
  ContentBlock,
  FinishReason,
  Message,
  MessageId,
  SessionId,
  TokenUsage,
  ToolCallId,
} from './message.js'
import { asMessageId } from './message.js'
// Type-only, so this does not create a runtime cycle with ipc.ts (which
// imports SessionEvent). The review verdict belongs to the log, not the bridge.
import type { ReviewFinding } from './ipc.js'

export const SESSION_FORMAT_VERSION = 1

export type Seq = number & { readonly __brand: 'Seq' }

/** Every event carries a monotonically increasing `seq` and a wall-clock `time`. */
interface EventBase {
  seq: number
  time: number
}

export type SessionEvent =
  | (EventBase & { type: 'session/start'; data: { sessionId: string; cwd: string; model: string } })
  | (EventBase & { type: 'session/title'; data: { title: string } })
  | (EventBase & { type: 'turn/start'; data: { turn: number } })
  | (EventBase & { type: 'turn/end'; data: { turn: number; reason: FinishReason } })
  /** Appended when the user submits. The message is already fully formed. */
  | (EventBase & { type: 'user/message'; data: { message: Message } })
  /** Opens an assistant step; deltas below belong to it. */
  | (EventBase & { type: 'step/start'; data: { turn: number; step: number; model: string; provider: string } })
  | (EventBase & { type: 'step/text'; data: { id: MessageId; index: number; text: string } })
  | (EventBase & { type: 'step/reasoning'; data: { id: MessageId; index: number; text: string } })
  | (EventBase & { type: 'step/tool-call'; data: { id: MessageId; callId: ToolCallId; name: string; arguments: unknown } })
  | (EventBase & { type: 'step/usage'; data: { usage: TokenUsage } })
  | (EventBase & { type: 'step/end'; data: { turn: number; step: number; reason: FinishReason } })
  /** A tool dispatch STARTING — recorded before the body runs, so a crash mid-tool is visible. */
  | (EventBase & { type: 'tool/start'; data: { callId: ToolCallId; name: string; arguments: unknown } })
  | (EventBase & { type: 'tool/end'; data: { callId: ToolCallId; name: string; isError: boolean; content: string; durationMs: number } })
  /**
   * The user rewrote an earlier message.
   *
   * Editing is another APPEND, never a rewrite of an existing line — the log is
   * append-only and that is what makes crash recovery trivial. The fold applies
   * the newest edit for each target, so what the model sees is the current text
   * while the original stays on disk.
   *
   * Note this does NOT re-run anything: replies already generated from the old
   * wording stay as they were. Editing corrects the prompt going forward.
   */
  | (EventBase & { type: 'message/edit'; data: { targetSeq: number; text: string } })
  /**
   * The transcript was compacted: everything at or below `upTo` has been rolled
   * into `summary`. Folding starts after `upTo` and prepends the summary, so the
   * model sees the short version while the full history remains readable from
   * the file.
   */
  | (EventBase & { type: 'session/compact'; data: { upTo: number; summary: string } })
  /**
   * The self-review gate was consulted, and this is what it decided.
   *
   * Recorded on EVERY path, including the two where the gate did nothing:
   * `skipped` (no tool ran, so there was no evidence to audit) and
   * `unavailable` (the reviewer itself failed to run). Without those, "the
   * reviewer agreed" and "the reviewer was never reached" would leave the
   * same empty gap in the only record there is of why a turn was allowed to
   * end — which is how a half-finished answer once shipped looking finished.
   *
   * `round` is 1-based: how many times the reviewer has been asked this turn,
   * so a session that came close to the cap shows it.
   *
   * Deliberately NOT a message. `deriveMessages` ignores it, so a verdict
   * never becomes something the model is asked to reply to.
   */
  | (EventBase & {
      type: 'review/result'
      data: {
        turn: number
        step: number
        outcome: 'match' | 'partial' | 'mismatch' | 'unavailable' | 'skipped'
        summary: string
        findings: ReviewFinding[]
        round: number
      }
    })

export type SessionEventType = SessionEvent['type']

/** Header persisted with the log so a file can be validated before replay. */
export interface SessionHeader {
  version: typeof SESSION_FORMAT_VERSION
  sessionId: SessionId
  cwd: string
  title: string
  createdAt: number
  updatedAt: number
}

export interface SessionMeta extends SessionHeader {
  /** Path on disk, when persisted. */
  path?: string
  messageCount: number
}

/**
 * Fold the log into the message list the model sees.
 *
 * Consecutive `step/text` / `step/reasoning` deltas sharing an `id` and `index`
 * are concatenated into one block. Tool results arrive as their own `tool/end`
 * events and become `tool-result` blocks on a synthetic `tool`-role message —
 * which is exactly the shape OpenAI-compatible and Ollama chat APIs expect.
 *
 * Two events change how the log is READ, and neither changes the log itself:
 *
 * - `session/compact` rolls everything at or below its `upTo` into one summary
 *   paragraph. The fold resumes after that seq and prepends the paragraph, so a
 *   compacted session stays fully recoverable from its file — this is a reading
 *   strategy, not a destructive trim.
 * - `message/edit` supersedes the text of an earlier `user/message`. Both
 *   versions survive on disk; the fold applies the newest.
 */
export function deriveMessages(events: readonly SessionEvent[]): Message[] {
  const { start, summary } = latestCompaction(events)
  const edits = editIndex(events)

  const out: Message[] = []
  /** Open assistant message, so deltas can append in order. */
  let open: Message | undefined
  const blockIndex = new Map<string, number>()
  /** Tool calls awaiting their result, keyed by callId. */
  const pending = new Map<ToolCallId, { name: string }>()

  const flush = () => {
    if (!open) return
    if (open.content.length > 0) out.push(open)
    open = undefined
    blockIndex.clear()
  }

  if (summary !== null) {
    out.push({
      id: asMessageId(`summary-${start}`),
      role: 'user',
      content: [{ type: 'text', text: summary }],
      source: { kind: 'system', name: 'compaction' },
      time: 0,
    })
  }

  for (const event of events) {
    // Everything at or below `start` is already inside the summary.
    if (event.seq <= start) continue

    switch (event.type) {
      case 'user/message':
        flush()
        out.push(applyEdit(event.data.message, edits.get(event.seq)))
        break

      case 'step/start':
        flush()
        open = {
          id: `assistant-${event.seq}` as MessageId,
          role: 'assistant',
          content: [],
          source: { kind: 'model', provider: event.data.provider, model: event.data.model },
          time: event.time,
        }
        break

      case 'step/text':
      case 'step/reasoning': {
        if (!open) break
        const kind = event.type === 'step/text' ? 'text' : 'reasoning'
        const key = `${event.data.id}:${event.data.index}`
        const existing = blockIndex.get(key)
        if (existing === undefined) {
          blockIndex.set(key, open.content.length)
          open.content.push(
            kind === 'text'
              ? { type: 'text', text: event.data.text }
              : { type: 'reasoning', text: event.data.text },
          )
        } else {
          const block = open.content[existing]
          if (block && (block.type === 'text' || block.type === 'reasoning')) {
            block.text += event.data.text
          }
        }
        break
      }

      case 'step/tool-call':
        if (!open) break
        open.content.push({
          type: 'tool-call',
          callId: event.data.callId,
          name: event.data.name,
          arguments: event.data.arguments,
        })
        pending.set(event.data.callId, { name: event.data.name })
        break

      case 'tool/end': {
        flush()
        const info = pending.get(event.data.callId)
        pending.delete(event.data.callId)
        const block: ContentBlock = {
          type: 'tool-result',
          callId: event.data.callId,
          name: event.data.name ?? info?.name ?? 'unknown',
          content: event.data.content,
          isError: event.data.isError,
        }
        const last = out[out.length - 1]
        // Ollama expects one tool message per result; group a parallel batch
        // only when the previous message is already a tool message.
        if (last && last.role === 'tool') {
          last.content.push(block)
        } else {
          out.push({
            id: `tool-${event.seq}` as MessageId,
            role: 'tool',
            content: [block],
            source: { kind: 'tool', callId: event.data.callId },
            time: event.time,
          })
        }
        break
      }

      default:
        break
    }
  }

  flush()
  return out
}

/**
 * The current text of every edited user message, keyed by the seq of the
 * `user/message` event it replaces.
 *
 * Exported because the renderer keeps its own node tree and has to apply the
 * same view of "current" — see the shared-fold invariant in useHarness.
 */
export function editIndex(events: readonly SessionEvent[]): Map<number, string> {
  const edits = new Map<number, string>()
  for (const event of events) {
    if (event.type !== 'message/edit') continue
    edits.set(event.data.targetSeq, event.data.text)
  }
  return edits
}

/** Where the visible transcript resumes, plus the summary standing in for what came before. */
export function latestCompaction(
  events: readonly SessionEvent[],
): { start: number; summary: string | null } {
  let start = 0
  let summary: string | null = null
  for (const event of events) {
    if (event.type !== 'session/compact') continue
    // A later compaction supersedes an earlier one, and `upTo` should only ever
    // move forward. The comparison guards against an out-of-order append.
    if (event.data.upTo >= start) {
      start = event.data.upTo
      summary = event.data.summary
    }
  }
  return { start, summary: summary !== null && summary.trim().length > 0 ? summary : null }
}

/**
 * Swap in an edited text without mutating the event we were handed — an edit has
 * to leave the original readable in memory too, or replay after an edit would be
 * order-dependent.
 */
function applyEdit(message: Message, text: string | undefined): Message {
  if (text === undefined) return message
  const rest = message.content.filter((block) => block.type !== 'text')
  return { ...message, content: [{ type: 'text', text }, ...rest] }
}

/** Total token usage across the whole session. */
export function deriveUsage(events: readonly SessionEvent[]): TokenUsage {
  let input = 0
  let output = 0
  let reasoning = 0
  let cacheRead = 0
  for (const e of events) {
    if (e.type !== 'step/usage') continue
    input += e.data.usage.inputTokens
    output += e.data.usage.outputTokens
    reasoning += e.data.usage.reasoningTokens ?? 0
    cacheRead += e.data.usage.cacheReadTokens ?? 0
  }
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    ...(reasoning > 0 ? { reasoningTokens: reasoning } : {}),
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
  }
}

/**
 * Approximate tokens the NEXT request will carry.
 *
 * `deriveUsage` sums every call (cumulative spend); this is the context SIZE:
 * the last model call's input (the full context it was shown) plus its output
 * (now part of the history it will be shown next time). Pure and event-folded
 * like everything else here, so the main process and any test see the same
 * number. `null` when no call has reported usage yet.
 */
export function deriveContextTokens(events: readonly SessionEvent[]): number | null {
  let total: number | null = null
  for (const e of events) {
    if (e.type !== 'step/usage') continue
    total = e.data.usage.inputTokens + e.data.usage.outputTokens
  }
  return total
}

/** Turn/step boundary state, used to decide whether a session is mid-flight. */
export interface TurnBoundary {
  lastTurn: number
  /** Open turn awaiting `turn/end`, if any. */
  openTurn: number | null
  midStep: boolean
}

export function deriveTurnBoundary(events: readonly SessionEvent[]): TurnBoundary {
  let lastTurn = 0
  let openTurn: number | null = null
  let midStep = false
  for (const e of events) {
    switch (e.type) {
      case 'turn/start':
        openTurn = e.data.turn
        lastTurn = e.data.turn
        break
      case 'turn/end':
        openTurn = null
        break
      case 'step/start':
        midStep = true
        break
      case 'step/end':
        midStep = false
        break
      default:
        break
    }
  }
  return { lastTurn, openTurn, midStep }
}

/** The title shown in the sidebar: explicit title wins, else the first user text. */
export function deriveTitle(events: readonly SessionEvent[]): string {
  for (const e of events) {
    if (e.type === 'session/title') return e.data.title
  }
  for (const e of events) {
    if (e.type !== 'user/message') continue
    const text = e.data.message.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join(' ')
      .trim()
    if (text) return text.length > 48 ? `${text.slice(0, 48)}…` : text
  }
  return '空会话'
}

/**
 * Which directory a turn runs in.
 *
 * The session header wins, always. `defaultWorkdir` only covers a session that
 * has no directory of its own, and `fallback` is the last resort.
 *
 * This is a pure function for one reason: the precedence is the bug. The sidebar
 * groups conversations by their header's `cwd`, so if the global default won, a
 * conversation filed under `D:\desktop1\test` would answer "the current working
 * directory is D:\desktop1\论文" and its tools would read files the user never
 * pointed at. That is invisible from the outside and easy to reintroduce, so it
 * is asserted rather than assumed.
 */
export function resolveSessionCwd(
  headerCwd: string | null | undefined,
  defaultWorkdir: string | null | undefined,
  fallback: string,
): string {
  return headerCwd?.trim() || defaultWorkdir?.trim() || fallback
}
