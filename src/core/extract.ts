/**
 * Turning a file on disk into text a model can read.
 *
 * ── Why this is hand-written rather than a dependency ───────────────────────
 *
 * The two formats that matter here are PDF and DOCX, and both are normalised in
 * the direction of "simpler than they look":
 *
 * - A DOCX is a ZIP containing `word/document.xml`. Pulling the text out is
 *   `inflate` + strip tags — maybe eighty lines, no ambiguity.
 * - A PDF is more work, but the common case (text the author typed, or a Word
 *   export) stores its content in `FlateDecode` streams whose operators are a
 *   small subset: `Tj`, `TJ`, `'`, `"` for showing text, plus the font's
 *   `ToUnicode` CMap for the character mapping. That is the whole of what a
 *   text-extraction pass needs, and it costs one file rather than a transitive
 *   tree of them.
 *
 * The harness has stayed dependency-free on purpose (`globToRegExp` is
 * hand-rolled, the markdown renderer is hand-rolled). A PDF parser is the
 * largest thing anyone has asked it to read, so it gets the same treatment.
 *
 * ── What this does NOT do ───────────────────────────────────────────────────
 *
 * - No layout reconstruction. It reads in content-stream order, which for a
 *   multi-column page means the columns interleave. That is a known limitation
 *   and the output says so.
 * - No OCR. A scanned PDF has no text objects to extract; that genuinely needs
 *   a vision model, which is a different code path (`message.images`).
 * - No embedded-file extraction from ZIPs beyond `word/document.xml`.
 *
 * Every extractor reports what it found and how confident it is, because "0
 * characters extracted" and "this is a scan" need different advice.
 */

import { inflateSync, inflateRawSync } from 'node:zlib'

/** How much of a document's text is worth inlining, in characters. */
export const EXTRACT_LIMIT = 200_000

export type ExtractKind = 'text' | 'pdf' | 'docx' | 'binary'

export interface ExtractResult {
  text: string
  /** Which path produced the text — the caller words its errors from this. */
  kind: ExtractKind
  /** True when the text was cut at `EXTRACT_LIMIT`. */
  truncated: boolean
  /** Set when the file could not be read as anything textual. */
  error?: string
  /**
   * Notes the model should see alongside the text: empty extraction, scrambled
   * page order, a spreadsheet whose cell grid is not repeated. Appended to the
   * tool result rather than thrown, because partial text still helps.
   */
  notes?: string[]
}

/** Extensions this module knows how to decode into text. */
const DOCUMENT_EXTENSIONS = new Set(['pdf', 'docx', 'doc', 'odt', 'rtf'])

/**
 * Extensions that are binary but whose content is still a meaningless byte
 * soup to a text model: images, archives, media, executables. Calling these out
 * lets the error say *why* instead of the generic "binary file" shrug.
 */
const OPAQUE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'tif', 'tiff', 'svgz',
  'zip', 'gz', 'tar', 'rar', '7z', 'xz', 'bz2', 'jar', 'war',
  'mp3', 'wav', 'flac', 'ogg', 'm4a', 'mp4', 'mkv', 'avi', 'mov', 'webm',
  'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'pyc', 'wasm', 'o', 'a',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  'db', 'sqlite', 'sqlite3', 'mdb', 'dat', 'pak',
])

export function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1).split('\\').pop() ?? path
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/** True when `read`/attachment should route this file through a decoder. */
export function isDocumentPath(path: string): boolean {
  return DOCUMENT_EXTENSIONS.has(extensionOf(path))
}

/**
 * Detect binary content from the bytes themselves.
 *
 * A NUL byte is the signal everything else agrees on; Git, `file(1)`, and most
 * editors use the same heuristic. The control-character ratio catches the
 * formats that avoid NULs, which is most of the compressed ones.
 *
 * This has to run on the raw buffer, not on a decoded string: once a binary
 * buffer has been through `toString('utf8')` the NULs are indistinguishable
 * from the replacement characters of an unusual encoding.
 */
export function looksBinary(buffer: Uint8Array): boolean {
  const window = Math.min(buffer.length, 8192)
  if (window === 0) return false
  let control = 0
  for (let i = 0; i < window; i++) {
    const byte = buffer[i]!
    if (byte === 0) return true
    // Tab, LF, CR, and form feed are legitimate in text; everything else below
    // 0x20 is not.
    if (byte < 0x20 && byte !== 9 && byte !== 10 && byte !== 13 && byte !== 12) control++
  }
  return control / window > 0.05
}

/** Extract text from a file buffer, dispatching on extension then content. */
export function extractText(path: string, buffer: Uint8Array): ExtractResult {
  const ext = extensionOf(path)

  if (ext === 'pdf' || hasPdfHeader(buffer)) {
    return extractPdf(buffer)
  }
  if (ext === 'docx' || isZipContainer(buffer)) {
    return extractDocx(buffer)
  }
  if (OPAQUE_EXTENSIONS.has(ext)) {
    return { text: '', kind: 'binary', truncated: false, error: describeOpaque(ext) }
  }
  if (looksBinary(buffer)) {
    return {
      text: '',
      kind: 'binary',
      truncated: false,
      error:
        `这是一个二进制文件（${ext ? `.${ext}` : '无扩展名'}），内容不是文本。` +
        '图片需要以图片形式发给模型，压缩包和可执行文件则无法读取。',
    }
  }

  const utf8 = new TextDecoder('utf-8').decode(buffer)
  return cut(decodeTextBuffer(utf8, buffer), 'text')
}

/**
 * Decode bytes that are expected to be text, applying the same fallbacks
 * `extractText` uses: strip a UTF-8 BOM, and retry as GBK when the UTF-8 reading
 * is mostly replacement characters.
 *
 * Exported because the shell tool hits the identical problem from the other
 * side. On Windows, console tools write the OEM code page — 936 on a Chinese
 * install — not UTF-8, so `dir` comes back as mojibake. The fix is the same
 * measurement, so it should be the same function.
 */
export function decodeBytes(buffer: Uint8Array): string {
  return decodeTextBuffer(new TextDecoder('utf-8').decode(buffer), buffer)
}

/* ────────────────────────────── generic helpers ───────────────────────────── */

function cut(text: string, kind: ExtractKind): ExtractResult {
  if (text.length <= EXTRACT_LIMIT) return { text, kind, truncated: false }
  return { text: text.slice(0, EXTRACT_LIMIT), kind, truncated: true }
}

function hasPdfHeader(buffer: Uint8Array): boolean {
  // The header may sit up to 1024 bytes in; some generators emit junk first.
  const head = buffer.subarray(0, Math.min(buffer.length, 1024))
  for (let i = 0; i + 4 < head.length; i++) {
    if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46) {
      return true
    }
  }
  return false
}

