/**
 * The agent loop.
 *
 * Shape: a session is a list of turns; a turn is a list of steps; a step is one
 * model call plus the tool calls it produced. The loop keeps taking steps until
 * the model stops asking for tools, the user cancels, or a step fails.
 *
 * Two invariants hold this together and are worth stating outright:
 *
 * 1. **The request is derived, never mutated.** Every model call rebuilds its
 *    message list from the session log. Nothing accumulates in a "current
 *    messages" variable, which is what makes cancel/resume/replay exact instead
 *    of approximately right.
 * 2. **Events are appended before their effects are observable.** A tool call is
 *    logged before it runs, so a crash mid-tool leaves a log that explains it.
 */

import type { LlmAdapter } from './llm/adapter.js'
import { LlmError } from './llm/adapter.js'
import { BlockAssembler } from './llm/assembler.js'
import type {
  ContentBlock,
  FinishReason,
  GenerateOptions,
  LlmFailure,
  Message,
  MessageId,
  StreamChunk,
  ToolCallBlock,
} from '../shared/message.js'
import { asMessageId, asToolCallId } from '../shared/message.js'
import type { SessionEvent } from '../shared/session.js'
import { deriveMessages } from '../shared/session.js'
import type { AppConfig, FileAttachment } from '../shared/ipc.js'
import { ATTACHMENT_MARKER } from '../shared/ipc.js'
import { buildSystemPrompt } from './prompt.js'
import { discoverSkills } from './skills.js'
import {
  buildCapabilityCorrection,
  buildClaimCorrection,
  buildStallCorrection,
  detectCapabilityDenial,
  detectStall,
  detectUnbackedClaim,
} from './stall.js'
import { buildReviewCorrection, reviewPassed, runSelfReview } from './review.js'
import type { ToolRegistry, ToolRunContext } from './tools/types.js'
import { validateArgs } from './tools/types.js'

export type AgentPhase = 'thinking' | 'streaming' | 'tool' | 'waiting-approval' | 'idle'

export interface LoopEvents {
  /** Called for every event the loop appends, in order. */
  onEvent(event: SessionEvent): void
  /** Called when the phase changes, for the status line. */
  onPhase(phase: AgentPhase): void
  /** Ask the user to confirm a tool call. Resolves true when approved. */
  requestApproval(callId: string, name: string, args: unknown, preview: string): Promise<boolean>
}

export interface RunTurnOptions {
  cwd: string
  model: string
  config: AppConfig
  adapter: LlmAdapter
  tools: ToolRegistry
  /** The log so far — the loop reads it and hands back only the events it added. */
  history: readonly SessionEvent[]
  /** The user's prompt for this turn. */
  userText: string
  /** Files the user attached to this turn, inlined into the user message. */
  attachments?: readonly FileAttachment[]
  events: LoopEvents
  signal: AbortSignal
}

/**
 * Fold attachments into the user's text.
 *
 * They are inlined as fenced blocks rather than passed as separate messages
 * because Ollama's chat API has no attachment channel — a local model can only
 * see text. The header line names the path so the model can reference it in
 * later tool calls instead of guessing.
 */
function buildUserText(text: string, attachments?: readonly FileAttachment[]): string {
  if (!attachments || attachments.length === 0) return text
  const blocks = attachments.map((file) => {
    if (file.error) {
      return [`Attached file: ${file.path}`, `<unreadable: ${file.error}>`].join('\n')
    }
    const note = file.truncated ? ' (truncated — the rest was too large to include)' : ''
    const language = guessLanguage(file.name)
    return [
      `Attached file: ${file.path}${note}`,
      '```' + language,
      file.content,
      '```',
    ].join('\n')
  })
  const header = attachments.length === 1
    ? 'The user attached the following file:'
    : `The user attached the following ${attachments.length} files:`
  // The marker goes on its own line so the renderer can hide the payload behind
  // a chip without the transcript having to re-derive what was inlined.
  return [text, '', ATTACHMENT_MARKER, header, '', blocks.join('\n\n')].join('\n')
}

