/**
 * The renderer's entire state layer.
 *
 * One reducer over pushed session events plus a small amount of UI state. The
 * renderer never derives conversation content itself — it rebuilds the node tree
 * by folding events, exactly like the main process does, so the two can never
 * disagree about what the conversation contains.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type {
  AgentStatus,
  AppConfig,
  ApprovalRequest,
  ContextSize,
  FileAttachment,
  ReviewResult,
  SessionSnapshot,
} from '@shared/ipc.js'
import { DEFAULT_CONFIG } from '@shared/ipc.js'
import type { ModelInfo, SessionId, ToolCallId, TokenUsage } from '@shared/message.js'
import type { SessionEvent, SessionMeta } from '@shared/session.js'
import { pathKey } from '@shared/grouping.js'

/** A renderable conversation node, folded from the log. */
export type Node =
  /** `seq` is the log seq of the originating `user/message` — the handle an edit uses. */
  | { kind: 'user'; id: string; seq: number; text: string; time: number; edited?: boolean }
  | {
    kind: 'assistant'
    id: string
    text: string
    reasoning: string
    time: number
    streaming: boolean
  }
  | {
    kind: 'tool'
    id: string
    callId: string
    name: string
    args: unknown
    status: 'running' | 'ok' | 'error'
    result: string
    durationMs?: number
  }
  | { kind: 'error'; id: string; message: string; code: string }
  /** Marker showing where the transcript was rolled into a summary. */
  | { kind: 'compact'; id: string; time: number }

interface State {
  nodes: Node[]
  usage: TokenUsage
  /** Id of the assistant node currently receiving deltas, if any. */
  openAssistantId: string | null
  /** Tool nodes by call id, so `tool/end` can find its `tool/start`. */
  toolIndex: Map<string, number>
  /** Current text of edited user messages, keyed by the seq they replace. */
  edits: Map<number, string>
  /**
   * Seq of the last compaction. Kept only so the renderer can mark the boundary:
   * the full transcript is still shown, because compressing changes what the
   * model is sent, not what happened.
   */
  compactedTo: number | null
  /** True once the log has been loaded for the active session. */
  loaded: boolean
}

type Action =
  | { type: 'reset'; events: SessionEvent[] }
  | { type: 'append'; event: SessionEvent }

/** Fold one event into the node list. */
function reduce(state: State, action: Action): State {
  if (action.type === 'reset') {
    const fresh: State = {
      nodes: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      openAssistantId: null,
      toolIndex: new Map(),
      edits: new Map(),
      compactedTo: null,
      loaded: true,
    }
    let next = fresh
    for (const event of action.events) next = fold(next, event)
    return next
  }
  return fold(state, action.event)
}

function emptyState(): State {
  return {
    nodes: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    openAssistantId: null,
    toolIndex: new Map(),
    edits: new Map(),
    compactedTo: null,
    loaded: false,
  }
}