function isZipContainer(buffer: Uint8Array): boolean {
  return (
    buffer.length > 4 &&
    buffer[0] === 0x50 && buffer[1] === 0x4b &&
    (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07)
  )
}

function describeOpaque(ext: string): string {
  if (/^(png|jpg|jpeg|gif|webp|bmp|ico|tif|tiff|svgz)$/.test(ext)) {
    return `这是一张图片（.${ext}），无法作为文本读取。如果要让模型看图，需要在输入框里以图片形式附加。`
  }
  if (/^(zip|gz|tar|rar|7z|xz|bz2|jar|war)$/.test(ext)) {
    return `这是一个压缩包（.${ext}），需要先解压。`
  }
  if (/^(mp3|wav|flac|ogg|m4a|mp4|mkv|avi|mov|webm)$/.test(ext)) {
    return `这是一个音视频文件（.${ext}），无法作为文本读取。`
  }
  if (/^(exe|dll|so|dylib|bin|class|pyc|wasm|o|a)$/.test(ext)) {
    return `这是一个二进制程序文件（.${ext}），无法作为文本读取。`
  }
  if (/^(db|sqlite|sqlite3|mdb)$/.test(ext)) {
    return `这是一个数据库文件（.${ext}），需要专门的查询工具而不是文本读取。`
  }
  if (/^(ttf|otf|woff2?|eot)$/.test(ext)) {
    return `这是一个字体文件（.${ext}），无法作为文本读取。`
  }
  return `这是一个二进制文件（.${ext}），无法作为文本读取。`
}

/**
 * Share of the NON-ASCII bytes that may be invalid UTF-8 before the buffer is
 * treated as some other code page.
 *
 * UTF-8 text scores ~0 (any valid sequence passes), while a GBK message scores
 * well over half: GBK spreads Chinese across two bytes in a range that overlaps
 * both the UTF-8 lead bytes and its continuation bytes, so most pairs fail. The
 * gap between the two populations is wide enough that the exact number does not
 * matter.
 */
const NON_UTF8_RATIO = 0.1

/**
 * Decode bytes as text, honouring a BOM and falling back to GBK.
 *
 * Windows Chinese tooling still writes GBK, and decoding it as UTF-8 produces a
 * wall of replacement characters that reads as "corrupt file" rather than
 * "wrong encoding". `TextDecoder('gbk')` is available in Node's full-ICU build,
 * which Electron ships.
 *
 * The decision is made on the BYTES and not on the UTF-8 reading, which used to
 * be measured for replacement characters. That measurement divided by the whole
 * buffer, so unrelated output diluted it: cmd's `子目录或文件 … 已经存在。`
 * measured 46 bad characters across ~1750 bytes of a Maven transcript, landed
 * under the 2% threshold, and reached the model as `��Ŀ¼���ļ�` — the one
 * useful line in the turn, delivered as unreadable boxes.
 *
 * `nonAsciiFailureRatio` fixes the direction of that error by counting only
 * bytes >= 0x80 in the denominator. ASCII is valid in every encoding, so it can
 * never make a GBK message look like UTF-8, whether ten ASCII bytes follow the
 * message or ten thousand.
 */
function decodeTextBuffer(utf8: string, buffer: Uint8Array): string {
  if (utf8.charCodeAt(0) === 0xfeff) return utf8.slice(1)

  // Fast path first: the overwhelming majority of buffers are valid UTF-8, and
  // the native decoder answers that in one pass without touching GBK.
  if (isValidUtf8(buffer)) return utf8

  if (nonAsciiFailureRatio(buffer) >= NON_UTF8_RATIO) {
    try {
      const decoded = new TextDecoder('gbk').decode(buffer)
      if (decoded.length > 0) return decoded
    } catch {
      // No GBK table in this build — the UTF-8 reading is all we have.
    }
  }
  return utf8
}

/** True when the bytes are a well-formed UTF-8 sequence. */
function isValidUtf8(buffer: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    return true
  } catch {
    return false
  }
}

/**
 * Fraction of the high bytes that cannot be read as UTF-8.
 *
 * Walks the buffer as UTF-8 by hand rather than decoding it, because the answer
 * needed is which BYTES failed, not what the failure rendered as. Bytes below
 * 0x80 are skipped entirely and are neither counted nor charged — the point of
 * the denominator being "non-ASCII bytes" is that a long ASCII tail cannot
 * move the score up or down.
 *
 * On failure the walk advances a single byte, so a GBK character is judged
 * twice rather than skipped wholesale. That is deliberate: it keeps the ratio
 * near 1 for real GBK text, where `子目录` happens to hide a valid pair
 * (`0xC4 0xBF` is a legal two-byte sequence) among the invalid ones.
 */
function nonAsciiFailureRatio(buffer: Uint8Array): number {
  let high = 0
  let failed = 0
  let i = 0
  while (i < buffer.length) {
    const lead = buffer[i] ?? 0
    if (lead < 0x80) {
      i++
      continue
    }
    high++
    const need =
      lead >= 0xc2 && lead <= 0xdf ? 1 : lead >= 0xe0 && lead <= 0xef ? 2 : lead >= 0xf0 && lead <= 0xf4 ? 3 : -1
    let ok = need > 0
    if (ok) {
      for (let k = 1; k <= need; k++) {
        const next = buffer[i + k]
        if (next === undefined || next < 0x80 || next > 0xbf) {
          ok = false
          break
        }
        high++
      }
    }
    if (!ok) {
      failed++
      i++
      continue
    }
    i += need + 1
  }
  return high === 0 ? 0 : failed / high
}

/* ────────────────────────────────── ZIP / DOCX ────────────────────────────── */

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  size: number
  localHeaderOffset: number
}

/**
 * Read the ZIP central directory.
 *
 * The central directory is used rather than the local headers because local
 * headers may carry zeroed sizes in streaming archives, while the directory
 * always has the real values. The End Of Central Directory record sits at the
 * tail, optionally followed by a comment whose length its own last two bytes
 * declare — hence the scan backwards over the final 64 KB (the maximum comment
 * size the format allows).
 */