/** Map a file extension to a fence tag so the model sees the file as code. */
function guessLanguage(name: string): string {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  const known: Record<string, string> = {
    ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
    json: 'json', java: 'java', py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
    c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', kt: 'kotlin',
    html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
    md: 'markdown', yml: 'yaml', yaml: 'yaml', toml: 'toml', xml: 'xml',
    sql: 'sql', sh: 'bash', bat: 'bat', ps1: 'powershell', vue: 'vue', svelte: 'svelte',
  }
  return known[ext] ?? ''
}

/**
 * Fallback cap on consecutive steps within one turn, used when the config does
 * not set one. The loop is bounded because a small model can otherwise cycle
 * "read, edit, read, edit" forever without concluding, which looks to the user
 * like a hang.
 */
const DEFAULT_MAX_STEPS_PER_TURN = 40

/**
 * How many self-correction messages one turn may spend.
 *
 * Two, not one, because the two guards catch genuinely different mistakes — a
 * model can narrate a plan and *then*, corrected, switch to claiming it has no
 * permission. Both are worth a nudge. Beyond two the model has shown it will not
 * take the hint, and further nudges only burn tokens while the user waits.
 */
const MAX_CORRECTIONS = 2

/**
 * How many self-reviews one turn may fail before the user is told, rather than
 * the turn being allowed to end anyway.
 *
 * This is the number that replaces "give up after two nudges". The old cap made
 * the harness's patience the definition of done — the system decided the work
 * was finished because it was tired, not because it was finished. A round here
 * is one rejected attempt, and the cap exists only so a model that cannot close
 * the gap does not loop forever; when it is reached the findings are handed to
 * the user instead of the turn being reported as complete.
 */
const MAX_REVIEW_ROUNDS = 3

/** Loop diagnostics, off unless HARNESS_LOOP_DEBUG=1. */
const TRACE = process.env.HARNESS_LOOP_DEBUG === '1'

function trace(message: string): void {
  if (TRACE) console.error(`[loop] ${message}`)
}

/** An event with its identity fields filled in. */
type DraftEvent = SessionEvent extends infer T
  ? T extends SessionEvent
    ? Omit<T, 'seq' | 'time'>
    : never
  : never

/**
 * Run one full turn: user message in, assistant work out.
 * Returns only the events appended during this turn, in order.
 */
