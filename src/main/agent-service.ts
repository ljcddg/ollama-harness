/**
 * AgentService — the orchestration layer the IPC handlers talk to.
 *
 * Owns the pieces the loop should not: which session is open, which adapter is
 * live for the current config, cancellation, and approval round-trips. The loop
 * itself stays a pure function of (history, user text) → events, which is what
 * makes it testable without Electron running.
 */

import { randomUUID } from 'node:crypto'
import type { LlmAdapter } from '../core/llm/adapter.js'
import { OllamaAdapter } from '../core/llm/ollama-adapter.js'
import { runTurn, maxSeq, type AgentPhase } from '../core/loop.js'
import { SessionStore } from '../core/session-store.js'
import type { ConfigStore } from '../core/config-store.js'
import { createDefaultRegistry, MUTATING_TOOLS, type ToolRegistry } from '../core/tools/index.js'
import type { GenerateOptions, LlmFailure, ModelInfo, SessionId, ToolCallId } from '../shared/message.js'
import { asMessageId, asSessionId } from '../shared/message.js'
import type { SessionEvent, SessionHeader, SessionMeta } from '../shared/session.js'
import { deriveMessages, deriveTitle, latestCompaction, resolveSessionCwd } from '../shared/session.js'
import type {
  AgentStatus,
  AppConfig,
  ApprovalRequest,
  FileAttachment,
  ReviewResult,
} from '../shared/ipc.js'
import { buildCompactPrompt, buildReviewPrompt, buildSystemPrompt } from '../core/prompt.js'
import { parseReview } from '../core/review.js'
import { buildTranscript, renderForSummary } from '../core/transcript.js'

export interface AgentServiceDeps {
  config: ConfigStore
  sessions: SessionStore
  /** Push one event to the renderer. */
  pushEvent(sessionId: SessionId, event: SessionEvent): void
  /** Push a status update. */
  pushStatus(status: AgentStatus): void
  /** Deliver an approval prompt to the renderer. The answer arrives via `resolveApproval`. */
  pushApproval(request: ApprovalRequest): void
}

export class AgentService {
  private adapter: LlmAdapter
  private tools: ToolRegistry
  private header: SessionHeader | null = null
  private events: SessionEvent[] = []
  private abort: AbortController | null = null
  private status: AgentStatus = { busy: false, turn: null, phase: 'idle' }
  /** Pending approval resolvers, keyed by call id. */
  private readonly pendingApprovals = new Map<ToolCallId, (approved: boolean) => void>()

  constructor(private readonly deps: AgentServiceDeps) {
    this.tools = createDefaultRegistry()
    this.adapter = this.buildAdapter({ ollamaBaseUrl: 'http://127.0.0.1:11434' } as AppConfig)
  }

  private buildAdapter(config: AppConfig): LlmAdapter {
    return new OllamaAdapter({ baseUrl: config.ollamaBaseUrl })
  }

  /** Called after a config change that affects the adapter. */
  async reconfigure(config: AppConfig): Promise<void> {
    this.adapter = this.buildAdapter(config)
  }

  get activeSessionId(): SessionId | null {
    return this.header ? asSessionId(this.header.sessionId) : null
  }

  get currentStatus(): AgentStatus {
    return this.status
  }

  async listModels(): Promise<ModelInfo[]> {
    const config = await this.deps.config.load()
    const adapter = this.buildAdapter(config)
    return await adapter.listModels()
  }

  async listSessions(): Promise<SessionMeta[]> {
    return await this.deps.sessions.list()
  }

  async createSession(cwd: string, model: string): Promise<{ meta: SessionMeta; events: SessionEvent[] }> {
    const id = randomUUID()
    const header = SessionStore.newHeader(id, cwd)
    this.header = header
    this.events = []
    await this.deps.sessions.save(header, this.events)
    return { meta: this.toMeta(header), events: [] }
  }

  async loadSession(id: SessionId): Promise<{ meta: SessionMeta; events: SessionEvent[] } | null> {
    const loaded = await this.deps.sessions.load(id)
    if (!loaded) return null
    this.header = loaded.header
    this.events = loaded.events
    return { meta: this.toMeta(loaded.header), events: loaded.events }
  }