function readZipEntries(buffer: Uint8Array): ZipEntry[] {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const scanFrom = Math.max(0, buffer.length - 65_557)

  let eocd = -1
  for (let i = buffer.length - 22; i >= scanFrom; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd === -1) return []

  const entryCount = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  const entries: ZipEntry[] = []

  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buffer.length) break
    if (view.getUint32(offset, true) !== 0x02014b50) break
    const method = view.getUint16(offset + 10, true)
    const compressedSize = view.getUint32(offset + 20, true)
    const size = view.getUint32(offset + 24, true)
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const localHeaderOffset = view.getUint32(offset + 42, true)
    const name = new TextDecoder('utf-8').decode(
      buffer.subarray(offset + 46, offset + 46 + nameLength),
    )
    entries.push({ name, method, compressedSize, size, localHeaderOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** Inflate one entry's bytes, or return null when it cannot be read. */
function readZipEntry(buffer: Uint8Array, entry: ZipEntry): Uint8Array | null {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const at = entry.localHeaderOffset
  if (at + 30 > buffer.length) return null
  if (view.getUint32(at, true) !== 0x04034b50) return null

  const nameLength = view.getUint16(at + 26, true)
  const extraLength = view.getUint16(at + 28, true)
  const start = at + 30 + nameLength + extraLength
  if (start > buffer.length) return null

  // A zeroed size in the local header is legal for streamed archives, in which
  // case the central directory is the only place the real length exists.
  const length = entry.compressedSize > 0 ? entry.compressedSize : buffer.length - start
  const raw = buffer.subarray(start, Math.min(start + length, buffer.length))

  if (entry.method === 0) return raw
  if (entry.method === 8) {
    try {
      return inflateRawSync(raw)
    } catch {
      return null
    }
  }
  return null // Deflate64, bzip2, LZMA — not worth supporting for docx.
}

/**
 * DOCX → text.
 *
 * Paragraph and line breaks are inserted from the XML itself rather than
 * inferred from newlines in the source, because `word/document.xml` is one long
 * line: a naive tag strip returns the whole document as a single paragraph.
 * Tabs become spaces so indentation survives without confusing the model about
 * column alignment.
 */
function extractDocx(buffer: Uint8Array): ExtractResult {
  const entries = readZipEntries(buffer)
  const document = entries.find((entry) => entry.name === 'word/document.xml')

  if (!document) {
    // A `.doc` renamed to `.docx`, or an ODT, or a corrupted file. Report the
    // likely cause rather than claiming the file is empty.
    const looksLikeLegacyDoc = entries.length === 0
    return {
      text: '',
      kind: 'docx',
      truncated: false,
      error: looksLikeLegacyDoc
        ? '这个文件不是有效的 docx（ZIP 结构无法解析）。如果它是老的 .doc 格式，请先在 Word 里另存为 .docx。'
        : '这个 docx 里没有 word/document.xml，可能不是 Word 文档。',
    }
  }

  const xmlBytes = readZipEntry(buffer, document)
  if (!xmlBytes) {
    return { text: '', kind: 'docx', truncated: false, error: 'docx 内容解压失败，文件可能已损坏。' }
  }

  const xml = new TextDecoder('utf-8').decode(xmlBytes)
  const notes: string[] = []
  const paragraphs = extractDocxParagraphs(xml)

  // Headers, footers, footnotes and tables all live in separate parts. Joining
  // them is worth doing: a form's actual content is frequently in a table, and
  // a document's page numbers live in a footer.
  const extraParts = entries.filter(
    (entry) =>
      /^word\/(header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(entry.name),
  )
  for (const part of extraParts) {
    const bytes = readZipEntry(buffer, part)
    if (!bytes) continue
    const text = extractDocxParagraphs(new TextDecoder('utf-8').decode(bytes)).join('\n').trim()
    if (text.length > 0) paragraphs.push(`【${part.name.replace('word/', '')}】\n${text}`)
  }
  if (extraParts.length > 0) notes.push('页眉页脚与脚注的内容附在正文之后。')

  const text = paragraphs.join('\n')
  if (text.trim().length === 0) {
    return {
      text: '',
      kind: 'docx',
      truncated: false,
      error: 'docx 解析成功，但里面没有文字内容（可能全是图片或嵌入对象）。',
    }
  }

  const result = cut(text, 'docx')
  return notes.length > 0 ? { ...result, notes } : result
}

function extractDocxParagraphs(xml: string): string[] {
  const paragraphs: string[] = []
  // Split on paragraph boundaries so runs inside one paragraph join into one
  // line, while `w:br` and `w:tab` become real whitespace.
  for (const chunk of xml.split(/<w:p[ >]/).slice(1)) {
    const body = chunk.split(/<\/w:p>/)[0] ?? ''
    const text = body
      .replace(/<w:tab\b[^>]*\/>/g, '\t')
      .replace(/<w:br\b[^>]*\/>/g, '\n')
      .replace(/<w:cr\b[^>]*\/>/g, '\n')
      // A cell end is a tab, so a table row reads as a tab-separated line
      // rather than every cell landing in its own paragraph.
      .replace(/<\/w:tc>/g, '\t')
      .replace(/<[^>]+>/g, '')
    const decoded = decodeXmlEntities(text).replace(/[ \t]+$/gm, '')
    if (decoded.trim().length > 0) paragraphs.push(decoded.trimEnd())
  }
  return paragraphs
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    // `&amp;` last, so `&amp;lt;` decodes to `&lt;` and not to `<`.
    .replace(/&amp;/g, '&')
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

/* ───────────────────────────────────── PDF ────────────────────────────────── */

/**
 * Diagnostic trace, off unless `HARNESS_PDF_DEBUG=1` is in the environment.
 *
 * PDF extraction fails by producing nothing rather than by throwing, so when a
 * file comes back empty the only useful question is *which stage* dropped it:
 * no objects found, no CMaps read, no streams decoded, or decoded but no text
 * drawn. This prints one line per stage so that question has an answer.
 */
const TRACE = process.env.HARNESS_PDF_DEBUG === '1'

function trace(message: string): void {
  if (TRACE) console.error(`[pdf] ${message}`)
}

/**
 * PDF → text.
 *
 * Structure: the file is a sequence of indirect objects; page content lives in
 * streams that are usually Flate-compressed; the glyph codes inside a content
 * stream are mapped back to characters by the *current font's* `ToUnicode`
 * CMap. Getting the font switch right is what separates real text from
 * meaningless byte offsets, so operators are walked in order and the active
 * font is tracked as `Tf` appears.
 *
 * Known limitation: no layout analysis. Text is emitted in content-stream
 * order, so on a two-column page the columns interleave.
 */
function extractPdf(buffer: Uint8Array): ExtractResult {
  const latin = new TextDecoder('latin1').decode(buffer)

  const objects = findObjectStarts(latin, buffer)
  if (objects.size === 0) {
    return { text: '', kind: 'pdf', truncated: false, error: '这个文件不像有效的 PDF（找不到任何对象）。' }
  }

  const cmaps = readCMaps(latin, objects)
  const pages = collectPages(latin, objects)
  trace(`objects=${objects.size} cmaps=${cmaps.size} pages=${pages.length}`)
  const notes: string[] = []
  const chunks: string[] = []

  for (const page of pages) {
    if (page.decoded === null) continue
    const fonts = resolvePageFonts(latin, objects, cmaps, page)
    const text = extractPageText(page.decoded, fonts)
    trace(`page obj=${page.number} fonts=${fonts.byName.size} chars=${text.length}`)
    if (text.trim().length > 0) chunks.push(text)
  }

  const text = chunks.join('\n\n')
  if (text.trim().length === 0) {
    return {
      text: '',
      kind: 'pdf',
      truncated: false,
      error:
        '这个 PDF 没有可提取的文本层——它多半是扫描件或图片导出的。' +
        '看清内容需要把页面转成图片交给能看图的模型，而不是读取文本。',
    }
  }

  if (pages.some((page) => page.decoded === null)) {
    notes.push('部分页面解码失败，输出可能不完整。')
  }
  notes.push('PDF 只按内容顺序提取，双栏或表格排版可能与原样不同。')

  const result = cut(text, 'pdf')
  return { ...result, notes }
}

interface PdfObject {
  number: number
  /** Offset of the object body (just after the `obj` keyword). */
  bodyStart: number
  /** Offset just past `endobj`. */
  end: number
  /** The object's source text. ASCII-safe; binary payloads must not be read from it. */
  source: string
  /**
   * The whole file's bytes.
   *
   * Kept here because stream payloads have to be sliced as bytes: the latin1
   * decode that makes the structure readable is windows-1252, which silently
   * rewrites every byte in 0x80–0x9F. See the note on `decodeStream`.
   */
  file: Uint8Array
}

interface PdfPage {
  /** Object number of the content stream. */
  number: number
  /** Decoded content stream, or null when it could not be inflated. */
  decoded: Uint8Array | null
  /** The page dict that owns this content stream, if one was found. */
  pageDict: string | null
  /** Resource dict text for this page, inherited from its parent if needed. */
  resources: string | null
}

/**
 * Locate indirect objects by scanning for `N M obj`.
 *
 * A full xref rebuild means following `/Prev` chains and object streams; a scan
 * finds the same objects with no risk of being misled by a stale xref table,
 * which is common in files that have been edited in place. The only thing the
 * scan misses is objects that exist *solely* inside an object stream — rare for
 * the dictionaries we care about, and the failure is degraded output rather
 * than a crash.
 */
function findObjectStarts(latin: string, file: Uint8Array): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>()
  const pattern = /(?:^|[\s>])(\d{1,10})\s+(\d{1,5})\s+obj\b/g
  let match: RegExpExecArray | null

  while ((match = pattern.exec(latin)) !== null) {
    const number = Number.parseInt(match[1]!, 10)
    const bodyStart = match.index + match[0].length
    const endKeyword = latin.indexOf('endobj', bodyStart)
    const end = endKeyword === -1 ? latin.length : endKeyword
    // Later definitions win: an incremental update that replaced an object
    // appends the new version, and the newest is the live one.
    objects.set(number, {
      number,
      bodyStart,
      end,
      source: latin.slice(bodyStart, end),
      file,
    })
  }
  return objects
}

/**
 * Extract the `<< … >>` dictionary that starts at `from`, honouring nesting and
 * string literals so a `>>` inside a string does not end it early.
 *
 * `from` of -1 means "not found" at the call sites, and is rejected here rather
 * than clamped: `source.indexOf('<<', -1)` searches from the beginning and
 * would return the FIRST dictionary in the object, silently substituting the
 * wrong one for a key that was absent.
 */
function readDictionary(source: string, from: number): { dict: string; end: number } | null {
  if (from < 0) return null
  const open = source.indexOf('<<', from)
  if (open === -1) return null
  let depth = 0
  let i = open
  while (i < source.length) {
    const ch = source[i]!
    if (ch === '\\' && i + 1 < source.length) {
      i += 2
      continue
    }
    if (ch === '(') {
      // A literal string: skip to its unescaped closing paren.
      let parens = 1
      i++
      while (i < source.length && parens > 0) {
        if (source[i] === '\\') i += 2
        else {
          if (source[i] === '(') parens++
          if (source[i] === ')') parens--
          i++
        }
      }
      continue
    }
    if (ch === '<' && source[i + 1] === '<') {
      depth++
      i += 2
      continue
    }
    if (ch === '>' && source[i + 1] === '>') {
      depth--
      i += 2
      if (depth === 0) return { dict: source.slice(open, i), end: i }
      continue
    }
    i++
  }
  return null
}

/**
 * Decode an object's stream payload.
 *
 * Only `FlateDecode` (possibly with a PNG/TIFF predictor prefix) is handled.
 * Anything else — DCTDecode is a JPEG, JPXDecode a JPEG2000 — is image data,
 * not text, and returning it would only produce garbage.
 */
/**
 * Decode one object's stream payload.
 *
 * Only `FlateDecode` (possibly with a PNG/TIFF predictor prefix) is handled.
 * Anything else — DCTDecode is a JPEG, JPXDecode a JPEG2000 — is image data,
 * not text, and returning it would only produce garbage.
 *
 * ── Why the bytes come from the original buffer ─────────────────────────────
 *
 * The stream data is sliced out of `bytes`, NOT out of the latin1-decoded
 * `latin` string. `TextDecoder('latin1')` is an alias for **windows-1252** in
 * the WHATWG encoding spec, not ISO-8859-1: bytes 0x80–0x9F decode to different
 * code points (0x9C becomes U+0153, 0x80 becomes U+2039), and re-encoding that
 * with `Buffer.from(text, 'latin1')` truncates each one to its low byte. A zlib
 * header of `78 9c` comes back as `78 53`, which inflates to nothing but
 * "incorrect header check".
 *
 * Structural parsing (finding `stream`, `endstream`, dictionaries) is safe in
 * string space because all of it is ASCII by construction — only the payload is
 * binary, so only the payload needs byte-exact handling.
 */
function decodeStream(latin: string, obj: PdfObject): Uint8Array | null {
  const fail = (why: string): null => {
    trace(`decodeStream obj=${obj.number} failed: ${why}`)
    return null
  }

  const streamKeyword = latin.indexOf('stream', obj.bodyStart)
  if (streamKeyword === -1 || streamKeyword > obj.end) {
    return fail(`no stream keyword (kw=${streamKeyword} end=${obj.end})`)
  }

  const header = latin.slice(obj.bodyStart, streamKeyword)
  if (!header.includes('<<')) return fail('header has no <<')

  const dict = readDictionary(header, 0)?.dict ?? header
  if (!/\/FlateDecode\b/.test(dict)) return fail(`not FlateDecode: ${JSON.stringify(dict.slice(0, 80))}`)

  // The spec allows CRLF or LF after `stream`; CR alone is out of spec but
  // exists in the wild.
  let start = streamKeyword + 'stream'.length
  if (latin[start] === '\r') start++
  if (latin[start] === '\n') start++

  // Search within the object (which runs to `endobj`, and always contains
  // `endstream` before it) rather than across the whole file: taking the last
  // match globally would pair this object's data with the *final* stream in the
  // document, and a file with one corrupt tail stream would then break every
  // stream before it.
  const endKeyword = latin.indexOf('endstream', start)
  if (endKeyword === -1 || endKeyword > obj.end || endKeyword <= start) {
    return fail(`endstream boundary (ek=${endKeyword} end=${obj.end} start=${start})`)
  }

  const raw = Buffer.from(obj.file.subarray(start, endKeyword))
  let inflated: Buffer
  try {
    inflated = inflateSync(raw)
  } catch {
    // Two recoveries for streams whose declared length disagrees with reality:
    // one trailing byte too many is the common off-by-one, and an `/Length`
    // that is right but a producer that padded the tail.
    try {
      inflated = inflateSync(raw.subarray(0, Math.max(0, raw.length - 1)))
    } catch (error) {
      return fail(`inflate: ${(error as Error).message} (len=${raw.length} head=${raw.subarray(0, 4).toString('hex')})`)
    }
  }

  const predictor = readPredictor(dict)
  return predictor ? undoPredictor(inflated, predictor) : inflated
}

interface Predictor {
  predictor: number
  colors: number
  bitsPerComponent: number
  columns: number
}

function readPredictor(dict: string): Predictor | null {
  const filter = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict)?.[1] ?? ''
  if (!/Predictor|FlateDecode.*DecodeParms|\/DecodeParms/.test(dict)) return null
  if (!/Predictor/.test(dict) && !filter.includes('[')) return null

  const number = (key: string, fallback: number): number => {
    const found = new RegExp(`/${key}\\s+(\\d+)`).exec(dict)
    return found ? Number.parseInt(found[1]!, 10) : fallback
  }
  const predictor = number('Predictor', 1)
  if (predictor < 2) return null
  return {
    predictor,
    colors: number('Colors', 1),
    bitsPerComponent: number('BitsPerComponent', 8),
    columns: number('Columns', 1),
  }
}

/**
 * Reverse the PNG/TIFF predictor that xref and content streams may be encoded
 * with. Without this the stream is usable but every byte after the first is an
 * off-by-one neighbour of the real value — which shows up as text that is
 * subtly, consistently wrong rather than obviously broken.
 */
function undoPredictor(data: Buffer, params: Predictor): Uint8Array {
  const bpp = Math.max(1, Math.ceil((params.colors * params.bitsPerComponent) / 8))
  const rowLength = Math.ceil((params.colors * params.bitsPerComponent * params.columns) / 8)

  // TIFF predictor 2: the deltas are within each row, no per-row tag byte.
  if (params.predictor === 2) {
    for (let row = 0; row + rowLength <= data.length; row += rowLength) {
      for (let i = bpp; i < rowLength; i++) {
        data[row + i] = (data[row + i]! + data[row + i - bpp]!) & 0xff
      }
    }
    return data
  }

  // PNG predictors: one tag byte per row, then the filtered bytes.
  const out = Buffer.alloc(data.length)
  let previous = Buffer.alloc(rowLength)
  let read = 0
  let write = 0
  while (read + 1 <= data.length - 1) {
    const tag = data[read]!
    read++
    const row = Buffer.alloc(rowLength)
    const available = Math.min(rowLength, data.length - read)
    data.copy(row, 0, read, read + available)
    read += available

    for (let i = 0; i < rowLength; i++) {
      const raw = row[i]!
      const left = i >= bpp ? row[i - bpp]! : 0
      const up = previous[i]!
      const upLeft = i >= bpp ? previous[i - bpp]! : 0
      let value: number
      switch (tag) {
        case 0: value = raw; break
        case 1: value = raw + left; break
        case 2: value = raw + up; break
        case 3: value = raw + ((left + up) >> 1); break
        case 4: {
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)
          break
        }
        default: value = raw
      }
      row[i] = value & 0xff
    }
    row.copy(out, write)
    write += rowLength
    previous = row
  }
  return out.subarray(0, write)
}

/**
 * Collect page content streams in document order.
 *
 * Order comes from the page tree when it is readable (`/Kids` order is the
 * reading order) and falls back to object-number order otherwise. Object-number
 * order is usually right because writers emit pages in sequence, but it is a
 * fallback rather than the rule.
 *
 * The page dictionary travels with each stream because fonts are named per
 * page: `/F1` on page 3 has nothing to do with `/F1` on page 4, and a shared
 * lookup built from "every font in the file" silently mis-maps text on any
 * document that uses two subsets of the same typeface.
 */
function collectPages(latin: string, objects: Map<number, PdfObject>): PdfPage[] {
  const pages: PdfPage[] = []
  const seenContent = new Set<number>()

  /** Follow `N 0 R` to the referenced object's dictionary text. */
  const deref = (ref: string): string | null => {
    const parsed = /^(\d+)\s+\d+\s+R$/.exec(ref.trim())
    if (!parsed) return null
    const target = objects.get(Number.parseInt(parsed[1]!, 10))
    return target ? readDictionary(target.source, 0)?.dict ?? target.source : null
  }

  /** Resolve a `/Contents` entry into a page record. */
  const emit = (contentNumber: number, pageDict: string | null, resources: string | null): void => {
    if (seenContent.has(contentNumber)) return
    seenContent.add(contentNumber)
    const obj = objects.get(contentNumber)
    if (!obj) return
    const streamKeyword = latin.indexOf('stream', obj.bodyStart)
    if (streamKeyword === -1 || streamKeyword > obj.end) return
    pages.push({
      number: contentNumber,
      decoded: decodeStream(latin, obj),
      pageDict,
      resources,
    })
  }

  /** Read `/Contents` out of a page dict, which may be one ref or an array. */
  const readContents = (dict: string, resources: string | null): void => {
    const single = /\/Contents\s+(\d+)\s+\d+\s+R/.exec(dict)
    if (single) {
      emit(Number.parseInt(single[1]!, 10), dict, resources)
      return
    }
    const array = /\/Contents\s*\[([^\]]*)\]/.exec(dict)?.[1]
    if (!array) return
    for (const ref of array.matchAll(/(\d+)\s+\d+\s+R/g)) {
      emit(Number.parseInt(ref[1]!, 10), dict, resources)
    }
  }

  /**
   * Resolve a page's `/Resources`, which is very often an indirect reference
   * (`/Resources 19 0 R`) rather than an inline dict. Chasing it is not
   * optional: that reference is where the font list lives, and without it every
   * page falls back to raw glyph codes.
   */
  const readResources = (dict: string, inherited: string | null): string | null => {
    const inline = /\/Resources\s*<</.test(dict)
    if (inline) return readDictionary(dict, dict.indexOf('/Resources'))?.dict ?? inherited
    const ref = /\/Resources\s+(\d+\s+\d+\s+R)/.exec(dict)?.[1]
    if (ref) return deref(ref) ?? inherited
    return inherited
  }

  /** Walk the tree carrying the nearest /Resources down, since pages inherit it. */
  const walk = (objectNumber: number, inherited: string | null, depth: number, visited: Set<number>): void => {
    if (depth > 32 || visited.has(objectNumber)) return
    visited.add(objectNumber)
    const node = objects.get(objectNumber)
    if (!node) return
    const dict = readDictionary(node.source, 0)?.dict ?? node.source
    const resources = readResources(dict, inherited)

    const kids = /\/Kids\s*\[([^\]]*)\]/.exec(dict)?.[1]
    if (kids) {
      for (const ref of kids.matchAll(/(\d+)\s+\d+\s+R/g)) {
        walk(Number.parseInt(ref[1]!, 10), resources, depth + 1, visited)
      }
      return
    }
    readContents(dict, resources)
  }

  // Prefer the page tree: walk /Root → /Pages → /Kids recursively.
  const rootRef = /\/Root\s+(\d+)\s+\d+\s+R/.exec(latin)
  const root = rootRef ? objects.get(Number.parseInt(rootRef[1]!, 10)) : undefined
  const pagesRef = root ? /\/Pages\s+(\d+)\s+\d+\s+R/.exec(root.source) : null

  if (pagesRef) walk(Number.parseInt(pagesRef[1]!, 10), null, 0, new Set<number>())

  // The tree may be missing or unreadable: fall back to every object that has a
  // /Contents entry, in object order.
  if (pages.length === 0) {
    for (const [, obj] of objects) {
      const dict = readDictionary(obj.source, 0)?.dict ?? obj.source.slice(0, 4000)
      if (!/\/Contents\b/.test(dict)) continue
      readContents(dict, readResources(dict, null))
    }
  }

  return pages
}