export async function runTurn(options: RunTurnOptions): Promise<SessionEvent[]> {
  const { events, signal, tools, adapter, config } = options
  const appended: SessionEvent[] = []
  let seq = maxSeq(options.history) + 1

  const emit = (draft: DraftEvent): void => {
    const full = { ...draft, seq: seq++, time: Date.now() } as SessionEvent
    appended.push(full)
    events.onEvent(full)
  }

  const turn = lastTurn(options.history) + 1
  emit({ type: 'turn/start', data: { turn } })

  const userMessage: Message = {
    id: asMessageId(`user-${seq}`),
    role: 'user',
    content: [{ type: 'text', text: buildUserText(options.userText, options.attachments) }],
    source: { kind: 'user' },
    time: Date.now(),
  }
  emit({ type: 'user/message', data: { message: userMessage } })

  const finishTurn = (reason: FinishReason): SessionEvent[] => {
    emit({ type: 'turn/end', data: { turn, reason } })
    return appended
  }

  const maxSteps =
    Number.isFinite(config.maxStepsPerTurn) && config.maxStepsPerTurn > 0
      ? Math.trunc(config.maxStepsPerTurn)
      : DEFAULT_MAX_STEPS_PER_TURN

  // Self-corrections spent this turn — see MAX_CORRECTIONS.
  let corrections = 0

  /**
   * Whether any tool has actually run during this turn.
   *
   * `detectUnbackedClaim` is documented as being "consulted only on a turn with
   * zero tool calls", because the shape it exists to catch is a model that has
   * stopped using tools and started reciting. It was being consulted per STEP.
   * That made a turn that listed a directory and then described it look like an
   * unbacked claim — and worse, the PATH_HINT branch fires on the user's own
   * words, which do not change between steps, so any request naming a path
   * could never end with an answer at all: each attempt was corrected twice and
   * the turn then died as UNBACKED_CLAIM. Turn level is what the contract
   * always said, and the only level at which "no tool ran" means anything.
   */
  let toolsRanThisTurn = false

  /** Self-reviews spent this turn — see MAX_REVIEW_ROUNDS. */
  let reviewRounds = 0

  /**
   * Convergence memory for the review gate: the open requirements and the
   * answer text from the last FAILED review. A re-review that raises the same
   * objections to a changed answer is reviewer drift (accept); a failed
   * re-review of an UNCHANGED answer means the correction changed nothing
   * (escalate immediately).
   */
  let prevOpenFindings = ''
  let prevReviewedAnswer = ''

  // Read once per turn, not once per step: the catalog is a directory walk, and a
  // turn is short enough that a skill written mid-turn can wait for the next one.
  // Never throws — a project with no skills, or an unreadable one, simply has none,
  // and a missing `.SKILL` directory must not be able to fail a conversation.
  const skills = await discoverSkills(options.cwd)

  try {
    for (let step = 1; step <= maxSteps; step++) {
      if (signal.aborted) return finishTurn({ kind: 'aborted' })

      events.onPhase('thinking')

      // The request is rebuilt from the log every step — never carried forward.
      const messages = deriveMessages([...options.history, ...appended])
      const systemPrompt = buildSystemPrompt({
        cwd: options.cwd,
        model: options.model,
        platform: process.platform,
        toolNames: tools.names(),
        persona: config.persona,
        skills,
      })

      const generate: GenerateOptions = {
        model: options.model,
        messages,
        systemPrompt,
        tools: tools.definitions(),
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        signal,
      }

      emit({
        type: 'step/start',
        data: { turn, step, model: options.model, provider: adapter.provider },
      })

      const messageId = asMessageId(`assistant-${turn}-${step}`)
      const messageTimestamp = Date.now()
      const outcome = await collectStream({
        generate,
        adapter,
        signal,
        messageId,
        messageTimestamp,
        emit,
      })

      if (outcome.kind === 'aborted') return finishTurn({ kind: 'aborted' })
      if (outcome.kind === 'error') {
        emit({ type: 'step/end', data: { turn, step, reason: { kind: 'error', failure: outcome.failure } } })
        return finishTurn({ kind: 'error', failure: outcome.failure })
      }

      // A tool call whose arguments never parsed is reported to the model as a
      // failed call, so it can correct itself instead of retrying blind.
      for (const bad of outcome.argumentErrors) {
        const callId = asToolCallId(bad.callId)
        emit({ type: 'tool/start', data: { callId, name: bad.name, arguments: {} } })
        emit({
          type: 'tool/end',
          data: {
            callId,
            name: bad.name,
            isError: true,
            content: `Your arguments were not valid JSON, so the call could not run. Received: ${bad.raw.slice(0, 300)}`,
            durationMs: 0,
          },
        })
      }

      for (const call of outcome.toolCalls) {
        emit({
          type: 'step/tool-call',
          data: { id: messageId, callId: call.callId, name: call.name, arguments: call.arguments },
        })
      }

      const hasText = outcome.content.some((b) => b.type === 'text' && b.text.trim().length > 0)
      const hasReasoning = outcome.content.some(
        (b) => b.type === 'reasoning' && b.text.trim().length > 0,
      )
      const noCalls = outcome.toolCalls.length === 0 && outcome.argumentErrors.length === 0

      if (noCalls && !hasText) {
        // A reasoning model can spend its whole budget thinking and never emit
        // an answer. That is a different problem from a genuinely empty reply —
        // one is fixed by raising the token budget, the other by retrying — so
        // say which happened instead of blaming the model size for both.
        const failure: LlmFailure =
          hasReasoning && outcome.finishReason?.kind === 'max-tokens'
            ? {
                message:
                  '模型把输出预算全用在推理上，始终没有产出正式回答。请调高最大输出 token，或把问题问得更具体。',
                code: 'REASONING_ONLY',
              }
            : {
                message: '模型返回了空回复。请重试，或换一个更大的模型。',
                code: 'EMPTY_RESPONSE',
              }
        emit({ type: 'step/end', data: { turn, step, reason: { kind: 'error', failure } } })
        return finishTurn({ kind: 'error', failure })
      }

      if (noCalls) {
        const text = outcome.content
          .filter((b) => b.type === 'text')
          .map((b) => (b as { text: string }).text)
          .join('')
        const reasoning = outcome.content
          .filter((b) => b.type === 'reasoning')
          .map((b) => (b as { text: string }).text)
          .join('')

        // Two failures look identical here — a text-only step with no tool call —
        // and they need opposite corrections, so tell them apart before acting.
        //
        // A false "I have no filesystem access" is checked first and suppresses
        // the stall check: a denial also reads as forward-looking, and the
        // capability correction is the right one to send.
        // A third shape, checked last: the model says it HAS looked when it has
        // not. The live case was long, reported a negative result and still ended
        // "我将尝试读取几个核心文件" — too long for detectStall's 400-character
        // guard, and backed by nothing at all.
        const denial = detectCapabilityDenial({ text, reasoning })
        const stalled = denial.denied ? { stalled: false as const } : detectStall({ text, reasoning })
        const claim =
          denial.denied || stalled.stalled || toolsRanThisTurn
            ? { claimed: false as const, reason: '' }
            : detectUnbackedClaim({ text, reasoning, userText: options.userText })

        if (denial.denied || stalled.stalled || claim.claimed) {
          const guard = denial.denied
            ? 'capability-guard'
            : stalled.stalled
              ? 'stall-guard'
              : 'claim-guard'
          const reason = denial.denied
            ? denial.reason
            : stalled.stalled
              ? stalled.reason
              : claim.reason
          trace(`step ${step}: ${guard} — ${reason}`)

          if (corrections < MAX_CORRECTIONS) {
            corrections++
            // Appended as a system-sourced user message, the same channel
            // compaction uses: it is part of the log the next step derives its
            // request from, so it survives a reload and reads correctly in the
            // transcript instead of being a UI-only notice.
            emit({
              type: 'user/message',
              data: {
                message: {
                  id: asMessageId(`guard-${turn}-${step}`),
                  role: 'user',
                  content: [
                    {
                      type: 'text',
                      text: denial.denied
                        ? buildCapabilityCorrection(denial, options.cwd)
                        : stalled.stalled
                          ? buildStallCorrection(stalled)
                          : buildClaimCorrection(claim),
                    },
                  ],
                  source: { kind: 'system', name: guard },
                  time: Date.now(),
                },
              },
            })
            emit({ type: 'step/end', data: { turn, step, reason: { kind: 'tool-calls' } } })
            continue
          }

          // Out of corrections and still not acting. Report which of the two it
          // is — "stuck" and "insists it has no permission" need different fixes
          // from the user.
          const failure: LlmFailure = denial.denied
            ? {
                message:
                  '模型坚持声称自己没有读写文件的权限，但它实际拿到了 read / glob / grep / bash 这些工具。' +
                  '已停止本轮。这不是权限问题，是模型没有按工具调用格式作答——换一个支持工具调用、参数更大的模型通常能解决；' +
                  '也可以把要求写得更直接，例如「用 glob 列出 D:\\xxx 下的所有文件」。',
                code: 'CAPABILITY_DENIED',
              }
            : stalled.stalled
              ? {
                  message:
                    '模型连续多次只描述计划、没有真正调用工具，已停止。可以把任务拆得更小、更具体（比如直接说"读取 src 下的文件"），或者换一个能力更强的模型。',
                  code: 'STALLED_NO_TOOL_CALL',
                }
              : {
                  message:
                    '模型连续多次在没有读取任何文件的情况下声称"已经看过"，已停止。它给出的内容不可信——' +
                    '请把问题缩小到一个具体文件（例如「读一下 dish-service 下的 AiDishGenerator.java」），' +
                    '或者换一个能力更强的模型。',
                  code: 'UNBACKED_CLAIM',
                }
          // With work behind it, a guard has no authority to end the turn — it
          // defers to the review gate below, which judges the work against the
          // request rather than against a phrase. Without work there is nothing
          // to review and no evidence anything happened, so the failure stands.
          if (!toolsRanThisTurn) {
            emit({ type: 'step/end', data: { turn, step, reason: { kind: 'error', failure } } })
            return finishTurn({ kind: 'error', failure })
          }
          trace(`step ${step}: ${guard} out of nudges — deferring to review`)
        }

        // ── The exit condition ───────────────────────────────────────────────
        // A turn ends when the work survives review, not when the model stops
        // emitting tool calls. "No tool call this step" is a fact about the
        // model's output format; reading it as "the task is done" is what let
        // turns end half-finished.
        //
        // The gate runs only on turns that produced tool evidence. A purely
        // conversational answer has nothing for an evidence-based reviewer to
        // check, so it would come back "无法确认" every time and the model
        // would be corrected forever over an answer that was already fine.
        if (toolsRanThisTurn) {
          events.onPhase('thinking')
          const review = await runSelfReview({
            adapter,
            model: options.model,
            config,
            cwd: options.cwd,
            messages: deriveMessages([...options.history, ...appended]),
            userText: options.userText,
            signal,
          })
          if (signal.aborted) return finishTurn({ kind: 'aborted' })

          // Logged either way, before anything acts on the verdict. This gate
          // decides whether the turn may end, so a verdict that never reaches
          // the log leaves the one record there is unable to say why it ended.
          emit({
            type: 'review/result',
            data: {
              turn,
              step,
              outcome: review ? review.verdict : 'unavailable',
              summary: review?.summary ?? '',
              findings: review?.findings ?? [],
              round: reviewRounds + 1,
            },
          })

          // A null review means the reviewer itself failed to run. Finishing is
          // the honest outcome — the alternative is punishing the model for the
          // harness's error, on a turn that may well be complete.
          if (review && !reviewPassed(review)) {
            // Two "stop now" shapes, checked BEFORE spending another round —
            // both observed live on gemma4:e2b:
            //
            // 1. The model re-answered (with new substance) and the reviewer
            //    repeats the SAME open requirements. Re-asking cannot add
            //    evidence: the reviewer is the same model as the worker, and
            //    when it contradicts itself (its own finding text reads
            //    "(已完成)" while the verdict stays partial) a third identical
            //    objection can only loop. The answer stands.
            // 2. The model's answer did not change AT ALL since the last
            //    failed review — the correction provably changed nothing, so
            //    the remaining rounds would arrive at the same place. Escalate
            //    immediately instead of burning them.
            const openKey = review.findings
              .filter((finding) => finding.status !== 'met')
              .map((finding) => finding.requirement.trim().toLowerCase().replace(/\s+/g, ' '))
              .sort()
              .join('|')
            const answerKey = text.trim().replace(/\s+/g, ' ')
            const repeatedObjections = openKey !== '' && openKey === prevOpenFindings
            const answerUnchanged = prevReviewedAnswer !== '' && answerKey === prevReviewedAnswer

            if (!repeatedObjections && !answerUnchanged && reviewRounds < MAX_REVIEW_ROUNDS) {
              prevOpenFindings = openKey
              prevReviewedAnswer = answerKey
              reviewRounds++
              trace(`step ${step}: review ${review.verdict} — round ${reviewRounds}`)
              emit({
                type: 'user/message',
                data: {
                  message: {
                    id: asMessageId(`review-${turn}-${step}`),
                    role: 'user',
                    content: [{ type: 'text', text: buildReviewCorrection(review) }],
                    source: { kind: 'system', name: 'review-gate' },
                    time: Date.now(),
                  },
                },
              })
              emit({ type: 'step/end', data: { turn, step, reason: { kind: 'tool-calls' } } })
              continue
            }

            if (repeatedObjections && !answerUnchanged) {
              trace(`step ${step}: reviewer repeats identical objections to a changed answer — accepting`)
              // Fall through to the normal end below: the answer the user can
              // see is the result; an error banner contradicting it helps nobody.
            } else {
              // Out of rounds, or the model provably cannot budge. Hand the
              // findings to the user rather than reporting a completion the
              // reviewer denies: "unfinished, and here is exactly what is
              // missing" is a result, a false success is not.
              const open = review.findings.filter((finding) => finding.status !== 'met')
              const detail = open.length > 0
                ? open.map((finding) => `${finding.requirement}（${finding.evidence || '没有证据'}）`).join('；')
                : review.summary || '自审没有给出具体原因'
              const failure: LlmFailure = {
                message:
                  `自审没有通过${reviewRounds > 0 ? `（已纠正 ${reviewRounds} 轮）` : ''}，已停止——任务很可能没有做完。` +
                  `还差这些：${detail}。换一个更强的模型，或者把要求拆得更具体之后重试。`,
                code: 'REVIEW_INCOMPLETE',
              }
              emit({ type: 'step/end', data: { turn, step, reason: { kind: 'error', failure } } })
              return finishTurn({ kind: 'error', failure })
            }
          }
        } else {
          // The gate was consulted and stood down: with no tool run there is no
          // evidence for an evidence-based reviewer to check. Recorded rather
          // than left silent, so "not consulted" never looks like "not reached" —
          // the difference between a turn the gate skipped and a turn that ended
          // before the gate ever ran.
          emit({
            type: 'review/result',
            data: { turn, step, outcome: 'skipped', summary: '', findings: [], round: 0 },
          })
        }

        const reason: FinishReason = outcome.finishReason?.kind === 'max-tokens' ? { kind: 'max-tokens' } : { kind: 'stop' }
        emit({ type: 'step/end', data: { turn, step, reason } })
        return finishTurn(reason)
      }

      events.onPhase('tool')
      for (const call of outcome.toolCalls) {
        if (signal.aborted) break
        await executeOne(call, { options, emit })
        // Set per call, not from `outcome.toolCalls.length`: a call that was
        // declared and then never run (abort, or a throw in the executor) is
        // not evidence that anything was looked at. Whether a call that ran and
        // errored counts as evidence is the reviewer's judgement to make, not
        // this flag's.
        toolsRanThisTurn = true
      }

      emit({ type: 'step/end', data: { turn, step, reason: { kind: 'tool-calls' } } })
      events.onPhase('idle')
    }

    // Ran out of steps without the model concluding. Say so rather than looping
    // forever — a silent stop here looks like a hang to the user.
    return finishTurn({
      kind: 'error',
      failure: {
        message: `连续执行 ${maxSteps} 步仍未完成任务，已停止。可以在「设置」里调高「单轮最大步数」，或者把这个任务拆成更小的部分。`,
        code: 'MAX_STEPS',
      },
    })
  } catch (error) {
    const failure = toFailure(error, 'INTERNAL')
    emit({ type: 'turn/end', data: { turn, reason: { kind: 'error', failure } } })
    return appended
  }
}

