/**
 * Filesystem tools: read, write, edit, glob, grep.
 *
 * Design notes that matter for a small local model:
 *
 * - `read` numbers its lines, because a model that can cite `file.ts:42` makes
 *   far fewer edit mistakes than one working from character offsets.
 * - `edit` uses exact string replacement, not line numbers, so a stale read
 *   fails loudly instead of silently corrupting the wrong line.
 * - Every tool truncates its own output. A 10k-line file dumped into context
 *   evicts the conversation that made it relevant.
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative } from 'node:path'
import type { Tool, ToolResult, ToolRunContext } from './types.js'
import { PathError, resolveToolPath } from './paths.js'
import { extractText, isDocumentPath } from '../extract.js'

const MAX_READ_BYTES = 256 * 1024
const MAX_READ_LINES = 2000
const MAX_MATCHES = 200
/**
 * Ceiling on how long `glob` keeps COUNTING after it stops collecting.
 *
 * Collecting and counting are separate on purpose: the model has to know that
 * 200 shown paths are a sample of a larger set, and the cheapest way to tell it
 * is to keep matching names — no `stat` — past the collection cap.
 */
const MAX_FOUND = 5_000
const MAX_LINE_LEN = 500

/**
 * Directory names that are never the user's own work.
 *
 * Shared by `glob`, `grep` and `list` so all three agree on what "the project"
 * is. Learned from a real project that carried 2,069 files under `.workbuddy/`
 * — Chromium profiles for browser automation, 90% of its 206.7 MB. A wide
 * `glob` returned 200 of those cache paths and every source file went
 * unreported, so the model described the project as a browser cache. Build
 * output is included too: it duplicates the sources, and a question about a
 * project is never a question about its compiled copy.
 */
export const NOISE_DIRS = new Set([
  // Dependencies.
  'node_modules', 'vendor', 'bower_components', '.pnpm-store', '.yarn',
  // Version control.
  '.git', '.svn', '.hg',
  // Editor, tool and automation state.
  '.workbuddy', '.idea', '.vscode', '.gradle', '.mvn', '.fleet',
  // Linter / test caches.
  '.cache', '.next', '.nuxt', '.turbo', '.parcel-cache',
  '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache',
  '.ruff_cache', 'coverage', '.nyc_output',
  // Build output.
  'dist', 'build', 'out', 'target', 'obj',
])

/**
 * Ceiling for documents that go through a decoder rather than a plain utf8
 * read. A 20 MB PDF is mostly images, and the text inside it is a small
 * fraction — so the size limit that guards a text file would reject a document
 * that would have inlined perfectly well.
 */
const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024

type Args = Record<string, unknown>

function str(args: Args, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v : ''
}

