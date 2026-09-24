/**
 * Shell tool.
 *
 * Runs a command in the working directory and captures combined stdout/stderr.
 *
 * The security posture is deliberate and worth stating: this executes whatever
 * the model writes. That is the entire point of a local coding agent, and it is
 * also the single largest risk in the harness — so `bash` is on the default
 * approval list (see `DEFAULT_CONFIG.approvalRequiredFor` in the settings layer).
 * Do not remove it from that list without understanding the trade.
 */

import { spawn } from 'node:child_process'
import type { Tool, ToolResult } from './types.js'
import { resolveToolPath } from './paths.js'
import { decodeBytes } from '../extract.js'

const MAX_OUTPUT_CHARS = 30_000
/**
 * Byte ceiling, separate from the character ceiling above.
 *
 * The byte cap bounds memory while a command is still running (we cannot know the
 * character count until the bytes are decoded); the character cap then bounds
 * what actually reaches the model's context.
 */
const MAX_OUTPUT_BYTES = 120_000
const DEFAULT_TIMEOUT_MS = 120_000

const DANGEROUS_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rf]/i, why: 'recursive or forced delete' },
  { re: /\b(mkfs|fdisk|diskpart)\b/i, why: 'filesystem formatting' },
  { re: /\bdd\s+.*of=\/dev\//i, why: 'raw device write' },
  { re: /:\s*\(\s*\)\s*\{.*\}\s*;\s*:/, why: 'fork bomb' },
  { re: /\b(curl|wget)\b[^|]*\|\s*(ba)?sh/i, why: 'piping a download into a shell' },
  { re: /\bgit\s+push\b[^|]*(--force|-f)\b/i, why: 'force push' },
  { re: /\bgit\s+reset\s+--hard\b/i, why: 'discarding local changes' },
  { re: /\bshutdown\b|\breboot\b/i, why: 'system shutdown' },
]

/** Commands that only read. These skip approval even when bash is guarded. */
const READ_ONLY_PREFIXES = [
  'ls', 'cat', 'head', 'tail', 'wc', 'pwd', 'echo', 'which', 'whoami', 'date',
  'git status', 'git log', 'git diff', 'git show', 'git branch', 'node -v', 'npm -v',
]

export interface BashToolOptions {
  /** Which shell binary to use. Defaults to the platform default. */
  shell?: string
}

export const bashTool: Tool = {
  name: 'bash',
  description:
    'Run a shell command in the working directory and return its output. Use this for ' +
    'builds, tests, git operations, and anything the other tools cannot express. ' +
    'Prefer the dedicated file tools for reading and editing, because they truncate ' +
    'more intelligently and fail more clearly.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to run.' },
      timeout_ms: {
        type: 'integer',
        description: `Kill the command after this many milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}.`,
      },
    },
    required: ['command'],
  },
  preview: (args) => `Run: ${String(args.command ?? '')}`,

  async execute(args, ctx): Promise<ToolResult> {
    const command = typeof args.command === 'string' ? args.command.trim() : ''
    if (command.length === 0) {
      return { content: 'command must not be empty', isError: true }
    }
    const timeoutMs =
      typeof args.timeout_ms === 'number' && args.timeout_ms > 0
        ? Math.min(args.timeout_ms, 600_000)
        : DEFAULT_TIMEOUT_MS

    const { absolute: cwd } = await resolveToolPath('.', ctx.cwd)

    // Flag the genuinely destructive shapes. Even when bash is not on the
    // approval list, these get one, because the cost of a false positive is a
    // prompt and the cost of a false negative is the user's working tree.
    const hazard = DANGEROUS_PATTERNS.find((p) => p.re.test(command))
    if (hazard) {
      const ok = await ctx.requestApproval(
        `This command looks like it could ${hazard.why}:\n\n  ${command}\n\nRun it anyway?`,
      )
      if (!ok) {
        return { content: `User declined to run: ${command}`, isError: true }
      }
    }

    return await runCommand(command, cwd, timeoutMs, ctx.signal)
  },
}

