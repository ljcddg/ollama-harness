/**
 * `search` — semantic code search via local embeddings.
 *
 * Why this exists alongside `grep`: a Chinese question about an English
 * codebase has no shared tokens. 问"做菜流程是怎么实现的"，grep 无论用什么
 * 关键词都会漏 —— 代码里写的是 `RecipeService.generateFlow`。An embedding
 * model (bge-m3, multilingual, already on the user's Ollama) closes exactly
 * this gap: the query and the code land near each other in meaning space even
 * with zero shared words.
 *
 * What it deliberately is NOT: a replacement for exploration. It does not fix
 * "the model didn't read the code" — `list`'s project map and `read` do that.
 * It is a grep supplement for meaning-based lookup, and its description says
 * so, because a small model needs to be told when a tool is the wrong tool.
 *
 * Process-in-memory by design: this harness targets single projects (hundreds
 * of files), where an external vector database is operational weight without
 * benefit. The index is cached per directory and invalidated by a cheap
 * size+mtime fingerprint, so the expensive part (embedding) happens once per
 * change, not once per query.
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { guardOutside, NOISE_DIRS } from './files.js'
import { resolveToolPath } from './paths.js'
import { fileKind } from './list.js'
import type { ModelInfo } from '../../shared/message.js'
import type { Tool, ToolResult } from './types.js'

/** What the tool needs from the live provider. Injected, so tests stub it. */
export interface SearchToolDeps {
  /** Model list, to find an embedding model without hard-coding a name. */
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>
  /** Embed a batch of texts. Order-preserving. */
  embed(model: string, input: readonly string[], signal?: AbortSignal): Promise<number[][]>
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

export interface TextChunk {
  /** Path relative to the index root. */
  path: string
  startLine: number
  endLine: number
  text: string
}

/** Lines per chunk. Big enough to carry a whole function or section. */
const CHUNK_LINES = 60
/** Chunks per file — a 2400-line generated monster stops at 40 chunks. */
const MAX_CHUNKS_PER_FILE = 40
/** Files indexed per root. */
const MAX_FILES = 1_500
/** Total chunks per root. */
const MAX_CHUNKS = 3_000
/** Files whose content is read at all. */
const MAX_READ_BYTES = 256_000
/** Texts sent to /api/embed per request. */
const EMBED_BATCH = 32
/** Results returned. */
const TOP_K = 8

/**
 * Split one file's content into line-ranged chunks.
 *
 * Pure and exported so the shape the model sees (file:line-range + snippet)
 * can be asserted without touching the network.
 */
export function chunkFile(path: string, content: string): TextChunk[] {
  const lines = content.split(/\r?\n/)
  const chunks: TextChunk[] = []
  for (let i = 0; i < lines.length && chunks.length < MAX_CHUNKS_PER_FILE; i += CHUNK_LINES) {
    const slice = lines.slice(i, i + CHUNK_LINES)
    if (slice.join('').trim().length === 0) continue
    chunks.push({
      path,
      startLine: i + 1,
      endLine: i + slice.length,
      text: slice.join('\n'),
    })
  }
  return chunks
}

/** Extensions worth embedding. `fileKind` already encodes "is this text". */
function isIndexable(name: string): boolean {
  const kind = fileKind(name)
  return kind === 'code' || kind === 'doc' || kind === 'config'
}

interface Collected {
  files: string[]
  truncated: boolean
}

/** Bounded walk collecting indexable files, absolute paths, noise skipped. */
async function collectFiles(
  dir: string,
  signal: AbortSignal,
  budget: { left: number },
  out: Collected,
  level: number,
): Promise<void> {
  if (level > 12 || signal.aborted || budget.left <= 0) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (signal.aborted || budget.left <= 0) return
    if (entry.isDirectory()) {
      if (NOISE_DIRS.has(entry.name)) continue
      budget.left--
      await collectFiles(join(dir, entry.name), signal, budget, out, level + 1)
      continue
    }
    if (!entry.isFile() || !isIndexable(entry.name)) continue
    if (out.files.length >= MAX_FILES) {
      out.truncated = true
      return
    }
    out.files.push(join(dir, entry.name))
  }
}