/** Thousands separators. Shared with the `list` tool, which reports the same numbers. */
export function withCommas(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * Ask before touching a path outside the working directory.
 *
 * The prompt is worded for the model as much as for the user: a small model
 * reading "declined" often reports it back as "I don't have permission", which
 * sends the user hunting for a setting that does not exist. Saying who decided
 * keeps the blame in the right place.
 */
export async function guardOutside(
  ctx: ToolRunContext,
  path: string,
  action: string,
): Promise<void> {
  const { outsideWorkdir } = await resolveToolPath(path, ctx.cwd)
  if (!outsideWorkdir) return
  const ok = await ctx.requestApproval(
    `${action} 想要访问工作目录之外的路径：\n${path}\n\n` +
      '允许本次访问。如果拒绝，请直接告诉用户这次操作被拒绝了——不要理解成你没有权限。',
  )
  if (!ok) {
    throw new PathError(
      `The user declined this ${action} of "${path}", which is outside the working directory. ` +
        'You are not missing a permission — it was refused just now. Do not retry by another route; ' +
        'tell the user it was declined and ask how they would like to proceed.',
    )
  }
}

/**
 * Read a file from disk.
 *
 * Text, source, PDF and docx all work: documents are routed through a decoder
 * (see core/extract.ts) rather than read as bytes. Output is line-numbered so
 * the model can cite `file.ts:42`, and truncated so a large file cannot evict
 * the conversation that made it relevant.
 */
export const readTool: Tool = {
  name: 'read',
  description:
    'Read a file from disk. Returns the content with 1-based line numbers. ' +
    'Plain text, source code, PDF and docx all work — documents are decoded to text first. ' +
    'Use offset/limit for large files. Output is truncated at 2000 lines, so read in ' +
    'chunks when a file is longer than that.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, absolute or relative to the working directory.' },
      offset: { type: 'integer', description: 'First line to read (1-based). Defaults to 1.' },
      limit: { type: 'integer', description: 'Maximum number of lines to read. Defaults to 2000.' },
    },
    required: ['path'],
  },
  preview: (args) => `Read ${String(args.path ?? '')}`,

  async execute(args, ctx): Promise<ToolResult> {
    const input = str(args, 'path')
    await guardOutside(ctx, input, 'read')
    const { absolute } = await resolveToolPath(input, ctx.cwd)

    let info
    try {
      info = await stat(absolute)
    } catch {
      return await readAfterMistypedPath(absolute, input, args, ctx)
    }
    if (info.isDirectory()) {
      const entries = await readdir(absolute, { withFileTypes: true })
      // Sorted, directories first. readdir returns filesystem order, which is
      // arbitrary, and an arbitrary dump is hard to read even when it is short.
      const names = entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort((a, b) => {
          const aDir = a.endsWith('/') ? 0 : 1
          const bDir = b.endsWith('/') ? 0 : 1
          return aDir - bDir || (a < b ? -1 : a > b ? 1 : 0)
        })
      const shown = names.slice(0, MAX_MATCHES)
      const clipped = names.length > shown.length
        ? `\n\n[${withCommas(names.length - shown.length)} more entries not shown]`
        : ''
      return {
        content:
          `${input} is a directory, not a file. ${withCommas(entries.length)} entries:\n` +
          `${shown.join('\n')}${clipped}\n\n` +
          '[for a description of the folder — subdirectory weights, kinds of files, what kind ' +
          'of project it is — call the list tool]',
      }
    }

    return await serveFile(absolute, input, args)
  },
}

/**
 * Read and format a file that is known to exist and not to be a directory.
 *
 * Split out of `read` because the mistyped-path recovery below needs the exact
 * same behaviour, and two copies would drift.
 */
async function serveFile(absolute: string, label: string, args: Args): Promise<ToolResult> {
  if (isDocumentPath(absolute)) {
    const result = await readDocument(absolute, label)
    if (result.error !== undefined) return { content: result.error, isError: true }
    return { content: numberLines(result.text, args, result.notes) }
  }

  let size = 0
  try {
    size = (await stat(absolute)).size
  } catch {
    size = 0
  }
  if (size > MAX_READ_BYTES) {
    return {
      content: `File is ${(size / 1024 / 1024).toFixed(1)} MB, which exceeds the read limit. Use grep to find what you need, or read a range with offset/limit.`,
      isError: true,
    }
  }

  const raw = await readFile(absolute)
  const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
  const extracted = extractText(absolute, bytes)
  if (extracted.error !== undefined) {
    return { content: `${label}: ${extracted.error}`, isError: true }
  }
  return { content: numberLines(extracted.text, args, extracted.notes) }
}

/**
 * Decode a PDF or docx into text.
 *
 * Read as a Buffer rather than a utf8 string: the decoders need the raw bytes
 * (a zlib stream read as text is destroyed before it can be inflated).
 */
