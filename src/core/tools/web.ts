/**
 * `web` — look things up on the internet.
 *
 * The gap this closes: a local model's knowledge ends at its training cutoff
 * and it knows nothing about the user's library versions, today's error
 * messages, or a doc page it has never seen. Asked for any of those, it does
 * what it always does with missing context — it invents. A search tool turns
 * "我记得 Spring Boot 3 里是这么配的" into something it can check.
 *
 * Local-first constraints shape the design: no API keys (so no paid search
 * backend), everything over plain `fetch`, results aggressively trimmed. The
 * search backend is DuckDuckGo's HTML endpoint — keyless, and its markup is
 * stable enough to parse with the patterns below; the parse functions are
 * pure and exported so a markup change shows up as a test failure with a
 * fixture, not as "web is broken" in a chat.
 *
 * Two modes, one tool, because a 5B model handles one schema better than two:
 * `query` searches and returns title/url/snippet rows; `url` fetches one page
 * and returns readable text, capped hard so a 200 KB article cannot evict the
 * conversation that asked about it.
 */

import type { Tool, ToolResult, ToolRunContext } from './types.js'

/** Injected so tests never touch the network. */
export interface WebToolDeps {
  fetch?: typeof fetch
}

const MAX_RESULTS = 6
const MAX_PAGE_CHARS = 4_000
const MAX_RAW_BYTES = 800_000
const FETCH_TIMEOUT_MS = 15_000
const SEARCH_URL = 'https://html.duckduckgo.com/html/'
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

// ---------------------------------------------------------------------------
// Parsing — pure, exported, fixture-tested
// ---------------------------------------------------------------------------

/** Decode the entities that actually appear in titles and snippets. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

/** Tags to text; block-ish tags become line breaks first. */
export function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}

/** DDG wraps outbound links in its redirect endpoint; unwrap to the real URL. */
export function unwrapDdgLink(href: string): string {
  const match = /[?&]uddg=([^&]+)/.exec(href)
  if (match) {
    try {
      return decodeURIComponent(match[1]!)
    } catch {
      // Fall through to the raw href below.
    }
  }
  if (href.startsWith('//')) return `https:${href}`
  return href
}

export interface WebResult {
  title: string
  url: string
  snippet: string
}

/**
 * Parse the DuckDuckGo HTML result page.
 *
 * Result rows pair `result__a` anchors with `result__snippet` blocks by
 * document order. If DDG changes its markup this returns [] — the tool then
 * reports "no results" rather than garbage, and the fixture test in
 * check-core is what actually sounds the alarm.
 */
export function parseDdgResults(html: string): WebResult[] {
  const links = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
  const snippets = [...html.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)]

  const results: WebResult[] = []
  for (let i = 0; i < links.length && results.length < MAX_RESULTS; i++) {
    const title = stripTags(links[i]![2]!)
    const url = unwrapDdgLink(links[i]![1]!)
    if (title.length === 0 || !/^https?:\/\//.test(url)) continue
    const rawSnippet = snippets[i]?.[1]
    results.push({
      title,
      url,
      snippet: rawSnippet ? stripTags(rawSnippet).slice(0, 240) : '',
    })
  }
  return results
}

/** Turn a fetched page into readable text, hard-capped. */
export function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const title = titleMatch ? stripTags(titleMatch[1]!).slice(0, 160) : ''
  const body = /<body[\s\S]*$/i.exec(html)?.[0] ?? html
  let text = stripTags(body)
  if (text.length > MAX_PAGE_CHARS) {
    text = `${text.slice(0, MAX_PAGE_CHARS)}\n[已截断——页面正文超过 ${MAX_PAGE_CHARS} 字符，只取了开头]`
  }
  return { title, text }
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

type Args = Record<string, unknown>

function str(args: Args, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v : ''
}

export function createWebTool(deps?: WebToolDeps): Tool {
  const doFetch = deps?.fetch ?? fetch

  async function search(query: string, ctx: ToolRunContext): Promise<ToolResult> {
    let html: string
    try {
      const response = await doFetch(`${SEARCH_URL}?q=${encodeURIComponent(query)}`, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
      })
      if (!response.ok) {
        return {
          content: `Search failed: the search endpoint returned ${response.status}. Try again, or rephrase.`,
          isError: true,
        }
      }
      html = await response.text()
    } catch (error) {
      return {
        content:
          `Could not reach the internet: ${error instanceof Error ? error.message : String(error)}. ` +
          'Answer from local files and your own knowledge instead, and say that the web lookup failed.',
        isError: true,
      }
    }

    const results = parseDdgResults(html)
    if (results.length === 0) {
      return {
        content:
          `No results for "${query}". Either nothing matches, or the search page markup ` +
          'changed. Try rewording the query; if it keeps failing, say the web search is unavailable.',
      }
    }

    const lines = [`Web results for "${query}" (top ${results.length}):`]
    for (let i = 0; i < results.length; i++) {
      const r = results[i]!
      lines.push(`\n${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`)
    }
    lines.push('\nTo read one of these pages, call web with its url.')
    return { content: lines.join('\n') }
  }

  async function fetchPage(url: string, ctx: ToolRunContext): Promise<ToolResult> {
    try {
      const response = await doFetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml' },
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
      })
      if (!response.ok) {
        return { content: `Fetching ${url} failed: HTTP ${response.status}.`, isError: true }
      }
      const contentType = response.headers.get('content-type') ?? ''
      if (contentType.length > 0 && !/text|html|xml|json/i.test(contentType)) {
        return { content: `${url} is not a readable page (content-type: ${contentType}).`, isError: true }
      }
      const raw = (await response.text()).slice(0, MAX_RAW_BYTES)
      const { title, text } = htmlToText(raw)
      if (text.length === 0) {
        return { content: `${url} returned a page with no readable text (it may need JavaScript to render).` }
      }
      return { content: [`${title ? `${title}\n` : ''}${url}`, '', text].join('\n') }
    } catch (error) {
      return {
        content:
          `Could not fetch the page: ${error instanceof Error ? error.message : String(error)}. ` +
          'If it requires JavaScript, say so instead of guessing its contents.',
        isError: true,
      }
    }
  }

  return {
    name: 'web',
    description:
      'Search the internet or read a web page. Use `query` to search (returns titles, URLs, ' +
      'and snippets) or `url` to fetch one page as readable text. Use this when the question ' +
      'needs current information, library documentation, or facts outside the local codebase ' +
      'and your training data. For anything in the local project, use grep/search instead.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search terms. Provide this OR url.' },
        url: { type: 'string', description: 'A single http(s) page to read. Provide this OR query.' },
      },
      required: [],
    },
    preview: (args) => `Web ${String(args.query ?? args.url ?? '')}`,

    async execute(args, ctx): Promise<ToolResult> {
      const query = str(args, 'query').trim()
      const url = str(args, 'url').trim()
      if ((query.length === 0) === (url.length === 0)) {
        return { content: 'Provide exactly one of "query" (search) or "url" (read a page).', isError: true }
      }
      if (url.length > 0) {
        if (!/^https?:\/\//i.test(url)) {
          return { content: `Only http(s) pages can be fetched, got: ${url}`, isError: true }
        }
        return await fetchPage(url, ctx)
      }
      return await search(query, ctx)
    },
  }
}