/**
 * Normalise anything thrown into an `LlmFailure`.
 *
 * An `LlmError` already carries a structured failure; everything else is a bug
 * or a runtime fault, so it gets a readable message under the caller's code.
 */
function toFailure(error: unknown, code: string): LlmFailure {
  if (error instanceof LlmError) return error.failure
  return { message: error instanceof Error ? error.message : String(error), code }
}

interface StreamInput {
  generate: GenerateOptions
  adapter: LlmAdapter
  signal: AbortSignal
  messageId: MessageId
  messageTimestamp: number
  emit(draft: DraftEvent): void
}

type StreamOutcome =
  | {
    kind: 'ok'
    content: ContentBlock[]
    toolCalls: ToolCallBlock[]
    argumentErrors: Array<{ callId: string; name: string; raw: string }>
    finishReason: FinishReason | undefined
  }
  | { kind: 'aborted' }
  | { kind: 'error'; failure: LlmFailure }

/**
 * Consume the adapter's stream into the log.
 *
 * Text and reasoning are flushed INCREMENTALLY so the UI streams token by token,
 * while the tool calls are only known once the stream ends. `flushed` tracks how
 * much of each block has already been emitted, so a block that keeps growing
 * produces one append per delta rather than one per chunk of the whole block.
 */
async function collectStream(input: StreamInput): Promise<StreamOutcome> {
  const { adapter, generate, signal, emit, messageId } = input
  const assembler = new BlockAssembler()
  const flushed = new Map<number, number>()

  const flush = (): void => {
    for (const block of assembler.snapshot()) {
      if (block.kind === 'tool-call') continue
      const already = flushed.get(block.index) ?? 0
      if (block.text.length <= already) continue
      const fresh = block.text.slice(already)
      flushed.set(block.index, block.text.length)
      emit({
        type: block.kind === 'reasoning' ? 'step/reasoning' : 'step/text',
        data: { id: messageId, index: block.index, text: fresh },
      })
    }
  }

  try {
    for await (const chunk of adapter.stream(generate)) {
      if (signal.aborted) return { kind: 'aborted' }
      assembler.accept(chunk as StreamChunk)
      flush()
    }
  } catch (error) {
    if (signal.aborted) return { kind: 'aborted' }
    return { kind: 'error', failure: toFailure(error, 'STREAM_FAILED') }
  }

  const finishReason = assembler.finish
  if (finishReason?.kind === 'error') return { kind: 'error', failure: finishReason.failure }
  if (finishReason?.kind === 'aborted') return { kind: 'aborted' }

  if (assembler.usage) emit({ type: 'step/usage', data: { usage: assembler.usage } })

  const { content, argumentErrors } = assembler.flush()
  return {
    kind: 'ok',
    content,
    toolCalls: content.filter((b): b is ToolCallBlock => b.type === 'tool-call'),
    argumentErrors,
    finishReason,
  }
}