async function readDocument(
  absolute: string,
  label: string,
): Promise<{ text: string; error?: string; notes?: string[] }> {
  let buffer: Buffer
  try {
    const info = await stat(absolute)
    if (info.size === 0) {
      return { text: '', error: `${label} is empty.` }
    }
    if (info.size > MAX_DOCUMENT_BYTES) {
      return {
        text: '',
        error: `${label} is ${(info.size / 1024 / 1024).toFixed(1)} MB, which exceeds the document read limit.`,
      }
    }
    buffer = await readFile(absolute)
  } catch (error) {
    return { text: '', error: `Could not read ${label}: ${(error as Error).message}` }
  }

  const result = extractText(absolute, new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength))
  if (result.error !== undefined) {
    return { text: '', error: `${label}: ${result.error}` }
  }

  const notes = [...(result.notes ?? [])]
  notes.push(`（${extname(absolute).slice(1) || 'document'} 文档已转为纯文本，共 ${result.text.length} 字符）`)
  if (result.truncated) {
    notes.push('内容过长，只保留了前面一部分。可以用 offset/limit 继续读，或者先告诉我你想找什么。')
  }
  return { text: result.text, error: undefined, notes }
}

/**
 * Recover a read whose directory is wrong but whose file name is not.
 *
 * A 5B model reading a directory tree reassembles the path by hand and drops a
 * level: it asked for `.../com/apesource/AiDishGenerator.java` when the file
 * lives under `.../apesource/dishservice/ai/`. Reporting that as an error ends
 * the attempt — the model reads `isError` as a dead end and switches strategy
 * rather than retrying a path it cannot see was wrong. So when exactly ONE file
 * on disk carries that name, the read is unambiguous: serve it, and say what
 * happened. Two candidates is a real ambiguity and stays an error.
 */
async function readAfterMistypedPath(
  absolute: string,
  input: string,
  args: Args,
  ctx: ToolRunContext,
): Promise<ToolResult> {
  const name = basename(absolute)
  const matches = await pathsNamed(name, absolute, ctx)

  if (matches.length === 0) {
    return { content: `File not found: ${input}`, isError: true }
  }
  if (matches.length > 1) {
    return {
      content:
        `File not found: ${input}\n${matches.length} different files are named "${name}" — ` +
        `read whichever one you meant:\n${matches.map((m) => `- ${m}`).join('\n')}`,
      isError: true,
    }
  }

  const corrected = matches[0]!
  const served = await serveFile(corrected, corrected, args)
  if (served.isError) return served
  return {
    content:
      `[note: "${input}" does not exist. Read "${corrected}" instead — a different directory, ` +
      `the same file name.]\n\n${served.content}`,
  }
}

/**
 * Every file named `name` under the deepest existing ancestor of `near`.
 *
 * Searching from that ancestor rather than the working directory keeps the walk
 * small and pointed: a mistyped path almost always has a valid prefix, and that
 * prefix is the right place to look. Capped at 5, and noise is not walked.
 */
async function pathsNamed(name: string, near: string, ctx: ToolRunContext): Promise<string[]> {
  const target = name.toLowerCase()
  if (target.length === 0) return []

  let root = dirname(near)
  for (let i = 0; i < 8; i++) {
    const info = await stat(root).catch(() => null)
    if (info?.isDirectory()) break
    const parent = dirname(root)
    if (parent === root) break
    root = parent
  }

  const found: string[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    if (found.length >= 5 || depth > 10) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= 5) return
      if (entry.isDirectory()) {
        if (NOISE_DIRS.has(entry.name)) continue
        await walk(join(dir, entry.name), depth + 1)
      } else if (entry.name.toLowerCase() === target) {
        found.push(join(dir, entry.name))
      }
    }
  }
  await walk(root, 0)
  return found
}

/** The shared line-numbering tail of `read`, used by both paths. */
function numberLines(text: string, args: Args, notes?: readonly string[]): string {
  const allLines = text.split(/\r\n|\n/)
  const offset = Math.max(1, typeof args.offset === 'number' ? Math.trunc(args.offset) : 1)
  const limit = Math.max(1, typeof args.limit === 'number' ? Math.trunc(args.limit) : MAX_READ_LINES)
  const slice = allLines.slice(offset - 1, offset - 1 + limit)

  const numbered = slice
    .map((line, i) => {
      const n = offset + i
      const clipped = line.length > MAX_LINE_LEN ? `${line.slice(0, MAX_LINE_LEN)}…` : line
      return `${String(n).padStart(5)}│${clipped}`
    })
    .join('\n')

  const lastShown = offset - 1 + slice.length
  const more = lastShown < allLines.length
    ? `\n\n[${allLines.length - lastShown} more lines not shown — continue with offset=${lastShown + 1}]`
    : ''
  const header = notes && notes.length > 0 ? `[${notes.join(' ')}]\n\n` : ''

  return header + numbered + more
}

