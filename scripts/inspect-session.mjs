/**
 * Dump a session log in a readable shape.
 *
 * This exists because "the model stopped / refused / did nothing" is never
 * diagnosable from the UI, and the session log always contains the answer. The
 * distinction that matters most is between three very different diseases that
 * all look identical on screen:
 *
 *   - the model never asked for a tool        → prompt/capability problem
 *   - the model asked and the tool failed     → tool problem
 *   - the model asked, the tool worked, and
 *     the model then ignored the result       → loop/prompt problem
 *
 * Usage:
 *   node scripts/inspect-session.mjs                 # newest session, full dump
 *   node scripts/inspect-session.mjs --list          # list sessions
 *   node scripts/inspect-session.mjs --last 3        # dump the last 3 turns
 *   node scripts/inspect-session.mjs <sessionId>     # a specific session
 *   node scripts/inspect-session.mjs --turns         # one line per turn
 *
 * Reads from the same userData directory the app uses, so it sees exactly the
 * files the app wrote. macOS/Linux paths are derived from APPDATA/HOME the same
 * way Electron does.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const CANDIDATE_ROOTS = [
  process.env.APPDATA ? join(process.env.APPDATA, 'ollama harness', 'sessions') : null,
  process.env.APPDATA ? join(process.env.APPDATA, 'Ollama Harness', 'sessions') : null,
  process.env.APPDATA ? join(process.env.APPDATA, 'ollama-harness', 'sessions') : null,
  join(homedir(), 'Library', 'Application Support', 'Ollama Harness', 'sessions'),
  join(homedir(), '.config', 'Ollama Harness', 'sessions'),
].filter(Boolean)

function findRoot() {
  for (const root of CANDIDATE_ROOTS) {
    try {
      if (readdirSync(root).some((f) => f.endsWith('.jsonl'))) return root
    } catch {
      continue
    }
  }
  return null
}

const root = findRoot()
if (!root) {
  console.error('No session directory found. Looked in:')
  for (const c of CANDIDATE_ROOTS) console.error(`  ${c}`)
  process.exit(1)
}

const args = process.argv.slice(2)
const files = readdirSync(root)
  .filter((f) => f.endsWith('.jsonl'))
  .map((f) => ({ file: f, id: f.slice(0, -6), mtime: statSync(join(root, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)

if (args.includes('--list')) {
  console.log(`${root}\n`)
  for (const f of files) {
    const events = readEvents(f.id)
    const header = events[0]?.header
    const turns = events.filter((e) => e.type === 'turn/start').length
    const calls = events.filter((e) => e.type === 'tool/start').length
    console.log(
      `${f.id}  ${new Date(f.mtime).toISOString().slice(0, 16)}  ` +
        `turns=${String(turns).padStart(2)} tools=${String(calls).padStart(3)}  ` +
        `${header?.cwd ?? '?'}`,
    )
    console.log(`    ${header?.title || '(untitled)'}`)
  }
  process.exit(0)
}

function readEvents(id) {
  const raw = readFileSync(join(root, `${id}.jsonl`), 'utf8')
  const lines = raw.split('\n').filter((l) => l.trim().length > 0)
  const out = []
  let header = null
  for (let i = 0; i < lines.length; i++) {
    try {
      const parsed = JSON.parse(lines[i])
      if (i === 0) { header = parsed; out.header = parsed; continue }
      out.push(parsed)
    } catch {
      out.truncatedAt = i
      break
    }
  }
  out.header = header
  return out
}

const wanted = args.find((a) => !a.startsWith('--'))
const target = wanted ? files.find((f) => f.id.startsWith(wanted)) : files[0]
if (!target) {
  console.error(`No session matching "${wanted}"`)
  process.exit(1)
}

const events = readEvents(target.id)
console.log(`session : ${target.id}`)
console.log(`file    : ${join(root, `${target.id}.jsonl`)}`)
console.log(`cwd     : ${events.header?.cwd}`)
console.log(`title   : ${events.header?.title}`)
console.log(`events  : ${events.length}${events.truncatedAt ? ` (truncated at line ${events.truncatedAt})` : ''}`)

/** Split the log into turns so a long session stays readable. */
const turns = []
for (const e of events) {
  if (e.type === 'turn/start') turns.push({ turn: e.data.turn, events: [] })
  if (turns.length === 0) continue
  turns[turns.length - 1].events.push(e)
}

if (args.includes('--turns')) {
  console.log('\nturn  steps  tools  end')
  for (const t of turns) {
    const steps = t.events.filter((e) => e.type === 'step/start').length
    const tools = t.events.filter((e) => e.type === 'tool/start').length
    const end = [...t.events].reverse().find((e) => e.type === 'turn/end')
    console.log(
      `${String(t.turn).padStart(4)}  ${String(steps).padStart(5)}  ${String(tools).padStart(5)}  ` +
        `${JSON.stringify(end?.data?.reason ?? null)}`,
    )
  }
  process.exit(0)
}

const lastN = (() => {
  const i = args.indexOf('--last')
  return i === -1 ? null : Number.parseInt(args[i + 1], 10)
})()
const shown = lastN ? turns.slice(-lastN) : turns

for (const t of shown) {
  console.log(`\n${'='.repeat(70)}\nTURN ${t.turn}\n${'='.repeat(70)}`)
  for (const e of t.events) {
    switch (e.type) {
      case 'turn/start':
        break
      case 'turn/end':
        console.log(`  turn/end  ${JSON.stringify(e.data.reason)}`)
        break
      case 'user/message': {
        const src = e.data.message.source
        const tag = src.kind === 'system' ? `[system:${src.name}]` : '[user]'
        const text = e.data.message.content.map((b) => b.text ?? '').join('')
        console.log(`  ${tag} ${clip(text, 900)}`)
        break
      }
      case 'step/start':
        console.log(`  -- step ${e.data.step} (${e.data.model}) --`)
        break
      case 'step/reasoning':
        process.stdout.write(`  [think] ${clip(e.data.text, 2000)}\n`)
        break
      case 'step/text':
        process.stdout.write(`  [text ] ${clip(e.data.text, 2000)}\n`)
        break
      case 'step/tool-call':
        console.log(`  CALL  ${e.data.name}(${clip(JSON.stringify(e.data.arguments), 400)})`)
        break
      case 'step/end':
        console.log(`  step/end  ${JSON.stringify(e.data.reason)}`)
        break
      case 'tool/start':
        console.log(`  TOOL>  ${e.data.name} ${clip(JSON.stringify(e.data.arguments), 400)}`)
        break
      case 'tool/end':
        console.log(`  TOOL<  ${e.data.isError ? 'ERROR' : 'ok'} ${clip(e.data.content, 700)}`)
        break
      case 'step/usage':
        console.log(`  usage  ${JSON.stringify(e.data.usage)}`)
        break
      default:
        break
    }
  }
}

function clip(text, max) {
  const flat = String(text ?? '').replace(/\n/g, ' ⏎ ')
  return flat.length > max ? `${flat.slice(0, max)}…(+${flat.length - max})` : flat
}
