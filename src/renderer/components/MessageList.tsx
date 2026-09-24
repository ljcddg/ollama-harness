/**
 * Message rendering.
 *
 * Two behaviours matter most here and both exist for the same reason — a local
 * model streams slowly and thinks out loud:
 *
 * - Reasoning is COLLAPSED by default. Small models emit a lot of it, and letting
 *   it fill the transcript buries the actual answer.
 * - Tool calls render as their own card with a visible status. A user watching a
 *   local model work needs to see "it is running grep right now", because
 *   otherwise a 20-second tool call looks like a hang.
 *
 * Attachments are collapsed too, but for the opposite reason: their content was
 * inlined so the MODEL could read it, and echoing a hundred kilobytes back into
 * the transcript buries everything else. What is useful later is the file names.
 */

import { useState } from 'react'
import type { Node } from '../hooks/useHarness.js'
import type { ReviewResult } from '@shared/ipc.js'
import { ATTACHMENT_MARKER } from '@shared/ipc.js'
import { CopyButton, Markdown } from './Markdown.js'
import { IconFile } from './icons.js'

export interface MessageActions {
  onEdit(seq: number, text: string): Promise<void>
  onCompact(): Promise<void>
  compacting: boolean
}

export function MessageList({
  nodes,
  review,
  actions,
}: {
  nodes: Node[]
  review?: ReviewResult | null
  actions: MessageActions
}) {
  if (nodes.length === 0 && !review) return <EmptyState />
  return (
    <div className="messages">
      {nodes.map((node) => (
        <Message key={node.id} node={node} actions={actions} />
      ))}
      {review && <ReviewCard review={review} />}
    </div>
  )
}

/**
 * Failure codes come from the loop and are stable, snake-cased identifiers. The
 * message text itself is also English (it doubles as the tool-result text the
 * model reads), so the UI supplies its own Chinese explanation and keeps the
 * code visible for anyone debugging.
 */
const ERROR_TEXT: Record<string, string> = {
  EMPTY_RESPONSE:
    '模型返回了空回复。可能原因：上下文对当前模型太大，或这个模型不适合当前任务。可以换个更大的模型、把温度调低，或把问题拆小一点再试。',
  REASONING_ONLY:
    '模型把整个输出预算都花在思考上，没能给出正式回答。去「设置 → 最大输出 token」调高上限，或者把问题问得更具体。',
  MAX_STEPS:
    '连续执行了太多步仍未得出结论，已经停下来。建议把任务拆成几个更小的步骤。',
  STREAM_FAILED: '与 Ollama 的连接中断了。确认服务还在运行，然后重试。',
  INTERNAL: '内部错误。',
}

function Message({ node, actions }: { node: Node; actions: MessageActions }) {
  switch (node.kind) {
    case 'user':
      return <UserMessage node={node} actions={actions} />
    case 'assistant':
      return <AssistantMessage node={node} />
    case 'tool':
      return <ToolCard node={node} />
    case 'compact':
      return <CompactMarker actions={actions} />
    case 'error':
      return (
        <article className="msg msg-error">
          <div className="msg-error-title">出错了</div>
          <div className="msg-body">{ERROR_TEXT[node.code] ?? node.message}</div>
          <div className="msg-error-code">{node.code}</div>
        </article>
      )
    default:
      return null
  }
}

/** Where the log was rolled up, so the user can see why old context got short. */
function CompactMarker({ actions }: { actions: MessageActions }) {
  return (
    <div className="compact-marker">
      <span className="compact-line" aria-hidden />
      <span className="compact-text">
        以上对话已压缩为摘要，之后的请求只会带上摘要
      </span>
      <button className="md-copy" onClick={() => void actions.onCompact()} disabled={actions.compacting}>
        {actions.compacting ? '压缩中…' : '重新压缩'}
      </button>
      <span className="compact-line" aria-hidden />
    </div>
  )
}

