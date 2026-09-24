/**
 * `list` — a structured overview of a directory.
 *
 * Why this is its own tool rather than a flag on `glob`:
 *
 * Asked "这个目录里有什么", the model would call `glob` with `**​/*`, receive up to
 * 200 paths sorted newest-first, and paste them straight back. That looks like
 * laziness, but the raw material was the problem. Turning a flat wall of paths
 * into "these are the three areas of the project, and here is what each is for"
 * is exactly the synthesis a 5B local model cannot do — so asking for it was
 * asking for a summary from something that can only copy.
 *
 * So the grouping happens here, on the machine, where it is cheap and exact, and
 * the model receives structure instead of names: which subdirectories exist and
 * how much is in each, which KINDS of files dominate, and the marker files that
 * identify what kind of thing this is. Its job drops to describing the shape it
 * was handed — a job it can actually do.
 *
 * Everything the model would otherwise have to compute is a pure function below
 * (`fileKind`, `summarizeKinds`, `findMarkers`, `formatSize`) so the grouping
 * rules are assertable rather than only visible in a screenshot.
 */

import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { Tool, ToolResult } from './types.js'
import { guardOutside, NOISE_DIRS, withCommas } from './files.js'
import { resolveToolPath } from './paths.js'
import { buildProjectMap, formatProjectMap } from './repo-map.js'

/** Hard stop so scanning a huge tree cannot wedge the turn. */
const MAX_ENTRIES = 20_000
/** Directories printed per level. Deeper levels are still counted, just not shown. */
const MAX_CHILDREN = 20
/** Example file names printed per kind. */
const MAX_EXAMPLES = 4
const DEFAULT_DEPTH = 2
const MAX_DEPTH = 5
/**
 * Recursion guard, deliberately above MAX_DEPTH: the tree is only PRINTED to
 * `depth`, but the walk descends further so the counts are subtree totals rather
 * than only what happens to be visible.
 */
const MAX_WALK_DEPTH = MAX_DEPTH + 3

export type FileKind =
  | 'code'
  | 'config'
  | 'doc'
  | 'image'
  | 'video'
  | 'audio'
  | 'archive'
  | 'font'
  | 'data'
  | 'other'

/**
 * Extension → kind.
 *
 * Two deliberate inclusions, both found by running this against a real folder
 * rather than by reasoning about it:
 *
 * - `.wxml` / `.wxss` / `.wxs` are WeChat mini-program source. Without them an
 *   entire mini-program landed in `other`, i.e. the one bucket that says nothing.
 * - `.ppt` / `.pptx` are documents. A single 37 MB deck was the largest file in
 *   a materials library and it was being reported as `other`.
 *
 * `'ts'` stays `code` only. It is also an MPEG transport-stream container, but in
 * a folder a person is asking about, TypeScript is the reading that is almost
 * never wrong. `'key'` is deliberately absent: a Keynote deck and a PEM private
 * key share the extension and the second one deserves no confident label.
 */
const KIND_EXTENSIONS: ReadonlyArray<readonly [Exclude<FileKind, 'other'>, readonly string[]]> = [
  ['code', [
    // Web and mini-program.
    'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte', 'astro', 'html', 'htm', 'xhtml',
    'css', 'scss', 'sass', 'less', 'styl', 'wxml', 'wxss', 'wxs', 'razor',
    // Backends and systems languages.
    'py', 'java', 'kt', 'kts', 'go', 'rs', 'rb', 'php', 'cs', 'vb', 'swift', 'scala',
    'c', 'h', 'cc', 'cpp', 'hpp', 'm', 'mm', 'fs', 'fsx', 'dart', 'lua', 'pl', 'r',
    'ex', 'exs', 'hs', 'clj', 'asm', 'sql', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'awk',
    // Build scripts and schemas.
    'gradle', 'groovy', 'cmake', 'nix', 'tf', 'hcl', 'proto', 'graphql', 'gql', 'ipynb',
  ]],
  ['config', [
    'json', 'json5', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties',
    'xml', 'plist', 'sln', 'csproj', 'vbproj', 'fsproj', 'props', 'targets', 'lock', 'rc',
    // A leading dot is treated as an extension on purpose, so dotfiles arrive here.
    'gitignore', 'gitattributes', 'gitmodules', 'dockerignore', 'npmrc', 'nvmrc',
    'babelrc', 'eslintrc', 'prettierrc', 'stylelintrc', 'editorconfig',
  ]],
  ['doc', [
    'md', 'mdx', 'txt', 'rst', 'org', 'tex', 'bib', 'log',
    'pdf', 'doc', 'docx', 'odt', 'rtf', 'epub', 'djvu', 'xps', 'chm',
    'ppt', 'pptx', 'odp',
  ]],
  ['image', [
    'png', 'jpg', 'jpeg', 'jpe', 'jfif', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'ico', 'svg',
    'avif', 'heic', 'heif', 'jxl', 'apng', 'tga', 'dds', 'exr', 'hdr', 'wmf', 'emf',
    'raw', 'cr2', 'nef', 'arw', 'orf', 'raf', 'psd', 'ai', 'eps', 'xcf',
  ]],
  ['video', ['mp4', 'm4v', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'mpg', 'mpeg', '3gp', 'mts', 'm2ts', 'ogv', 'vob', 'rmvb', 'asf']],
  ['audio', ['mp3', 'wav', 'flac', 'aac', 'ogg', 'oga', 'opus', 'm4a', 'wma', 'aiff', 'aif', 'ape', 'amr', 'caf', 'mid', 'midi', 'mka', 'ac3']],
  ['archive', ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'lz4', 'z', 'iso', 'dmg', 'cab', 'rpm', 'deb', 'apk', 'msi', 'pkg', 'xar', 'jar', 'war', 'ear']],
  ['font', ['ttf', 'otf', 'woff', 'woff2', 'eot', 'ttc', 'pfb', 'pfm']],
  ['data', [
    'csv', 'tsv', 'tab', 'jsonl', 'ndjson', 'xls', 'xlsx', 'xlsm', 'ods',
    'db', 'sqlite', 'sqlite3', 'parquet', 'avro', 'arrow', 'feather', 'h5', 'hdf5',
    'mdb', 'dta', 'sav', 'rds', 'rdata',
  ]],
]

