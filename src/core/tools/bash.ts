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
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

/**
 * Environment names whose values must never reach a child process.
 *
 * `bash` executes whatever the model writes, and the harness's own environment
 * holds the user's credentials. One `env` call (or `set`, on Windows) would
 * otherwise print them into the transcript, where they persist in the session log
 * and are replayed into every later request. Matching is a case-insensitive
 * substring test on the whole name and is deliberately broad: a false positive
 * costs a command one variable, a false negative leaks a key.
 *
 * The name list mirrors the rule DeepSeek Harness documents in its
 * defensive-patterns guide (`*KEY*`, `*SECRET*`, `*TOKEN*`, `*PASSWORD*`), plus
 * the two forms that rule misses in practice.
 */
const SECRET_ENV_PATTERN = /KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL/i

/**
 * The environment a child process is allowed to see: the harness's own
 * environment minus credential-shaped names.
 *
 * Essential names (`PATH`, `HOME`, `SystemRoot`, `TEMP`, ...) match no pattern and
 * pass through. The pagers are pinned so a command cannot block on an interactive
 * pager the model has no way to answer.
 */
export function scrubbedEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (SECRET_ENV_PATTERN.test(name)) continue
    env[name] = value
  }
  env['GIT_PAGER'] = 'cat'
  env['PAGER'] = 'cat'
  return env
}

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

/**
 * What the shell itself says when it could not run a command.
 *
 * These exist because exit code 0 does not mean "everything worked": the status
 * of a command line is the LAST command's status, so a line whose first command
 * does not exist can still exit 0 — and "exit code 0" is exactly what the model
 * reads as success. Session 67c03b60 is the case that put these here: the model
 * scaffolded a project with a multi-line `bash` call, only the first line ran,
 * `touch` did not exist on the machine, and the tool reported a clean exit 0.
 *
 * Anchored to the start of a line, and the POSIX arm additionally requires the
 * shell's own `bash:` / `sh:` prefix. Both details exist to keep a program that
 * merely PRINTS this text — `echo "bash: foo: command not found"`, or a grep that
 * found it in a log — from being mistaken for the shell failing to run something.
 */
const SHELL_CANNOT_RUN: RegExp[] = [
  /(?:^|\n)\s*'([^'\r\n]+)' is not recognized as an internal or external command/i,
  /(?:^|\n)\s*'([^'\r\n]+)' 不是内部或外部命令/,
  /(?:^|\n)\s*(?:\S*\/)?(?:ba|da|k|z)?sh:\s+(?:[^:\n]*:\s+)*([^\s:]+): command not found\b/,
]

/**
 * The command name the shell reported it could not run, or null.
 *
 * Used only when the exit code claimed success — a non-zero code is already
 * reported honestly and needs no second opinion.
 */
export function shellFailureIn(output: string): string | null {
  for (const re of SHELL_CANNOT_RUN) {
    const found = output.match(re)
    if (found?.[1]) return found[1]
  }
  return null
}

/** How one command will be handed to the operating system. */
interface SpawnSpec {
  file: string
  args: string[]
  /** `true` lets Node pick the shell; a string names one. */
  shell: boolean | string
  /** Scratch directory holding a generated script, removed once the child settles. */
  scratch: string | null
}

/**
 * Decide how to run a command, routing multi-line text through a script file.
 *
 * `spawn(cmd, { shell: true })` on Windows is `cmd.exe /d /s /c "<cmd>"`, and
 * cmd.exe executes only the FIRST line of a quoted string that contains
 * newlines: the rest are dropped with no diagnostic at all, while the exit code
 * still reports the first command's success. A model that scaffolds a project in
 * one multi-line call is therefore told "exit 0" while almost nothing happened.
 *
 * Writing the text to a script file and executing that file restores the real
 * semantics, including `for` / `if` blocks and comments. Folding the lines
 * together with `&&` would fix the truncation and destroy those constructs,
 * which is a worse trade for the commands that need them most.
 */
async function planSpawn(command: string): Promise<SpawnSpec> {
  const isWindows = process.platform === 'win32'

  if (!/[\r\n]/.test(command)) {
    return {
      file: command,
      args: [],
      shell: isWindows ? true : '/bin/bash',
      scratch: null,
    }
  }

  const scratch = await mkdtemp(join(tmpdir(), 'ollama-harness-sh-'))
  if (isWindows) {
    const file = join(scratch, 'command.cmd')
    // `@echo off` keeps the script's own lines out of the captured output, so
    // what the model reads is what the commands printed.
    await writeFile(file, `@echo off\r\n${command}\r\n`, 'utf8')
    return {
      file: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', file],
      shell: false,
      scratch,
    }
  }

  const file = join(scratch, 'command.sh')
  await writeFile(file, `${command}\n`, 'utf8')
  return { file: '/bin/bash', args: [file], shell: false, scratch }
}

export interface BashToolOptions {
  /** Which shell binary to use. Defaults to the platform default. */
  shell?: string
}

export const bashTool: Tool = {
  name: 'bash',
  description:
    'Run a shell command in the working directory and return its output. Use this for ' +
    'builds, tests, git operations, and anything the other tools cannot express. ' +
    'Multi-line commands are supported and run in order. ' +
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

async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<ToolResult> {
  let spec: SpawnSpec
  try {
    spec = await planSpawn(command)
  } catch (error) {
    return {
      content: `Could not prepare the command: ${(error as Error).message}`,
      isError: true,
    }
  }

  return await new Promise((resolve) => {
    const child = spawn(spec.file, spec.args, {
      cwd,
      shell: spec.shell,
      windowsHide: true,
      env: scrubbedEnv(),
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
      // Best effort: a child that outlived the process tree can still hold the
      // file on Windows, and a leaked temp directory is not worth failing over.
      if (spec.scratch !== null) {
        void rm(spec.scratch, { recursive: true, force: true }).catch(() => {})
      }
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
      const body = render()
      // The exit code is the LAST command's status, so it is not evidence that
      // every command succeeded. When the shell says it could not run something,
      // say so instead of passing a bare 0 along as a verdict.
      const failedToRun = code === 0 ? shellFailureIn(body) : null
      if (failedToRun !== null) {
        finish({
          content:
            `${body}\n\n[exit code 0, but the shell could not run \`${failedToRun}\`. ` +
            'An exit code only reports the LAST command of the line, so it is not proof ' +
            'that this command did what it says. Fix or drop the failing command and run it again.]',
          isError: true,
        })
        return
      }
      finish({
        content: `${body}\n\n[exit code ${code ?? 'null'}]`,
        isError: code !== 0,
      })
    })
  })
}
