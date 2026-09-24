/**
 * Composer geometry probe.
 *
 * `probe-render.mjs` answers "did React mount". That is not enough to catch a
 * visually broken control: a textarea collapsed to 2px and a textarea sized
 * correctly both report `mounted: true` and the same DOM node count — which is
 * exactly how a squashed composer shipped unnoticed.
 *
 * This probe asks the page for MEASURED BOXES instead: the textarea's real
 * height, whether it scrolls before it should, and whether it overlaps the
 * button row below it.
 *
 * Usage:  node scripts/probe-composer.mjs [--dev|--prod]
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const PORT = Number(process.env.PROBE_PORT ?? 9333)
const mode = process.argv.includes('--dev') ? 'dev' : 'prod'

const electron = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
if (!existsSync(electron)) {
  console.error(`Electron binary not found at ${electron}`)
  process.exit(1)
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
if (mode === 'dev' && !env.VITE_DEV_SERVER_URL) {
  env.VITE_DEV_SERVER_URL = `http://localhost:${env.VITE_PORT ?? '5173'}`
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`, mode === 'dev' ? '--dev' : '--prod'], {
  cwd: root,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
})
child.stdout.resume()
child.stderr.resume()

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

/**
 * Measure the composer, including a simulated two-line draft.
 *
 * Returns a plain object: `Runtime.evaluate` runs with `awaitPromise: true`, so
 * the async IIFE is unwrapped and `returnByValue` serialises the result. Do NOT
 * wrap the return in `JSON.stringify` — that would produce a JSON *string*, and
 * the caller would then have to parse it, which is an easy way to end up with
 * `undefined` for every field.
 */
const PROBE = `(async () => {
  const input = document.querySelector('.composer-input')
  const actions = document.querySelector('.composer-actions')
  const box = document.querySelector('.composer-box')
  const scroll = document.querySelector('.scroll')
  const wrap = document.querySelector('.scroll-wrap')
  if (!input || !actions || !box) {
    return { error: 'composer parts missing: input=' + !!input + ' actions=' + !!actions + ' box=' + !!box }
  }

  const measure = () => {
    const i = input.getBoundingClientRect()
    const a = actions.getBoundingClientRect()
    return {
      height: +i.height.toFixed(1),
      overlap: +(i.bottom - a.top).toFixed(1),
      scrollTop: input.scrollTop,
      scrollHeight: input.scrollHeight,
      clientHeight: input.clientHeight,
      overflowY: getComputedStyle(input).overflowY
    }
  }

  const baseline = measure()

  // Type two lines the way a user would, through the native value setter so
  // React's onChange sees it. "Two lines" is the exact case that used to
  // produce an inner scrollbar.
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(input, '第一行内容\\n第二行内容')
  input.dispatchEvent(new Event('input', { bubbles: true }))

  // Let React re-render and the sizing effect run.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  const twoLine = measure()

  const buttons = [...document.querySelectorAll('.composer-actions button')]
  const actionsRect = actions.getBoundingClientRect()
  const overflowing = buttons.filter((el) => {
    const r = el.getBoundingClientRect()
    return r.bottom > actionsRect.bottom + 0.5 || r.right > actionsRect.right + 0.5 || r.height < 10
  }).length

  return {
    baselineHeight: baseline.height,
    twoLineHeight: twoLine.height,
    grew: twoLine.height > baseline.height + 1,
    twoLineOverflow: twoLine.overflowY,
    twoLineHasInnerScrollbar:
      twoLine.overflowY === 'auto' && twoLine.scrollHeight > twoLine.clientHeight + 1,
    overlap: twoLine.overlap,
    overflowingButtons: overflowing,
    // Layout sanity: the transcript must be the thing that scrolls, and the
    // composer must stay inside the window.
    scrollIsScrollable: scroll ? scroll.scrollHeight > scroll.clientHeight + 1 : null,
    wrapHeight: wrap ? +wrap.getBoundingClientRect().height.toFixed(1) : null,
    scrollHeightPx: scroll ? +scroll.getBoundingClientRect().height.toFixed(1) : null,
    composerFitsInWindow:
      document.querySelector('.composer').getBoundingClientRect().bottom <= window.innerHeight + 0.5
  }
})()`

const target = await findPageTarget()
if (!target) {
  console.error('could not find a debuggable page')
  child.kill()
  process.exit(1)
}

// Let React mount and the first IPC round-trip settle before measuring — a probe
// that measures too early sees a pre-layout DOM.
await sleep(2500)

let measured
try {
  // No `JSON.parse`: the probe resolves an object, not a string.
  measured = await cdpEvaluate(target.webSocketDebuggerUrl, PROBE)
} catch (error) {
  console.error(`probe failed: ${error.message}`)
  child.kill()
  process.exit(1)
}

if (!measured || typeof measured !== 'object') {
  console.error(`probe returned ${typeof measured} instead of an object`)
  child.kill()
  process.exit(1)
}

console.log(`page : ${target.url}`)
if (measured.error) {
  console.log(`RESULT: FAILED (${measured.error})`)
  child.kill()
  process.exit(1)
}

for (const [key, value] of Object.entries(measured)) {
  console.log(`${key.padEnd(20)}: ${value}`)
}

const problems = []
if (measured.baselineHeight < 30) {
  problems.push(`empty textarea is only ${measured.baselineHeight}px tall`)
}
if (!measured.grew) {
  problems.push('textarea did not grow when a second line was typed')
}
if (measured.twoLineHasInnerScrollbar) {
  problems.push('a two-line draft scrolls inside the textarea — it should still be growing')
}
if (measured.overlap > 0.5) {
  problems.push(`textarea overlaps the actions row by ${measured.overlap}px`)
}
if (measured.overflowingButtons > 0) {
  problems.push(`${measured.overflowingButtons} button(s) overflow the actions row`)
}
if (measured.composerFitsInWindow === false) {
  problems.push('the composer is pushed below the bottom of the window')
}

console.log('')
if (problems.length > 0) {
  for (const problem of problems) console.log(`  - ${problem}`)
  console.log('RESULT: BROKEN')
  child.kill()
  process.exit(1)
}

console.log('RESULT: OK (textarea sized, no overlap, no early scrollbar)')
child.kill()