export const writeTool: Tool = {
  name: 'write',
  description:
    'Write a file to disk, creating parent directories as needed. Overwrites the whole file. ' +
    'To change part of an existing file, prefer the edit tool.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, absolute or relative to the working directory.' },
      content: { type: 'string', description: 'Full file content to write.' },
    },
    required: ['path', 'content'],
  },
  preview: (args) => `Write ${String(args.path ?? '')}`,

  async execute(args, ctx): Promise<ToolResult> {
    const input = str(args, 'path')
    const content = typeof args.content === 'string' ? args.content : ''
    await guardOutside(ctx, input, 'write')
    const { absolute } = await resolveToolPath(input, ctx.cwd)

    let existed = false
    try {
      existed = (await stat(absolute)).isFile()
    } catch {
      existed = false
    }

    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, content, 'utf8')

    const lineCount = content.split('\n').length
    return {
      content: `${existed ? 'Overwrote' : 'Created'} ${input} (${lineCount} lines, ${content.length} bytes).`,
    }
  },
}

export const editTool: Tool = {
  name: 'edit',
  description:
    'Replace an exact string in a file. old_string must appear exactly once unless ' +
    'replace_all is true. This is safer than rewriting the whole file because it fails ' +
    'loudly when your view of the file is stale instead of silently clobbering changes.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to edit.' },
      old_string: { type: 'string', description: 'Exact text to replace, including indentation.' },
      new_string: { type: 'string', description: 'Replacement text.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence. Defaults to false.' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  preview: (args) => `Edit ${String(args.path ?? '')}`,

  async execute(args, ctx): Promise<ToolResult> {
    const input = str(args, 'path')
    const oldString = typeof args.old_string === 'string' ? args.old_string : ''
    const newString = typeof args.new_string === 'string' ? args.new_string : ''
    const replaceAll = args.replace_all === true

    if (oldString.length === 0) {
      return { content: 'old_string must not be empty — use the write tool to create a file.', isError: true }
    }
    if (oldString === newString) {
      return { content: 'old_string and new_string are identical, so there is nothing to change.', isError: true }
    }

    await guardOutside(ctx, input, 'edit')
    const { absolute } = await resolveToolPath(input, ctx.cwd)

    let raw: string
    try {
      raw = await readFile(absolute, 'utf8')
    } catch {
      return { content: `File not found: ${input}`, isError: true }
    }

    const occurrences = countOccurrences(raw, oldString)
    if (occurrences === 0) {
      return {
        content: `old_string was not found in ${input}. Read the file again and match the text exactly, including whitespace.`,
        isError: true,
      }
    }
    if (occurrences > 1 && !replaceAll) {
      return {
        content: `old_string appears ${occurrences} times in ${input}. Add surrounding context to make it unique, or pass replace_all: true.`,
        isError: true,
      }
    }

    const updated = replaceAll
      ? raw.split(oldString).join(newString)
      : raw.replace(oldString, newString)

    await writeFile(absolute, updated, 'utf8')
    return {
      content: `Edited ${input}: replaced ${replaceAll ? occurrences : 1} occurrence${occurrences === 1 ? '' : 's'}.`,
    }
  },
}

/**
 * Patterns whose meaning is "show me everything here". For these, returning a
 * flat list of paths is returning material a small model can only copy back —
 * so `glob` returns the same structured overview as the `list` tool instead. A
 * specific pattern (`**​/*.ts`, `src/**`) still gets the flat list, because then
 * the model is locating files, not asking what a folder is.
 */
const BROAD_GLOB_PATTERNS = new Set(['*', '**', '**/*', '*.*'])

