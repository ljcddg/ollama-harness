/**
 * Verify that the renderer actually mounts.
 *
 * "The window is blank" is the single hardest failure to diagnose in an Electron
 * app, because a renderer that crashed looks identical to one that loaded fine:
 * the chrome paints and the body is empty. Neither the process exit code nor the
 * main-process log distinguishes them — and an unhandled renderer exception does
 * not even reach the terminal.
 *
 * So this launches the built app with a remote debugging port and asks the page
 * itself: did React mount, is the IPC bridge present, and how much DOM exists?
 * A blank window is then a failing assertion rather than a mystery.
 *
 * Usage:  node scripts/probe-render.mjs [--dev|--prod] [--keep]
 *   --dev    load from the Vite dev server (VITE_DEV_SERVER_URL, default :5173)
 *   --prod   load dist/renderer over file:// (default)
 *   --keep   leave the app running instead of terminating it
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = Number(process.env.PROBE_PORT ?? 9222)
const mode = process.argv.includes('--dev') ? 'dev' : 'prod'
const keep = process.argv.includes('--keep')

const electronPath = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const electron = process.platform === 'win32' ? electronPath : join(root, 'node_modules', 'electron', 'dist', 'electron')

if (!existsSync(electron)) {
  console.error(`Electron binary not found at ${electron}\nRun: node node_modules/electron/install.js`)
  process.exit(1)
}

// --prod forces the file:// path even though the app is not packaged.
const modeFlag = mode === 'dev' ? '--dev' : '--prod'
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
if (mode === 'dev' && !env.VITE_DEV_SERVER_URL) {
  env.VITE_DEV_SERVER_URL = `http://localhost:${env.VITE_PORT ?? '5173'}`
  console.log(`note: VITE_DEV_SERVER_URL unset, assuming ${env.VITE_DEV_SERVER_URL}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`, modeFlag], {
  cwd: root,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
})

const logs = []
const record = (buf) => {
  for (const line of String(buf).split(/\r?\n/)) {
    if (line.trim()) logs.push(line)
  }
}
child.stdout.on('data', record)
child.stderr.on('data', record)

/** Console messages and page errors do not surface in the terminal; CDP gets them. */
async function findPageTarget() {
  for (let i = 0; i < 80; i += 1) {
    if (child.exitCode !== null) return null
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch {
      /* port not listening yet */
    }
    await sleep(250)
  }
  return null
}

/** Minimal CDP client over the built-in WebSocket. */
function cdpEvaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('evaluate timed out'))
    }, 15_000)

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

const PROBE = `JSON.stringify({
  title: document.title,
  mounted: !!document.querySelector('.app'),
  rootChildren: (document.getElementById('root')?.children ?? []).length,
  nodeCount: document.querySelectorAll('*').length,
  sidebar: !!document.querySelector('.sidebar'),
  composer: !!document.querySelector('.composer'),
  bridgeKeys: window.harness ? Object.keys(window.harness).length : 0,
  text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 300)
})`

const target = await findPageTarget()
const alive = child.exitCode === null

let ok = false
if (target) {
  console.log(`page   : ${target.url}`)
  await sleep(2500) // let React mount and the first IPC round-trip settle
  try {
    const raw = await cdpEvaluate(target.webSocketDebuggerUrl, PROBE)
    const r = JSON.parse(raw)
    console.log(`title  : ${r.title}`)
    console.log(`mounted: ${r.mounted}`)
    console.log(`dom    : ${r.nodeCount} nodes, #root has ${r.rootChildren} child(ren)`)
    console.log(`layout : sidebar=${r.sidebar} composer=${r.composer}`)
    console.log(`bridge : ${r.bridgeKeys} methods`)
    console.log(`text   : ${r.text || '(empty)'}`)
    ok = r.mounted && r.rootChildren > 0 && r.nodeCount > 20 && r.bridgeKeys > 0
  } catch (error) {
    console.log(`probe failed: ${error.message}`)
  }
} else {
  console.log('page   : NONE — the app never opened a window')
}

console.log(`alive  : ${alive}${alive ? '' : ` (exited with ${child.exitCode})`}`)

// Renderer-side problems are invisible in the terminal, so echo anything that
// looked like an error. CDP would give more, but this covers the common cases.
const suspicious = logs.filter((l) =>
  /ERR_|error|failed|denied|blank|uncaught|GPU process isn't usable/i.test(l),
)
if (suspicious.length > 0) {
  console.log('\n--- notable log lines ---')
  for (const line of suspicious.slice(-25)) console.log(`  ${line}`)
}

console.log(`\nRESULT: ${ok ? 'RENDERED' : 'BLANK'}`)

if (keep) {
  console.log(`(app left running on pid ${child.pid}; debugging port ${PORT})`)
} else {
  child.kill()
}

process.exit(ok ? 0 : 2)
