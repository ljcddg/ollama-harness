/**
 * Self-review: auditing a finished turn against what was actually asked for.
 *
 * This lives in `core` rather than in the service because the agent loop needs
 * it. The gate that decides whether a turn may end is now "the reviewer agrees
 * it is finished", not "the model stopped emitting tool calls" — and that gate
 * has to sit inside the loop, where it can feed the findings back and take
 * another step.
 *
 * The reviewer is deliberately given the flattened transcript rather than being
 * asked to trust the model's own closing summary. A summary is the claim under
 * audit; letting the reviewer read only the claim makes it a rubber stamp.
 */

import type { LlmAdapter } from './llm/adapter.js'
import type { GenerateOptions, LlmFailure, Message } from '../shared/message.js'
import { asMessageId } from '../shared/message.js'
import type { AppConfig, ReviewFinding, ReviewResult } from '../shared/ipc.js'
import { buildReviewPrompt, buildSystemPrompt } from './prompt.js'
import { buildTranscript } from './transcript.js'

export interface SelfReviewInput {
  adapter: LlmAdapter
  model: string
  config: AppConfig
  cwd: string
  /** The derived conversation, exactly as the coding model saw it. */
  messages: readonly Message[]
  /** The user's own words for this turn — the yardstick. */
  userText: string
  signal: AbortSignal
}

/**
 * Run one self-review pass.
 *
 * Returns `null` when the review could not be performed at all — the model
 * errored, the stream was aborted, or the request never reached it. A null is
 * NOT a failed review: the caller should let the turn end rather than spend
 * another round correcting work that may well be finished. The reviewer being
 * broken is not the model's fault, and trapping the user in a loop over it is
 * worse than shipping a turn nobody audited.
 */
export async function runSelfReview(input: SelfReviewInput): Promise<ReviewResult | null> {
  const transcript = buildTranscript(input.messages)
  // The reviewer needs something to read even in the degenerate case, but an
  // empty transcript means there is genuinely nothing to audit.
  if (transcript.trim().length === 0) return null

  const generate: GenerateOptions = {
    model: input.model,
    messages: [
      {
        id: asMessageId('review-request'),
        role: 'user',
        content: [
          {
            type: 'text',
            text: [transcript, '', '---', '', buildReviewPrompt(input.userText)].join('\n'),
          },
        ],
        source: { kind: 'user' },
        time: Date.now(),
      },
    ],
    systemPrompt: buildSystemPrompt({
      cwd: input.cwd,
      model: input.model,
      platform: process.platform,
      // No tools: the reviewer reads the record, it does not go looking for
      // more. Handing it the registry would invite it to re-run the work.
      toolNames: [],
    }),
    tools: [],
    maxTokens: input.config.maxTokens,
    temperature: 0,
    signal: input.signal,
  }

  let raw = ''
  let failure: LlmFailure | null = null
  try {
    for await (const chunk of input.adapter.stream(generate)) {
      if (chunk.type === 'text-delta') raw += chunk.text
      else if (chunk.type === 'finish' && chunk.reason.kind === 'error') failure = chunk.reason.failure
    }
  } catch {
    return null
  }
  if (failure) return null

  return parseReview(raw)
}

/** Verdict wording, matching what the review card shows so the two cannot disagree. */
const VERDICT_LABEL: Record<ReviewResult['verdict'], string> = {
  match: '相符',
  partial: '部分相符',
  mismatch: '不相符',
}

const STATUS_LABEL: Record<ReviewFinding['status'], string> = {
  met: '已完成',
  partial: '部分完成',
  missing: '未完成',
  unclear: '无法确认',
}

/**
 * The correction fed back when the review rejects the turn.
 *
 * Names each requirement that is still open, with the reviewer's reason, and
 * ends with the one instruction a small model actually follows: keep working,
 * do not re-explain. Without that last line the model tends to restate its
 * previous answer, which the next review rejects again for the same reason.
 */
export function buildReviewCorrection(review: ReviewResult): string {
  const lines = [
    '自审没有通过，现在还不能收尾。',
    '',
    `自审判定：${VERDICT_LABEL[review.verdict]}`,
  ]
  if (review.summary.trim().length > 0) lines.push(`自审说明：${review.summary.trim()}`)

  // `met` rows are dropped: repeating what already succeeded is how a model
  // talks itself into redoing finished work instead of the open part.
  const open = review.findings.filter((finding) => finding.status !== 'met')
  if (open.length > 0) {
    lines.push('', '下面这些要求还没有证据支持：')
    for (const finding of open) {
      lines.push(`  - [${STATUS_LABEL[finding.status]}] ${finding.requirement}`)
      if (finding.evidence.trim().length > 0) lines.push(`      原因：${finding.evidence.trim()}`)
    }
  }

  lines.push(
    '',
    '继续调用工具把上面每一条真正做完，不要只说明你打算怎么做，也不要重复已经给过的答复。',
    '全部做完之后再给出最终答复。',
  )
  return lines.join('\n')
}

/** True when the review says the turn may end. */
export function reviewPassed(review: ReviewResult): boolean {
  return review.verdict === 'match'
}

/**
 * Turn the reviewer's raw output into a `ReviewResult`.
 *
 * Local models wrap JSON in prose, fences, or both, and sometimes trail a
 * comma. Rather than fail the whole review on a formatting slip, recover the
 * first balanced object and fall back to showing the raw text as the summary —
 * a malformed review is still more useful than an error.
 */
export function parseReview(raw: string): ReviewResult {
  const text = raw.trim()
  const start = text.indexOf('{')
  if (start === -1) {
    return { verdict: 'partial', summary: text.slice(0, 1500), findings: [] }
  }

  // Scan for the matching brace so trailing prose after the object is ignored.
  let depth = 0
  let end = -1
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end === -1) {
    return { verdict: 'partial', summary: text.slice(0, 1500), findings: [] }
  }

  const candidate = text.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1')
  try {
    const parsed = JSON.parse(candidate) as {
      verdict?: unknown
      summary?: unknown
      findings?: unknown
    }
    const verdict =
      parsed.verdict === 'match' || parsed.verdict === 'mismatch' || parsed.verdict === 'partial'
        ? parsed.verdict
        : 'partial'

    const findings: ReviewFinding[] = []
    if (Array.isArray(parsed.findings)) {
      for (const item of parsed.findings) {
        if (typeof item !== 'object' || item === null) continue
        const row = item as Record<string, unknown>
        const status = row.status
        findings.push({
          requirement: typeof row.requirement === 'string' ? row.requirement : '',
          status:
            status === 'met' || status === 'partial' || status === 'missing' || status === 'unclear'
              ? status
              : 'unclear',
          evidence: typeof row.evidence === 'string' ? row.evidence : '',
        })
      }
    }

    return {
      verdict,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      findings,
    }
  } catch {
    return { verdict: 'partial', summary: candidate.slice(0, 1500), findings: [] }
  }
}
