/**
 * Composer.
 *
 * Enter sends, Shift+Enter newlines — the convention every chat UI shares, and
 * getting it backwards is the fastest way to annoy a user. The textarea grows
 * with its content up to a cap so a pasted stack trace does not push the send
 * button off screen.
 *
 * ── On sizing the textarea correctly ────────────────────────────────────────
 * Two traps, and getting either wrong is visible:
 *
 * 1. `scrollHeight` never reports less than `clientHeight`. So measuring while
 *    the element still has a height gives you at least the old height back, and
 *    the box can only ever grow. The fix is to collapse it first — `height: 0`
 *    (not `auto`) forces a real reflow to zero, after which `scrollHeight` is
 *    genuinely the content height.
 * 2. `box-sizing: border-box` (set globally) means `height` includes padding and
 *    border, while `scrollHeight` is content + padding. Setting `height` to the
 *    raw `scrollHeight` therefore overshoots, and the element overflows by its
 *    own border width — which is what paints the phantom scrollbar.
 *
 * So: collapse to 0, read `scrollHeight` (content + padding), then hand that
 * back as a border-box height and add back only the border. Two-thirds of a
 * line of slack absorbs sub-pixel line-box rounding without ever showing a
 * scrollbar, because `overflow-y: auto` only engages past `max-height`.
 */

import { useEffect, useRef, useState } from 'react'
import type { AgentStatus, FileAttachment } from '@shared/ipc.js'

/** Cap on textarea growth, in px. Mirrors `max-height` in global.css. */
const MAX_HEIGHT_PX = 220
/** Absorbs sub-pixel line-box rounding, so text never clips or scrolls early. */
const ROUNDING_SLACK_PX = 0.5

interface Props {
  status: AgentStatus
  disabled: boolean
  attachments: FileAttachment[]
  onSend(text: string): void
  onCancel(): void
  onAddFiles(): void
  onRemoveAttachment(path: string): void
  onReview(): void
  placeholder?: string
}

export function Composer(props: Props) {
  const { status, disabled, attachments, onSend, onCancel, placeholder } = props
  const [value, setValue] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  // Grow with the content, then scroll once the cap is reached.
  //
  // Scrolling is switched on by JS rather than left to CSS: a textarea with
  // `overflow-y: auto` paints a scrollbar as soon as its content box overflows
  // by even a fraction of a pixel, and with a fractional line-height that
  // happens on the *second* line of a two-line draft. Instead the element is
  // kept at `overflow: hidden` until the measured content genuinely exceeds the
  // cap, at which point it becomes scrollable at a fixed height.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const styles = window.getComputedStyle(el)
    // height is border-box, scrollHeight is content + padding: add back only the
    // border, or the element overflows by its own border width.
    const border =
      Number.parseFloat(styles.borderTopWidth) + Number.parseFloat(styles.borderBottomWidth)

    // Collapse to 0 so `scrollHeight` reports content rather than the current
    // height (`scrollHeight` never goes below `clientHeight`).
    el.style.height = '0px'
    const content = el.scrollHeight
    const capped = content + border > MAX_HEIGHT_PX

    el.style.height = `${Math.min(content + border + ROUNDING_SLACK_PX, MAX_HEIGHT_PX)}px`
    el.style.overflowY = capped ? 'auto' : 'hidden'

    // Keep the caret in view when the draft is taller than the box.
    if (capped) el.scrollTop = el.scrollHeight
  }, [value])

  // Return focus when a turn ends, so the user can keep typing without clicking.
  // Keyed on `busy` alone and not on every phase change: refocusing mid-turn
  // yanks the page scroll back and fights the user's wheel.
  useEffect(() => {
    if (!status.busy) ref.current?.focus()
  }, [status.busy])

  const canSend = value.trim().length > 0 || attachments.length > 0

  const submit = () => {
    const text = value.trim()
    if (!canSend || status.busy || disabled) return
    // A file-only message still needs some text: the request is what the model
    // is being asked to do, and an empty one gives it nothing to act on.
    onSend(text.length > 0 ? text : '请看我附加的文件。')
    setValue('')
  }

  return (
    <div className="composer">
      <div className="composer-box">
        {attachments.length > 0 && (
          <div className="attach-list">
            {attachments.map((file) => (
              <AttachmentChip
                key={file.path}
                file={file}
                onRemove={() => props.onRemoveAttachment(file.path)}
              />
            ))}
          </div>
        )}

        <textarea
          ref={ref}
          className="composer-input"
          value={value}
          disabled={disabled}
          rows={1}
          placeholder={placeholder ?? '说说你想改什么…'}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />

        <div className="composer-actions">
          <div className="composer-left">
            <button
              className="btn btn-ghost btn-tiny"
              onClick={props.onAddFiles}
              disabled={disabled}
              title="把本地文件加入这条消息的上下文"
            >
              ＋ 添加文件
            </button>
            <button
              className="btn btn-ghost btn-tiny"
              onClick={props.onReview}
              disabled={disabled || status.busy}
              title="让模型核对它自己的改动与你的要求是否相符"
            >
              模型自审
            </button>
            <StatusLine status={status} />
            <ContextMeter context={status.context} />
          </div>

          {status.busy ? (
            <button className="btn btn-stop" onClick={onCancel} title="停止生成">
              <span className="stop-square" aria-hidden />
              停止
            </button>
          ) : (
            <button className="btn btn-send" onClick={submit} disabled={disabled || !canSend}>
              发送
              <kbd>↵</kbd>
            </button>
          )}
        </div>
      </div>
      <div className="composer-hint">
        <kbd>Shift</kbd> + <kbd>↵</kbd> 换行
      </div>
    </div>
  )
}