export const globTool: Tool = {
  name: 'glob',
  description:
    'Find files by name pattern, e.g. "**/*.ts" or "src/**/*.test.tsx". ' +
    'Returns paths sorted by modification time, newest first, at most 200 of them — ' +
    'the result states the real total whenever it had to stop early. Use this to ' +
    'locate files; use grep to search their contents, and the list tool to describe ' +
    'a directory.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern. "**" matches across directories.' },
      path: { type: 'string', description: 'Directory to search in. Defaults to the working directory.' },
    },
    required: ['pattern'],
  },
  preview: (args) => `Glob ${String(args.pattern ?? '')}`,

  async execute(args, ctx): Promise<ToolResult> {
    const pattern = str(args, 'pattern')
    const root = str(args, 'path') || '.'
    if (pattern.length === 0) {
      return { content: 'pattern must not be empty', isError: true }
    }

    // "List everything" is a question about what a folder IS, not where a file
    // is. Answer it with structure, not a wall of names. The dynamic import
    // avoids a static cycle — list.ts already imports guardOutside/withCommas
    // from this file.
    if (BROAD_GLOB_PATTERNS.has(pattern)) {
      const { buildDirectoryOverview } = await import('./list.js')
      const { absolute } = await resolveToolPath(root, ctx.cwd)
      let info
      try {
        info = await stat(absolute)
      } catch {
        return { content: `Path not found: ${root}`, isError: true }
      }
      if (info.isFile()) {
        return { content: `"${root}" is a file, not a directory. Use read for its contents.`, isError: true }
      }
      const label = root === '.' || root === '' ? '.' : root
      const content = await buildDirectoryOverview(absolute, label, ctx.signal, 2)
      return {
        content:
          `"${pattern}" lists everything, so here is a structured overview instead of a flat list:\n\n${content}`,
      }
    }

    const { absolute } = await resolveToolPath(root, ctx.cwd)

    const regex = globToRegExp(pattern)
    const matches: Array<{ path: string; mtime: number }> = []
    // Counted separately from `matches`. Knowing there were 1,354 files when only
    // 200 were kept is the difference between "the project has 200 files" — which
    // is what the model used to report — and "showing 200 of 1,354".
    let found = 0

    async function walk(dir: string, depth: number): Promise<void> {
      if (depth > 12 || found >= MAX_FOUND) return
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (found >= MAX_FOUND) return
        // Skipping noise is not an optimisation: walking `node_modules` takes
        // minutes, and walking a browser-automation profile (see NOISE_DIRS)
        // buries every source file under thousands of cache entries.
        if (NOISE_DIRS.has(entry.name)) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full, depth + 1)
          continue
        }
        const rel = relative(ctx.cwd, full).split('\\').join('/')
        if (!regex.test(rel) && !regex.test(entry.name)) continue
        found++
        // Past the cap, keep counting but stop stating: the stat is the expensive
        // part and the extra paths would be discarded anyway.
        if (matches.length >= MAX_MATCHES) continue
        try {
          const info = await stat(full)
          matches.push({ path: rel, mtime: info.mtimeMs })
        } catch {
          matches.push({ path: rel, mtime: 0 })
        }
      }
    }

    await walk(absolute, 0)
    if (found === 0) {
      return { content: `No files matched "${pattern}".` }
    }
    matches.sort((a, b) => b.mtime - a.mtime)
    const listed = matches.map((m) => m.path).join('\n')

    if (found <= matches.length) {
      return { content: `${withCommas(found)} file${found === 1 ? '' : 's'} matched "${pattern}":\n${listed}` }
    }

    const total = found >= MAX_FOUND ? `more than ${withCommas(MAX_FOUND)}` : withCommas(found)
    return {
      content:
        `Matched ${total} files for "${pattern}". Showing the ${matches.length} most recently ` +
        `modified — the rest were NOT returned, so this is a sample, not the full list.\n${listed}\n\n` +
        '[narrow the pattern to see the rest, or use the list tool for an overview of the directory]',
    }
  },
}