/**
 * Build `font object number → glyph code → character` from every font's
 * `ToUnicode` CMap.
 *
 * Without this, the text operators yield glyph indices, not characters — which
 * for an embedded subset font is a byte that means nothing outside it. The
 * result is keyed by font object, so the same map serves every page that names
 * that font.
 */
function readCMaps(latin: string, objects: Map<number, PdfObject>): Map<number, Map<number, string>> {
  const maps = new Map<number, Map<number, string>>()

  for (const [number, obj] of objects) {
    if (!/\/Type\s*\/Font/.test(obj.source)) continue
    const ref = /\/ToUnicode\s+(\d+)\s+\d+\s+R/.exec(obj.source)
    if (!ref) continue
    const targetNumber = Number.parseInt(ref[1]!, 10)
    const cmapObject = objects.get(targetNumber)
    if (!cmapObject) {
      trace(`font obj=${number} ToUnicode=${targetNumber} -> object missing`)
      continue
    }
    const bytes = decodeStream(latin, cmapObject)
    if (!bytes) continue
    const map = parseToUnicode(new TextDecoder('latin1').decode(bytes))
    trace(`font obj=${number} ToUnicode=${targetNumber} -> ${map.size} entries`)
    if (map.size > 0) maps.set(number, map)
  }
  return maps
}

