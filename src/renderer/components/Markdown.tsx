/**
 * Markdown renderer.
 *
 * Hand-rolled instead of pulling in remark + react-markdown, for three reasons
 * that are specific to this app:
 *
 * 1. The author is a local 5B model, so the subset that actually appears is
 *    small — fences, lists, tables, emphasis, links, headings. A full CommonMark
 *    implementation is dead weight here.
 * 2. The hard cases are ones generic parsers treat as errors: an UNTERMINATED
 *    fence while text is still streaming, a ragged table, a lone `*` that is
 *    multiplication rather than emphasis. Each needs a defined behaviour here,
 *    not a parse failure.
 * 3. Everything renders to React elements and never to an HTML string, so there
 *    is no `dangerouslySetInnerHTML` anywhere. Injection is impossible by
 *    construction, which matters more than usual: whatever the model emits is
 *    rendered inside an app that sits in front of a Node IPC surface.
 */

import { useMemo, type ReactNode } from 'react'
import { simplifyInlineMath } from '../../shared/latex.js'

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text])
  if (blocks.length === 0) return null
  return (
    <div className="md">
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} />
      ))}
    </div>
  )
}

type Block =
  | { kind: 'code'; lang: string; text: string; open: boolean }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'rule' }
  | { kind: 'para'; text: string }

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case 'code':
      return <CodeBlock lang={block.lang} text={block.text} open={block.open} />
    case 'heading': {
      const Tag = `h${Math.min(block.level, 6)}` as 'h1'
      return <Tag className="md-heading">{renderInline(block.text)}</Tag>
    }
    case 'quote':
      return <blockquote className="md-quote">{renderInline(block.text)}</blockquote>
    case 'list':
      return block.ordered ? (
        <ol className="md-list">
          {block.items.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ol>
      ) : (
        <ul className="md-list">
          {block.items.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ul>
      )
    case 'table':
      return (
        <div className="md-table-wrap">
          <table className="md-table">
            <thead>
              <tr>
                {block.head.map((cell, i) => (
                  <th key={i}>{renderInline(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i}>
                  {block.head.map((_, j) => (
                    <td key={j}>{renderInline(row[j] ?? '')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'rule':
      return <hr className="md-rule" />
    case 'para':
      return <p className="md-para">{renderInline(block.text)}</p>
    default:
      return null
  }
}

function CodeBlock({ lang, text, open }: { lang: string; text: string; open: boolean }) {
  return (
    <div className="md-code-block">
      <div className="md-code-head">
        <span className="md-code-lang">{lang || 'text'}</span>
        <CopyButton text={text} label="复制代码" />
      </div>
      {/* A fence still streaming has no closing marker; showing one would make
          the buffer look like it ended. */}
      <pre className="md-code-body">
        <code>{text}</code>
      </pre>
      {open && <div className="md-code-pending">还在输出…</div>}
    </div>
  )
}

/**
 * Split markdown into blocks.
 *
 * Line-oriented and sequential rather than regex-over-the-whole-text: which
 * block a line belongs to depends on where the previous one ended, and trying to
 * express that in one expression is how parsers get both slow and wrong.
 */
function parseBlocks(text: string): Block[] {
  const blocks: Block[] = []
  const lines = text.split(/\r?\n/)
  let i = 0

  // Leading and trailing blank lines carry no meaning and would otherwise
  // produce empty paragraphs with real margins.
  while (i < lines.length && lines[i]!.trim().length === 0) i += 1
  let end = lines.length
  while (end > i && lines[end - 1]!.trim().length === 0) end -= 1

  while (i < end) {
    const line = lines[i]!

    const fence = /^```([\w+-]*)\s*$/.exec(line)
    if (fence) {
      const lang = fence[1] ?? ''
      const body: string[] = []
      i += 1
      let closed = false
      while (i < end) {
        if (/^```\s*$/.test(lines[i]!)) {
          closed = true
          i += 1
          break
        }
        body.push(lines[i]!)
        i += 1
      }
      blocks.push({ kind: 'code', lang, text: body.join('\n'), open: !closed })
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]!.trim() })
      i += 1
      continue
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ kind: 'rule' })
      i += 1
      continue
    }

    if (/^>\s?/.test(line)) {
      const body: string[] = []
      while (i < end && /^>\s?/.test(lines[i]!)) {
        body.push(lines[i]!.replace(/^>\s?/, ''))
        i += 1
      }
      blocks.push({ kind: 'quote', text: body.join(' ').trim() })
      continue
    }

    // A table needs the pipe row AND the dashes under it. Checking only the pipe
    // row would swallow prose that happens to contain a `|`.
    if (isTableRow(line) && i + 1 < end && /^[\s|:-]+$/.test(lines[i + 1]!) && lines[i + 1]!.includes('-')) {
      const head = splitRow(line)
      i += 2
      const rows: string[][] = []
      while (i < end && isTableRow(lines[i]!)) {
        rows.push(splitRow(lines[i]!))
        i += 1
      }
      blocks.push({ kind: 'table', head, rows })
      continue
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      const ordered = numbered !== null
      const pattern = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/
      const items: string[] = []
      while (i < end) {
        const match = pattern.exec(lines[i]!)
        if (!match) break
        items.push(match[1]!.trim())
        i += 1
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }

    const para: string[] = []
    while (i < end) {
      const current = lines[i]!
      if (current.trim().length === 0) break
      if (
        /^```/.test(current) ||
        /^#{1,6}\s/.test(current) ||
        /^>\s?/.test(current) ||
        /^\s*[-*+]\s+/.test(current) ||
        /^\s*\d+[.)]\s+/.test(current)
      ) {
        break
      }
      para.push(current)
      i += 1
    }
    // Skipping blank lines here rather than above keeps the loop simple: the
    // top-of-loop blank check would otherwise need duplicating at every branch.
    if (para.length > 0) {
      blocks.push({ kind: 'para', text: para.join('\n') })
    } else {
      i += 1
    }
    while (i < end && lines[i]!.trim().length === 0) i += 1
  }

  return blocks
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.includes('|') && trimmed.length > 1
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((cell) => cell.trim())
}

/**
 * Inline formatting: code spans, links, bold, italic.
 *
 * Scanned left to right with the FIRST-matching construct winning, which is what
 * makes `` `a *b* c` `` render the asterisk literally — the code span starts
 * earlier, so it consumes that region before the emphasis rule ever sees it.
 */
function renderInline(text: string): ReactNode[] {
  // LaTeX fallback before any other rule. `$\rightarrow$` arrives from models
  // despite the prompt ban, and no other rule here would touch it — so without
  // this line the user sees the raw dollars and backslashes. Code blocks never
  // pass through renderInline, so fenced code is untouched by construction.
  const source = simplifyInlineMath(text)
  const out: ReactNode[] = []
  let plain = ''
  let i = 0

  const flush = () => {
    if (plain.length > 0) {
      out.push(plain)
      plain = ''
    }
  }
  const key = () => `n${out.length}`

  while (i < source.length) {
    const rest = source.slice(i)

    if (source[i] === '`') {
      const closing = source.indexOf('`', i + 1)
      if (closing > i + 1) {
        flush()
        out.push(
          <code className="md-inline-code" key={key()}>
            {source.slice(i + 1, closing)}
          </code>,
        )
        i = closing + 1
        continue
      }
    }

    const link = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest)
    if (link) {
      flush()
      out.push(
        <a className="md-link" href={link[2]} target="_blank" rel="noreferrer noopener" key={key()}>
          {link[1]}
        </a>,
      )
      i += link[0].length
      continue
    }

    const bold = /^\*\*([\s\S]+?)\*\*/.exec(rest) ?? /^__([\s\S]+?)__/.exec(rest)
    if (bold) {
      flush()
      out.push(<strong key={key()}>{renderInline(bold[1]!)}</strong>)
      i += bold[0].length
      continue
    }

    // Single `*`/`_`: requires a non-space immediately after the delimiter and
    // before the closer, so `2 * 3 * 4` survives as arithmetic.
    const italic = /^\*(?=\S)([\s\S]*?\S)\*/.exec(rest) ?? /^_(?=\S)([\s\S]*?\S)_/.exec(rest)
    if (italic) {
      flush()
      out.push(<em key={key()}>{renderInline(italic[1]!)}</em>)
      i += italic[0].length
      continue
    }

    plain += source[i]
    i += 1
  }

  flush()
  return out
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  return (
    <button
      className="md-copy"
      title={label ?? '复制'}
      onClick={(event) => {
        event.stopPropagation()
        // Grab the node synchronously: inside an async continuation React may
        // have reused `currentTarget` for a different event.
        const target = event.currentTarget
        void window.harness.writeClipboard(text).then(() => flash(target))
      }}
    >
      {label ?? '复制'}
    </button>
  )
}

/** Brief visual confirmation, since a clipboard write is invisible otherwise. */
function flash(el: HTMLElement): void {
  const original = el.textContent
  el.textContent = '已复制'
  el.classList.add('is-copied')
  window.setTimeout(() => {
    el.textContent = original
    el.classList.remove('is-copied')
  }, 1200)
}