export const grepTool: Tool = {
  name: 'grep',
  description:
    'Search file contents with a regular expression. Returns matching lines with file ' +
    'paths and line numbers. Use this to find where a symbol is defined or used.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for.' },
      path: { type: 'string', description: 'File or directory to search. Defaults to the working directory.' },
      glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.ts".' },
      ignoreCase: { type: 'boolean', description: 'Case-insensitive match. Defaults to false.' },
    },
    required: ['pattern'],
  },
  preview: (args) => `Grep ${String(args.pattern ?? '')}`,

  async execute(args, ctx): Promise<ToolResult> {
    const pattern = str(args, 'pattern')
    const requestedPath = str(args, 'path')
    let globFilter = str(args, 'glob')
    let target = requestedPath || '.'
    const ignoreCase = args.ignoreCase === true
    if (pattern.length === 0) {
      return { content: 'pattern must not be empty', isError: true }
    }

    // A caller wanting "the Java files under dish-service/src" writes either a
    // `path` plus a recursive glob, or one glob with the directory baked in.
    // Only the first shape used to match: the filter is tested against a base
    // name and a working-directory relative path, and an absolute glob matches
    // neither. The search then read zero files and reported "no matches", which
    // the model relayed to the user as "that feature is not implemented".
    if (requestedPath.length === 0 && globFilter.length > 0) {
      const split = splitGlobRoot(globFilter)
      if (split) {
        target = split.root
        globFilter = split.glob
      }
    }

    // A small model writes search logic the way it writes English — "AI OR retry
    // AND dish" — which, read as a regex, matches that literal sentence and so
    // nothing. Restate it rather than fail and hope the model recovers.
    let note = ''
    let effective = pattern
    const translated = translateLogicExpression(pattern)
    if (translated) {
      effective = translated.regex
      note = `[${translated.note}]\n`
    }

    let regex: RegExp
    try {
      regex = new RegExp(effective, ignoreCase ? 'i' : '')
    } catch (e) {
      return { content: `Invalid regular expression: ${(e as Error).message}`, isError: true }
    }

    const { absolute } = await resolveToolPath(target, ctx.cwd)
    const globRegex = globFilter ? globToRegExp(globFilter) : undefined
    // A glob arrives in three shapes -- a base name, a path relative to the
    // working directory, or an absolute path -- so test all three. A filter
    // that excludes everything is indistinguishable, from the outside, from a
    // term the code does not contain.
    const testGlob = (name: string, full: string): boolean => {
      if (!globRegex) return true
      if (globRegex.test(name)) return true
      if (globRegex.test(relative(ctx.cwd, full).split('\\').join('/'))) return true
      return globRegex.test(full.split('\\').join('/'))
    }
    const hits: string[] = []
    let filesScanned = 0
    // Whether the scanned source contains CJK. Turns the "try Chinese" tip from
    // a generic guess into a statement about THIS project.
    let sawCjk = false

    async function scanFile(file: string): Promise<void> {
      if (hits.length >= MAX_MATCHES) return
      let raw: string
      try {
        const info = await stat(file)
        if (info.size > 2 * 1024 * 1024) return
        raw = await readFile(file, 'utf8')
      } catch {
        return
      }
      filesScanned++
      if (!sawCjk && /[\u4e00-\u9fff]/.test(raw)) sawCjk = true
      const rel = relative(ctx.cwd, file).split('\\').join('/')
      const lines = raw.split(/\r\n|\n/)
      for (let i = 0; i < lines.length; i++) {
        if (hits.length >= MAX_MATCHES) return
        const line = lines[i] ?? ''
        if (!regex.test(line)) continue
        const clipped = line.length > MAX_LINE_LEN ? `${line.slice(0, MAX_LINE_LEN)}…` : line
        hits.push(`${rel}:${i + 1}: ${clipped}`)
      }
    }

    async function walk(dir: string, depth: number): Promise<void> {
      if (hits.length >= MAX_MATCHES || depth > 12) return
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (hits.length >= MAX_MATCHES) return
        if (NOISE_DIRS.has(entry.name)) continue
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(full, depth + 1)
        } else if (testGlob(entry.name, full)) {
          await scanFile(full)
        }
      }
    }

    const info = await stat(absolute).catch(() => null)
    if (info?.isFile()) {
      await scanFile(absolute)
    } else {
      await walk(absolute, 0)
    }

    if (hits.length === 0) {
      return { content: note + noMatchHint(effective, filesScanned, ignoreCase, sawCjk, globFilter) }
    }
    const capped = hits.length >= MAX_MATCHES ? `\n\n[stopped at ${MAX_MATCHES} matches — narrow the pattern]` : ''
    const body = `${hits.length} match${hits.length === 1 ? '' : 'es'} in ${filesScanned} file${filesScanned === 1 ? '' : 's'}:\n${hits.join('\n')}${capped}`
    return { content: note + body + cjkNote(effective, sawCjk) }
  },
}

