/**
 * Flattening a derived transcript into text a model can read.
 *
 * Shared by compaction and self-review for one reason: both ask a model a
 * question ABOUT the conversation rather than continuing it. That means both
 * need the same lossy projection into plain text — and two copies of that
 * projection would drift, so the reviewer would end up judging a different
 * transcript than the one the summariser measured.
 *
 * Reasoning blocks are dropped on purpose: they are the route taken, not the
 * destination, and including them roughly doubles the transcript for no gain.
 * Tool results are clamped because the record is not the point — which tool ran
 * with which arguments, and that it returned rather than errored, is.
 */

import type { ContentBlock, Message } from '../shared/message.js'

/** How much of one tool result survives into the flattened form. */
const RESULT_LIMIT = 600
/** How much of one argument value survives; a pasted file would otherwise dominate. */
const ARGUMENT_LIMIT = 160
/** How much of the whole argument object survives. */
const ARGUMENTS_LIMIT = 400

/** Flatten one message into lines a summarising model can read. */
export function renderForSummary(message: Message): string {
  const parts: string[] = []
  for (const block of message.content) {
    const line = renderBlock(block)
    if (line) parts.push(line)
  }
  const body = parts.join('\n').trim()
  if (body.length === 0) return ''

  if (message.source.kind === 'system') return `【上下文】\n${body}`
  if (message.role === 'user') return `用户：${body}`
  if (message.role === 'tool') return `工具输出：${body}`
  return `助手：${body}`
}

/**
 * Flatten a whole message list, dropping messages that carry nothing.
 *
 * Empty messages are skipped rather than rendered as a bare role label: a
 * reasoning-only assistant message would otherwise appear as "助手：" followed
 * by nothing, which reads to a small model as an answer it failed to produce.
 */
export function buildTranscript(messages: readonly Message[]): string {
  return messages.map(renderForSummary).filter((line) => line.length > 0).join('\n\n')
}

function renderBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text
    case 'tool-call':
      return `- 调用工具 ${block.name}(${summariseArguments(block.arguments)})`
    case 'tool-result':
      return `- ${block.name} ${block.isError ? '报错' : '返回'}：${clamp(block.content, RESULT_LIMIT)}`
    default:
      // Reasoning: see the module comment.
      return ''
  }
}

function summariseArguments(args: unknown): string {
  if (typeof args !== 'object' || args === null) return String(args ?? '')
  const record = args as Record<string, unknown>
  const parts = Object.entries(record).map(
    ([key, value]) => `${key}=${clamp(String(value), ARGUMENT_LIMIT)}`,
  )
  return clamp(parts.join(', '), ARGUMENTS_LIMIT)
}

function clamp(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
