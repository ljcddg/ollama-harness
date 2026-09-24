/**
 * What a turn changed on disk, measured by the harness rather than reported by a
 * command.
 *
 * Every failure this exists for has the same shape: a command succeeds, the model
 * states an effect, and nothing independent checks the statement.
 *
 * - `del /q *.*` prints nothing and exits 0. Asked to clear a directory, the model
 *   ran exactly that and answered "已清空当前目录下的文件。" — while 25 of the 27
 *   files were still there, untouched, in subdirectories the command never looked
 *   at. The `exit code 0` it took as evidence only means `del` itself did not
 *   error (session c0a198d7).
 * - A Spring Boot project was reported finished in a turn that never ran a build;
 *   it did not compile (session 0b5d68df).
 *
 * DeepSeek Harness answers this with `deliverables` / `workspace-changes`:
 * snapshot before, snapshot after, diff, and let the machine say what happened.
 * The snapshot here records size and mtime instead of contents — enough to name
 * added, removed and modified files, which is what the claims are made about.
 *
 * Nothing is written to disk and nothing is sent anywhere; the caller decides what
 * to do with the answer.
 */

import { readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { NOISE_DIRS } from './tools/files.js'

/**
 * Ceilings on one walk.
 *
 * A turn must never be slowed down or failed by bookkeeping, so both limits are
 * generous and hitting either one is recorded rather than hidden. An incomplete
 * list that does not say it is incomplete is exactly the failure mode this module
 * exists to remove.
 */
const MAX_FILES = 4000
const MAX_DEPTH = 12
const MAX_MS = 2000

export type ChangeKind = 'added' | 'removed' | 'modified'

export interface WorkspaceChange {
  /** Path relative to the session cwd, with forward slashes. */
  path: string
  kind: ChangeKind
}

export interface WorkspaceSnapshot {
  /** Relative path -> `size:mtimeMs`. */
  files: Map<string, string>
  /** True when a limit was hit, so `files` is not the whole tree. */
  truncated: boolean
}

/**
 * Walk the working directory and record every file's size and mtime.
 *
 * Noise directories are skipped through the same `NOISE_DIRS` set the file tools
 * use, so editor state (`.idea`), dependencies and build output (`target`,
 * `dist`) stay out. That is not only a speed decision: a `mvn compile` creating
 * `target/classes` is not a change to anyone's work, and listing it as one would
 * bury the two files that were actually deleted.
 *
 * Never throws. A directory that cannot be read is a directory with no files as
 * far as this is concerned — a failed snapshot must not be able to fail a turn.
 */
export async function snapshotWorkspace(root: string): Promise<WorkspaceSnapshot> {
  const files = new Map<string, string>()
  const started = Date.now()
  let truncated = false

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (truncated) return
    if (depth > MAX_DEPTH || Date.now() - started > MAX_MS) {
      truncated = true
      return
    }
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null)
    if (entries === null) return

    for (const entry of entries) {
      if (truncated) return
      if (NOISE_DIRS.has(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      if (files.size >= MAX_FILES) {
        truncated = true
        return
      }
      const info = await stat(full).catch(() => null)
      if (info === null) continue
      files.set(pathKey(root, full), `${info.size}:${Math.floor(info.mtimeMs)}`)
    }
  }

  await walk(root, 0)
  return { files, truncated }
}

/** Forward slashes on every platform, so a snapshot is comparable across them. */
function pathKey(root: string, full: string): string {
  return relative(root, full).split('\\').join('/')
}

/**
 * Which files appeared, disappeared or changed between two snapshots.
 *
 * Sorted, because a reviewer reads this: an order that shifts between runs makes
 * two identical turns look different. Each path appears once — a file can only be
 * in one of the three states.
 */
export function diffWorkspace(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
): WorkspaceChange[] {
  const changes: WorkspaceChange[] = []

  for (const [path, stamp] of after.files) {
    const previous = before.files.get(path)
    if (previous === undefined) changes.push({ path, kind: 'added' })
    else if (previous !== stamp) changes.push({ path, kind: 'modified' })
  }
  for (const path of before.files.keys()) {
    if (!after.files.has(path)) changes.push({ path, kind: 'removed' })
  }

  return changes.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind))
}

/** How many paths one log event carries before it switches to counting only. */
export const MAX_LOGGED_PATHS = 40

/**
 * Render the diff for a reader, whether that is the log, the reviewer or a person.
 *
 * An empty diff is stated rather than omitted. "Nothing on disk changed" is the
 * single most useful thing this module can say about a turn whose commands all
 * reported success — silence would leave the same hole the changes were meant to
 * fill. So this always returns a line, and says so when the walk was cut short.
 */
export function formatChanges(changes: readonly WorkspaceChange[], truncated: boolean): string {
  const note = truncated ? ['(the walk hit its limits, so this list may be incomplete)'] : []
  if (changes.length === 0) {
    return [...note, '- no files on disk changed during this turn'].join('\n')
  }
  const counts = countChanges(changes)
  const head = `${changes.length} file(s) changed: ${[counts.added ? `${counts.added} added` : '', counts.removed ? `${counts.removed} removed` : '', counts.modified ? `${counts.modified} modified` : ''].filter(Boolean).join(', ')}`
  const lines = changes.map((change) => `- ${change.kind}: ${change.path}`)
  return [head, ...note, ...lines].join('\n')
}

export function countChanges(changes: readonly WorkspaceChange[]): Record<ChangeKind, number> {
  const counts: Record<ChangeKind, number> = { added: 0, removed: 0, modified: 0 }
  for (const change of changes) counts[change.kind] += 1
  return counts
}