/**
 * Translate a glob to a RegExp.
 *
 * Supports `**` (any depth), `*` (within a segment), `?`, and `{a,b}` alternation.
 * A hand-rolled matcher keeps the harness dependency-free, and the failure mode
 * of a slightly-imperfect glob is a narrower result rather than a crash.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` should match zero directories too, hence the optional group.
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else if (ch === '{') {
      const close = pattern.indexOf('}', i)
      if (close === -1) {
        out += '\\{'
      } else {
        const options = pattern.slice(i + 1, close).split(',')
        out += `(?:${options.map(escapeRegExp).join('|')})`
        i = close
      }
    } else if ('.+^$()|[]\\'.includes(ch)) {
      out += `\\${ch}`
    } else {
      out += ch
    }
  }
  return new RegExp(`^${out}$`)
}

/**
 * Split a glob that carries a directory prefix into (search root, remainder).
 *
 * A caller wanting the Java files under `dish-service/src` writes either a
 * `path` plus a recursive glob, or one glob with the directory baked in. Only
 * the first shape matched, because the filter is tested against a base name and
 * a working-directory relative path -- and an absolute glob matches neither.
 * The search read zero files, the tool answered "no matches", and the model
 * told the user the feature did not exist.
 *
 * A directory named inside the glob is the root the caller meant. Return it, so
 * the search actually happens, with the remainder as the filter.
 */
