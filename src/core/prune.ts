/**
 * Deterministic trimming of oversized tool output.
 *
 * DeepSeek Harness splits compaction by whether a layer needs a model call, and
 * the split is the whole point: its summariser needs one and therefore runs at
 * turn boundaries, while its `compaction-tool-result-pruner` needs none and
 * therefore runs **before every step**. This harness had only the first layer —
 * `maybeAutoCompact()` fires between turns (see `agent-service.ts`) — so a single
 * long turn had no protection whatsoever.
 *
 * Session 0b5d68df spent its entire life inside one turn: ten steps took the
 * request from 3 183 to 25 015 input tokens, and the summary only appeared after
 * the turn had already failed. A comment in the agent service says compaction is
 * kept out of the turn so a summary cannot fold itself into the answer to it —
 * true, and exactly why the layer that needs no model call has to exist.
 *
 * A tool result is both where that growth comes from and the cheapest thing to
 * trim: it is machine output, the model has already acted on it, and the full
 * text stays in the log. So this runs before each step, but only once the
 * request is over budget — trimming a result the model can still afford to read
 * costs information for nothing.
 *
 * Ported from dsh's `compaction-tool-result-pruner`, defaults and marker text
 * included.
 */

import type { ContentBlock, Message } from '../shared/message.js'

/** Stands in for the removed middle. Same wording DeepSeek Harness uses. */
export const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'

/**
 * A tool result longer than this many characters is trimmed.
 *
 * Head + marker + tail stays well under the threshold, so a pruned result can
 * never be pruned again and never grows: the rewrite is idempotent, which is
 * what lets it run on every step without making the request drift.
 */
export const PRUNE_THRESHOLD_CHARS = 8192
export const PRUNE_HEAD_CHARS = 4096
export const PRUNE_TAIL_CHARS = 1024

/**
 * Trim one tool result to head + marker + tail, or null when it already fits.
 *
 * Slices by Unicode code point — `Array.from` walks the string iterator, so a
 * surrogate pair is never split in half. A multi-character grapheme cluster
 * still can be, which is the same limit dsh documents rather than fixes.
 */
export function pruneText(text: string): string | null {
  const points = Array.from(text)
  if (points.length <= PRUNE_THRESHOLD_CHARS) return null
  return (
    points.slice(0, PRUNE_HEAD_CHARS).join('') +
    PRUNE_MARKER +
    points.slice(points.length - PRUNE_TAIL_CHARS).join('')
  )
}

export interface PruneOutcome {
  messages: Message[]
  /** How many tool results were rewritten. */
  pruned: number
  /** Characters removed across all of them, as `String.length` counts them. */
  charsRemoved: number
}

/**
 * Rewrite every oversized tool result in one request.
 *
 * Only `tool-result` blocks are touched. Assistant text is left alone on
 * purpose: it is the model's own words, and cutting it changes what the model
 * believes it said. Tool output has no such problem — the model asked for it,
 * used it, and the log still holds every character of it.
 *
 * Nothing is written to the log. The request is a pure function of the log, and
 * this is a deterministic step in that function, so a replay derives the same
 * request and the full text stays readable to the UI and to `inspect-session`.
 */
export function pruneToolResults(messages: readonly Message[]): PruneOutcome {
  let pruned = 0
  let charsRemoved = 0

  const out = messages.map((message) => {
    // Cheap guard: most messages carry no tool result at all, and this keeps the
    // per-block walk off them.
    if (!message.content.some((block) => block.type === 'tool-result')) return message

    let blocks: ContentBlock[] | null = null
    message.content.forEach((block, index) => {
      if (block.type !== 'tool-result') return
      const shortened = pruneText(block.content)
      if (shortened === null) return
      pruned++
      charsRemoved += block.content.length - shortened.length
      // Copy once per message, not once per block: untouched blocks must stay
      // the same objects so nothing downstream compares them by value.
      blocks ??= [...message.content]
      blocks[index] = { ...block, content: shortened }
    })

    return blocks === null ? message : { ...message, content: blocks }
  })

  return { messages: out, pruned, charsRemoved }
}

/**
 * How many characters a request would carry.
 *
 * Counts what the adapter actually sends, which is NOT the same set the log
 * holds. Two differences, and the first one was measured: `deriveMessages` keeps
 * a `reasoning` block on every assistant message — 39.5% of the characters in
 * session 0b5d68df — while `encodeMessage` drops it on the way out, so counting
 * it inflated the budget by more than a third and would have fired the pruner on
 * requests that were never over. Tool-call arguments go the other way: they ARE
 * sent as structured data, and were not counted at all.
 *
 * This is not a rounding error — it decides whether a request is trimmed. The
 * unit matches `compactThresholdChars` so the two compare directly.
 */
export function requestChars(messages: readonly Message[]): number {
  let total = 0
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'text') total += block.text.length
      else if (block.type === 'tool-result') total += block.content.length
      else if (block.type === 'tool-call') {
        // `JSON.stringify(undefined)` returns undefined, not a string.
        total += block.arguments === undefined ? 0 : JSON.stringify(block.arguments).length
      }
    }
  }
  return total
}
