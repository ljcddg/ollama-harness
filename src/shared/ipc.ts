/**
 * IPC contract between the Electron main process and the renderer.
 *
 * The renderer never talks to Ollama directly — it goes through these channels,
 * so the renderer stays a pure view and the main process owns filesystem,
 * process spawn, and network access. This is also what makes sandboxing the
 * UI possible later without touching agent logic.
 */

import type { ModelInfo, SessionId, ToolCallId } from './message.js'
import type { SessionEvent, SessionMeta } from './session.js'

export const IPC = {
  /** Renderer → main, expects a reply. */
  invoke: {
    listModels: 'models:list',
    listSessions: 'sessions:list',
    loadSession: 'sessions:load',
    deleteSession: 'sessions:delete',
    createSession: 'sessions:create',
    sendMessage: 'agent:send',
    cancelTurn: 'agent:cancel',
    respondApproval: 'agent:approval',
    getState: 'agent:state',
    setModel: 'agent:set-model',
    setWorkdir: 'agent:set-workdir',
    pickDirectory: 'dialog:pick-directory',
    pickFiles: 'dialog:pick-files',
    readAttachment: 'files:read-attachment',
    reviewSession: 'agent:review',
    getConfig: 'config:get',
    setConfig: 'config:set',
    /** Rewrite one earlier user message. Appends an edit event; see session.ts. */
    editMessage: 'agent:edit-message',
    /** Summarise the early part of the transcript so later turns still fit. */
    compactSession: 'agent:compact',
    /** Write through Electron's clipboard — see why in main.ts. */
    writeClipboard: 'clipboard:write',
    /** Where sessions and config live on disk, for the "open folder" item. */
    dataPath: 'app:data-path',
    /** Show a path in the OS file manager (Explorer / Finder). */
    revealPath: 'shell:reveal-path',
  },
  /** Main → renderer, fire and forget. */
  push: {
    sessionEvent: 'push:session-event',
    status: 'push:status',
    approvalRequest: 'push:approval-request',
    menuCommand: 'push:menu-command',
  },
} as const

/**
 * How the assistant should talk to the user. This is a personality preset, not
 * a free-form prompt: each value maps to a fixed instruction paragraph in the
 * system prompt, so the tone stays stable and predictable.
 */
export type PersonaTone = 'warm' | 'balanced' | 'blunt' | 'concise'

export interface PersonaSettings {
  /** What the assistant calls the user. Empty means "don't use a name". */
  userName: string
  /** How the assistant addresses itself, e.g. "沈知语". Empty means the default. */
  assistantName: string
  /** Reply personality preset. */
  tone: PersonaTone
  /** Free-form extra style notes appended to the persona section. */
  customStyle: string
}

export interface AgentStatus {
  /** True while a turn is executing. */
  busy: boolean
  /** Turn number currently running, if any. */
  turn: number | null
  /** Human-readable phase, for the status line. */
  phase: 'idle' | 'thinking' | 'streaming' | 'tool' | 'waiting-approval'
  /** Set when the last turn failed. */
  lastError?: string
  /**
   * Context occupancy of the open conversation: tokens the next request will
   * carry (last call's input + output), and the model's context window when
   * the provider reports it. Absent before the first call.
   */
  context?: { used: number; window: number | null }
}

