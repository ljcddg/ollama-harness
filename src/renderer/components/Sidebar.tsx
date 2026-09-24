/**
 * Sidebar: sessions grouped by the working directory they were started in, plus
 * the model picker.
 *
 * The grouping IS the working-directory control. There is no separate global
 * "working directory" field any more: a conversation belongs to the folder it
 * was started in (the header's `cwd`, which the agent is told about), so the
 * place to express "where am I working" is the group you are in — not a setting
 * that silently overrides it.
 *
 * Sessions are grouped by the `cwd` in their header (see shared/grouping.ts for
 * the ordering and hiding rules). The grouping is a pure function so the tricky
 * parts — a hidden group that must still show while active, Windows paths that
 * differ only in case or separator — are asserted rather than eyeballed.
 *
 * Two Electron constraints shape the interactions here:
 *   - `window.prompt` is NOT implemented, so renaming is an inline input.
 *   - `window.confirm` IS implemented, and is used for deletions.
 *
 * Every icon is inline SVG rather than an emoji or a symbol character — see
 * icons.tsx for why.
 */

import { useEffect, useRef, useState } from 'react'
import type { ModelInfo, SessionId } from '@shared/message.js'
import type { SessionMeta } from '@shared/session.js'
import type { AppConfig } from '@shared/ipc.js'
import type { SessionGroup } from '@shared/grouping.js'
import { groupSessions, isPinned, pathKey } from '@shared/grouping.js'
import {
  IconChevron,
  IconDots,
  IconFolder,
  IconFolderOpen,
  IconGear,
  IconPin,
  IconPlus,
} from './icons.js'

interface Props {
  config: AppConfig
  models: ModelInfo[]
  sessions: SessionMeta[]
  activeSessionId: SessionId | null
  modelError: string | null
  busy: boolean
  /** `workdir` omitted means "the directory the current conversation uses". */
  onNewSession(workdir?: string): void
  /** Pick a folder and start a conversation in it. */
  onOpenFolder(): void
  onOpenSession(id: SessionId): void
  onRemoveSession(id: SessionId): void
  /** Delete every session in a directory, then hide the group. */
  onRemoveGroup(cwd: string, ids: SessionId[]): void
  /** Store a display alias. `label` empty clears it. */
  onRenameGroup(cwd: string, label: string): void
  onUnhideGroup(cwd: string): void
  onTogglePin(id: SessionId): void
  onUpdateConfig(patch: Partial<AppConfig>): void
  onRefreshModels(): void
  onOpenSettings(): void
}

