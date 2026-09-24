/**
 * Geometric probe for the grouped sidebar.
 *
 * The failure this exists to catch is invisible to a screenshot review: the
 * sidebar is a scroll container (`overflow-y: auto`), and a scroll container
 * clips its descendants on BOTH axes. The "…" menu is absolutely-positioned
 * content inside that container, so an implementation that looks perfect at the
 * top of the list gets sliced in half near the bottom of it.
 *
 * So this measures real pixels: open both menus, then check the popup is inside
 * the viewport, is the topmost element at its own centre (nothing covering or
 * clipping it), and that every item is inside the popup's box.
 *
 * Usage:  node scripts/probe-sidebar.mjs [--dev|--prod] [--keep]
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = Number(process.env.PROBE_PORT ?? 9223)
const mode = process.argv.includes('--dev') ? 'dev' : 'prod'
const keep = process.argv.includes('--keep')

const electronExe = join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
const electron = process.platform === 'win32' ? electronExe : join(root, 'node_modules', 'electron', 'dist', 'electron')
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
const logs = []
const record = (b) => { for (const l of String(b).split(/\r?\n/)) if (l.trim()) logs.push(l) }
child.stdout.on('data', record)
child.stderr.on('data', record)

async function findTarget() {
  for (let i = 0; i < 80; i += 1) {
    if (child.exitCode !== null) return null
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const page = (await res.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch { /* not listening yet */ }
    await sleep(250)
  }
  return null
}

/**
 * Evaluate an expression in the page and return its value.
 *
 * `returnByValue` unwraps the object for us, so the expression returns a plain
 * object and is NOT stringified — stringifying here and parsing outside turns
 * every property into `undefined` and manufactures failures.
 */
function cdpEvaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => { ws.close(); reject(new Error('evaluate timed out')) }, 20_000)
    ws.onopen = () => ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    }))
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data))
      if (msg.id !== 1) return
      clearTimeout(timer)
      ws.close()
      const details = msg.result?.exceptionDetails
      if (details) reject(new Error(details.exception?.description ?? details.text))
      else resolve(msg.result?.result?.value)
    }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('websocket error')) }
  })
}

/** Open a menu, then measure it against the viewport and the paint order. */
const MEASURE_MENU = (triggerSelector) => `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const fail = []
  const trigger = document.querySelector(${JSON.stringify(triggerSelector)})
  if (!trigger) return { fail: ['trigger not found: ' + ${JSON.stringify(triggerSelector)}] }
  trigger.click()
  // Two frames: React commits, then layout settles. Measuring on the first frame
  // reads the pre-layout box.
  await sleep(140)
  const popup = document.querySelector('.menu-popup')
  if (!popup) return { fail: ['menu did not open'], triggerRect: trigger.getBoundingClientRect().toJSON() }

  const r = popup.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (r.width <= 0 || r.height <= 0) fail.push('popup has zero size')
  if (r.top < 0 || r.left < 0 || r.bottom > vh || r.right > vw) {
    fail.push('popup escapes the viewport: ' + JSON.stringify({ top: r.top, left: r.left, bottom: r.bottom, right: r.right, vw, vh }))
  }

  // The decisive check: is the popup the topmost element at its own centre?
  // A clipped or covered popup still reports a full bounding box, so the box
  // alone cannot tell you it is actually visible.
  const cx = r.left + r.width / 2
  const cy = r.top + r.height / 2
  const hit = document.elementFromPoint(cx, cy)
  if (!hit || !hit.closest('.menu-popup')) {
    fail.push('popup is not visible at its centre (covered or clipped); hit=' + (hit ? hit.className : 'null'))
  }

  const items = [...popup.querySelectorAll('.menu-item')]
  if (items.length === 0) fail.push('popup has no items')
  const outside = items.filter((b) => {
    const q = b.getBoundingClientRect()
    return q.width <= 0 || q.height <= 0 || q.top < r.top - 0.5 || q.bottom > r.bottom + 0.5
  })
  if (outside.length > 0) fail.push(outside.length + ' item(s) fall outside the popup box')

  const out = {
    fail,
    popup: { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) },
    viewport: { vw, vh },
    itemCount: items.length,
    items: items.map((b) => b.textContent.trim()),
  }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  await sleep(80)
  out.closedOnEscape = !document.querySelector('.menu-popup')
  return out
})()`