function fold(state: State, event: SessionEvent): State {
  switch (event.type) {
    case 'user/message': {
      // The loop's stall/claim/capability corrections borrow this event type,
      // because they have to sit in the log the next request is derived from.
      // They are not the user's words, though: rendered as a user bubble the
      // transcript claims the user typed them, and `lastUserText` would hand the
      // reviewer a correction instead of the request it is meant to measure.
      // Dropped at the fold, so the log and the model are untouched.
      if (event.data.message.source.kind === 'system') return state

      const raw = event.data.message.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('')
      // An edit appended earlier in the replay already applies here, because
      // events are folded in order — the same reason the main process gets the
      // same result from `deriveMessages`.
      const text = state.edits.get(event.seq) ?? raw
      return {
        ...state,
        openAssistantId: null,
        nodes: [
          ...state.nodes,
          {
            kind: 'user',
            id: `u-${event.seq}`,
            seq: event.seq,
            text,
            time: event.time,
            ...(state.edits.has(event.seq) ? { edited: true } : {}),
          },
        ],
      }
    }

    case 'message/edit': {
      const target = event.data.targetSeq
      return {
        ...state,
        edits: new Map(state.edits).set(target, event.data.text),
        nodes: state.nodes.map((node) =>
          node.kind === 'user' && node.seq === target
            ? { ...node, text: event.data.text, edited: true }
            : node,
        ),
      }
    }

    case 'session/compact':
      return {
        ...state,
        compactedTo: event.data.upTo,
        nodes: [...state.nodes, { kind: 'compact', id: `c-${event.seq}`, time: event.time }],
      }

    case 'step/start': {
      const id = `a-${event.data.turn}-${event.data.step}`
      return {
        ...state,
        openAssistantId: id,
        nodes: [
          ...state.nodes,
          {
            kind: 'assistant',
            id,
            text: '',
            reasoning: '',
            time: event.time,
            streaming: true,
          },
        ],
      }
    }

    case 'step/text':
    case 'step/reasoning': {
      if (state.openAssistantId === null) return state
      const isReasoning = event.type === 'step/reasoning'
      return {
        ...state,
        nodes: state.nodes.map((node) =>
          node.kind === 'assistant' && node.id === state.openAssistantId
            ? {
              ...node,
              text: isReasoning ? node.text : node.text + event.data.text,
              reasoning: isReasoning ? node.reasoning + event.data.text : node.reasoning,
            }
            : node,
        ),
      }
    }

    case 'step/tool-call': {
      const id = `t-${event.data.callId}`
      return {
        ...state,
        toolIndex: new Map(state.toolIndex).set(event.data.callId, state.nodes.length),
        nodes: [
          ...state.nodes,
          {
            kind: 'tool',
            id,
            callId: event.data.callId,
            name: event.data.name,
            args: event.data.arguments,
            status: 'running',
            result: '',
          },
        ],
      }
    }

    case 'tool/start': {
      // A call can be logged as starting without a preceding `step/tool-call`
      // when the model produced unparseable arguments. Create the node then.
      if (state.toolIndex.has(event.data.callId)) return state
      return {
        ...state,
        toolIndex: new Map(state.toolIndex).set(event.data.callId, state.nodes.length),
        nodes: [
          ...state.nodes,
          {
            kind: 'tool',
            id: `t-${event.data.callId}`,
            callId: event.data.callId,
            name: event.data.name,
            args: event.data.arguments,
            status: 'running',
            result: '',
          },
        ],
      }
    }

    case 'tool/end': {
      const index = state.toolIndex.get(event.data.callId)
      if (index === undefined) return state
      return {
        ...state,
        nodes: state.nodes.map((node, i) =>
          i === index && node.kind === 'tool'
            ? {
              ...node,
              status: event.data.isError ? 'error' : 'ok',
              result: event.data.content,
              durationMs: event.data.durationMs,
            }
            : node,
        ),
      }
    }

    case 'step/usage':
      return {
        ...state,
        usage: {
          inputTokens: state.usage.inputTokens + event.data.usage.inputTokens,
          outputTokens: state.usage.outputTokens + event.data.usage.outputTokens,
          totalTokens:
            (state.usage.totalTokens ?? 0) + (event.data.usage.totalTokens ?? 0),
        },
      }

    case 'step/end': {
      const reason = event.data.reason
      const nodes = state.nodes.map((node) =>
        node.kind === 'assistant' && node.id === state.openAssistantId
          ? { ...node, streaming: false }
          : node,
      )
      if (reason.kind === 'error') {
        return {
          ...state,
          openAssistantId: null,
          nodes: [
            ...nodes,
            {
              kind: 'error',
              id: `e-${event.seq}`,
              message: reason.failure.message,
              code: reason.failure.code,
            },
          ],
        }
      }
      return { ...state, nodes }
    }

    case 'turn/end': {
      const reason = event.data.reason
      const nodes = state.nodes.map((node) =>
        node.kind === 'assistant' && node.streaming ? { ...node, streaming: false } : node,
      )
      if (reason.kind === 'error') {
        // The loop emits step/end AND turn/end with the same failure; without
        // this guard the user sees the identical error card twice in a row.
        const last = nodes[nodes.length - 1]
        if (
          last?.kind === 'error' &&
          last.message === reason.failure.message &&
          last.code === reason.failure.code
        ) {
          return { ...state, openAssistantId: null, nodes }
        }
        return {
          ...state,
          openAssistantId: null,
          nodes: [
            ...nodes,
            { kind: 'error', id: `e-${event.seq}`, message: reason.failure.message, code: reason.failure.code },
          ],
        }
      }
      return { ...state, openAssistantId: null, nodes }
    }

    default:
      return state
  }
}

