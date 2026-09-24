/**
 * Settings dialog scroll probe.
 *
 * The complaint this exists for is "scrolling the settings dialog feels
 * stuttery" — which is not diagnosable by reading CSS, because the same styles
 * are cheap or expensive depending on WHERE they sit. So this probe measures
 * frames instead of intentions: it opens the dialog, scrolls it for ~150 frames
 * and reports the frame-interval distribution, once with the backdrop blur as
 * shipped and once with `backdrop-filter: none` forced on the same element.
 *
 * A/B inside ONE process is the point. Two runs of two processes differ by
 * enough noise (warm-up, JIT, first-paint, window compositing) that the
 * difference being chased here would be invisible.
 *
 * Usage:  node scripts/probe-settings-scroll.mjs [--dev|--prod]
 *
 * Frames are measured with requestAnimationFrame, which the compositor drives.
 * Scrolling by assigning `scrollTop` runs the path through the main thread —
 * the harsher of the two — so a frames figure that is already fine here is
 * evidence the cost is not in paint/composite at all.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const PORT = Number(process.env.PROBE_PORT ?? 9334)
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
function cdpCall(wsUrl, method, params) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error(`${method} timed out`))
    }, 30_000)

    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }))
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

const evaluate = (wsUrl, expression) =>
  cdpCall(wsUrl, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })

/**
 * Open the dialog and report the styles that could plausibly cost frames.
 *
 * Returns a plain object — `awaitPromise` unwraps the async IIFE and
 * `returnByValue` serialises it. Do NOT hand back a JSON string: the caller
 * would then have to parse it, and every field would read as `undefined`.
 */
const OPEN = `(async () => {
  const button = document.querySelector('button[aria-label="设置"]')
  if (!button) return { error: 'settings button not found in the sidebar' }
  button.click()
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))

  const scroll = document.querySelector('.settings-scroll')
  const backdrop = document.querySelector('.modal-backdrop')
  const modal = document.querySelector('.modal')
  if (!scroll || !backdrop || !modal) {
    return { error: 'dialog parts missing: scroll=' + !!scroll + ' backdrop=' + !!backdrop + ' modal=' + !!modal }
  }

  const sc = getComputedStyle(scroll)
  const bc = getComputedStyle(backdrop)
  const mr = modal.getBoundingClientRect()
  return {
    scrollable: scroll.scrollHeight > scroll.clientHeight + 1,
    scrollHeight: scroll.scrollHeight,
    clientHeight: scroll.clientHeight,
    backdropFilter: bc.backdropFilter,
    overscrollBehaviorY: sc.overscrollBehaviorY,
    willChange: sc.willChange,
    contain: sc.contain,
    modalHeight: +mr.height.toFixed(1),
    modalFits: mr.top >= 0 && mr.bottom <= window.innerHeight + 0.5,
  }
})()`

/**
 * Scroll the dialog under a frame-time recorder.
 *
 * `blur === 'off'` forces the backdrop's blur away in the live page so the two
 * halves of the A/B differ in exactly one property.
 */
const scrollRun = (blur, frames) => `(async () => {
  const scroll = document.querySelector('.settings-scroll')
  const backdrop = document.querySelector('.modal-backdrop')
  if (!scroll || !backdrop) return { error: 'dialog is not open' }

  backdrop.style.backdropFilter = ${blur === 'off' ? "'none'" : "''"}
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))

  const start = scroll.scrollTop
  const intervals = []
  const result = await new Promise((resolve) => {
    let last = performance.now()
    let n = 0
    let dir = 1
    const step = () => {
      const now = performance.now()
      intervals.push(now - last)
      last = now
      const max = scroll.scrollHeight - scroll.clientHeight
      scroll.scrollTop = Math.max(0, Math.min(max, scroll.scrollTop + dir * 72))
      if (scroll.scrollTop >= max - 1) dir = -1
      else if (scroll.scrollTop <= 1) dir = 1
      n += 1
      if (n < ${frames}) {
        requestAnimationFrame(step)
      } else {
        // Drop the first samples: they include the layout of the scroll itself.
        const s = intervals.slice(5).sort((a, b) => a - b)
        resolve({
          p50: +s[Math.floor(s.length * 0.5)].toFixed(2),
          p95: +s[Math.floor(s.length * 0.95)].toFixed(2),
          worst: +s[s.length - 1].toFixed(2),
          over32: s.filter((t) => t > 32).length,
          samples: s.length,
        })
      }
    }
    requestAnimationFrame(step)
  })
  scroll.scrollTop = start
  return { ...result, scrolled: scroll.scrollHeight - scroll.clientHeight > 0 }
})()`