/** Cheap per-file signature: change the size or mtime, the cache misses. */
async function fileFingerprint(path: string): Promise<string | null> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_READ_BYTES) return null
    return `${info.size}:${Math.trunc(info.mtimeMs)}`
  } catch {
    return null
  }
}

/** FNV-1a 32-bit. Not cryptographic — it only decides cache hit or miss. */
function hashString(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

interface IndexedChunk extends TextChunk {
  vector: number[]
}

interface CodeIndex {
  fingerprint: string
  model: string
  chunks: IndexedChunk[]
  truncated: boolean
}

/** In-memory index cache, keyed by absolute root. Lives for the process. */
const indexCache = new Map<string, CodeIndex>()

/**
 * Cosine similarity between two vectors.
 *
 * Exported for the same reason every other pure piece here is: the ranking
 * math is exactly what a silent bug would corrupt invisibly.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const len = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  if (na === 0 || nb === 0) return 0
  return dot / Math.sqrt(na * nb)
}

/** Build (or reuse) the embedding index for a root directory. */
async function getOrBuildIndex(
  root: string,
  model: string,
  deps: SearchToolDeps,
  signal: AbortSignal,
): Promise<CodeIndex> {
  const collected: Collected = { files: [], truncated: false }
  await collectFiles(root, signal, { left: 20_000 }, collected, 0)

  // Fingerprint over the files that would be indexed. Building it costs one
  // stat per file — embedding them again costs seconds.
  const parts: string[] = []
  for (const file of collected.files) {
    const fp = await fileFingerprint(file)
    if (fp === null) continue
    parts.push(`${relative(root, file)}@${fp}`)
  }
  const fingerprint = hashString(`${model}|${parts.join('|')}`)

  const cached = indexCache.get(root)
  if (cached && cached.fingerprint === fingerprint && cached.model === model) {
    return cached
  }

  const chunks: IndexedChunk[] = []
  for (const file of collected.files) {
    if (signal.aborted || chunks.length >= MAX_CHUNKS) break
    let content: string
    try {
      content = (await readFile(file)).toString('utf8')
    } catch {
      continue
    }
    // A NUL early in the file means binary with a text-ish extension.
    if (content.slice(0, 4096).includes('\u0000')) continue
    for (const chunk of chunkFile(relative(root, file), content)) {
      if (chunks.length >= MAX_CHUNKS) break
      chunks.push({ ...chunk, vector: [] })
    }
  }

  // Embed in batches; the cache only ever stores a fully-embedded index, so a
  // failed build is not remembered as a good one.
  for (let i = 0; i < chunks.length && !signal.aborted; i += EMBED_BATCH) {
    const batch = chunks.slice(i, i + EMBED_BATCH)
    const vectors = await deps.embed(
      model,
      batch.map((c) => c.text),
      signal,
    )
    for (let j = 0; j < batch.length; j++) {
      batch[j]!.vector = vectors[j] ?? []
    }
  }
  if (signal.aborted) throw new Error('aborted')

  const index: CodeIndex = { fingerprint, model, chunks, truncated: collected.truncated }
  indexCache.set(root, index)
  return index
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>

function str(args: Args, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v : ''
}

/** First content-bearing lines of a chunk, capped — a preview, not a dump. */
function snippetOf(chunk: TextChunk): string {
  const lines = chunk.text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(0, 3)
    .map((l) => (l.length > 120 ? `${l.slice(0, 117)}…` : l))
  return lines.length > 0 ? lines.join('\n') : '(empty)'
}

/** One line of the ranked result list. */
function resultLine(rank: number, chunk: IndexedChunk, score: number): string {
  return `${rank}. ${chunk.path}:${chunk.startLine}-${chunk.endLine}  (similarity ${score.toFixed(2)})`
}

export function createSearchTool(deps: SearchToolDeps): Tool {
  return {
    name: 'search',
    description:
      'Semantic search over the codebase: finds files whose MEANING matches the query, even ' +
      'with no shared words — a Chinese question can match English identifiers (做菜流程 ↔ ' +
      'RecipeService). Returns file:line ranges with snippets. Use it when the query is ' +
      'descriptive or when grep found nothing; for exact strings, names, or regex, grep is ' +
      'the better tool.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, phrased naturally. Required.' },
        path: { type: 'string', description: 'Directory to search. Defaults to the working directory.' },
      },
      required: ['query'],
    },
    preview: (args) => `Search ${String(args.query ?? '')}`,

    async execute(args, ctx): Promise<ToolResult> {
      const query = str(args, 'query').trim()
      if (query.length === 0) {
        return { content: 'Missing required argument "query".', isError: true }
      }
      const input = str(args, 'path') || '.'
      await guardOutside(ctx, input, 'search')
      const { absolute } = await resolveToolPath(input, ctx.cwd)

      // Find an embedding model on the live provider — a fact from
      // /api/tags + /api/show, not a hard-coded name.
      let models: ModelInfo[]
      try {
        models = await deps.listModels(ctx.signal)
      } catch (error) {
        return {
          content:
            `Semantic search needs Ollama for embeddings and could not reach it: ` +
            `${error instanceof Error ? error.message : String(error)}. ` +
            `Start it (ollama serve) and retry, or use grep for exact terms.`,
          isError: true,
        }
      }
      const embeddingModel = models.find((m) => m.embedding === true)
      if (!embeddingModel) {
        return {
          content:
            'No embedding model found on your Ollama. Semantic search needs one (bge-m3 is ' +
            'multilingual and recommended). Run `ollama pull bge-m3` and retry, or use grep ' +
            'for exact terms.',
          isError: true,
        }
      }

      let index: CodeIndex
      let queryVector: number[] | undefined
      try {
        index = await getOrBuildIndex(absolute, embeddingModel.id, deps, ctx.signal)
        const vectors = await deps.embed(embeddingModel.id, [query], ctx.signal)
        queryVector = vectors[0]
      } catch (error) {
        if (ctx.signal.aborted) return { content: 'Search aborted.' }
        return {
          content:
            `Embedding failed: ${error instanceof Error ? error.message : String(error)}. ` +
            'The index is not cached; retrying will start over.',
          isError: true,
        }
      }

      if (!queryVector || queryVector.length === 0) {
        return { content: 'The embedding model returned nothing for the query.', isError: true }
      }
      if (index.chunks.length === 0) {
        return {
          content:
            `Indexed nothing under ${input} — no readable code, doc, or config files ` +
            '(dependency and build directories are skipped). Use list to see what is there.',
          isError: true,
        }
      }

      // Results below this are noise, not matches: with a real embedding
      // model even unrelated text lands around 0.3, so the floor only drops
      // what scored essentially zero. A top-K that lists zero-similarity
      // chunks is a path wall wearing a ranking.
      const SIMILARITY_FLOOR = 0.05
      const ranked = index.chunks
        .map((chunk) => ({ chunk, score: cosineSimilarity(queryVector, chunk.vector) }))
        .filter((entry) => entry.score >= SIMILARITY_FLOOR)
        .sort((a, b) => b.score - a.score)
        .slice(0, TOP_K)

      if (ranked.length === 0) {
        return {
          content:
            `Nothing under ${input} is semantically close to "${query}". Try rewording it, ` +
            'or use grep for exact terms.',
        }
      }

      const header =
        `Semantic search for "${query}" (model ${embeddingModel.id}, ` +
        `${index.chunks.length} chunks indexed under ${input}):`

      const lines = [header]
      for (let i = 0; i < ranked.length; i++) {
        lines.push(resultLine(i + 1, ranked[i]!.chunk, ranked[i]!.score))
        lines.push(`   ${snippetOf(ranked[i]!.chunk).split('\n').join('\n   ')}`)
      }
      if (ranked.length > 0 && ranked[0]!.score < 0.3) {
        lines.push(
          'Note: even the best match scores below 0.3 — likely nothing here is semantically ' +
            'close to the query. Try rewording it, or use grep for exact terms.',
        )
      }
      if (index.truncated) {
        lines.push(
          `[WARNING] the file scan stopped at ${MAX_FILES} files, so the index is partial.`,
        )
      }
      return { content: lines.join('\n') }
    },
  }
}