export interface Harness {
  config: AppConfig
  models: ModelInfo[]
  sessions: SessionMeta[]
  nodes: Node[]
  usage: TokenUsage
  /** Rough size of what the next request will carry, driving the compact hint. */
  contextSize: ContextSize
  status: AgentStatus
  activeSessionId: SessionId | null
  /**
   * The directory the active conversation runs in.
   *
   * Derived from the session list, not stored: the session header is what the
   * agent is actually told (see AgentService.send), and the sidebar is already
   * grouped by the same value — so deriving here cannot drift from reality.
   */
  activeCwd: string
  approval: ApprovalRequest | null
  /** Files staged for the next message, already read by the main process. */
  attachments: FileAttachment[]
  /** The most recent self-review, if any. Not persisted — see AgentService.review. */
  review: ReviewResult | null
  reviewRunning: boolean
  /** Set when Ollama cannot be reached, so the UI can say so instead of showing an empty list. */
  modelError: string | null
  modelErrorDetail: string | null
  ready: boolean
  send(text: string): Promise<void>
  cancel(): void
  answerApproval(approved: boolean, remember?: boolean): void
  newSession(): Promise<void>
  /** Start a session in a specific directory (sidebar group "+"). */
  newSessionIn(workdir?: string): Promise<void>
  openSession(id: SessionId): Promise<void>
  removeSession(id: SessionId): Promise<void>
  /** Delete every session in a directory, then hide the group. Irreversible. */
  removeGroup(cwd: string, ids: SessionId[]): Promise<void>
  /** Set (or clear, with an empty label) a group's display name. */
  renameGroup(cwd: string, label: string): Promise<void>
  unhideGroup(cwd: string): Promise<void>
  togglePin(id: SessionId): Promise<void>
  /** Returns the stored config, since callers often need the merged result. */
  updateConfig(patch: Partial<AppConfig>): Promise<AppConfig>
  /** Pick a folder and start a conversation in it. */
  createSessionInFolder(): Promise<void>
  addAttachments(): Promise<void>
  removeAttachment(path: string): void
  runReview(): Promise<void>
  clearReview(): void
  refreshModels(): Promise<void>
  /** Rewrite one earlier prompt. Does not re-run anything downstream of it. */
  editMessage(seq: number, text: string): Promise<void>
  /** Roll the current transcript into a summary for future turns. */
  compactSession(): Promise<void>
  compacting: boolean
  writeClipboard(text: string): Promise<void>
}