/**
 * Turn one page's `/Resources /Font` dictionary into `name → CMap`.
 *
 * The mapping is by *name* (`/F1`) because that is what `Tf` operators carry.
 * Every level here is usually an indirect reference — the page points at a
 * resources object, which points at a font dict, which points at the font —
 * so each hop is dereferenced explicitly. A page with no resolvable fonts still
 * gets an empty map, which the text walker treats as "decode as ASCII" rather
 * than failing the whole file.
 */
function resolvePageFonts(
  latin: string,
  objects: Map<number, PdfObject>,
  cmaps: Map<number, Map<number, string>>,
  page: PdfPage,
): PageFonts {
  const byName = new Map<string, Map<number, string>>()

  /** Follow `N 0 R` and return the target's dictionary text. */
  const deref = (objectNumber: number): string | null => {
    const target = objects.get(objectNumber)
    return target ? readDictionary(target.source, 0)?.dict ?? target.source : null
  }

  /** Collect `/Name N 0 R` entries from a font dictionary. */
  const absorb = (fontDict: string): void => {
    for (const entry of fontDict.matchAll(/\/([A-Za-z0-9+._-]+)\s+(\d+)\s+\d+\s+R/g)) {
      const cmap = cmaps.get(Number.parseInt(entry[2]!, 10))
      if (cmap) byName.set(entry[1]!, cmap)
    }
  }

  const seen = new Set<number>()

  /** True when `/Font` is followed by a dictionary, not by an object reference. */
  const hasInlineFontDict = (resources: string): boolean => {
    const at = resources.indexOf('/Font')
    if (at === -1) return false
    const after = resources.slice(at + '/Font'.length).trimStart()
    return after.startsWith('<<')
  }

  for (const resources of [page.resources, page.pageDict]) {
    if (!resources) continue

    // `/Font << /F1 16 0 R >>` — the entries are in this very dictionary.
    if (hasInlineFontDict(resources)) {
      const inlineFonts = extractSubDictionary(resources, 'Font')
      if (inlineFonts) absorb(inlineFonts)
      continue
    }

    // `/Font 17 0 R` — the entries live in another object, which itself maps
    // names to font objects. Following this hop is mandatory: without it the
    // names never resolve and every page falls back to whatever CMap happens to
    // be first in the file.
    const fontRef = /\/Font\s+(\d+)\s+\d+\s+R/.exec(resources)
    if (!fontRef) continue
    const number = Number.parseInt(fontRef[1]!, 10)
    if (seen.has(number)) continue
    seen.add(number)
    const fontDict = deref(number)
    if (fontDict) absorb(fontDict)
  }

  // Nothing usable: fall back to any single CMap in the file. Wrong for a
  // multi-font page, but far better than raw glyph indices, and the alternative
  // is emitting nothing at all.
  if (byName.size === 0 && cmaps.size > 0) {
    const [first] = cmaps.values()
    if (first) byName.set('', first)
  }

  trace(
    `fonts for page obj=${page.number}: ${[...byName.entries()]
      .map(([name, map]) => `${name || '(fallback)'}→${map.size}`)
      .join(', ')}`,
  )

  return { byName }
}