function UserMessage({
  node,
  actions,
}: {
  node: Extract<Node, { kind: 'user' }>
  actions: MessageActions
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [showFiles, setShowFiles] = useState(false)

  const { prompt, attached } = splitAttachments(node.text)
  const paths = attachmentPaths(attached)

  const beginEdit = () => {
    setDraft(prompt)
    setEditing(true)
  }

  const commit = async () => {
    const next = draft.trim()
    setEditing(false)
    if (next.length === 0 || next === prompt) return
    await actions.onEdit(node.seq, next)
  }

  if (editing) {
    return (
      <article className="msg msg-user msg-editing">
        <textarea
          className="edit-input"
          value={draft}
          autoFocus
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') setEditing(false)
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void commit()
          }}
        />
        <div className="edit-actions">
          <button className="btn btn-small" onClick={() => void commit()}>
            保存
          </button>
          <button className="btn btn-small btn-ghost" onClick={() => setEditing(false)}>
            取消
          </button>
          <span className="edit-hint">Ctrl/⌘ + Enter 保存，Esc 取消</span>
        </div>
      </article>
    )
  }

  return (
    <article className="msg msg-user">
      <div className="msg-body">
        <Markdown text={prompt} />
      </div>

      {paths.length > 0 && (
        <div className="msg-files">
          {paths.map((path) => (
            <span key={path} className="file-chip" title={path}>
              <span className="file-chip-icon">
                <IconFile />
              </span>
              <span className="file-chip-name">{fileName(path)}</span>
            </span>
          ))}
          <button className="file-toggle" onClick={() => setShowFiles((v) => !v)}>
            {showFiles ? '隐藏内容' : '展开内容'}
          </button>
        </div>
      )}

      {showFiles && attached.length > 0 && (
        <div className="msg-files-body">
          <Markdown text={attached} />
        </div>
      )}

      <div className="msg-tools">
        <CopyButton text={prompt} label="复制" />
        <button className="md-copy" onClick={beginEdit}>
          编辑
        </button>
        {node.edited && <span className="msg-edited-badge">已编辑</span>}
      </div>
    </article>
  )
}

function AssistantMessage({ node }: { node: Extract<Node, { kind: 'assistant' }> }) {
  const [showReasoning, setShowReasoning] = useState(false)
  const hasText = node.text.trim().length > 0
  const hasReasoning = node.reasoning.trim().length > 0

  return (
    <article className="msg msg-assistant">
      {hasReasoning && (
        <div className="reasoning">
          <button className="reasoning-toggle" onClick={() => setShowReasoning((v) => !v)}>
            <span className={`chevron ${showReasoning ? 'open' : ''}`} aria-hidden />
            {showReasoning ? '收起思考过程' : `思考过程（${node.reasoning.length} 字）`}
          </button>
          {showReasoning && <pre className="reasoning-body">{node.reasoning}</pre>}
        </div>
      )}
      {hasText && (
        <div className="msg-body">
          <Markdown text={node.text} />
        </div>
      )}
      {!hasText && node.streaming && <ThinkingDots />}
      {node.streaming && hasText && <span className="caret" aria-hidden />}
      {hasText && !node.streaming && (
        <div className="msg-tools">
          <CopyButton text={node.text} label="复制回复" />
          {hasReasoning && <CopyButton text={node.reasoning} label="复制思考过程" />}
        </div>
      )}
    </article>
  )
}

function ThinkingDots() {
  return (
    <div className="thinking" aria-label="思考中">
      <span />
      <span />
      <span />
    </div>
  )
}