export interface AppConfig {
  /** Ollama base URL, e.g. http://127.0.0.1:11434 */
  ollamaBaseUrl: string
  /** Currently selected model id. */
  model: string
  /**
   * Default folder for a brand-new conversation, until one has a directory of
   * its own.
   *
   * This is NOT the working directory of the open conversation. Each session
   * header carries its own `cwd`, and that is what the agent is told and what
   * its tools resolve against — treating this field as the authority made an
   * open conversation report (and read files from) a folder the user had picked
   * for a different chat.
   */
  workdir: string
  /** Sampling temperature. */
  temperature: number
  /**
   * Per-request max output tokens.
   *
   * This is the whole output budget, and for a reasoning model the thinking
   * tokens are spent from it. A 4096 default left a thinking model unable to
   * finish a tool call -- it wrote a page of reasoning, hit the cap, and the
   * turn ended on a half-written "let me look at ..." with no tool invoked.
   * Budget for the reasoning plus the call.
   */
  maxTokens: number
  /**
   * Tools whose every invocation must be confirmed by the user before running.
   * Empty array means "run everything without asking".
   */
  approvalRequiredFor: string[]
  /** Personalisation: how the assistant addresses the user and sounds. */
  persona: PersonaSettings
  /** Run an automated self-review of the reply against the request. */
  selfReview: boolean
  /**
   * Summarise the transcript automatically once it grows past
   * `compactThresholdChars`, so a long session cannot outgrow the model's
   * context window.
   *
   * On by default. The original argument for `false` — an extra model call is
   * worse than doing this on request — was overturned by evidence: nobody
   * requests it, and an 18-turn session that never compacted left the model
   * answering from stale history and describing an unrelated earlier project as
   * if it were this one. One extra call is cheap beside a confident wrong answer.
   */
  autoCompact: boolean
  /**
   * Character budget that triggers an automatic compaction. Deliberately
   * characters rather than tokens: counting tokens needs a tokenizer per model,
   * and characters track context size closely enough for a threshold.
   */
  compactThresholdChars: number
  /**
   * Maximum tool-calling steps in a single turn before the loop stops.
   *
   * One "step" is one model call plus the tools it asked for, so a task that
   * reads six files and makes four edits can spend a dozen steps before it
   * writes anything. The ceiling exists to stop a model that is stuck in a
   * loop, not to ration legitimate work — raise it for tasks that touch many
   * files, lower it if a small model keeps wandering.
   */
  maxStepsPerTurn: number
  /**
   * Display names for working-directory groups in the sidebar, keyed by
   * `pathKey(cwd)` (lowercased, forward slashes, no trailing separator).
   *
   * An alias only changes the label. The real path is what the model is told and
   * what the tools resolve against, so renaming a group can never move a file.
   */
  workdirAliases: Record<string, string>
  /**
   * Working directories whose group is hidden from the sidebar.
   *
   * "Remove from list" also deletes that group's sessions, so this records the
   * user's intent after there is nothing left in the group to display. A group
   * holding the active session is shown regardless — see grouping.ts.
   */
  hiddenWorkdirs: string[]
  /** Session ids sorted to the top of their group. A view preference, not content. */
  pinnedSessions: string[]
}

/**
 * Rough context size of a transcript, which is what the compaction decision is
 * made on. Derived from the folded nodes so it counts what the model would
 * actually see, including tool results.
 */
export interface ContextSize {
  chars: number
  /** True once the transcript is longer than the auto-compact threshold. */
  overBudget: boolean
}

export const DEFAULT_PERSONA: PersonaSettings = {
  userName: '',
  assistantName: '',
  tone: 'balanced',
  customStyle: '',
}

export const DEFAULT_CONFIG: AppConfig = {
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  model: '',
  workdir: '',
  temperature: 0.7,
  maxTokens: 8192,
  approvalRequiredFor: [],
  persona: DEFAULT_PERSONA,
  selfReview: false,
  autoCompact: true,
  // ~24k characters sits comfortably under a 4k-token window for Chinese text
  // (roughly one token per character for models with a Chinese vocab), leaving
  // room for the answer and the system prompt.
  compactThresholdChars: 24_000,
  // 40 steps is roughly six read-edit-verify cycles, which covers a normal
  // single-file change with room to spare. A task that legitimately needs more
  // should be split, which is what the error message tells the user.
  maxStepsPerTurn: 40,
  workdirAliases: {},
  hiddenWorkdirs: [],
  pinnedSessions: [],
}

/** A file the user attached to a message, read by the main process. */
export interface FileAttachment {
  path: string
  name: string
  /** UTF-8 content, possibly truncated. */
  content: string
  bytes: number
  truncated: boolean
  error?: string
}

/** Commands the application menu can ask the renderer to perform. */
export type MenuCommand =
  | 'session:new'
  | 'session:compact'
  | 'session:review'
  | 'session:cancel'
  | 'view:settings'
  | 'view:back-to-latest'