/** True when a command is purely informational and needs no approval. */
export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim().toLowerCase()
  if (trimmed.includes('|') || trimmed.includes('>') || trimmed.includes('&&') || trimmed.includes(';')) {
    // Compound commands are only read-only when every segment is.
    const segments = trimmed.split(/\|\||&&|[|;]/).map((s) => s.trim()).filter(Boolean)
    return segments.length > 0 && segments.every((s) => READ_ONLY_PREFIXES.some((p) => s.startsWith(p)))
  }
  return READ_ONLY_PREFIXES.some((p) => trimmed.startsWith(p))
}

function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32'
    const child = spawn(command, {
      cwd,
      shell: isWindows ? true : '/bin/bash',
      windowsHide: true,
      env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat' },
    })

    // Collect raw bytes and decode ONCE, at the end. Two separate reasons:
    //
    // 1. `chunk.toString('utf8')` corrupts whenever a multi-byte character is
    //    split across a chunk boundary — each write() from the child is an
    //    arbitrary byte boundary, not a character boundary, so Chinese filenames
    //    from `dir` arrive with U+FFFD sprinkled through them.
    // 2. The encoding is not knowable until the whole buffer is visible. Windows
    //    console tools write the OEM code page (936 on a Chinese install), and
    //    the only reliable way to tell GBK from UTF-8 is to measure how badly the
    //    UTF-8 reading failed — which needs the complete output.
    const chunks: Buffer[] = []
    let bytesSeen = 0
    let truncated = false
    const append = (chunk: Buffer) => {
      if (truncated) return
      bytesSeen += chunk.length
      // Cap on bytes, well above the character budget: a GBK-encoded page costs
      // ~1.5 bytes per character, and cutting mid-character is exactly the
      // corruption this refactor removed.
      if (bytesSeen > MAX_OUTPUT_BYTES) {
        chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (bytesSeen - MAX_OUTPUT_BYTES))))
        truncated = true
        return
      }
      chunks.push(chunk)
    }

    child.stdout?.on('data', append)
    child.stderr?.on('data', append)

    /**
     * The output so far, decoded.
     *
     * Called from all three terminal paths (close, timeout, abort) so a killed
     * command still reports what it managed to print.
     */
    const render = (): string => {
      const text = decodeBytes(Uint8Array.from(Buffer.concat(chunks)))
      const body = text.trim().length === 0 ? '[no output]' : text.trimEnd()
      if (body.length <= MAX_OUTPUT_CHARS) {
        return truncated
          ? `${body}\n\n[output truncated at ${MAX_OUTPUT_BYTES} bytes]`
          : body
      }
      // Cut the decoded string, never the byte stream: slicing bytes would split
      // a character and re-introduce the corruption this decode-once approach
      // exists to avoid. Drop a trailing lone surrogate so the cut cannot leave
      // half of an emoji behind either.
      let cut = body.slice(0, MAX_OUTPUT_CHARS)
      const last = cut.charCodeAt(cut.length - 1)
      if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1)
      return `${cut}\n\n[output truncated at ${MAX_OUTPUT_CHARS} characters]`
    }

    let settled = false
    const finish = (result: ToolResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(result)
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({
        content: `${render()}\n\n[command killed after ${timeoutMs}ms]`,
        isError: true,
      })
    }, timeoutMs)

    const onAbort = () => {
      child.kill('SIGKILL')
      finish({ content: `${render()}\n\n[command aborted by user]`, isError: true })
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })

    child.on('error', (err) => {
      finish({ content: `Failed to start command: ${err.message}`, isError: true })
    })

    child.on('close', (code) => {
      finish({
        content: `${render()}\n\n[exit code ${code ?? 'null'}]`,
        isError: code !== 0,
      })
    })
  })
}
