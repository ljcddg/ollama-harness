/**
 * Fold a `StreamChunk` sequence into assembler state.
 *
 * The adapter yields deltas; the assembler turns them into the ordered content
 * blocks the session log records. Text and reasoning accumulate per index, and
 * tool-call arguments accumulate as a JSON string that is parsed once at flush.
 *
 * Why a separate assembler instead of letting the loop mutate a Message: the
 * loop needs to emit events as deltas ARRIVE (so the UI streams), while the
 * final message must be well-formed (parsed arguments, merged blocks). Keeping
 * the two apart means a malformed argument string fails at one known place.
 */

import type { ContentBlock, FinishReason, TokenUsage, ToolCallBlock } from '../../shared/message.js'
import { asToolCallId } from '../../shared/message.js'
import type { StreamChunk } from '../../shared/message.js'

interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  callId?: string
  name?: string
  /** Tool-call only: the accumulated JSON string. */
  argumentsJson: string
  /** Tool-call only: true once a non-empty name has been seen. */
  opened: boolean
}

/**
 * True when `text` is a self-contained JSON object or array.
 *
 * Used to tell a complete arguments payload (Ollama) from a fragment (OpenAI).
 * Scalar JSON like `42` or `"x"` returns false on purpose: a fragment could be
 * exactly that, and treating it as complete would drop the surrounding object.
 */
function isCompleteJson(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < 2) return false
  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]
  if (!((first === '{' && last === '}') || (first === '[' && last === ']'))) return false
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

export class BlockAssembler {
  private readonly blocks = new Map<number, OpenBlock>()
  private order: number[] = []
  private _usage: TokenUsage | undefined
  private _finish: FinishReason | undefined

  /** Feed one chunk. Returns the opened block when this chunk STARTED one. */
  accept(chunk: StreamChunk): OpenBlock | undefined {
    switch (chunk.type) {
      case 'block-start': {
        // A repeated block-start for the same index must not reset accumulated
        // text — adapters are allowed to re-announce a block they keep writing to.
        const existing = this.blocks.get(chunk.index)
        if (existing) {
          if (existing.kind !== chunk.kind) {
            throw new Error(
              `assembler: index ${chunk.index} was opened as ${existing.kind}, re-announced as ${chunk.kind}`,
            )
          }
          return undefined
        }
        const block: OpenBlock = {
          index: chunk.index,
          kind: chunk.kind,
          text: '',
          argumentsJson: '',
          opened: true,
        }
        this.blocks.set(chunk.index, block)
        this.order.push(chunk.index)
        return block
      }

      case 'text-delta':
        this.appendText(chunk.index, 'text', chunk.text)
        return undefined

      case 'reasoning-delta':
        this.appendText(chunk.index, 'reasoning', chunk.text)
        return undefined

      case 'tool-call-delta': {
        const block = this.ensureToolBlock(chunk.index, chunk.callId, chunk.name)
        if (chunk.callId !== undefined && block.callId === undefined) block.callId = chunk.callId
        if (chunk.name !== undefined && chunk.name.length > 0) block.name = chunk.name
        // Two provider styles exist and both must work here:
        //   - OpenAI-style: partial JSON fragments that CONCATENATE.
        //   - Ollama-style: the complete arguments object, re-sent as it grows.
        // Appending a complete object onto a previous complete object yields
        // `{...}{...}`, which is invalid JSON, so detect that case and replace.
        // The test is "the incoming delta is itself well-formed JSON" — a
        // fragment like `{"pa` never is, and a complete object always is.
        if (block.argumentsJson.length > 0 && isCompleteJson(chunk.argumentsDelta)) {
          block.argumentsJson = chunk.argumentsDelta
        } else {
          block.argumentsJson += chunk.argumentsDelta
        }
        return undefined
      }

      case 'usage':
        this._usage = chunk.usage
        return undefined

      case 'finish':
        this._finish = chunk.reason
        return undefined

      default:
        return undefined
    }
  }

