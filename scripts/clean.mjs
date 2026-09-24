/**
 * Remove build output.
 *
 * Stale files in dist/ are dangerous here rather than merely untidy: a leftover
 * `dist/main/preload.js` (ESM) sitting next to the real `preload.cjs` means the
 * app can silently load the wrong one, which is how the window ends up blank.
 * Erasing wholesale makes the build's output a function of its input.
 *
 * Usage: node scripts/clean.mjs [main|renderer|all]
 */

import { rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const which = process.argv[2] ?? 'all'

const targets = {
  main: ['dist/main', 'dist/core', 'dist/shared', 'dist/preload'],
  renderer: ['dist/renderer'],
  all: ['dist'],
}

const dirs = targets[which]
if (!dirs) {
  console.error(`Unknown target "${which}". Use: main | renderer | all`)
  process.exit(1)
}

for (const dir of dirs) {
  rmSync(join(root, dir), { recursive: true, force: true })
  console.log(`removed ${dir}`)
}