export function useHarness(): Harness {
  const [state, dispatch] = useReducer(reduce, undefined, emptyState)
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG)
  const [models, setModels] = useState<ModelInfo[]>([])
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [status, setStatus] = useState<AgentStatus>({ busy: false, turn: null, phase: 'idle' })
  const [activeSessionId, setActiveSessionId] = useState<SessionId | null>(null)
  const [approval, setApproval] = useState<ApprovalRequest | null>(null)
  const [attachments, setAttachments] = useState<FileAttachment[]>([])
  const [review, setReview] = useState<ReviewResult | null>(null)
  const [reviewRunning, setReviewRunning] = useState(false)
  const [modelError, setModelError] = useState<string | null>(null)
  const [modelErrorDetail, setModelErrorDetail] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [compacting, setCompacting] = useState(false)

  /** Guards against events for a session the user already navigated away from. */
  const activeRef = useRef<SessionId | null>(null)
  activeRef.current = activeSessionId

  /**
   * Late-bound handles.
   *
   * `removeGroup` is declared before `openSession` and `updateConfig`, so it
   * cannot close over them directly without a declaration-order dance. Refs keep
   * the callbacks' dependency lists honest (no churn per render) while letting the
   * earlier one reach the later one.
   */
  const configRef = useRef(config)
  configRef.current = config
  const updateConfigRef = useRef<(patch: Partial<AppConfig>) => Promise<AppConfig>>(
    async () => config,
  )
  const openSessionRef = useRef<(id: SessionId) => Promise<void>>(async () => {})

  // The session list is the authority here, so an async refresh is the only
  // thing that can move this.
  const activeCwd = useMemo(
    () => sessions.find((s) => s.sessionId === activeSessionId)?.cwd ?? config.workdir,
    [sessions, activeSessionId, config.workdir],
  )

  const refreshModels = useCallback(async () => {
    try {
      const list = await window.harness.listModels()
      setModels(list)
      setModelError(null)
      setModelErrorDetail(null)
    } catch (error) {
      setModels([])
      const message = error instanceof Error ? error.message : String(error)
      setModelError('Could not reach Ollama')
      setModelErrorDetail(message)
    }
  }, [])

  const refreshSessions = useCallback(async () => {
    setSessions(await window.harness.listSessions())
  }, [])

  // Initial load: config, model list, session list, then the last session.
  useEffect(() => {
    let cancelled = false

    void (async () => {
      const initial = await window.harness.getState()
      if (cancelled) return
      setConfig(initial.config)
      setStatus(initial.status)
      setSessions(initial.sessions)
      void refreshModels()

      // Never auto-open a session that has no messages. A session is created
      // eagerly (the first keystroke-less "new chat"), so the newest file is
      // often an empty one — restoring that shows a blank window and reads as
      // "my history is gone". Prefer the newest session that actually has
      // something in it.
      const restorable =
        initial.sessions.find((s) => s.messageCount > 0) ?? initial.sessions[0] ?? null

      if (initial.activeSessionId) {
        const snapshot = await window.harness.loadSession(initial.activeSessionId)
        if (cancelled) return
        setActiveSessionId(snapshot.meta.sessionId)
        dispatch({ type: 'reset', events: snapshot.events })
      } else if (restorable && restorable.messageCount > 0) {
        const snapshot = await window.harness.loadSession(restorable.sessionId)
        if (cancelled) return
        setActiveSessionId(snapshot.meta.sessionId)
        dispatch({ type: 'reset', events: snapshot.events })
      } else if (restorable) {
        // Only empty sessions exist: reuse the newest instead of piling up files.
        setActiveSessionId(restorable.sessionId)
        dispatch({ type: 'reset', events: [] })
      } else {
        const created = await window.harness.createSession()
        if (cancelled) return
        setActiveSessionId(created.meta.sessionId)
        setSessions([created.meta])
        dispatch({ type: 'reset', events: [] })
      }
      if (!cancelled) setReady(true)
    })()

    return () => {
      cancelled = true
    }
  }, [refreshModels])

  // Push subscriptions.
  useEffect(() => {
    const offEvent = window.harness.onSessionEvent((sessionId, event) => {
      // Events for a background session are dropped here; the session list
      // refresh below is what surfaces their progress.
      if (sessionId !== activeRef.current) return
      dispatch({ type: 'append', event })
    })
    const offStatus = window.harness.onStatus(setStatus)
    const offApproval = window.harness.onApprovalRequest(setApproval)
    return () => {
      offEvent()
      offStatus()
      offApproval()
    }
  }, [])

  // Refresh the sidebar when a turn finishes, so titles and counts update.
  useEffect(() => {
    if (!status.busy && ready) void refreshSessions()
  }, [status.busy, ready, refreshSessions])

  /** The prompt the reviewer should measure the work against. */
  const lastUserText = useCallback((): string => {
    const nodes = state.nodes
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i]!
      if (node.kind === 'user') return node.text
    }
    return ''
  }, [state.nodes])

  const runReviewFor = useCallback(async (prompt: string) => {
    setReviewRunning(true)
    try {
      // Give the previous turn's status push time to land, or the review would
      // race the turn-end and appear to start mid-stream.
      await new Promise((resolve) => setTimeout(resolve, 0))
      const result = await window.harness.reviewSession(prompt)
      if (result) setReview(result)
    } catch (error) {
      setReview({
        verdict: 'partial',
        summary: '',
        findings: [],
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setReviewRunning(false)
    }
  }, [])

  const runReview = useCallback(async () => {
    await runReviewFor(lastUserText())
  }, [lastUserText, runReviewFor])

  const addAttachments = useCallback(async () => {
    const paths = await window.harness.pickFiles()
    if (paths.length === 0) return
    // The working directory only decides how generous the inlined excerpt is —
    // a file inside the project can carry more of itself than one plucked from
    // somewhere else on the disk. It follows the ACTIVE conversation for the
    // same reason the agent does.
    const workdir = activeCwd
    const read = await Promise.all(
      paths.map((path) => window.harness.readAttachment(path, workdir)),
    )
    // De-duplicate by path: picking the same file twice would inline it twice
    // and waste context for no gain.
    setAttachments((current) => {
      const byPath = new Map(current.map((file) => [file.path, file]))
      for (const file of read) byPath.set(file.path, file)
      return [...byPath.values()]
    })
  }, [activeCwd])

  const removeAttachment = useCallback((path: string) => {
    setAttachments((current) => current.filter((file) => file.path !== path))
  }, [])

  const clearReview = useCallback(() => setReview(null), [])

  /**
   * How much text the next request would carry. This is the trigger for the
   * "compress?" affordance, so it has to count what the model will actually
   * receive — tool results included, since those are frequently the bulk.
   */
  const contextSize: ContextSize = useMemo(() => {
    let chars = 0
    for (const node of state.nodes) {
      if (node.kind === 'user' || node.kind === 'assistant') chars += node.text.length
      else if (node.kind === 'tool') chars += node.result.length
    }
    const threshold = config.compactThresholdChars
    return {
      chars,
      overBudget: threshold > 0 && chars > threshold && state.compactedTo === null,
    }
  }, [state.nodes, state.compactedTo, config.compactThresholdChars])

  const editMessage = useCallback(async (seq: number, text: string) => {
    const sessionId = activeRef.current
    if (!sessionId) return
    const trimmed = text.trim()
    if (trimmed.length === 0) return
    await window.harness.editMessage(sessionId, seq, trimmed)
  }, [])

  const compactSession = useCallback(async () => {
    const sessionId = activeRef.current
    if (!sessionId || compacting) return
    setCompacting(true)
    try {
      await window.harness.compactSession(sessionId)
    } finally {
      setCompacting(false)
    }
  }, [compacting])

  const writeClipboard = useCallback(async (text: string) => {
    await window.harness.writeClipboard(text)
  }, [])

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim()
      if (trimmed.length === 0 && attachments.length === 0) return
      let sessionId = activeRef.current
      if (!sessionId) {
        const created = await window.harness.createSession()
        sessionId = created.meta.sessionId
        setActiveSessionId(sessionId)
        dispatch({ type: 'reset', events: [] })
      }
      const staged = attachments
      // Clear the staging area up front: the files are already read, and leaving
      // them attached would silently re-inline them into the next message too.
      setAttachments([])
      setReview(null)
      await window.harness.sendMessage({ sessionId, text: trimmed, attachments: staged })
      if (config.selfReview) void runReviewFor(trimmed)
    },
    [attachments, config.selfReview, runReviewFor],
  )

  const cancel = useCallback(() => {
    void window.harness.cancelTurn()
  }, [])

  const answerApproval = useCallback(
    (approved: boolean, remember = false) => {
      const current = approval
      setApproval(null)
      if (current) void window.harness.respondApproval(current.callId as ToolCallId, approved, remember)
    },
    [approval],
  )

  const newSession = useCallback(async () => {
    const created = await window.harness.createSession()
    setActiveSessionId(created.meta.sessionId)
    dispatch({ type: 'reset', events: [] })
    setReview(null)
    setAttachments([])
    await refreshSessions()
  }, [refreshSessions])

  /**
   * Start a session in a specific directory.
   *
   * Used by a sidebar group's "+", so the new conversation lands in the folder
   * the user clicked. The global workdir is left alone — clicking "+" on a group
   * is about that conversation, not about changing where everything runs.
   */
  const newSessionIn = useCallback(
    async (workdir?: string) => {
      if (!workdir) {
        await newSession()
        return
      }
      const created = await window.harness.createSession(workdir)
      setActiveSessionId(created.meta.sessionId)
      dispatch({ type: 'reset', events: [] })
      setReview(null)
      setAttachments([])
      await refreshSessions()
    },
    [newSession, refreshSessions],
  )

  /**
   * Remove a whole directory group: delete its sessions, then hide the group.
   *
   * The order matters. Hiding first would leave the group holding the active
   * session on screen — grouping.ts always shows the active group — so the
   * deletion has to happen first for the removal to look like it took effect.
   * The caller confirms with the user before getting here.
   */
  const removeGroup = useCallback(
    async (cwd: string, ids: SessionId[]) => {
      for (const id of ids) {
        await window.harness.deleteSession(id)
      }
      const key = pathKey(cwd)
      const remaining = await window.harness.listSessions()
      setSessions(remaining)

      await updateConfigRef.current({
        hiddenWorkdirs: [
          ...new Set([...configRef.current.hiddenWorkdirs.map(pathKey), key]),
        ],
        // Drop pins and aliases for sessions that no longer exist.
        pinnedSessions: configRef.current.pinnedSessions.filter(
          (id) => !ids.includes(id as SessionId),
        ),
      })

      // If the session we were viewing was deleted, move somewhere valid.
      if (activeRef.current && ids.includes(activeRef.current)) {
        const next = remaining[0]
        if (next) await openSessionRef.current(next.sessionId)
        else await newSession()
      }
    },
    [newSession],
  )

  const renameGroup = useCallback(async (cwd: string, label: string) => {
    const key = pathKey(cwd)
    const next = { ...configRef.current.workdirAliases }
    if (label.trim().length === 0) delete next[key]
    else next[key] = label.trim()
    await updateConfigRef.current({ workdirAliases: next })
  }, [])

  const unhideGroup = useCallback(async (cwd: string) => {
    const key = pathKey(cwd)
    await updateConfigRef.current({
      hiddenWorkdirs: configRef.current.hiddenWorkdirs.filter((p) => pathKey(p) !== key),
    })
  }, [])

  const togglePin = useCallback(async (id: SessionId) => {
    const current = configRef.current.pinnedSessions
    const next = current.includes(id)
      ? current.filter((x) => x !== id)
      : [...current, id]
    await updateConfigRef.current({ pinnedSessions: next })
  }, [])

  const openSession = useCallback(async (id: SessionId) => {
    const snapshot: SessionSnapshot = await window.harness.loadSession(id)
    setActiveSessionId(snapshot.meta.sessionId)
    dispatch({ type: 'reset', events: snapshot.events })
    // A review belongs to the transcript it judged, so it must not follow the
    // user into a different session.
    setReview(null)
  }, [])

  // Publish the late-bound handles now that both callbacks exist.
  openSessionRef.current = openSession

  const removeSession = useCallback(
    async (id: SessionId) => {
      await window.harness.deleteSession(id)
      const remaining = await window.harness.listSessions()
      setSessions(remaining)
      if (activeRef.current === id) {
        if (remaining.length > 0) {
          await openSession(remaining[0]!.sessionId)
        } else {
          await newSession()
        }
      }
    },
    [newSession, openSession],
  )

  const updateConfig = useCallback(async (patch: Partial<AppConfig>) => {
    const next = await window.harness.setConfig(patch)
    setConfig(next)
    return next
  }, [])

  // Now that both exist, publish them for the callbacks declared above.
  updateConfigRef.current = updateConfig

  /**
   * Pick a folder and start a conversation in it.
   *
   * This is how the user works somewhere else now. It deliberately does not
   * touch `config.workdir`: the folder belongs to the new conversation, and
   * writing it globally is exactly what used to make an open conversation
   * report — and read files from — a directory the user had pointed at for a
   * different chat.
   */
  const createSessionInFolder = useCallback(async () => {
    const dir = await window.harness.pickDirectory()
    if (!dir) return
    await newSessionIn(dir)
  }, [newSessionIn])

  return {
    config,
    models,
    sessions,
    nodes: state.nodes,
    usage: state.usage,
    contextSize,
    status,
    activeSessionId,
    activeCwd,
    approval,
    attachments,
    review,
    reviewRunning,
    modelError,
    modelErrorDetail,
    ready,
    send,
    cancel,
    answerApproval,
    newSession,
    /** Start a session in a specific directory (sidebar group "+"). */
    newSessionIn,
    openSession,
    removeSession,
    removeGroup,
    renameGroup,
    unhideGroup,
    togglePin,
    updateConfig,
    createSessionInFolder,
    addAttachments,
    removeAttachment,
    runReview,
    clearReview,
    refreshModels,
    editMessage,
    compactSession,
    compacting,
    writeClipboard,
  }
}