function ToolCard({ node }: { node: Extract<Node, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const summary = summarizeArgs(node.args)

  return (
    <article className={`tool tool-${node.status}`}>
      <button className="tool-head" onClick={() => setOpen((v) => !v)}>
        <span className={`tool-dot tool-dot-${node.status}`} aria-hidden />
        <span className="tool-name">{node.name}</span>
        <span className="tool-summary">{summary}</span>
        {node.durationMs !== undefined && node.status !== 'running' && (
          <span className="tool-time">{formatDuration(node.durationMs)}</span>
        )}
      </button>
      {open && (
        <div className="tool-detail">
          {node.args !== undefined && Object.keys(node.args as object).length > 0 && (
            <>
              <div className="tool-detail-label">参数</div>
              <pre className="tool-detail-body">{JSON.stringify(node.args, null, 2)}</pre>
            </>
          )}
          {node.result.length > 0 && (
            <>
              <div className="tool-detail-label">结果</div>
              <pre className="tool-detail-body">{truncate(node.result, 4000)}</pre>
            </>
          )}
        </div>
      )}
    </article>
  )
}

/**
 * Split a user message back into what was typed and what was inlined.
 *
 * Everything after the marker is shown behind a chip by default. Editing uses
 * only the `prompt` half, so a rewrite never has to round-trip the file content.
 */
function splitAttachments(text: string): { prompt: string; attached: string } {
  const at = text.indexOf(ATTACHMENT_MARKER)
  if (at === -1) return { prompt: text, attached: '' }
  return {
    prompt: text.slice(0, at).trim(),
    attached: text.slice(at + ATTACHMENT_MARKER.length).trim(),
  }
}

/** `Attached file: /path` lines are how the loop labels each inlined file. */
function attachmentPaths(attached: string): string[] {
  if (attached.length === 0) return []
  const found: string[] = []
  const pattern = /^Attached file:\s*(.+?)(?:\s*\(truncated[^\n]*\))?$/gm
  let match: RegExpExecArray | null
  while ((match = pattern.exec(attached)) !== null) {
    found.push(match[1]!.trim())
  }
  return found
}

function fileName(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const parts = normalized.split('/')
  return parts[parts.length - 1] || path
}

/** Verdict labels, in the order they appear in the review card. */
const VERDICT_LABEL: Record<ReviewResult['verdict'], string> = {
  match: '相符',
  partial: '部分相符',
  mismatch: '不相符',
}

const STATUS_LABEL: Record<string, string> = {
  met: '已完成',
  partial: '部分完成',
  missing: '未完成',
  unclear: '无法确认',
}

function ReviewCard({ review }: { review: ReviewResult }) {
  if (review.error) {
    return (
      <article className="msg msg-error">
        <div className="msg-error-title">自审未能完成</div>
        <div className="msg-body">{review.error}</div>
      </article>
    )
  }

  return (
    <article className={`review review-${review.verdict}`}>
      <div className="review-head">
        <span className="review-badge">{VERDICT_LABEL[review.verdict]}</span>
        <span className="review-title">模型自审</span>
      </div>
      {review.summary && <div className="review-summary">{review.summary}</div>}
      {review.findings.length > 0 && (
        <ul className="review-findings">
          {review.findings.map((finding, i) => (
            <li key={i} className={`review-finding finding-${finding.status}`}>
              <span className="finding-status">{STATUS_LABEL[finding.status] ?? finding.status}</span>
              <span className="finding-requirement">{finding.requirement}</span>
              {finding.evidence && <span className="finding-evidence">{finding.evidence}</span>}
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}

function EmptyState() {
  return (
    <div className="empty">
      <h1>想做点什么？</h1>
      <p>描述你要的改动，模型会自己读代码、改文件，并运行验证命令。</p>
      <div className="empty-hints">
        <span>讲一下这个项目的请求流程</span>
        <span>找出并修掉失败的测试</span>
        <span>给设置表单加上输入校验</span>
      </div>
    </div>
  )
}

function summarizeArgs(args: unknown): string {
  if (typeof args !== 'object' || args === null) return ''
  const record = args as Record<string, unknown>
  const primary = record.path ?? record.pattern ?? record.command ?? record.query
  if (typeof primary === 'string') return truncate(primary.replace(/\s+/g, ' '), 90)
  const keys = Object.keys(record)
  return keys.length > 0 ? `${keys.length} 个参数` : ''
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
