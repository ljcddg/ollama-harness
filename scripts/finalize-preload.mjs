/**
 * Rename the compiled preload bundle to .cjs.
 *
 * The root package.json declares `"type": "module"`, so every `.js` file in the
 * package is an ES module as far as Node and Electron are concerned — regardless
 * of what syntax TypeScript emitted. Electron loads preload scripts with
 * `require()`, and require() of an ES module throws ERR_REQUIRE_ESM, so the
 * bridge never installs, `window.harness` is undefined, and React dies on its
 * first IPC call — leaving the window painted but empty.
 *
 * tsc cannot emit a `.cjs` extension, so we compile to `.js` and rename here.
 * src/main/preload.ts imports nothing at runtime, so the result is a single
 * self-contained file and no sibling modules need the same treatment.
 */

import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const from = join(root, 'dist', 'preload', 'main', 'preload.js')
const to = join(root, 'dist', 'preload', 'main', 'preload.cjs')

if (!existsSync(from) && !existsSync(to)) {
  console.error(`preload bundle missing: ${from}`)
  console.error('Run: npm run build:main')
  process.exit(1)
}

if (existsSync(from)) {
  renameSync(from, to)
}

// tsc also emits a stale sibling map; point it at the new filename or drop it.
const mapFrom = `${from}.map`
const mapTo = `${to}.map`
if (existsSync(mapFrom)) renameSync(mapFrom, mapTo)

console.log(`preload: dist/preload/main/preload.cjs`)

// TypeScript resolved the shared types into a declaration-only footprint; if any
// runtime helper ever creeps back in, tsc will emit a require() for it and the
// file stops being self-contained. Fail loudly rather than ship a broken bridge.
const emitted = readFileSync(to, 'utf8')
const strayRequires = [...emitted.matchAll(/require\("(\.[^"]+)"\)/g)].map((m) => m[1])
if (strayRequires.length > 0) {
  console.error(
    `preload is no longer self-contained — it requires: ${strayRequires.join(', ')}\n` +
      'Those modules would need their own CommonJS handling. Prefer inlining over importing.',
  )
  process.exit(1)
}