  get usage(): TokenUsage | undefined {
    return this._usage
  }

  /**
   * Read-only view of the blocks as they currently stand, in arrival order.
   * The loop uses this to stream text out as it arrives without waiting for the
   * step to finish — the assembler stays the single owner of accumulated state.
   */
  snapshot(): ReadonlyArray<{ index: number; kind: 'text' | 'reasoning' | 'tool-call'; text: string; name?: string }> {
    return this.order
      .map((index) => this.blocks.get(index))
      .filter((b): b is OpenBlock => b !== undefined)
      .map((b) => ({
        index: b.index,
        kind: b.kind,
        text: b.text,
        ...(b.name === undefined ? {} : { name: b.name }),
      }))
  }

  get finish(): FinishReason | undefined {
    return this._finish
  }

  /** True once anything meaningful has been produced. */
  get isEmpty(): boolean {
    for (const block of this.blocks.values()) {
      if (block.kind === 'text' && block.text.length > 0) return false
      if (block.kind === 'reasoning' && block.text.length > 0) return false
      if (block.kind === 'tool-call' && block.name !== undefined) return false
    }
    return true
  }

  /**
   * Produce the final content blocks in arrival order.
   *
   * A tool call whose arguments never parsed becomes a `tool-result` reporting
   * the parse failure rather than a `tool-call` — the model gets told its own
   * arguments were malformed instead of the call silently vanishing.
   */
  flush(): { content: ContentBlock[]; argumentErrors: Array<{ callId: string; name: string; raw: string }> } {
    const content: ContentBlock[] = []
    const argumentErrors: Array<{ callId: string; name: string; raw: string }> = []

    for (const index of this.order) {
      const block = this.blocks.get(index)
      if (!block) continue

      if (block.kind === 'text' && block.text.length > 0) {
        content.push({ type: 'text', text: block.text })
        continue
      }
      if (block.kind === 'reasoning' && block.text.length > 0) {
        content.push({ type: 'reasoning', text: block.text })
        continue
      }
      if (block.kind === 'tool-call' && block.name !== undefined) {
        const callId = block.callId ?? `call-${index}-${Date.now().toString(36)}`
        let args: unknown = {}
        if (block.argumentsJson.trim().length > 0) {
          try {
            args = JSON.parse(block.argumentsJson)
          } catch {
            argumentErrors.push({ callId, name: block.name, raw: block.argumentsJson })
            continue
          }
        }
        const call: ToolCallBlock = {
          type: 'tool-call',
          callId: asToolCallId(callId),
          name: block.name,
          arguments: args,
        }
        content.push(call)
      }
    }

    return { content, argumentErrors }
  }

  /** Reset for a fresh step. */
  clear(): void {
    this.blocks.clear()
    this.order = []
    this._usage = undefined
    this._finish = undefined
  }

  private appendText(index: number, kind: 'text' | 'reasoning', text: string): void {
    let block = this.blocks.get(index)
    if (!block) {
      block = { index, kind, text: '', argumentsJson: '', opened: true }
      this.blocks.set(index, block)
      this.order.push(index)
    } else if (block.kind !== kind) {
      // Two channels sharing one index would silently merge, and since the
      // visible answer and the reasoning trace are the two things a user most
      // needs to tell apart, merging them is not a survivable failure — the
      // message renders with no text at all. An adapter that reuses an index
      // across kinds is buggy; surface it here rather than at the UI.
      throw new Error(
        `assembler: index ${index} already holds a ${block.kind} block, cannot append ${kind}`,
      )
    }
    block.text += text
  }

  private ensureToolBlock(index: number, callId?: string, name?: string): OpenBlock {
    let block = this.blocks.get(index)
    if (!block) {
      block = {
        index,
        kind: 'tool-call',
        text: '',
        argumentsJson: '',
        opened: false,
        ...(callId === undefined ? {} : { callId }),
        ...(name === undefined ? {} : { name }),
      }
      this.blocks.set(index, block)
      this.order.push(index)
    }
    return block
  }
}
