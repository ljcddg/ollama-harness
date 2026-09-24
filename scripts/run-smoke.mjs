/**
 * Run the main-process smoke test inside Electron's own Node runtime.
 *
 * Electron ships the runtime the app actually uses, so loading the bundle there
 * is the only way to catch a dependency that works under the host Node but not
 * under Electron. `ELECTRON_RUN_AS_NODE=1` makes the binary behave as plain
 * Node, which keeps the test headless — no window, no display needed.
 *
 *   npm run check:smoke
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Resolve the platform binary the way the `electron` package does: `path.txt`
// names the executable, and `dist/` holds it.
const distDir = join(root, 'node_modules', 'electron', 'dist')
const pathTxt = join(root, 'node_modules', 'electron', 'path.txt')
const exeName = existsSync(pathTxt)
  ? (await import('node:fs')).readFileSync(pathTxt, 'utf8').trim()
  : process.platform === 'win32'
    ? 'electron.exe'
    : process.platform === 'darwin'
      ? 'Electron.app/Contents/MacOS/Electron'
      : 'electron'
const exe = process.platform === 'darwin' ? join(distDir, exeName) : join(distDir, exeName)

if (!existsSync(exe)) {
  console.error(`electron binary not found at ${exe}`)
  console.error('run `node node_modules/electron/install.js` to download it')
  process.exit(1)
}

const result = spawnSync(exe, [join(root, 'scripts', 'smoke-main.mjs')], {
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
})

process.exit(result.status ?? 1)
