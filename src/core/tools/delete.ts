/**
 * `delete` — move something to the system recycle bin instead of destroying it.
 *
 * Why this is a tool of its own rather than "let the model run `del`":
 *
 * - A shell delete is permanent. `del /q *.*` and `rm -rf` do not go through the
 *   recycle bin, so a wrong path is unrecoverable, and the user only finds out
 *   later.
 * - A shell delete is also SILENT. `del` prints nothing and exits 0 whether it
 *   removed one file or none, so the transcript cannot contradict a model that
 *   reports "已清空". That happened here: `del /q *.*` removed 2 files out of 27,
 *   reported success, and the review gate passed it.
 *
 * The rule this tool is built around — learned by measuring, not by reading the
 * docs — is that the platform's own report cannot be trusted in EITHER
 * direction. On this machine `Microsoft.VisualBasic`'s `DeleteFile` /
 * `DeleteDirectory` with `SendToRecycleBin` throws
 * `MethodInvocationException: 无法找到指定文件` on EVERY successful deletion
 * (verified for an ASCII file, a Chinese-named file and a non-empty directory —
 * all three landed in the bin, all three threw). A conventional implementation
 * that reported `isError` whenever the call threw would announce a successful
 * deletion as a failure, and one that trusted the exit code would report a
 * failure as success. So the verdict here comes from re-checking the path on
 * disk after the call, and the platform's output is kept only as diagnostics.
 */

import { spawn } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import type { Tool, ToolResult, ToolRunContext } from './types.js'
import { resolveToolPath } from './paths.js'

/** How much of the platform's output to keep when something goes wrong. */
const MAX_DETAIL_CHARS = 400

/**
 * The PowerShell that performs the recycle.
 *
 * `-EncodedCommand` carries it as base64/UTF-16, which sidesteps the code-page
 * mangling that a Chinese path or a Chinese error message would otherwise
 * suffer on the command line. The strings it prints are ASCII on purpose.
 *
 * The `catch {}` is deliberate and load-bearing: the known false exception is
 * swallowed, and the script then reports the only fact that matters — whether
 * the path is still there.
 */
function recycleScript(target: string): string {
  const quoted = target.replace(/'/g, "''")
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    `$t = '${quoted}'`,
    `if (-not (Test-Path -LiteralPath $t)) { Write-Output 'MISSING'; exit 3 }`,
    'try {',
    '  if ([System.IO.Directory]::Exists($t)) {',
    "    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($t, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)",
    '  } else {',
    "    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($t, [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs, [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin)",
    '  }',
    '} catch { }',
    `if (Test-Path -LiteralPath $t) { Write-Output 'STILL_THERE'; exit 4 }`,
    "Write-Output 'RECYCLED'",
  ].join('\n')
}

/**
 * The command that hands a path to the platform's trash.
 *
 * Exported so the shape of each platform's invocation can be asserted without
 * running it — the encoded PowerShell is opaque in a log, and an opaque command
 * is exactly the kind of thing that rots unnoticed.
 */
export function recycleInvocation(
  platform: NodeJS.Platform,
  target: string,
): { command: string; args: string[] } {
  if (platform === 'win32') {
    return {
      command: 'powershell',
      args: [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(recycleScript(target), 'utf16le').toString('base64'),
      ],
    }
  }
  if (platform === 'darwin') {
    const escaped = target.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    return {
      command: 'osascript',
      args: ['-e', `tell application "Finder" to delete POSIX file "${escaped}"`],
    }
  }
  // freedesktop-trash via the GLib helper, present on GNOME/KDE and most
  // others. There is no equally universal alternative, so a missing `gio` is
  // reported rather than worked around.
  return { command: 'gio', args: ['trash', '--', target] }
}

/**
 * The verdict, from the two facts that can be checked rather than the one the
 * platform reports.
 *
 * `detail` is used for diagnostics only and never decides the outcome — that is
 * the whole point of this function existing separately.
 */
export function recycleVerdict(
  existedBefore: boolean,
  existsAfter: boolean,
  detail: string,
): { ok: boolean; reason: 'missing' | 'removed' | 'still-there' } {
  void detail
  if (!existedBefore) return { ok: false, reason: 'missing' }
  return existsAfter ? { ok: false, reason: 'still-there' } : { ok: true, reason: 'removed' }
}

/**
 * True when `target` is `other` or an ancestor of it.
 *
 * Deleting the working directory — or anything containing it — is refused
 * outright: every file tool is scoped to that directory, so the session would
 * lose the ground it stands on, and no approval prompt makes that recoverable
 * in a way the user can reason about at the moment they see it.
 */
