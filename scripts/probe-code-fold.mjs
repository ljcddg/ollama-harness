/**
 * Verify that long code blocks render folded, and open on a click.
 *
 * The whole point of the fold is what the eye does NOT have to wade through, so
 * "it compiles" is not evidence and neither is a snapshot of the component tree.
 * This seeds one synthetic session with a 20-line block and a 1-line block,
 * launches the built app, clicks into the session over CDP, and reads the real
 * DOM back — twice: once as it loads, once after clicking the header.
 *
 * Both halves matter and they pull in opposite directions. Folding everything
 * would make a one-line command taller than the command (its header is a line
 * too), so the short block must stay open. Folding nothing is the behaviour
 * being removed. A regression that swaps one for the other fails here.
 *
 * Restores config.json and deletes the synthetic session afterwards.
 *
 * Usage:  node scripts/probe-code-fold.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, copyFileSync, rmSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const APPDATA = join(process.env.APPDATA ?? '', 'ollama harness')
const SESSIONS = join(APPDATA, 'sessions')
const CONFIG = join(APPDATA, 'config.json')
const CONFIG_BAK = CONFIG + '.probe-bak'

const SID = 'zz-code-fold-probe'
const FILE = join(SESSIONS, SID + '.jsonl')
const TITLE = 'CODE_FOLD_PROBE'
const PORT = 9461
const LONG_LINES = 20
/** Lines in the short block, which must stay open: one. */
const SHORT_LINES = 'npm run build'.split('\n').length

const now = Date.now()
const header = { version: 1, sessionId: SID, cwd: ROOT, title: TITLE, createdAt: now, updatedAt: now }

const longCode = Array.from({ length: LONG_LINES }, (_, i) => `const step${i + 1} = ${i + 1}`).join('\n')
const markdown = [
  '改动集中在两个文件。',
  '',
  '```typescript',
  longCode,
  '```',
  '',
  '然后跑这条命令：',
  '',
  '```bash',
  'npm run build',
  '```',
].join('\n')

const ev = (seq, type, data) => ({ seq, time: now + seq, type, data })
const events = [
  ev(1, 'turn/start', { turn: 1 }),
  ev(2, 'user/message', {
    message: {
      id: 'u1',
      role: 'user',
      content: [{ type: 'text', text: '改完了吗' }],
      source: { kind: 'user' },
      time: now,
    },
  }),
  ev(3, 'step/start', { turn: 1, step: 1, model: 'probe', provider: 'probe' }),
  ev(4, 'step/text', { id: 'assistant-1-1', index: 1, text: markdown }),
  ev(5, 'step/end', { turn: 1, step: 1, reason: { kind: 'stop' } }),
  ev(6, 'turn/end', { turn: 1, reason: { kind: 'stop' } }),
]

writeFileSync(FILE, [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join('\n') + '\n', 'utf8')
if (existsSync(CONFIG)) copyFileSync(CONFIG, CONFIG_BAK)
console.log('seeded:', SID)

const cleanup = () => {
  try {
    unlinkSync(FILE)
  } catch {
    /* already gone */
  }
  if (existsSync(CONFIG_BAK)) {
    writeFileSync(CONFIG, readFileSync(CONFIG_BAK))
    rmSync(CONFIG_BAK, { force: true })
    console.log('config.json restored')
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const electron = join(ROOT, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`, '--prod'], {
  cwd: ROOT,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
})

function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('evaluate timed out'))
    }, 20_000)
    ws.onopen = () =>
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true },
        }),
      )
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data))
      if (msg.id !== 1) return
      clearTimeout(timer)
      ws.close()
      const details = msg.result?.exceptionDetails
      if (details) reject(new Error(details.exception?.description ?? details.text))
      else resolve(msg.result?.result?.value)
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error('websocket error'))
    }
  })
}

const READ_BLOCKS = `JSON.stringify([...document.querySelectorAll('.md-code-block')].map((b) => ({
  folded: b.classList.contains('is-folded'),
  bodyLines: b.querySelector('.md-code-body')
    ? b.querySelector('.md-code-body').textContent.split('\\n').length
    : 0,
  head: (b.querySelector('.md-code-head')?.textContent || '').trim(),
})))`

let code = 1
try {
  let page = null
  for (let i = 0; i < 80 && !page; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null
    } catch {
      /* port not listening yet */
    }
    if (!page) await sleep(250)
  }
  if (!page) throw new Error('the app never opened a window')
  await sleep(2500)

  const clicked = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const rows = [...document.querySelectorAll('.session-row')];
      const hit = rows.find((r) => (r.textContent || '').includes('${TITLE}'));
      if (hit) hit.click();
      return !!hit;
    })()`,
  )
  if (!clicked) throw new Error('the synthetic session is not in the sidebar')
  await sleep(1500)

  const before = JSON.parse(await evaluate(page.webSocketDebuggerUrl, READ_BLOCKS))
  console.log('\nas loaded:')
  for (const [i, b] of before.entries()) {
    console.log(`  block ${i}: folded=${b.folded} bodyLines=${b.bodyLines} head=${JSON.stringify(b.head)}`)
  }

  const tapped = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => { const b = document.querySelector('.md-code-block .md-code-toggle'); if (b) b.click(); return !!b; })()`,
  )
  if (!tapped) throw new Error('the folded block has no toggle to click')
  await sleep(400)

  const after = JSON.parse(await evaluate(page.webSocketDebuggerUrl, READ_BLOCKS))
  console.log('\nafter clicking the first header:')
  for (const [i, b] of after.entries()) {
    console.log(`  block ${i}: folded=${b.folded} bodyLines=${b.bodyLines}`)
  }

  const longShapeOk =
    before[0] !== undefined &&
    before[0].folded === true &&
    before[0].bodyLines === 0 &&
    before[0].head.includes(String(LONG_LINES))
  const shortShapeOk =
    before[1] !== undefined && before[1].folded === false && before[1].bodyLines === SHORT_LINES
  const opensOk = after[0] !== undefined && after[0].folded === false && after[0].bodyLines === LONG_LINES
  const othersUntouched = after[1] !== undefined && after[1].bodyLines === SHORT_LINES

  console.log()
  console.log(`  long block folded by default : ${longShapeOk ? 'yes' : 'NO'}`)
  console.log(`  short block left open        : ${shortShapeOk ? 'yes' : 'NO'}`)
  console.log(`  clicking the head opens it   : ${opensOk ? 'yes' : 'NO'}`)
  console.log(`  other block unaffected       : ${othersUntouched ? 'yes' : 'NO'}`)

  const pass = before.length === 2 && longShapeOk && shortShapeOk && opensOk && othersUntouched
  console.log(`\nRESULT: ${pass ? 'CODE FOLDS' : 'NOT FOLDING'}`)
  code = pass ? 0 : 2
} catch (error) {
  console.log('probe failed:', error.message)
  code = 1
}

child.kill()
await sleep(500)
cleanup()
process.exit(code)