const EXT_TO_KIND: ReadonlyMap<string, FileKind> = new Map(
  KIND_EXTENSIONS.flatMap(([kind, extensions]) => extensions.map((ext) => [ext, kind] as const)),
)

/**
 * Well-known files that carry meaning without an extension.
 *
 * Checked before the extension, so `Makefile` and `Dockerfile` do not land in
 * `other` merely for having no dot in them.
 */
const NAME_KINDS: ReadonlyMap<string, FileKind> = new Map([
  ['readme', 'doc'], ['license', 'doc'], ['licence', 'doc'], ['changelog', 'doc'],
  ['notice', 'doc'], ['authors', 'doc'], ['contributing', 'doc'], ['copying', 'doc'],
  ['makefile', 'code'], ['dockerfile', 'code'], ['cmakelists', 'code'],
  ['procfile', 'config'], ['gemfile', 'config'], ['rakefile', 'code'],
])

/** Marker files whose presence says what kind of project a folder is. */
const MARKER_NAMES = new Set([
  'readme.md', 'readme', 'readme.txt', 'license', 'changelog.md',
  // JS / TS ecosystem.
  'package.json', 'tsconfig.json', 'vite.config.ts', 'webpack.config.js',
  'next.config.js', 'next.config.mjs', 'nuxt.config.ts', 'angular.json',
  'vue.config.js', 'deno.json', 'manifest.json',
  // Java / Kotlin / Scala.
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'build.sbt',
  // Python / Ruby / PHP / Go / Rust / Swift / Elixir / Dart.
  'requirements.txt', 'pyproject.toml', 'setup.py', 'manage.py', 'gemfile',
  'composer.json', 'go.mod', 'cargo.toml', 'package.swift', 'mix.exs', 'pubspec.yaml',
  // C / C++ and containers.
  'makefile', 'cmakelists.txt', 'dockerfile', 'docker-compose.yml',
  // WeChat mini-program and React Native share `project.config.json` / `app.json`.
  'project.config.json', 'project.private.config.json', 'app.json', 'app.config.ts',
  // Entry points.
  'index.html', 'index.js', 'index.ts', 'main.py', 'main.go', 'main.rs', 'app.tsx',
  'app.js', 'notebook.ipynb',
])

/**
 * Classify a file name.
 *
 * Extension-only, so it is a cheap synchronous lookup the tests can pin down.
 * A leading dot counts as an extension on purpose: `.env` is config and
 * `.gitignore` is at least not code.
 */
export function fileKind(name: string): FileKind {
  const bare = name.toLowerCase()
  const named = NAME_KINDS.get(bare)
  if (named) return named

  const dot = bare.lastIndexOf('.')
  if (dot < 0 || dot === bare.length - 1) return 'other'
  return EXT_TO_KIND.get(bare.slice(dot + 1)) ?? 'other'
}

/** Human-readable byte count. Binary units, one decimal — this is a description, not a measurement. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function plural(count: number, singular: string, pluralForm?: string): string {
  const word = count === 1 ? singular : pluralForm ?? `${singular}s`
  return `${withCommas(count)} ${word}`
}

interface Entry {
  name: string
  size: number
}

interface DirNode {
  name: string
  /** Files directly in this directory. */
  files: number
  bytes: number
  /** Recursive totals, so a one-level view still shows the weight of a subtree. */
  totalFiles: number
  totalBytes: number
  children: DirNode[]
}