export function Sidebar(props: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [renaming, setRenaming] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)

  const groups = groupSessions(props.sessions, {
    aliases: props.config.workdirAliases,
    hidden: showHidden ? [] : props.config.hiddenWorkdirs,
    pinned: props.config.pinnedSessions,
    activeSessionId: props.activeSessionId,
  })

  const hiddenCount = props.config.hiddenWorkdirs.length

  const toggle = (cwd: string) => {
    setCollapsed((current) => {
      const next = new Set(current)
      const key = cwd === '' ? '' : pathKey(cwd)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="brand">Ollama Harness</span>
        <div className="sidebar-head-actions">
          <button
            className="btn btn-ghost btn-icon"
            onClick={props.onOpenSettings}
            title="设置"
            aria-label="设置"
          >
            <IconGear />
          </button>
          <button
            className="btn btn-ghost btn-icon"
            onClick={props.onOpenFolder}
            disabled={props.busy}
            title="选择一个文件夹，并在其中开始新对话"
            aria-label="选择文件夹并开始新对话"
          >
            <IconFolderOpen />
          </button>
          <button
            className="btn btn-ghost btn-icon"
            onClick={() => props.onNewSession()}
            disabled={props.busy}
            title="新建会话（沿用当前对话所在的文件夹）"
            aria-label="新建会话"
          >
            <IconPlus />
          </button>
        </div>
      </div>

      <div className="sidebar-controls">
        <ModelPicker {...props} />
      </div>

      <div className="sidebar-scroll">
        {groups.length === 0 && hiddenCount === 0 && (
          <div className="session-empty">还没有会话</div>
        )}

        {groups.map((group) => (
          <Group
            key={group.cwd || '(none)'}
            group={group}
            collapsed={collapsed.has(group.cwd === '' ? '' : pathKey(group.cwd))}
            renaming={renaming === (group.cwd === '' ? '' : pathKey(group.cwd))}
            activeSessionId={props.activeSessionId}
            pinnedIds={props.config.pinnedSessions}
            busy={props.busy}
            onToggle={() => toggle(group.cwd)}
            onStartRename={() => setRenaming(group.cwd === '' ? '' : pathKey(group.cwd))}
            onCancelRename={() => setRenaming(null)}
            onCommitRename={(label) => {
              setRenaming(null)
              props.onRenameGroup(group.cwd, label)
            }}
            onNewSession={() => props.onNewSession(group.cwd)}
            onOpenSession={props.onOpenSession}
            onRemoveSession={props.onRemoveSession}
            onTogglePin={props.onTogglePin}
            onRemoveGroup={() => {
              // Destructive and irreversible, so the message states the count and
              // says explicitly what is NOT touched — the folder and its files are
              // untouched, which is the natural fear when removing a directory row.
              const count = group.sessions.length
              const ok = confirm(
                `确定从列表中移除「${group.label}」吗？\n\n` +
                  `这会同时永久删除该目录下的 ${count} 个会话记录，无法撤销。\n\n` +
                  '工作目录里的文件不会被删除，只是这个目录不再出现在侧边栏。',
              )
              if (!ok) return
              props.onRemoveGroup(
                group.cwd,
                group.sessions.map((s) => s.sessionId),
              )
            }}
            onUnhide={() => props.onUnhideGroup(group.cwd)}
          />
        ))}

        {hiddenCount > 0 && (
          <button className="hidden-toggle" onClick={() => setShowHidden((v) => !v)}>
            {showHidden ? '收起已移除的目录' : `已移除 ${hiddenCount} 个目录 · 显示`}
          </button>
        )}
      </div>

      <UsageFooter busy={props.busy} />
    </aside>
  )
}

function Group({
  group,
  collapsed,
  renaming,
  activeSessionId,
  pinnedIds,
  busy,
  onToggle,
  onStartRename,
  onCancelRename,
  onCommitRename,
  onNewSession,
  onOpenSession,
  onRemoveSession,
  onTogglePin,
  onRemoveGroup,
  onUnhide,
}: {
  group: SessionGroup
  collapsed: boolean
  renaming: boolean
  activeSessionId: SessionId | null
  pinnedIds: string[]
  busy: boolean
  onToggle(): void
  onStartRename(): void
  onCancelRename(): void
  onCommitRename(label: string): void
  onNewSession(): void
  onOpenSession(id: SessionId): void
  onRemoveSession(id: SessionId): void
  onTogglePin(id: SessionId): void
  onRemoveGroup(): void
  onUnhide(): void
}) {
  const [draft, setDraft] = useState(group.label)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renaming) {
      setDraft(group.aliased ? group.label : '')
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [renaming, group.aliased, group.label])

  const commit = () => onCommitRename(draft.trim())

  return (
    <section className={`group ${group.active ? 'group-active' : ''}`}>
      <header className="group-head">
        {/* The whole header is the "where am I working" control: the tooltip
            carries the full path, which the label shortens to the folder name. */}
        <button
          className="group-toggle"
          onClick={onToggle}
          title={group.fullPath || '未指定目录'}
        >
          <span className={`group-chevron ${collapsed ? 'group-chevron-closed' : ''}`}>
            <IconChevron />
          </span>
          <span className="group-icon">
            <IconFolder />
          </span>
          {renaming ? (
            <input
              ref={inputRef}
              className="group-rename"
              value={draft}
              placeholder={group.aliased ? group.label : '新的显示名'}
              onChange={(e) => setDraft(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commit()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  onCancelRename()
                }
              }}
              onBlur={commit}
            />
          ) : (
            <span className="group-name">{group.label}</span>
          )}
        </button>

        {!renaming && (
          <div className="group-actions">
            <span className="group-count">{group.sessions.length}</span>
            <Menu
              label={`「${group.label}」的更多操作`}
              items={[
                { label: '打开文件夹', onSelect: () => void window.harness.revealPath(group.cwd) },
                { label: '重命名', onSelect: onStartRename },
                ...(group.aliased
                  ? [{ label: '清除自定义名称', onSelect: () => onCommitRename('') }]
                  : []),
                ...(group.pinnedOpenByActivity
                  ? [{ label: '恢复显示（取消移除）', onSelect: onUnhide }]
                  : []),
                { label: '从列表中移除', danger: true, onSelect: onRemoveGroup },
              ]}
            />
            <button
              className="group-add"
              onClick={onNewSession}
              disabled={busy}
              title={`在「${group.label}」里新建会话`}
              aria-label={`在「${group.label}」里新建会话`}
            >
              <IconPlus />
            </button>
          </div>
        )}
      </header>

      {!collapsed && (
        <div className="group-sessions">
          {group.sessions.length === 0 && <div className="session-empty">这个目录还没有会话</div>}
          {group.sessions.map((session) => (
            <SessionRow
              key={session.sessionId}
              session={session}
              active={session.sessionId === activeSessionId}
              pinned={isPinned(session.sessionId, pinnedIds)}
              onOpen={() => onOpenSession(session.sessionId)}
              onTogglePin={() => onTogglePin(session.sessionId)}
              onRemove={() => onRemoveSession(session.sessionId)}
            />
          ))}
        </div>
      )}
    </section>
  )
}