export function splitGlobRoot(glob: string): { root: string; glob: string } | null {
  const normalized = glob.split('\\').join('/')
  const wildcardAt = normalized.search(/[*?{]/)
  const head = wildcardAt === -1 ? normalized : normalized.slice(0, wildcardAt)

  // A separator is what makes the prefix a directory; `*.ts` names none.
  const cut = head.lastIndexOf('/')
  if (cut <= 0) return null

  const root = normalized.slice(0, cut)
  const rest = normalized.slice(cut + 1)
  // The remainder must still be a pattern, or there is nothing to split.
  if (!/[*?{]/.test(rest)) return null

  return { root, glob: rest }
}

/**
 * Translate the natural-language logic a small model writes into a regex.
 *
 * Asked to find AI / retry / error handling, a 5B model writes
 * `AI OR retry OR error AND (dish OR order)`. That is a VALID regex — `OR` and
 * `AND` are ordinary characters — so it silently searches for that literal
 * sentence and finds nothing, then tells the user the code does not exist.
 *
 * Rather than fail and hope the model recovers, restate it: `OR` becomes an
 * alternation, `AND` becomes a same-line requirement (grep tests one line at a
 * time). Returns null when the pattern is not such an expression, so a real
 * regex is never rewritten.
 */
function translateLogicExpression(pattern: string): { regex: string; note: string } | null {
  if (!/\s+(?:OR|AND)\s+/i.test(pattern)) return null

  // AND binds looser than OR, so split it first and alternate within each part.
  const andParts = pattern.split(/\s+AND\s+/i).map((p) => p.trim()).filter(Boolean)
  if (andParts.length === 0) return null

  const groups: string[] = []
  for (const part of andParts) {
    const inner = part.replace(/^\(+/, '').replace(/\)+$/, '').trim()
    const alternatives = inner.split(/\s+OR\s+/i).map((w) => w.trim()).filter(Boolean)
    if (alternatives.length === 0) return null
    const escaped = alternatives.map(escapeRegExp)
    groups.push(escaped.length === 1 ? escaped[0]! : `(?:${escaped.join('|')})`)
  }

  const regex = groups.length === 1
    ? groups[0]!
    : `${groups.map((g) => `(?=.*${g})`).join('')}.*`
  return {
    regex,
    note: `interpreted "${pattern}" as /${regex}/ — OR becomes |, AND becomes a same-line requirement`,
  }
}

/**
 * A one-line nudge when a Chinese project is being searched with English words.
 *
 * The failure this catches is subtler than a total miss: Java identifiers such
 * as `Exception` and `errorMsg` are ASCII even in a Chinese codebase, so an
 * English search returns real hits and looks successful — while the behaviour
 * being asked about (重试) is written in Chinese and never appears. Returns ''
 * for a Chinese pattern or a project without CJK, so it cannot nag pointlessly.
 */
function cjkNote(effective: string, sawCjk: boolean): string {
  if (!sawCjk || /[\u4e00-\u9fff]/.test(effective)) return ''
  return (
    '\n[note: the source of this project is written in Chinese. Java identifiers stay English, so you ' +
    'get hits — but the same concept may also appear in Chinese, and if it does, only a Chinese search ' +
    'finds it (retry = 重试, failure = 失败, generate = 生成)]'
  )
}

/**
 * What to say when a search finds nothing.
 *
 * "No matches" is where a small model gives up and asks the user to paste the
 * file. Each line below is a specific next move instead: the case mismatch
 * nobody thinks of (`AI` vs a class named `AiDishGenerator`), the Chinese
 * project whose comments are not in English, and searching inside the right
 * module rather than the whole tree.
 */
function noMatchHint(
  effective: string,
  filesScanned: number,
  ignoreCase: boolean,
  sawCjk: boolean,
  globFilter: string,
): string {
  // Zero files scanned is not the same answer as zero matches, and must never
  // be reported as one. When the filter excluded every file nothing was read,
  // and "no matches" reads as "this code does not contain the term" -- which is
  // how a model comes to tell a user a feature is not implemented. It was never
  // looked at. Say what actually happened, and which knob to turn.
  if (filesScanned === 0) {
    const cause =
      globFilter.length > 0
        ? `the glob "${globFilter}" matched no files under the search root`
        : 'no readable files were found under the search root'
    return [
      `Nothing was searched: ${cause}.`,
      'That is NOT evidence the code lacks the term -- no file was ever opened.',
      '- Drop the glob, or widen it, and search again.',
      '- Run `list` on the directory first to confirm it exists and holds source files.',
    ].join('\n')
  }

  const lines = [
    `No matches for /${effective}/ in ${withCommas(filesScanned)} file${filesScanned === 1 ? '' : 's'}.`,
  ]

  // Lead with this when it is true, because it is a FACT about this project
  // rather than advice: the model searched English words, and the source it just
  // swept is written in Chinese. A generic "try Chinese" is easy to skim past.
  if (sawCjk && !/[\u4e00-\u9fff]/.test(effective)) {
    lines.push(
      '- THE SOURCE FILES ARE WRITTEN IN CHINESE. You searched English words; the comments, log ' +
        'messages and docs are Chinese. Search the Chinese term instead — retry is 重试, failure is ' +
        '失败, generate is 生成. e.g. grep(pattern: "重试").',
    )
  }

  if (!ignoreCase && /[A-Za-z]/.test(effective)) {
    lines.push(
      '- Retry with ignoreCase: true. Code capitalises differently from how you would write a word — ' +
        'a class is named `AiDishGenerator` when you searched `AI`.',
    )
  }
  lines.push('- Search ONE short word instead of an expression; a long expression finds less, not more.')
  lines.push('- Run `list` first to see the module layout, then grep inside the module that owns the behaviour.')
  return lines.join('\n')
}

function escapeRegExp(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&')
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count++
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}
