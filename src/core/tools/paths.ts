/**
 * Path containment.
 *
 * Every filesystem tool resolves its argument through here first. The rule is
 * simple: a tool may read and write inside the session working directory, and
 * anywhere else requires an explicit approval. This is deliberately a soft
 * boundary — the user can approve — rather than a hard sandbox, because a
 * coding agent that cannot touch anything outside its cwd is not much use.
 */

import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export interface ResolvedPath {
  /** Absolute path the tool should use. */
  absolute: string
  /** True when the path escapes the working directory. */
  outsideWorkdir: boolean
}

/** Thrown when a path cannot be resolved at all. */
export class PathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathError'
  }
}

/**
 * Resolve a tool-supplied path against the working directory.
 *
 * `realpath` runs on the deepest EXISTING ancestor so that a symlink cannot be
 * used to slip outside the workdir while the target itself does not exist yet
 * (the common case for a write). Failing to do this is the classic symlink
 * escape in file-tool sandboxes.
 */
export async function resolveToolPath(input: string, cwd: string): Promise<ResolvedPath> {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new PathError('path must be a non-empty string')
  }
  if (input.includes('\0')) {
    throw new PathError('path must not contain a NUL byte')
  }

  const absolute = isAbsolute(input) ? resolve(input) : resolve(cwd, input)
  const realRoot = await resolveWithExistingAncestor(cwd)
  const realTarget = await resolveWithExistingAncestor(absolute)

  const rel = relative(realRoot, realTarget)
  const outsideWorkdir = rel.startsWith('..') || (rel.length > 0 && !rel.startsWith(`.${sep}`) && isAbsolute(rel))

  return { absolute: realTarget, outsideWorkdir }
}

/**
 * Walk up from `target` until an ancestor exists, realpath that ancestor, then
 * re-append the non-existent tail. Returns the lexical path unchanged when
 * nothing along the chain exists (a fresh absolute path under no root).
 */
async function resolveWithExistingAncestor(target: string): Promise<string> {
  const tail: string[] = []
  let current = target
  for (;;) {
    try {
      const real = await realpath(current)
      return tail.length === 0 ? real : resolve(real, ...tail.reverse())
    } catch {
      const parent = resolve(current, '..')
      if (parent === current) return target
      tail.push(current.slice(parent.length).replace(/^[\\/]+/, ''))
      current = parent
    }
  }
}

/** Human-readable note appended to results that touched the outside world. */
export function outsideNote(path: string): string {
  return `\n[note: "${path}" is outside the working directory]`
}
