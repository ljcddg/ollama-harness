import { useEffect, useRef, useState } from 'react'
import type { MenuCommand } from '@shared/ipc.js'
import { useHarness } from './hooks/useHarness.js'
import { Sidebar } from './components/Sidebar.js'
import { MessageList } from './components/MessageList.js'
import { Composer } from './components/Composer.js'
import { ApprovalDialog } from './components/ApprovalDialog.js'
import { SettingsDialog } from './components/SettingsDialog.js'

export function App() {
  const harness = useHarness()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [pinned, setPinned] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)

  // Follow the stream, but stop following if the user scrolls up to read. Auto-
  // scrolling over someone who is reading is worse than not scrolling at all.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
      // 48px rather than a full viewport: the last message is often taller than
      // the window, so a large threshold makes "keep following" unreachable.
      const next = distanceFromBottom < 48
      // Only re-render when the state actually flips — this fires on every
      // wheel tick, and a setState per event would thrash the tree mid-scroll.
      if (next !== pinnedRef.current) {
        pinnedRef.current = next
        setPinned(next)
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [])

  // Follow new content, but only while pinned. `requestAnimationFrame` matters:
  // the node list changes before the browser has laid the new content out, so
  // scrolling synchronously lands short of the real bottom on fast streams.
  useEffect(() => {
    if (!pinnedRef.current) return
    const el = scrollRef.current
    if (!el) return
    const frame = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
    return () => cancelAnimationFrame(frame)
  }, [harness.nodes, harness.review, harness.reviewRunning])

  // Switching sessions should always start at the newest message.
  useEffect(() => {
    pinnedRef.current = true
    setPinned(true)
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [harness.activeSessionId])

  const jumpToLatest = () => {
    const el = scrollRef.current
    if (!el) return
    // `scroll-behavior: smooth` on the container would animate this, which reads
    // as slow when the history is long. Jump instantly for an explicit action.
    el.scrollTo({ top: el.scrollHeight, behavior: 'auto' })
    pinnedRef.current = true
    setPinned(true)
  }

  // The native menu announces intent and nothing else: this app owns the session
  // state, so it decides whether "new session" or "compact" is legal right now.
  useEffect(() => {
    return window.harness.onMenuCommand((command: MenuCommand) => {
      switch (command) {
        case 'session:new':
          if (!harness.status.busy) void harness.newSession()
          break
        case 'session:compact':
          void harness.compactSession()
          break
        case 'session:review':
          void harness.runReview()
          break
        case 'session:cancel':
          harness.cancel()
          break
        case 'view:settings':
          setSettingsOpen(true)
          break
        case 'view:back-to-latest':
          jumpToLatest()
          break
        default:
          break
      }
    })
  }, [harness, setSettingsOpen])

  const modelMissing = harness.config.model === ''

  return (
    <div className="app">
      <Sidebar
        config={harness.config}
        models={harness.models}
        sessions={harness.sessions}
        activeSessionId={harness.activeSessionId}
        modelError={harness.modelError}
        busy={harness.status.busy}
        // No argument means "the folder this conversation is in", which is what
        // the header's "+" should do. Moving to a different folder is a separate
        // action — it belongs to the new conversation, not to a global setting.
        onNewSession={(workdir) => void harness.newSessionIn(workdir ?? harness.activeCwd)}
        onOpenFolder={() => void harness.createSessionInFolder()}
        onOpenSession={(id) => void harness.openSession(id)}
        onRemoveSession={(id) => void harness.removeSession(id)}
        onRemoveGroup={(cwd, ids) => void harness.removeGroup(cwd, ids)}
        onRenameGroup={(cwd, label) => void harness.renameGroup(cwd, label)}
        onUnhideGroup={(cwd) => void harness.unhideGroup(cwd)}
        onTogglePin={(id) => void harness.togglePin(id)}
        onUpdateConfig={(patch) => void harness.updateConfig(patch)}
        onRefreshModels={() => void harness.refreshModels()}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <main className="main">
        {harness.modelError && (
          <Banner
            title="连接不上 Ollama"
            body={
              harness.modelErrorDetail ??
              '请先启动 Ollama，然后在侧边栏里重新拉取模型列表。'
            }
            action={{ label: '重试', onClick: () => void harness.refreshModels() }}
          />
        )}
        {!harness.modelError && modelMissing && harness.models.length > 0 && (
          <Banner title="还没选模型" body="在左侧选一个模型就能开始对话。" />
        )}
        {harness.contextSize.overBudget && !harness.compacting && (
          <Banner
            title="这段对话已经很长了"
            body={`约 ${harness.contextSize.chars.toLocaleString('zh-CN')} 字符。上下文越长小模型越容易跑偏，压缩之后后续请求只带摘要，完整记录仍然保留。`}
            action={{ label: '压缩上下文', onClick: () => void harness.compactSession() }}
          />
        )}

        <div className="scroll-wrap">
          <div className="scroll" ref={scrollRef}>
            <MessageList
              nodes={harness.nodes}
              review={harness.review}
              actions={{
                onEdit: harness.editMessage,
                onCompact: harness.compactSession,
                compacting: harness.compacting,
              }}
            />
            {harness.reviewRunning && (
              <div className="review-running">
                <span className="status-spinner" aria-hidden />
                模型正在核对自己的改动与你的要求…
              </div>
            )}
          </div>

          {/* Without this, unpinning is a one-way door: the user scrolls up to
              read, the stream stops following, and there is no way back short of
              dragging the scrollbar to the bottom. */}
          {!pinned && (
            <button className="jump-latest" onClick={jumpToLatest}>
              ↓ 回到最新
            </button>
          )}
        </div>

        <Composer
          status={harness.status}
          disabled={modelMissing || !harness.ready}
          attachments={harness.attachments}
          placeholder={modelMissing ? '请先选择模型…' : '说说你想改什么…（Enter 发送）'}
          onSend={(text) => void harness.send(text)}
          onCancel={harness.cancel}
          onAddFiles={() => void harness.addAttachments()}
          onRemoveAttachment={harness.removeAttachment}
          onReview={() => void harness.runReview()}
        />
      </main>

      {harness.approval && (
        <ApprovalDialog request={harness.approval} onAnswer={harness.answerApproval} />
      )}

      {settingsOpen && (
        <SettingsDialog
          config={harness.config}
          onUpdate={(patch) => void harness.updateConfig(patch)}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}

function Banner({
  title,
  body,
  action,
}: {
  title: string
  body: string
  action?: { label: string; onClick(): void }
}) {
  return (
    <div className="banner">
      <div className="banner-text">
        <strong>{title}</strong>
        <span>{body}</span>
      </div>
      {action && (
        <button className="btn btn-small" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  )
}