/**
 * Pull one nested `<< … >>` out of a dictionary by key.
 *
 * A flat regex cannot do this: `/Resources << /Font << … >> /XObject << … >> >>`
 * has three levels, and matching to the first `>>` stops inside `/Font`.
 */
function extractSubDictionary(dict: string, key: string): string | null {
  const at = dict.indexOf(`/${key}`)
  if (at === -1) return null
  // A reference form (`/Font 12 0 R`) has nothing to extract here.
  if (/^\s+\d+\s+\d+\s+R/.test(dict.slice(at + key.length + 1))) return null
  return readDictionary(dict, at)?.dict ?? null
}

/**
 * Parse a CMap into code → text.
 *
 * Two forms appear in practice: `beginbfchar` pairs one code with one string,
 * and `beginbfrange` spans a run. Ranges whose target is an array of strings
 * (`[<0041> <0042>]`) are handled separately because their entries are not
 * consecutive code points.
 */
function parseToUnicode(cmap: string): Map<number, string> {
  const map = new Map<number, string>()

  const hexToNumber = (hex: string): number => Number.parseInt(hex, 16)

  const codeBytesToHex = (hex: string): string => hex.replace(/\s+/g, '')

  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of (block[1] ?? '').matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const code = hexToNumber(codeBytesToHex(pair[1]!))
      map.set(code, hexToUtf16(pair[2]!))
    }
  }

  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1] ?? ''
    // Array form first: `<lo> <hi> [<a> <b> …]`. The single-target form below
    // would otherwise match the first two entries of the array and mis-assign.
    const withArray = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([^\]]*)\]/g
    for (const range of body.matchAll(withArray)) {
      const lo = hexToNumber(range[1]!)
      const hi = hexToNumber(range[2]!)
      const targets = [...(range[3] ?? '').matchAll(/<([0-9a-fA-F]+)>/g)].map((m) => m[1]!)
      for (let i = 0; lo + i <= hi && i < targets.length; i++) {
        map.set(lo + i, hexToUtf16(targets[i]!))
      }
    }
    const single = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g
    for (const range of body.matchAll(single)) {
      const lo = hexToNumber(range[1]!)
      const hi = hexToNumber(range[2]!)
      const destination = hexToNumber(range[3]!)
      for (let code = lo; code <= hi && code - lo < 65_536; code++) {
        map.set(code, String.fromCodePoint(destination + (code - lo)))
      }
    }
  }

  return map
}

