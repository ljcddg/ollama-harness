/**
 * Group sessions by the working directory they were started in.
 *
 * Sessions already record `cwd` in their header, so grouping needs no new
 * storage — this is a pure view over data that was always there. Keeping it pure
 * (and out of the component) means the ordering and the hidden/active rules can
 * be asserted directly, which matters because they interact: a hidden group must
 * still appear if the user is currently inside it, or the open conversation
 * vanishes from the sidebar.
 */

import type { SessionMeta } from './session.js'

export interface SessionGroup {
  /** The real working directory, as first seen. The group key. */
  cwd: string
  /** What to show: the alias when one is set, otherwise the folder name. */
  label: string
  /** The full path, for the tooltip when `label` is a shortened name. */
  fullPath: string
  /** True when `label` came from an alias rather than the path. */
  aliased: boolean
  /** Display order: pinned first, then most recently updated. */
  sessions: SessionMeta[]
  /**
   * True when this group holds the active session. Such a group is never hidden
   * — see `groupSessions`.
   */
  active: boolean
  /** True when this group is hidden but shown anyway because it is active. */
  pinnedOpenByActivity: boolean
}

export interface GroupOptions {
  /** Display renames, keyed by normalised path. */
  aliases?: Record<string, string>
  /** Normalised paths whose group is hidden from the sidebar. */
  hidden?: readonly string[]
  /** Session ids sorted to the top of their group. */
  pinned?: readonly string[]
  activeSessionId?: string | null
}

/** Shown for sessions whose header has no cwd — predates the field, or was blank. */
const NO_DIRECTORY = '(未指定工作目录)'

/**
 * Fold a path to a comparison key.
 *
 * Windows paths differ in case, separator and trailing slash depending on who
 * wrote them — the config stores `D:\desktop1\test`, a model writes
 * `D:/desktop1/test`, and a picked folder arrives with a trailing separator. Left
 * alone these become three groups for one folder, which reads as data loss.
 */
export function pathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** The last path segment, which is what a user recognises. */
export function folderName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut === -1 ? trimmed : trimmed.slice(cut + 1)
}

/**
 * Build the sidebar's group list.
 *
 * Ordering rules, in order of application:
 *   1. Groups are ordered by their most recent activity, newest first.
 *   2. Inside a group, pinned sessions come first, then newest first.
 *   3. A hidden group is dropped UNLESS it contains the active session.
 *
 * Rule 3 is the important one. Hiding is a way to clear clutter, not a way to
 * lose the conversation you are in the middle of; without this, "remove from list"
 * while sitting in that group would blank the sidebar around an open session.
 *
 * Every group here is backed by at least one real session. There is deliberately
 * no "current working directory" group: a directory with no conversations is not
 * something to display, and synthesising one produced a phantom group the user
 * could not get rid of (it reappeared from `config.workdir` alone).
 */
export function groupSessions(
  sessions: readonly SessionMeta[],
  options: GroupOptions = {},
): SessionGroup[] {
  const aliases = options.aliases ?? {}
  const hidden = new Set((options.hidden ?? []).map(pathKey))
  const pinned = new Set(options.pinned ?? [])
  const activeSessionId = options.activeSessionId ?? null

  const byKey = new Map<string, SessionGroup>()

  const ensure = (cwd: string): SessionGroup => {
    const key = cwd === '' ? '' : pathKey(cwd)
    const existing = byKey.get(key)
    if (existing) return existing

    const alias = aliases[key]
    const group: SessionGroup = {
      cwd: cwd === '' ? '' : cwd,
      label: cwd === '' ? NO_DIRECTORY : (alias?.trim() || folderName(cwd)),
      fullPath: cwd === '' ? '' : cwd,
      aliased: Boolean(alias?.trim()),
      sessions: [],
      active: false,
      pinnedOpenByActivity: false,
    }
    byKey.set(key, group)
    return group
  }

  for (const session of sessions) {
    ensure(session.cwd ?? '').sessions.push(session)
  }

  const groups = [...byKey.values()]

  for (const group of groups) {
    group.sessions.sort((a, b) => {
      const aPinned = pinned.has(a.sessionId)
      const bPinned = pinned.has(b.sessionId)
      if (aPinned !== bPinned) return aPinned ? -1 : 1
      return b.updatedAt - a.updatedAt
    })
    group.active = group.sessions.some((s) => s.sessionId === activeSessionId)
  }

  return groups
    .filter((group) => {
      const key = group.cwd === '' ? '' : pathKey(group.cwd)
      if (!hidden.has(key)) return true
      // Rule 4: never hide the group the user is currently working in.
      if (group.active) {
        group.pinnedOpenByActivity = true
        return true
      }
      return false
    })
    .sort((a, b) => (b.sessions[0]?.updatedAt ?? 0) - (a.sessions[0]?.updatedAt ?? 0))
}

/** True when a session should sort to the top of its group. */
export function isPinned(sessionId: string, pinned: readonly string[]): boolean {
  return pinned.includes(sessionId)
}