/**
 * Marker separating what the user typed from the files inlined behind it.
 *
 * The renderer splits on this so a 100 KB log attached to a one-line question
 * does not also become the tallest thing in the transcript. It must be a string
 * nobody could type by accident, because a false match would swallow real text.
 *
 * Lives here rather than in core so the renderer can import it without pulling
 * in the tool implementations that come with `loop.ts`.
 */
export const ATTACHMENT_MARKER = '[[harness:attachments]]'

/** One line of a self-review: whether a requirement was actually met. */
export interface ReviewFinding {
  requirement: string
  status: 'met' | 'partial' | 'missing' | 'unclear'
  evidence: string
}

export interface ReviewResult {
  verdict: 'match' | 'partial' | 'mismatch'
  summary: string
  findings: ReviewFinding[]
  /** Set when the review itself could not be completed. */
  error?: string
}

export interface SendMessageRequest {
  sessionId: SessionId
  text: string
  /** Optional files to inline into this turn's context. */
  attachments?: FileAttachment[]
}

export interface SessionSnapshot {
  meta: SessionMeta
  events: SessionEvent[]
}

export interface AppState {
  config: AppConfig
  sessions: SessionMeta[]
  activeSessionId: SessionId | null
  status: AgentStatus
}

export interface ApprovalRequest {
  callId: ToolCallId
  name: string
  arguments: unknown
  /** Short preview of what the tool would do, rendered by the tool itself. */
  preview: string
}

/** The surface exposed on `window.harness` by the preload script. */
export interface HarnessBridge {
  listModels(): Promise<ModelInfo[]>
  listSessions(): Promise<SessionMeta[]>
  loadSession(id: SessionId): Promise<SessionSnapshot>
  deleteSession(id: SessionId): Promise<void>
  /**
   * Start a new session, optionally pinned to a specific working directory.
   *
   * The sidebar's per-group "new conversation" passes that group's directory, so
   * the new session lands in the folder the user clicked instead of wherever the
   * default folder happens to point.
   */
  createSession(workdir?: string): Promise<SessionSnapshot>
  sendMessage(req: SendMessageRequest): Promise<void>
  cancelTurn(): Promise<void>
  respondApproval(callId: ToolCallId, approved: boolean, remember?: boolean): Promise<void>
  getState(): Promise<AppState>
  setModel(model: string): Promise<void>
  setWorkdir(dir: string): Promise<void>
  pickDirectory(): Promise<string | null>
  pickFiles(): Promise<string[]>
  readAttachment(path: string, workdir?: string): Promise<FileAttachment>
  /** Ask the model to check its own work against the user's request. */
  reviewSession(prompt: string): Promise<ReviewResult | null>
  getConfig(): Promise<AppConfig>
  setConfig(patch: Partial<AppConfig>): Promise<AppConfig>
  /**
   * Replace the text of an earlier user message.
   *
   * The original is not destroyed: the edit is appended to the log and read
   * back during folding, so the file stays append-only and the history of what
   * was actually asked remains recoverable.
   */
  editMessage(sessionId: SessionId, targetSeq: number, text: string): Promise<void>
  /**
   * Summarise the transcript up to now, so subsequent turns send the summary
   * instead of the full early history.
   */
  compactSession(sessionId: SessionId): Promise<{ upTo: number; summary: string } | null>
  writeClipboard(text: string): Promise<void>
  dataPath(): Promise<string>
  /**
   * Open a path in the OS file manager, selecting it when it is a file.
   * Resolves to an error string when the path cannot be opened, `null` on success.
   */
  revealPath(path: string): Promise<string | null>
  /** Subscribe to pushed events; returns an unsubscribe function. */
  onSessionEvent(fn: (sessionId: SessionId, event: SessionEvent) => void): () => void
  onStatus(fn: (status: AgentStatus) => void): () => void
  onApprovalRequest(fn: (req: ApprovalRequest) => void): () => void
  onMenuCommand(fn: (command: MenuCommand) => void): () => void
}

declare global {
  interface Window {
    harness: HarnessBridge
  }
}