  async deleteSession(id: SessionId): Promise<void> {
    await this.deps.sessions.remove(id)
    if (this.header?.sessionId === id) {
      this.header = null
      this.events = []
    }
  }

  async send(text: string, config: AppConfig, attachments?: readonly FileAttachment[]): Promise<void> {
    if (this.status.busy) {
      throw new Error('A turn is already running. Cancel it before sending another message.')
    }
    if (!this.header) {
      await this.createSession(config.workdir, config.model)
    }
    if (!config.model) {
      throw new Error('No model selected. Pick one in the model menu.')
    }

    // The session header is authoritative, NOT `config.workdir`.
    //
    // A conversation belongs to the folder it was started in: that is what the
    // sidebar groups by, and what the user believes they are talking about. The
    // global workdir is only the default for a brand-new session that has not
    // chosen a folder yet.
    //
    // Getting this backwards is not a cosmetic bug. The sidebar can show a
    // session under `D:\desktop1\test` while the agent works in whatever
    // `config.workdir` last pointed at — so the model answers "the current
    // working directory is D:\desktop1\论文" inside a conversation filed under
    // `test`, and reads files the user never pointed it at.
    const cwd = resolveSessionCwd(this.header!.cwd, config.workdir, process.cwd())

    // Housekeeping runs BEFORE the turn, never inside it: compaction needs a
    // model call of its own, and letting that happen mid-turn would fold a
    // summary of the conversation into the answer to it.
    await this.maybeAutoCompact(config)

    const controller = new AbortController()
    this.abort = controller
    this.setStatus({ busy: true, turn: null, phase: 'thinking' })

    try {
      const appended = await runTurn({
        cwd,
        model: config.model,
        config,
        adapter: this.adapter,
        tools: this.tools,
        history: this.events,
        userText: text,
        attachments,
        signal: controller.signal,
        events: {
          onEvent: (event) => {
            this.events.push(event)
            if (event.type === 'turn/start') {
              this.setStatus({ ...this.status, turn: event.data.turn })
            }
            this.deps.pushEvent(asSessionId(this.header!.sessionId), event)
          },
          onPhase: (phase: AgentPhase) => {
            this.setStatus({ ...this.status, phase })
          },
          requestApproval: async (callId, name, args, preview) =>
            await this.awaitApproval({
              callId: callId as ToolCallId,
              name,
              arguments: args,
              preview,
            }),
        },
      })

      // runTurn already pushed every event through `onEvent`, so `this.events`
      // is current. Assert the count instead of re-pushing, so a future change
      // that stops emitting shows up here rather than silently duplicating.
      if (this.events.length < appended.length) {
        this.events.push(...appended.slice(this.events.length))
      }
      // Persist once per turn rather than per event: a turn is the atomic unit a
      // user expects to survive a crash, and one write is cheaper.
      await this.persist()
    } finally {
      this.abort = null
      this.setStatus({ busy: false, turn: null, phase: 'idle' })
    }
  }