export function containsPath(target: string, other: string): boolean {
  if (target === other) return true
  const rel = relative(target, other)
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

/** Run the platform command and collect its output for diagnostics. */
async function runRecycle(
  platform: NodeJS.Platform,
  target: string,
  signal: AbortSignal,
): Promise<string> {
  const { command, args } = recycleInvocation(platform, target)
  return await new Promise<string>((resolve) => {
    let detail = ''
    let settled = false
    const done = (extra: string) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(`${detail}\n${extra}`.trim())
    }
    const child = spawn(command, args, { windowsHide: true })
    const onAbort = () => {
      child.kill()
      done('[aborted]')
    }
    signal.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d) => (detail += d.toString('utf8')))
    child.stderr.on('data', (d) => (detail += d.toString('utf8')))
    child.on('error', (err) => done(`[spawn failed: ${String(err)}]`))
    child.on('close', (code) => done(`[exit ${code}]`))
  })
}

function clip(text: string): string {
  const tidy = text.replace(/\s+/g, ' ').trim()
  return tidy.length > MAX_DETAIL_CHARS ? `${tidy.slice(0, MAX_DETAIL_CHARS)}…` : tidy
}

export const deleteTool: Tool = {
  name: 'delete',
  description:
    'Move a file or directory to the system recycle bin, where the user can restore it. ' +
    'Use this instead of a shell delete: `del`, `erase` and `rm` destroy the file ' +
    'immediately and print nothing, so a wrong path cannot be undone and leaves no trace ' +
    'in the output. Give one path. A directory is moved whole, with everything inside it. ' +
    'The path is checked before and after, so the result always states what actually ' +
    'happened to the file on disk.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'File or directory to move to the recycle bin, relative to the working directory or absolute.',
      },
    },
    required: ['path'],
  },
  preview: (args) => `Delete ${String(args.path ?? '')}`,

  async execute(args, ctx): Promise<ToolResult> {
    const raw = typeof args.path === 'string' ? args.path.trim() : ''
    if (raw.length === 0) {
      return { content: 'Give the path of the file or directory to delete.', isError: true }
    }

    let absolute: string
    let outsideWorkdir: boolean
    try {
      const resolved = await resolveToolPath(raw, ctx.cwd)
      absolute = resolved.absolute
      outsideWorkdir = resolved.outsideWorkdir
    } catch (err) {
      return { content: `Could not resolve "${raw}": ${String(err)}`, isError: true }
    }

    if (containsPath(absolute, ctx.cwd)) {
      return {
        content:
          `Refusing to delete "${absolute}": it is the working directory itself, or contains it. ` +
          'Deleting it would remove the directory this session is scoped to. Delete the parts ' +
          'you want individually, or tell the user this has to be done outside the session.',
        isError: true,
      }
    }

    const before = await lstat(absolute).catch(() => null)
    if (before === null) {
      return {
        content:
          `There is nothing at "${absolute}", so nothing was deleted. ` +
          'Check the path — a delete that reports a missing file is still a truthful result, ' +
          'so report it rather than retrying the same path.',
        isError: true,
      }
    }
    const isDirectory = before.isDirectory()

    const approved = await ctx.requestApproval(
      `把以下内容移入系统回收站（之后可以从回收站恢复）：\n\n${absolute}\n` +
        (isDirectory ? '（这是一个目录，连同里面的内容一起删除）\n' : '') +
        (outsideWorkdir ? '⚠️ 该路径在工作目录之外。\n' : '') +
        '\n允许本次删除。如果拒绝，请直接告诉用户这次操作被拒绝了——不要理解成你没有权限。',
    )
    if (!approved) {
      return {
        content:
          `The user declined to delete "${absolute}". ` +
          'You are not missing a permission — it was refused just now. Do not retry by another ' +
          'route, and do not run a shell delete instead; ask what they would prefer.',
        isError: true,
      }
    }

    const detail = await runRecycle(process.platform, absolute, ctx.signal)
    const after = await lstat(absolute).catch(() => null)
    const verdict = recycleVerdict(before !== null, after !== null, detail)

    if (!verdict.ok) {
      const hint =
        process.platform === 'linux'
          ? ' (`gio` comes with GLib — install `glib2` / `libglib2.0-bin` if it is missing)'
          : ''
      return {
        content:
          `Could not move "${raw}" to the recycle bin — it is STILL at ${absolute}. ` +
          `Whatever it is, it was not deleted, so do not report it as gone.${hint}\n` +
          `[${clip(detail)}]`,
        isError: true,
      }
    }

    return {
      content:
        `Moved to the system recycle bin: ${absolute}${isDirectory ? ' (directory and contents)' : ''}. ` +
        'It is gone from its original location and the user can restore it from the bin. ' +
        'This is not a permanent erase — do not describe it as one.',
    }
  },
}