export interface KindBucket {
  kind: FileKind
  count: number
  bytes: number
  examples: string[]
}

/** Group a file sample by kind, most common first. Pure, so it can be asserted. */
export function summarizeKinds(entries: readonly Entry[]): KindBucket[] {
  const byKind = new Map<FileKind, KindBucket>()
  for (const entry of entries) {
    const kind = fileKind(entry.name)
    let bucket = byKind.get(kind)
    if (!bucket) {
      bucket = { kind, count: 0, bytes: 0, examples: [] }
      byKind.set(kind, bucket)
    }
    bucket.count++
    bucket.bytes += entry.size
    bucket.examples.push(entry.name)
  }

  const buckets = [...byKind.values()]
  for (const bucket of buckets) {
    bucket.examples.sort()
    bucket.examples.length = Math.min(bucket.examples.length, MAX_EXAMPLES)
  }
  buckets.sort((a, b) => b.count - a.count || compare(a.kind, b.kind))
  return buckets
}

/** Which marker files are present among a directory's direct children. */
export function findMarkers(names: readonly string[]): string[] {
  return names.filter((name) => MARKER_NAMES.has(name.toLowerCase())).sort()
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

interface ScanOutput {
  sample: Entry[]
  rootNames: string[]
  skipped: Set<string>
}

/**
 * Walk the tree, accumulating counts and sizes per directory.
 *
 * Sequential rather than parallel: `Promise.all` over a wide directory opens a
 * file descriptor per entry, and this is not on a hot path.
 */
async function scanDirectory(
  absolute: string,
  name: string,
  signal: AbortSignal,
  budget: { left: number },
  out: ScanOutput,
  level: number,
): Promise<DirNode> {
  const node: DirNode = { name, files: 0, bytes: 0, totalFiles: 0, totalBytes: 0, children: [] }
  if (level > MAX_WALK_DEPTH || signal.aborted) return node

  let entries
  try {
    entries = await readdir(absolute, { withFileTypes: true })
  } catch {
    // An unreadable subdirectory is not an error worth failing the whole scan
    // for — it shows up as zero files, and the parent totals stay honest.
    return node
  }

  for (const entry of entries) {
    if (signal.aborted || budget.left <= 0) return node
    const child = join(absolute, entry.name)

    if (entry.isDirectory()) {
      if (NOISE_DIRS.has(entry.name)) {
        out.skipped.add(entry.name)
        continue
      }
      budget.left--
      const sub = await scanDirectory(child, entry.name, signal, budget, out, level + 1)
      node.children.push(sub)
      node.totalFiles += sub.totalFiles
      node.totalBytes += sub.totalBytes
      continue
    }

    if (!entry.isFile()) continue
    budget.left--
    let size = 0
    try {
      size = (await stat(child)).size
    } catch {
      size = 0
    }
    node.files++
    node.bytes += size
    node.totalFiles++
    node.totalBytes += size
    out.sample.push({ name: entry.name, size })
    if (level === 0) out.rootNames.push(entry.name)
  }

  return node
}

/** Print the subtree to `maxDepth`, heaviest sibling first. */
function renderTree(
  node: DirNode,
  level: number,
  maxDepth: number,
  indent: string,
  lines: string[],
): void {
  if (level > maxDepth) return

  // Heaviest first, so the part of the tree that dominates is not buried under
  // twenty alphabetically-earlier folders that hold nothing.
  const children = [...node.children].sort(
    (a, b) => b.totalBytes - a.totalBytes || compare(a.name, b.name),
  )

  for (const child of children.slice(0, MAX_CHILDREN)) {
    // `N here` only when the split is ambiguous: a directory that holds both
    // loose files and subdirectories, where the total alone would mislead.
    const here = child.children.length > 0 && child.files > 0
      ? `, ${withCommas(child.files)} here`
      : ''
    lines.push(
      `${indent}${child.name}/ — ${plural(child.totalFiles, 'file')}, ${formatSize(child.totalBytes)}${here}`,
    )
    renderTree(child, level + 1, maxDepth, indent + '  ', lines)
  }
  const hidden = children.length - MAX_CHILDREN
  if (hidden > 0) lines.push(`${indent}… ${withCommas(hidden)} more not shown`)
}

type Args = Record<string, unknown>

function str(args: Args, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v : ''
}

/**
 * Scan and render a directory into the structured overview `list` returns.
 *
 * Exported separately so `glob` can hand it back too. A small model answering
 * "what is in this folder" reaches for `glob` out of habit, and a flat wall of
 * paths is material it can only copy, not synthesise. `glob` detects the
 * "list everything" patterns and returns this instead, so whichever tool the
 * model picks, it gets structure it can describe rather than names it can dump.
 */
export async function buildDirectoryOverview(
  absolute: string,
  label: string,
  signal: AbortSignal,
  depth: number,
): Promise<string> {
  const budget = { left: MAX_ENTRIES }
  const out: ScanOutput = { sample: [], rootNames: [], skipped: new Set<string>() }
  const root = await scanDirectory(absolute, basename(absolute) || absolute, signal, budget, out, 0)
  const truncated = budget.left <= 0

  const lines: string[] = [
    `${label} — ${plural(root.totalFiles, 'file')}, ${formatSize(root.totalBytes)}`,
  ]
  if (truncated) {
    // Said loudly because the failure mode is silent and confident: a model
    // handed a partial count reports it as the total.
    lines.push(
      `[WARNING] the scan stopped after ${withCommas(MAX_ENTRIES)} entries, so every count ` +
        'below is partial. Do not report them as totals.',
    )
  }

  if (root.totalFiles === 0 && root.children.length === 0) {
    lines.push('', 'This directory is empty.')
    return lines.join('\n')
  }

  lines.push('', `Structure (${depth} level${depth === 1 ? '' : 's'} deep, heaviest first):`)
  // Where the files actually LIVE is part of the shape. Without this line a
  // folder holding three small subdirectories and ninety loose files reads as
  // though the subdirectories held everything — and the model describes it that
  // way, confidently and wrongly.
  lines.push(
    root.children.length === 0
      ? `${root.name}/ — ${plural(root.files, 'file')}, no subdirectories`
      : `${root.name}/ — ${plural(root.files, 'file')} directly here, ` +
          `${plural(root.children.length, 'subdirectory', 'subdirectories')}`,
  )
  renderTree(root, 1, depth, '  ', lines)

  const kinds = summarizeKinds(out.sample)
  if (kinds.length > 0) {
    lines.push('', 'File kinds (most common first):')
    for (const bucket of kinds) {
      const size = formatSize(bucket.bytes).padStart(9)
      const suffix = bucket.examples.length > 0 ? `   e.g. ${bucket.examples.join(', ')}` : ''
      lines.push(`  ${bucket.kind.padEnd(8)} ${withCommas(bucket.count).padStart(7)} files ${size}${suffix}`)
    }
  }

  const markers = findMarkers(out.rootNames)
  if (markers.length > 0) {
    lines.push('', `Marker files at the top level: ${markers.join(', ')}`)
  }

  // The L0 project map. `list` alone answers "what shape is this folder"; the
  // map answers "what IS this project" — from pom.xml / package.json / Java
  // annotations the harness reads offline, so the model states facts instead of
  // guessing ("似乎是前端"). It comes after the structure because it is the
  // conclusion the structure points at.
  const map = await buildProjectMap(absolute, signal)
  if (map) lines.push('', ...formatProjectMap(map))
  if (out.skipped.size > 0) {
    const names = [...out.skipped].sort()
    lines.push('', `Skipped (dependency/build noise — NOT counted above): ${names.map((n) => `${n}/`).join(', ')}`)
  }

  return lines.join('\n')
}

export const listTool: Tool = {
  name: 'list',
  description:
    'Get an organised overview of a directory: its subdirectories with how many files and ' +
    'how much data each holds, which kinds of files dominate, and the marker files that show ' +
    'what kind of project it is. Use this when the user asks what is in a folder or asks you ' +
    'to explain a project — it returns structure you can describe. `glob` returns a flat list ' +
    'of paths, which is not an answer to that question.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to summarise. Defaults to the working directory.' },
      depth: { type: 'integer', description: `How many directory levels to print. Defaults to ${DEFAULT_DEPTH}, max ${MAX_DEPTH}. Deeper levels are still counted in the totals.` },
    },
    required: [],
  },
  preview: (args) => `List ${String(args.path ?? '.')}`,

  async execute(args, ctx): Promise<ToolResult> {
    const input = str(args, 'path') || '.'
    const requested = typeof args.depth === 'number' ? Math.trunc(args.depth) : DEFAULT_DEPTH
    const depth = Math.min(MAX_DEPTH, Math.max(1, requested))

    await guardOutside(ctx, input, 'list')
    const { absolute } = await resolveToolPath(input, ctx.cwd)

    let info
    try {
      info = await stat(absolute)
    } catch {
      return { content: `Path not found: ${input}`, isError: true }
    }
    if (info.isFile()) {
      return {
        content: `${input} is a file (${formatSize(info.size)}), not a directory. Use the read tool for its contents.`,
        isError: true,
      }
    }

    return { content: await buildDirectoryOverview(absolute, input, ctx.signal, depth) }
  },
}