/** A CMap target is UTF-16BE hex, so surrogate pairs come through correctly. */
function hexToUtf16(hex: string): string {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '')
  if (clean.length === 0) return ''
  if (clean.length <= 4) return String.fromCodePoint(Number.parseInt(clean, 16))
  let out = ''
  for (let i = 0; i + 4 <= clean.length; i += 4) {
    const unit = Number.parseInt(clean.slice(i, i + 4), 16)
    // A lone surrogate is not a character; skip it rather than emit a broken one.
    if (unit >= 0xd800 && unit <= 0xdfff && i + 8 > clean.length) continue
    out += String.fromCharCode(unit)
  }
  return out
}

/* ──────────────────────────── PDF content streams ─────────────────────────── */

/** How far apart two text baselines must be before they count as separate lines. */
const LINE_BREAK_THRESHOLD = 1.5

/**
 * Walk a page's content stream and emit its text.
 *
 * The operators that matter: `Tf` selects the font (and therefore the CMap),
 * `Td`/`TD`/`Tm`/`T*` move the cursor, and `Tj`/`'`/`"`/`TJ` draw text. Line
 * breaks are taken from vertical cursor movement rather than from the operators,
 * because a `Td` of a fraction of a line is letter spacing, not a new line, and
 * treating every `Td` as a break produces one word per line.
 *
 * Nothing here is stateful across calls — every cursor, font and operand lives
 * in a local, so extracting ten pages cannot leak state from one into the next.
 */
function extractPageText(data: Uint8Array, fonts: PageFonts): string {
  const content = new TextDecoder('latin1').decode(data)
  const lines: string[] = []

  let line = ''
  let font: Map<number, string> | undefined
  let fontSize = 1
  let leading = 0
  /** Where the cursor will be for the next show-text operator. */
  let cursorY = 0
  /** Where the last text was actually drawn. */
  let lastY: number | null = null
  const operands: number[] = []
  let lastName: string | null = null

  const flushLine = (): void => {
    if (line.trim().length > 0) lines.push(line.trimEnd())
    line = ''
  }

  let i = 0
  while (i < content.length) {
    while (i < content.length && /\s/.test(content[i]!)) i++
    if (i >= content.length) break

    const ch = content[i]!

    if (ch === '(') {
      const { value, next } = readLiteralString(content, i)
      i = next
      line += applyFont(value, font)
      continue
    }

    if (ch === '<' && content[i + 1] !== '<') {
      const close = content.indexOf('>', i)
      if (close === -1) break
      const hex = content.slice(i + 1, close)
      i = close + 1
      line += applyFont(hexStringToBytes(hex), font)
      continue
    }

    // A `<<` inside a content stream means an inline image's dictionary; its
    // data is binary and must be skipped, not fed to the text extractor.
    if (ch === '<' && content[i + 1] === '<') {
      const dict = readDictionary(content, i)
      i = dict ? dict.end : i + 2
      const dataStart = content.indexOf('ID', i)
      const dataEnd = dataStart === -1 ? -1 : content.indexOf('EI', dataStart)
      if (dataStart !== -1 && dataEnd !== -1) i = dataEnd + 2
      continue
    }

    if (ch === '[') {
      const close = findArrayEnd(content, i)
      const body = content.slice(i + 1, close === -1 ? content.length : close)
      i = close === -1 ? content.length : close + 1
      line += readTextArray(body, font, fontSize)
      continue
    }

    // A name token (`/F1`). It must be matched as a unit: the operand regex
    // below excludes `/`, so `/F1` would otherwise arrive as a bare `F1` and
    // the `Tf` operator would find no font to select.
    if (ch === '/') {
      const name = /^\/([^\s<>\[\]()/{}]*)/.exec(content.slice(i))
      if (name) {
        lastName = name[1] ?? ''
        i += name[0].length
        continue
      }
      i++
      continue
    }

    const tokenMatch = /^[^\s<>\[\]()/{}]+/.exec(content.slice(i))
    if (!tokenMatch) {
      i++
      continue
    }
    const token = tokenMatch[0]
    i += token.length

    // A bare number is an operand. Anything else that is not a known operator
    // is ignored, which is deliberate: content streams contain painting
    // operators (`q`, `re`, `cm`) that carry no text.
    if (/^[-+.\d]+$/.test(token)) {
      operands.push(Number.parseFloat(token))
      if (operands.length > 8) operands.shift()
      continue
    }

    switch (token) {
      case 'Tf': {
        const size = operands[operands.length - 2]
        if (typeof size === 'number' && Number.isFinite(size) && size > 0) fontSize = size
        if (lastName !== null) font = fonts.byName.get(lastName)
        break
      }
      case 'Td':
      case 'TD': {
        const dy = operands[operands.length - 1]
        if (typeof dy === 'number') {
          if (token === 'TD') leading = -dy
          cursorY += dy
        }
        break
      }
      case 'Tm': {
        const e = operands[operands.length - 1]
        if (typeof e === 'number') cursorY = e
        break
      }
      case 'T*': {
        cursorY -= leading
        break
      }
      case 'Tj':
      case 'TJ':
      case "'":
      case '"': {
        // `'` and `"` move to the next line *before* drawing, per the spec.
        if (token === "'" || token === '"') cursorY -= leading
        if (lastY !== null && Math.abs(cursorY - lastY) > fontSize * LINE_BREAK_THRESHOLD) {
          flushLine()
        }
        lastY = cursorY
        break
      }
      default:
        break
    }
  }

  flushLine()
  return lines.join('\n')
}