/** The structural facts that must hold regardless of geometry. */
const STRUCTURE = `(async () => {
  await new Promise((r) => setTimeout(r, 200))
  const groups = [...document.querySelectorAll('.group')]
  return {
    groupCount: groups.length,
    labels: groups.map((g) => g.querySelector('.group-name')?.textContent ?? '?'),
    counts: groups.map((g) => g.querySelector('.group-count')?.textContent ?? '-'),
    eachHasAdd: groups.every((g) => g.querySelector('.group-add')),
    eachHasMenu: groups.every((g) => g.querySelector('.menu-trigger')),
    sessionRows: document.querySelectorAll('.session-row').length,
    sessionMenus: document.querySelectorAll('.session-row .menu-trigger').length,
    emptyGroupNotice: document.querySelectorAll('.group-sessions .session-empty').length,
    // The scroll container must declare min-height:0 or it will not scroll at
    // all — it grows and pushes the footer out of the window instead.
    scrollMinHeight: getComputedStyle(document.querySelector('.sidebar-scroll') ?? document.body).minHeight,
    sidebarBottom: Math.round((document.querySelector('.sidebar')?.getBoundingClientRect().bottom) ?? -1),
    footerVisible: (() => {
      const f = document.querySelector('.sidebar-foot')
      if (!f) return false
      const r = f.getBoundingClientRect()
      return r.top >= 0 && r.bottom <= window.innerHeight + 1 && r.height > 0
    })(),
  }
})()`

const target = await findTarget()
let ok = false

if (!target) {
  console.log('page   : NONE — the app never opened a window')
} else {
  console.log(`page   : ${target.url}`)
  await sleep(2500) // React mount + first IPC round trip
  try {
    const structure = await cdpEvaluate(target.webSocketDebuggerUrl, STRUCTURE)
    console.log(`groups : ${structure.groupCount} -> ${structure.labels.join(' | ')}`)
    console.log(`counts : ${structure.counts.join(', ')}`)
    console.log(`controls: add=${structure.eachHasAdd} menu=${structure.eachHasMenu} sessionMenus=${structure.sessionMenus}`)
    console.log(`empty groups: ${structure.emptyGroupNotice}`)
    console.log(`scroll : min-height=${structure.scrollMinHeight} footerVisible=${structure.footerVisible}`)

    const groupMenu = await cdpEvaluate(
      target.webSocketDebuggerUrl,
      MEASURE_MENU('.group .menu-trigger'),
    )
    console.log(`\n-- group menu --`)
    console.log(`  box    : ${JSON.stringify(groupMenu.popup)} in ${groupMenu.viewport.vw}x${groupMenu.viewport.vh}`)
    console.log(`  items  : ${groupMenu.items?.join(' / ')}`)
    console.log(`  escape closes: ${groupMenu.closedOnEscape}`)
    if (groupMenu.fail?.length) for (const f of groupMenu.fail) console.log(`  FAIL   ${f}`)

    const sessionMenu = await cdpEvaluate(
      target.webSocketDebuggerUrl,
      MEASURE_MENU('.session-row .menu-trigger'),
    )
    console.log(`\n-- session menu --`)
    console.log(`  box    : ${JSON.stringify(sessionMenu.popup)}`)
    console.log(`  items  : ${sessionMenu.items?.join(' / ')}`)
    console.log(`  escape closes: ${sessionMenu.closedOnEscape}`)
    if (sessionMenu.fail?.length) for (const f of sessionMenu.fail) console.log(`  FAIL   ${f}`)

    ok =
      structure.groupCount > 0 &&
      structure.eachHasAdd &&
      structure.eachHasMenu &&
      structure.footerVisible &&
      structure.scrollMinHeight === '0px' &&
      (groupMenu.fail?.length ?? 1) === 0 &&
      (sessionMenu.fail?.length ?? 1) === 0 &&
      groupMenu.closedOnEscape === true
  } catch (error) {
    console.log(`probe failed: ${error.message}`)
  }
}

console.log(`\nRESULT: ${ok ? 'SIDEBAR OK' : 'SIDEBAR BROKEN'}`)
if (keep) console.log(`(left running on pid ${child.pid}, port ${PORT})`)
else child.kill()
process.exit(ok ? 0 : 2)