function AttachmentChip({ file, onRemove }: { file: FileAttachment; onRemove(): void }) {
  const size = file.bytes >= 1024 ? `${(file.bytes / 1024).toFixed(1)} KB` : `${file.bytes} B`
  const title = file.error ? `${file.path}\n${file.error}` : file.path
  const state = file.error ? '文件错误' : file.truncated ? `${size}（已截断）` : size

  return (
    <span className={`attach-chip ${file.error ? 'attach-chip-error' : ''}`} title={title}>
      <span className="attach-name">{file.name}</span>
      <span className="attach-size">{state}</span>
      <button className="attach-remove" onClick={onRemove} title="移除">
        ×
      </button>
    </span>
  )
}

function StatusLine({ status }: { status: AgentStatus }) {
  if (!status.busy) return <span className="status status-idle" />
  const label =
    status.phase === 'thinking'
      ? '思考中…'
      : status.phase === 'streaming'
        ? '正在输出…'
        : status.phase === 'tool'
          ? '正在调用工具…'
          : status.phase === 'waiting-approval'
            ? '等待你确认…'
            : '处理中…'
  return (
    <span className="status status-busy">
      <span className="status-spinner" aria-hidden />
      {label}
    </span>
  )
}

/** `1234` → `1.2k`, so the meter stays narrow in every state. */
function formatK(tokens: number): string {
  return tokens >= 10_000
    ? `${Math.round(tokens / 1000)}k`
    : tokens >= 1000
      ? `${(tokens / 1000).toFixed(1)}k`
      : String(tokens)
}

/**
 * Context occupancy: how much of the model's window the next request will
 * carry. Always visible once a conversation has made a call — the number a
 * user needs BEFORE the model starts drowning is this one, not a banner that
 * shows up after. Without a reported window only the absolute count shows.
 */
function ContextMeter({ context }: { context: AgentStatus['context'] }) {
  if (!context) return null
  const share = context.window !== null && context.window > 0 ? context.used / context.window : null
  const percent = share !== null ? Math.min(999, Math.round(share * 100)) : null
  const level = share === null ? '' : share >= 0.85 ? ' is-high' : share >= 0.7 ? ' is-warn' : ''
  const label =
    context.window !== null
      ? `上下文 ${formatK(context.used)} / ${formatK(context.window)}（${percent}%）`
      : `上下文 ${formatK(context.used)}`
  return (
    <span
      className={`context-meter${level}`}
      title={`下一次请求将携带的上下文：约 ${context.used.toLocaleString('zh-CN')} tokens${
        context.window !== null ? `，模型窗口 ${context.window.toLocaleString('zh-CN')}` : ''
      }。超过约 70% 时会自动压缩。`}
    >
      {label}
    </span>
  )
}