  /**
   * Ask the model to audit the work it just did against the request.
   *
   * This deliberately does NOT append to the session log. A review is a
   * question *about* the session, not part of it — logging it would make the
   * next real turn's derived history contain the assistant's self-assessment,
   * which the model would then treat as established fact.
   */
  async review(prompt: string, config: AppConfig): Promise<ReviewResult | null> {
    if (this.events.length === 0) return null
    if (!config.model) throw new Error('No model selected. Pick one in the model menu.')
    if (this.status.busy) {
      throw new Error('A turn is already running. Cancel it before running a review.')
    }

    this.setStatus({ busy: true, turn: null, phase: 'thinking' })
    try {
      // Feed the transcript as a plain-text block rather than as chat turns:
      // the reviewer only needs to read, and a flattened transcript keeps its
      // context window free of tool-call scaffolding it would have to interpret.
      const request = prompt
        || this.events.find((e) => e.type === 'user/message')?.data.message.content
          .filter((b) => b.type === 'text')
          .map((b) => (b as { text: string }).text)
          .join('')
        || '(the user did not state an explicit request)'

      // The transcript has to be IN the request. The prompt instructs the
      // reviewer to read "the conversation above" — without this it had nothing
      // above it, so the only thing it could audit was the closing summary,
      // which is precisely the claim it exists to check.
      const transcript = buildTranscript(deriveMessages(this.events))

      const generate: GenerateOptions = {
        model: config.model,
        messages: [
          {
            id: asMessageId('review-request'),
            role: 'user',
            content: [
              {
                type: 'text',
                text: [transcript, '', '---', '', buildReviewPrompt(request)].join('\n'),
              },
            ],
            source: { kind: 'user' },
            time: Date.now(),
          },
        ],
        systemPrompt: buildSystemPrompt({
          cwd: this.header?.cwd ?? config.workdir,
          model: config.model,
          platform: process.platform,
          toolNames: [],
        }),
        tools: [],
        maxTokens: config.maxTokens,
        temperature: 0,
        signal: new AbortController().signal,
      }

      let raw = ''
      let failure: LlmFailure | null = null
      for await (const chunk of this.adapter.stream(generate)) {
        if (chunk.type === 'text-delta') raw += chunk.text
        else if (chunk.type === 'finish' && chunk.reason.kind === 'error') failure = chunk.reason.failure
      }
      if (failure) throw new Error(failure.message)
      return parseReview(raw)
    } catch (error) {
      return {
        verdict: 'partial',
        summary: '',
        findings: [],
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      this.setStatus({ busy: false, turn: null, phase: 'idle' })
    }
  }

  cancel(): void {
    this.abort?.abort()
  }

  /**
   * Rewrite one earlier user message.
   *
   * The edit APPENDS to the log rather than rewriting a line — the log is the
   * source of truth and it is append-only, which is what makes a crash cost at
   * most one event. The original text stays recoverable on disk while both
   * folds (this process's `deriveMessages` and the renderer's node tree) pick up
   * the replacement.
   *
   * Nothing downstream is re-run. Editing corrects the prompt going forward; it
   * does not regenerate answers already produced from the old wording, because
   * doing so silently would rewrite history the user can no longer compare against.
   */
  async editMessage(targetSeq: number, text: string): Promise<SessionEvent> {
    if (!this.header) throw new Error('No session is open.')
    const trimmed = text.trim()
    if (trimmed.length === 0) throw new Error('消息不能为空。')

    const target = this.events.find((e) => e.seq === targetSeq && e.type === 'user/message')
    if (!target) throw new Error(`找不到 seq 为 ${targetSeq} 的用户消息。`)

    const event: SessionEvent = {
      type: 'message/edit',
      data: { targetSeq, text: trimmed },
      seq: maxSeq(this.events) + 1,
      time: Date.now(),
    }
    this.events.push(event)
    this.deps.pushEvent(asSessionId(this.header.sessionId), event)
    await this.persist()
    return event
  }

  /**
   * Summarise the transcript once it outgrows the configured budget.
   *
   * `autoCompact` shipped as a config field with a settings input and no reader,
   * so a session grew without bound while the setting appeared to be on. That is
   * not merely untidy: a small model drowns in a long transcript. Observed live
   * at 18 turns / ~22K tokens, the model stopped calling tools altogether and
   * answered from what it half-remembered, attributing a directory from an
   * earlier, unrelated project to the current one.
   *
   * Measured through `renderForSummary` — the same rendering the summariser
   * consumes — so the size this triggers on is the size the model receives,
   * edits and previously-skipped ranges included.
   */
  private async maybeAutoCompact(config: AppConfig): Promise<void> {
    if (!config.autoCompact || !this.header) return
    const budget = config.compactThresholdChars
    if (!Number.isFinite(budget) || budget <= 0) return

    const chars = deriveMessages(this.events).map(renderForSummary).join('\n\n').length
    if (chars <= budget) return

    try {
      await this.compactSession(config)
    } catch {
      // Never block the user's message on housekeeping; the next send retries.
    }
  }

  /**
   * Roll the transcript into a summary so subsequent turns still fit the window.
   *
   * Nothing is deleted. A `session/compact` event records the last seq the
   * summary covers, and `deriveMessages` resumes from there — so compaction is a
   * way of READING the log, not a destructive trim, and the full conversation is
   * still there for anyone reading the file (or the UI, which keeps showing it).
   *
   * Uses `deriveMessages` rather than the raw events so what gets summarised is
   * exactly what the model was seeing, edits included.
   */
  async compactSession(config: AppConfig): Promise<{ upTo: number; summary: string } | null> {
    if (!this.header) throw new Error('No session is open.')
    if (!config.model) throw new Error('No model selected. Pick one in the model menu.')
    if (this.status.busy) {
      throw new Error('A turn is already running. Cancel it before compacting.')
    }

    const messages = deriveMessages(this.events)
    // A second compaction summarises the previous summary plus what came after,
    // because `deriveMessages` already resumes after the last compaction point.
    const transcript = messages.map(renderForSummary).filter((s) => s.length > 0).join('\n\n')
    if (transcript.trim().length === 0) return null

    this.setStatus({ busy: true, turn: null, phase: 'thinking' })
    try {
      const generate: GenerateOptions = {
        model: config.model,
        messages: [
          {
            id: asMessageId('compact-request'),
            role: 'user',
            content: [{ type: 'text', text: buildCompactPrompt() }],
            source: { kind: 'user' },
            time: Date.now(),
          },
          {
            id: asMessageId('compact-transcript'),
            role: 'user',
            content: [{ type: 'text', text: `以下是到目前为止的完整对话记录：\n\n${transcript}` }],
            source: { kind: 'user' },
            time: Date.now(),
          },
        ],
        systemPrompt: buildSystemPrompt({
          cwd: this.header.cwd || config.workdir,
          model: config.model,
          platform: process.platform,
          toolNames: [],
        }),
        tools: [],
        maxTokens: config.maxTokens,
        // Summarising is transcription, not composition — same reason a review
        // runs cold.
        temperature: 0,
        signal: new AbortController().signal,
      }

      let raw = ''
      let failure: LlmFailure | null = null
      for await (const chunk of this.adapter.stream(generate)) {
        if (chunk.type === 'text-delta') raw += chunk.text
        else if (chunk.type === 'finish' && chunk.reason.kind === 'error') failure = chunk.reason.failure
      }
      if (failure) throw new Error(failure.message)

      const summary = raw.trim()
      if (summary.length === 0) throw new Error('模型返回了空摘要，上下文没有被改动。')

      // `upTo` is the LAST seq the summary accounts for. Everything at or below
      // it is what gets skipped next time, so it must be the current end of the
      // log — anything higher would silently drop events nobody summarised.
      const upTo = maxSeq(this.events)
      const event: SessionEvent = {
        type: 'session/compact',
        data: { upTo, summary },
        seq: upTo + 1,
        time: Date.now(),
      }
      this.events.push(event)
      this.deps.pushEvent(asSessionId(this.header.sessionId), event)
      await this.persist()
      return { upTo, summary }
    } finally {
      this.setStatus({ busy: false, turn: null, phase: 'idle' })
    }
  }

  resolveApproval(callId: ToolCallId, approved: boolean): void {
    const resolver = this.pendingApprovals.get(callId)
    if (!resolver) return
    this.pendingApprovals.delete(callId)
    resolver(approved)
  }

  /** Tools that should be listed as approval-guarded in the settings UI. */
  get mutatingTools(): readonly string[] {
    return MUTATING_TOOLS
  }

  private awaitApproval(request: ApprovalRequest): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(request.callId, resolve)
      // If the turn is cancelled while a prompt is open, unblock the loop so it
      // can settle instead of hanging until the user answers a stale prompt.
      const onAbort = () => {
        if (this.pendingApprovals.delete(request.callId)) resolve(false)
      }
      this.abort?.signal.addEventListener('abort', onAbort, { once: true })
      this.deps.pushApproval(request)
    })
  }

  private setStatus(status: AgentStatus): void {
    this.status = status
    this.deps.pushStatus(status)
  }

  private toMeta(header: SessionHeader): SessionMeta {
    return {
      ...header,
      title: header.title || deriveTitle(this.events),
      messageCount: this.events.filter((e) => e.type === 'user/message').length,
    }
  }

  private async persist(): Promise<void> {
    if (!this.header) return
    this.header = {
      ...this.header,
      title: this.header.title || deriveTitle(this.events),
      updatedAt: Date.now(),
    }
    await this.deps.sessions.save(this.header, this.events)
  }
}