interface ExecuteInput {
  options: RunTurnOptions
  emit(draft: DraftEvent): void
}

async function executeOne(call: ToolCallBlock, input: ExecuteInput): Promise<void> {
  const { options, emit } = input
  const { tools, config } = options
  const start = Date.now()

  const tool = tools.get(call.name)
  if (!tool) {
    emit({ type: 'tool/start', data: { callId: call.callId, name: call.name, arguments: call.arguments } })
    emit({
      type: 'tool/end',
      data: {
        callId: call.callId,
        name: call.name,
        isError: true,
        content: `Unknown tool "${call.name}". Available tools: ${tools.names().join(', ')}.`,
        durationMs: 0,
      },
    })
    return
  }

  emit({ type: 'tool/start', data: { callId: call.callId, name: call.name, arguments: call.arguments } })

  const args =
    typeof call.arguments === 'object' && call.arguments !== null
      ? (call.arguments as Record<string, unknown>)
      : {}

  const schemaError = validateArgs(tool.parameters, args)
  if (schemaError) {
    emit({
      type: 'tool/end',
      data: {
        callId: call.callId,
        name: call.name,
        isError: true,
        content: `Invalid arguments for ${call.name}: ${schemaError}`,
        durationMs: Date.now() - start,
      },
    })
    return
  }

  const preview = tool.preview?.(args) ?? `${call.name}(${JSON.stringify(args).slice(0, 120)})`

  const ctx: ToolRunContext = {
    cwd: options.cwd,
    signal: options.signal,
    callId: call.callId,
    // A tool that asks on its own always gets a prompt, even when the tool as a
    // whole is not guarded — the tool knows better than the config does.
    requestApproval: async (message: string) => {
      options.events.onPhase('waiting-approval')
      try {
        return await options.events.requestApproval(call.callId, call.name, args, message)
      } finally {
        options.events.onPhase('tool')
      }
    },
    // Log-only, and the loop owns the log: a tool records the fact it is
    // responsible for, never the shape of the log. `deriveMessages` ignores this
    // event type, so recording state can never add something for the model to
    // answer.
    emit: (event) => emit(event),
  }

  if (config.approvalRequiredFor.includes(call.name)) {
    options.events.onPhase('waiting-approval')
    const approved = await options.events.requestApproval(call.callId, call.name, args, preview)
    options.events.onPhase('tool')
    if (!approved) {
      emit({
        type: 'tool/end',
        data: {
          callId: call.callId,
          name: call.name,
          isError: true,
          content: 'The user declined to run this tool call. Do not retry it; ask what they would prefer instead.',
          durationMs: Date.now() - start,
        },
      })
      return
    }
  }

  try {
    const result = await tool.execute(args, ctx)
    emit({
      type: 'tool/end',
      data: {
        callId: call.callId,
        name: call.name,
        isError: result.isError === true,
        content: result.content,
        durationMs: Date.now() - start,
      },
    })
  } catch (error) {
    emit({
      type: 'tool/end',
      data: {
        callId: call.callId,
        name: call.name,
        isError: true,
        content: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - start,
      },
    })
  }
}

/**
 * Highest seq in the log. Callers outside the loop need this to append their own
 * events without colliding with the next one the loop will allocate.
 */
export function maxSeq(events: readonly SessionEvent[]): number {
  let max = 0
  for (const e of events) max = Math.max(max, e.seq)
  return max
}

function lastTurn(events: readonly SessionEvent[]): number {
  let turn = 0
  for (const e of events) {
    if (e.type === 'turn/start') turn = Math.max(turn, e.data.turn)
  }
  return turn
}
