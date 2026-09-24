/**
 * Verify the turn-changes card renders, with the numbers it was given.
 *
 * Seeded with the real shape of session c0a198d7: a request to clear the working
 * directory, a `del /q *.*` that printed nothing and exited 0, a model reply of
 * "已清空当前目录下的文件。" — and the harness's own measurement showing two files
 * removed out of twenty-seven. That contrast is the whole feature, so a screenshot
 * of it is worth more than an assertion, but both are here.
 *
 * Restores config.json, deletes the synthetic session and writes the screenshot to
 * .trash/.
 *
 * Usage:  node scripts/probe-changes.mjs
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

const SID = 'zz-changes-probe'
const FILE = join(SESSIONS, SID + '.jsonl')
const TITLE = 'CHANGES_PROBE'
const PORT = 9463

const now = Date.now()
const header = { version: 1, sessionId: SID, cwd: ROOT, title: TITLE, createdAt: now, updatedAt: now }

const ev = (seq, type, data) => ({ seq, time: now + seq, type, data })
const events = [
  ev(1, 'turn/start', { turn: 1 }),
  ev(2, 'user/message', {
    message: {
      id: 'u1',
      role: 'user',
      content: [{ type: 'text', text: '清空当前工作目录文件' }],
      source: { kind: 'user' },
      time: now,
    },
  }),
  ev(3, 'step/start', { turn: 1, step: 1, model: 'probe', provider: 'probe' }),
  ev(4, 'step/tool-call', { id: 'assistant-1-1', callId: 'c1', name: 'bash', arguments: { command: 'del /q *.*' } }),
  ev(5, 'tool/start', { callId: 'c1', name: 'bash', arguments: { command: 'del /q *.*' } }),
  ev(6, 'tool/end', {
    callId: 'c1',
    name: 'bash',
    isError: false,
    content: '[no output]\n\n[exit code 0]',
    durationMs: 87,
  }),
  ev(7, 'step/end', { turn: 1, step: 1, reason: { kind: 'stop' } }),
  ev(8, 'workspace/changes', {
    turn: 1,
    counts: { added: 0, removed: 2, modified: 0 },
    paths: ['removed: mail.iml', 'removed: pom.xml'],
    truncated: false,
  }),
  ev(9, 'step/text', { id: 'assistant-1-1', index: 1, text: '已清空当前目录下的文件。' }),
  ev(10, 'turn/end', { turn: 1, reason: { kind: 'stop' } }),
  // A second turn with nothing to report, so the "no files changed" wording is
  // covered too — it is the strongest thing the card can say about a turn whose
  // commands all claimed success.
  ev(11, 'turn/start', { turn: 2 }),
  ev(12, 'user/message', {
    message: {
      id: 'u2',
      role: 'user',
      content: [{ type: 'text', text: '再检查一遍' }],
      source: { kind: 'user' },
      time: now,
    },
  }),
  ev(13, 'step/start', { turn: 2, step: 1, model: 'probe', provider: 'probe' }),
  ev(14, 'workspace/changes', {
    turn: 2,
    counts: { added: 0, removed: 0, modified: 0 },
    paths: [],
    truncated: false,
  }),
  ev(15, 'step/text', { id: 'assistant-2-1', index: 1, text: '检查完毕，没有必要改动。' }),
  ev(16, 'turn/end', { turn: 2, reason: { kind: 'stop' } }),
]

writeFileSync(FILE, [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))].join('\n') + '\n', 'utf8')
if (existsSync(CONFIG)) copyFileSync(CONFIG, CONFIG_BAK)
console.log('seeded:', SID)

const cleanup = () => {
  try {
    unlinkSync(FILE)
  } catch {
    /* gone */
  }
  if (existsSync(CONFIG_BAK)) {
    writeFileSync(CONFIG, readFileSync(CONFIG_BAK))
    rmSync(CONFIG_BAK, { force: true })
    console.log('config.json restored')
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const electron = join(
  ROOT,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron',
)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`, '--prod'], {
  cwd: ROOT,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
})

function send(wsUrl, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('timeout'))
    }, 20_000)
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }))
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data))
      if (msg.id !== 1) return
      clearTimeout(timer)
      ws.close()
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    }
    ws.onerror = () => {
      clearTimeout(timer)
      reject(new Error('websocket error'))
    }
  })
}

const evaluate = async (wsUrl, expression) =>
  (await send(wsUrl, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.value

const PROBE = `JSON.stringify([...document.querySelectorAll('.changes')].map((card) => ({
  summary: (card.querySelector('.changes-summary')?.textContent || '').trim(),
  none: card.classList.contains('changes-none'),
  rows: [...card.querySelectorAll('.changes-row')].map((row) => ({
    cls: row.className,
    text: (row.textContent || '').trim(),
  })),
  more: (card.querySelector('.changes-more')?.textContent || '').trim(),
})))`

let code = 1
try {
  let page = null
  for (let i = 0; i < 80 && !page; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null
    } catch {
      /* not up yet */
    }
    if (!page) await sleep(250)
  }
  if (!page) throw new Error('the app never opened a window')
  await sleep(2500)

  const hit = await evaluate(
    page.webSocketDebuggerUrl,
    `(() => {
      const rows = [...document.querySelectorAll('.session-row')];
      const found = rows.find((r) => (r.textContent || '').includes('${TITLE}'));
      if (found) found.click();
      return !!found;
    })()`,
  )
  if (!hit) throw new Error('the synthetic session is not in the sidebar')
  await sleep(1600)

  const cards = JSON.parse(await evaluate(page.webSocketDebuggerUrl, PROBE))
  console.log('\ncards rendered:', cards.length)
  for (const [i, card] of cards.entries()) {
    console.log(`  card ${i}: summary=${JSON.stringify(card.summary)} none=${card.none} rows=${card.rows.length}`)
    for (const row of card.rows) console.log(`     [${row.cls}] ${row.text}`)
  }

  await send(page.webSocketDebuggerUrl, 'Page.enable', {})
  const shot = await send(page.webSocketDebuggerUrl, 'Page.captureScreenshot', { format: 'png' })
  const out = join(ROOT, '.trash', 'changes-preview.png')
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log('\nscreenshot:', out)

  const withChanges = cards[0]
  const withNone = cards[1]
  const pass =
    cards.length === 2 &&
    withChanges !== undefined &&
    withChanges.summary === '2 删除' &&
    withChanges.rows.length === 2 &&
    withChanges.rows.every((row) => row.cls.includes('changes-removed')) &&
    withChanges.rows.some((row) => row.text.includes('pom.xml')) &&
    withNone !== undefined &&
    withNone.none === true &&
    withNone.summary === '没有文件变动' &&
    withNone.rows.length === 0

  console.log()
  console.log(`  two cards rendered            : ${cards.length === 2 ? 'yes' : 'NO'}`)
  console.log(`  "2 删除" with two rows        : ${withChanges?.summary === '2 删除' && withChanges?.rows.length === 2 ? 'yes' : 'NO'}`)
  console.log(`  both rows marked removed      : ${withChanges?.rows.every((r) => r.cls.includes('changes-removed')) ? 'yes' : 'NO'}`)
  console.log(`  an empty turn says so         : ${withNone?.summary === '没有文件变动' ? 'yes' : 'NO'}`)
  console.log(`\nRESULT: ${pass ? 'CHANGES RENDER' : 'NOT RENDERING'}`)
  code = pass ? 0 : 2
} catch (error) {
  console.log('probe failed:', error.message)
  code = 1
}

child.kill()
await sleep(500)
cleanup()
process.exit(code)