/** CMap lookups for one page, keyed by the resource name `Tf` operators use. */
interface PageFonts {
  byName: Map<string, Map<number, string>>
}

/** Read a `(…)` literal string, following escapes and nesting. */
function readLiteralString(content: string, start: number): { value: number[]; next: number } {
  const bytes: number[] = []
  let depth = 1
  let i = start + 1
  while (i < content.length && depth > 0) {
    const ch = content[i]!
    if (ch === '\\') {
      const next = content[i + 1]
      i += 2
      switch (next) {
        case 'n': bytes.push(10); break
        case 'r': bytes.push(13); break
        case 't': bytes.push(9); break
        case 'b': bytes.push(8); break
        case 'f': bytes.push(12); break
        case '(': bytes.push(40); break
        case ')': bytes.push(41); break
        case '\\': bytes.push(92); break
        default:
          if (next !== undefined && next >= '0' && next <= '7') {
            // Octal escape, one to three digits.
            let octal = next
            while (octal.length < 3 && i < content.length && content[i]! >= '0' && content[i]! <= '7') {
              octal += content[i]
              i++
            }
            bytes.push(Number.parseInt(octal, 8) & 0xff)
          } else if (next !== undefined) {
            bytes.push(next.charCodeAt(0) & 0xff)
          }
      }
      continue
    }
    if (ch === '(') depth++
    if (ch === ')') {
      depth--
      if (depth === 0) {
        i++
        break
      }
    }
    bytes.push(ch.charCodeAt(0) & 0xff)
    i++
  }
  return { value: bytes, next: i }
}

function findArrayEnd(content: string, start: number): number {
  let depth = 0
  for (let i = start; i < content.length; i++) {
    const ch = content[i]!
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '(') {
      let parens = 1
      i++
      while (i < content.length && parens > 0) {
        if (content[i] === '\\') i++
        else {
          if (content[i] === '(') parens++
          if (content[i] === ')') parens--
        }
        i++
      }
      i--
      continue
    }
    if (ch === '[') depth++
    if (ch === ']') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * Read a `TJ` array: string elements are text, numbers are kerning adjustments.
 *
 * A large negative adjustment is a missing glyph — the classic case is a
 * ligature the font lacks. Emitting a space for it keeps words from fusing.
 */
function readTextArray(
  body: string,
  font: Map<number, string> | undefined,
  fontSize: number,
): { text: string; gapBreaks: boolean } {
  let text = ''
  let gapBreaks = false
  let i = 0
  while (i < body.length) {
    const ch = body[i]!
    if (ch === '(') {
      const { value, next } = readLiteralString(body, i)
      i = next
      text += applyFont(value, font)
      continue
    }
    if (ch === '<') {
      const close = body.indexOf('>', i)
      if (close === -1) break
      const hex = body.slice(i + 1, close).replace(/[^0-9a-fA-F]/g, '')
      i = close + 1
      text += applyFont(hexStringToBytes(hex), font)
      continue
    }
    const number = /^[-+]?\d*\.?\d+/.exec(body.slice(i))
    if (number) {
      const adjustment = Number.parseFloat(number[0])
      // Scaled by font size in the spec; a tenth of the em is a reliable hint
      // that the writer intended a gap rather than letter-level kerning.
      if (adjustment < -fontSize * 0.3) text += ' '
      i += number[0].length
      continue
    }
    i++
  }
  return { text, gapBreaks }
}

function hexStringToBytes(hex: string): number[] {
  const bytes: number[] = []
  for (let i = 0; i + 2 <= hex.length; i += 2) bytes.push(Number.parseInt(hex.slice(i, i + 2), 16))
  return bytes
}

/**
 * Map a run of glyph bytes through the active CMap.
 *
 * Multi-byte codes are tried longest-first (2 bytes, then 1) because a CMap
 * with any code above 0xff is a two-byte CMap, and guessing wrong turns one
 * character into two.
 */
function applyFont(bytes: number[], font: Map<number, string> | undefined): string {
  if (bytes.length === 0) return ''
  if (!font) {
    // No ToUnicode map: the bytes are the best guess available. ASCII passes
    // through legibly; anything else does not, which is why the caller mentions
    // that extraction was partial.
    return bytes.map((byte) => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '')).join('')
  }

  const usesTwoBytes = [...font.keys()].some((code) => code > 0xff)
  let out = ''
  if (usesTwoBytes) {
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      const code = (bytes[i]! << 8) | bytes[i + 1]!
      out += font.get(code) ?? font.get(bytes[i]!) ?? ''
    }
    if (bytes.length % 2 === 1) {
      out += font.get(bytes[bytes.length - 1]!) ?? ''
    }
    return out
  }

  for (const byte of bytes) out += font.get(byte) ?? ''
  return out
}
