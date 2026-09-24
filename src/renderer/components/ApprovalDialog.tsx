/**
 * Approval dialog.
 *
 * Shown when a tool on the approval list is about to run, or when a tool asks on
 * its own initiative. The arguments are shown raw rather than prettified: the
 * user is deciding whether to trust a command, and the exact text is what they
 * need to read. Default focus is on Deny, so a stray Enter cannot approve.
 */

import { useEffect, useRef } from 'react'
import type { ApprovalRequest } from '@shared/ipc.js'

interface Props {
  request: ApprovalRequest
  onAnswer(approved: boolean): void
}

export function ApprovalDialog({ request, onAnswer }: Props) {
  const denyRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    denyRef.current?.focus()
  }, [request.callId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onAnswer(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onAnswer])

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="approval-title">
      <div className="modal">
        <div className="modal-eyebrow">需要你的授权</div>
        <h2 id="approval-title" className="modal-title">
          要运行 <code>{request.name}</code> 吗？
        </h2>
        <p className="modal-preview">{request.preview}</p>

        <div className="modal-detail">
          <div className="modal-detail-label">参数</div>
          <pre className="modal-detail-body">{JSON.stringify(request.arguments, null, 2)}</pre>
        </div>

        <div className="modal-actions">
          <button ref={denyRef} className="btn btn-ghost" onClick={() => onAnswer(false)}>
            拒绝 <kbd>Esc</kbd>
          </button>
          <button className="btn btn-primary" onClick={() => onAnswer(true)}>
            允许这一次
          </button>
        </div>
      </div>
    </div>
  )
}