function SessionRow({
  session,
  active,
  pinned,
  onOpen,
  onTogglePin,
  onRemove,
}: {
  session: SessionMeta
  active: boolean
  pinned: boolean
  onOpen(): void
  onTogglePin(): void
  onRemove(): void
}) {
  // An empty session is the one that reads as "my history disappeared" when it
  // is auto-opened, so label it rather than showing a bare "未命名".
  const empty = session.messageCount === 0
  // Sessions written before the UI was localised carry English placeholders.
  const PLACEHOLDER_TITLES = new Set(['New session', 'Untitled', 'Untitled session'])
  const stored = session.title
  const isPlaceholder = stored === '' || stored === session.sessionId || PLACEHOLDER_TITLES.has(stored)
  const label = isPlaceholder ? (empty ? '空会话' : '未命名会话') : stored

  return (
    <div className={`session-row ${active ? 'active' : ''} ${pinned ? 'pinned' : ''}`}>
      <button className="session-main" onClick={onOpen} title={label}>
        <span className={`session-title ${empty ? 'session-title-empty' : ''}`}>
          {pinned && (
            <span className="session-pin" aria-label="已置顶" title="已置顶">
              <IconPin />
            </span>
          )}
          {label}
        </span>
        <span className="session-meta">{formatRelative(session.updatedAt)}</span>
      </button>
      <Menu
        label={`「${label}」的更多操作`}
        items={[
          { label: pinned ? '取消置顶' : '置顶', onSelect: onTogglePin },
          { label: '删除会话', danger: true, onSelect: onRemove },
        ]}
      />
    </div>
  )
}

/**
 * A small "…" dropdown.
 *
 * Positioned `fixed` from the trigger's bounding box rather than absolutely
 * inside it. The sidebar is a scroll container (`overflow-y: auto`), and a
 * scroll container clips its descendants on BOTH axes — so an absolutely
 * positioned menu near the bottom of a long list would be cut off mid-item.
 *
 * Closes on outside click, Escape, or scroll (the anchor moves when the list
 * scrolls, and a menu left floating away from its row is worse than a closed one).
 */
const MENU_WIDTH = 168
const MENU_ITEM_HEIGHT = 32

function Menu({
  label,
  items,
}: {
  label: string
  items: Array<{ label: string; onSelect(): void; danger?: boolean }>
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const place = () => {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (!rect) return
    const estimated = items.length * MENU_ITEM_HEIGHT + 10
    // Flip above the trigger when opening downward would leave the viewport.
    const below = rect.bottom + 4
    const top = below + estimated > window.innerHeight - 8 ? rect.top - estimated - 4 : below
    const left = Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8))
    setPos({ top: Math.max(8, top), left })
  }

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    const onScroll = () => setOpen(false)
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open])

  return (
    <div className="menu-wrap" ref={wrapRef}>
      <button
        ref={triggerRef}
        className="menu-trigger"
        aria-label={label}
        title={label}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation()
          if (open) {
            setOpen(false)
            return
          }
          place()
          setOpen(true)
        }}
      >
        <IconDots />
      </button>
      {open && pos && (
        <div
          className="menu-popup"
          role="menu"
          style={{ top: pos.top, left: pos.left, width: MENU_WIDTH }}
        >
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              className={`menu-item ${item.danger ? 'menu-item-danger' : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                setOpen(false)
                item.onSelect()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ModelPicker({ models, config, modelError, onUpdateConfig, onRefreshModels }: Props) {
  const current = models.find((m) => m.id === config.model)
  // Ollama lists embedding models alongside chat models, so `bge-m3` appears in
  // this dropdown and selecting it makes every request fail with "does not
  // support chat". Mark them rather than hide them: a missing model looks like a
  // bug, a labelled one explains itself.
  const usable = models.filter((m) => m.chat !== false)
  const unusable = models.filter((m) => m.chat === false)

  return (
    <div className="control">
      <label className="control-label">
        模型
        <button
          className="btn btn-ghost btn-tiny"
          onClick={onRefreshModels}
          title="重新拉取模型列表"
        >
          刷新
        </button>
      </label>
      {modelError ? (
        <div className="control-error">
          <div>连接不上 Ollama</div>
          <div className="control-error-hint">
            先执行 <code>ollama serve</code>，再点刷新。
          </div>
        </div>
      ) : (
        <select
          className="control-select"
          value={config.model}
          onChange={(e) => onUpdateConfig({ model: e.target.value })}
        >
          {config.model === '' && <option value="">请选择模型…</option>}
          {usable.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
          {unusable.length > 0 && (
            <optgroup label="不可用于对话（嵌入模型）">
              {unusable.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — 仅嵌入
                </option>
              ))}
            </optgroup>
          )}
        </select>
      )}
      {current && (
        <div className="control-badges">
          {current.vision && <span className="badge">视觉</span>}
          {current.tools && <span className="badge">工具调用</span>}
          {current.thinking && <span className="badge">推理</span>}
        </div>
      )}
      {current?.chat === false && (
        <div className="control-warn">
          这个是嵌入模型，不能对话。换一个对话模型再开始。
        </div>
      )}
    </div>
  )
}

function UsageFooter({ busy }: { busy: boolean }) {
  return (
    <div className="sidebar-foot">
      <span className={`dot ${busy ? 'dot-busy' : 'dot-idle'}`} />
      {busy ? '运行中' : '空闲'}
    </div>
  )
}

function formatRelative(time: number): string {
  const delta = Date.now() - time
  const minutes = Math.floor(delta / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} 天前`
  const date = new Date(time)
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}