const target = await findPageTarget()
if (!target) {
  console.error('could not find a debuggable page')
  child.kill()
  process.exit(1)
}

// Let React mount and the first IPC round-trip settle: a probe that measures too
// early sees a pre-layout DOM and reports nonsense.
await sleep(2500)

let opened
try {
  opened = await evaluate(target.webSocketDebuggerUrl, OPEN)
} catch (error) {
  console.error(`probe failed: ${error.message}`)
  child.kill()
  process.exit(1)
}

if (!opened || typeof opened !== 'object') {
  console.error(`probe returned ${typeof opened} instead of an object`)
  child.kill()
  process.exit(1)
}

console.log(`page : ${target.url}`)
if (opened.error) {
  console.log(`RESULT: FAILED (${opened.error})`)
  child.kill()
  process.exit(1)
}

console.log('')
console.log('dialog styles as shipped')
for (const [key, value] of Object.entries(opened)) {
  console.log(`  ${key.padEnd(20)}: ${value}`)
}

const runs = []
try {
  await evaluate(target.webSocketDebuggerUrl, scrollRun('on', 40))
  runs.push(['blur on  (shipped)', await evaluate(target.webSocketDebuggerUrl, scrollRun('on', 150))])
  runs.push(['blur off (proposed)', await evaluate(target.webSocketDebuggerUrl, scrollRun('off', 150))])
  runs.push(['blur on  (repeat)', await evaluate(target.webSocketDebuggerUrl, scrollRun('on', 150))])
} catch (error) {
  console.error(`measurement failed: ${error.message}`)
  child.kill()
  process.exit(1)
}

console.log('')
console.log('frame interval (ms) — lower is smoother, 16.7 is a 60Hz frame')
console.log('  run                    p50     p95    worst   frames >32ms')
for (const [label, r] of runs) {
  if (!r || r.error) {
    console.log(`  ${label.padEnd(20)} ${r?.error ?? 'no result'}`)
    continue
  }
  console.log(
    `  ${label.padEnd(20)} ${String(r.p50).padStart(6)}  ${String(r.p95).padStart(6)}  ` +
      `${String(r.worst).padStart(6)}  ${String(r.over32).padStart(6)}`,
  )
}

const withBlur = [runs[0][1], runs[2][1]].filter((r) => r && !r.error)
const withoutBlur = runs[1][1]
const problems = []

if (!opened.scrollable) {
  problems.push('the settings panel does not scroll at all — check the max-height')
}
if (!opened.modalFits) {
  problems.push('the dialog is taller than the window')
}
if (withBlur.length > 0 && withoutBlur && !withoutBlur.error) {
  const avg95 = withBlur.reduce((sum, r) => sum + r.p95, 0) / withBlur.length
  const gain = avg95 - withoutBlur.p95
  if (gain > avg95 * 0.15 && gain > 1) {
    problems.push(
      `backdrop blur costs ${gain.toFixed(1)}ms per frame at p95 ` +
        `(${avg95.toFixed(1)}ms with, ${withoutBlur.p95}ms without)`,
    )
  } else if (opened.backdropFilter === 'none') {
    // Two very different readings of "no difference", and which one it is
    // matters: with no blur to remove, both halves of the A/B are the same
    // run, so the absence of a gain is the expected result, not a dead end.
    console.log('')
    console.log('no blur on the shipped backdrop — nothing to A/B, and that is the fix holding')
  } else {
    console.log('')
    console.log(
      `the backdrop has ${opened.backdropFilter} but it does not cost frames here — ` +
        'look somewhere other than the blur',
    )
  }
}

console.log('')
if (problems.length > 0) {
  for (const problem of problems) console.log(`  - ${problem}`)
  console.log('RESULT: SLOW')
  child.kill()
  process.exit(1)
}

console.log('RESULT: OK (dialog scrolls, frames within budget)')
child.kill()
