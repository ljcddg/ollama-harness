/**
 * Load-smoke check: require every installed package and report what throws.
 *
 * Static analysis of `main`/`exports` (see check-deps.mjs) catches a package
 * whose entry point is missing, but not one that is missing a file its entry
 * point requires at runtime. `got` was exactly that case: the entry resolved,
 * then `require('../core')` failed because the whole `core/` directory had
 * never been extracted.
 *
 * Requiring each package is the only check that catches both. Packages are
 * skipped when they legitimately need a loader, a browser, or a native build —
 * the goal is finding half-extracted downloads, not judging packages.
 *
 *   node scripts/check-load.mjs
 */

import { readdirSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'

const ROOT = resolve(import.meta.dirname, '..')
const NM = join(ROOT, 'node_modules')
const require = createRequire(join(ROOT, 'noop.js'))

/**
 * Packages that cannot be `require`d in a plain Node process, with the reason.
 * Excluding them by name is deliberate: each entry is a known, understood case
 * rather than a blanket "skip anything that fails".
 */
const SKIP = new Map([
  ['electron', 'downloads a binary; main is a path shim'],
  ['esbuild', 'native binary broker'],
  ['@esbuild/win32-x64', 'native binary, no JS entry'],
  ['@esbuild/win32-arm64', 'native binary, no JS entry'],
  ['@esbuild/win32-ia32', 'native binary, no JS entry'],
  ['@esbuild/linux-x64', 'native binary, no JS entry'],
  ['@esbuild/darwin-x64', 'native binary, no JS entry'],
  ['@esbuild/darwin-arm64', 'native binary, no JS entry'],
  ['@esbuild/android-arm', 'native binary, no JS entry'],
  ['@esbuild/android-arm64', 'native binary, no JS entry'],
  ['@esbuild/android-x64', 'native binary, no JS entry'],
  ['@esbuild/freebsd-arm64', 'native binary, no JS entry'],
  ['@esbuild/freebsd-x64', 'native binary, no JS entry'],
  ['@esbuild/linux-arm', 'native binary, no JS entry'],
  ['@esbuild/linux-arm64', 'native binary, no JS entry'],
  ['@esbuild/linux-ia32', 'native binary, no JS entry'],
  ['@esbuild/linux-loong64', 'native binary, no JS entry'],
  ['@esbuild/linux-mips64el', 'native binary, no JS entry'],
  ['@esbuild/linux-ppc64', 'native binary, no JS entry'],
  ['@esbuild/linux-riscv64', 'native binary, no JS entry'],
  ['@esbuild/linux-s390x', 'native binary, no JS entry'],
  ['@esbuild/netbsd-arm64', 'native binary, no JS entry'],
  ['@esbuild/netbsd-x64', 'native binary, no JS entry'],
  ['@esbuild/openbsd-arm64', 'native binary, no JS entry'],
  ['@esbuild/openbsd-x64', 'native binary, no JS entry'],
  ['@esbuild/sunos-x64', 'native binary, no JS entry'],
  ['vite', 'ESM-only CLI'],
  ['react-dom', 'needs a DOM'],
  ['@types/react', 'types only'],
  ['@types/react-dom', 'types only'],
  ['@types/node', 'types only'],
  ['typescript', 'large CLI, resolves its own deps'],
])

/** Names that mark a failure as environmental rather than an install problem. */
const BENIGN = [
  'Cannot find module \'electron\'',
  'document is not defined',
  'window is not defined',
  'navigator is not defined',
  'self is not defined',
  'ReactDOM',
  'ERR_REQUIRE_ESM',
  'require() of ES Module',
  'Dynamic require of',
  'Cannot use import statement outside a module',
  'Unexpected token \'export\'',
  'Unexpected token \'import\'',
  'The specified module could not be found',
]

/**
 * Type-only packages ship just `index.d.ts`, and data packages expose only
 * subpaths (`node-releases/data/...`), so neither has a root entry to resolve.
 * Both shapes are legitimate; detect them by structure rather than by name.
 */
function hasNoRootEntry(dir, name) {
  if (name.startsWith('@types/') || name.startsWith('@types\\')) return true
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return false
  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch {
    return false
  }
  // A declared root entry means the package promised one; it must resolve.
  const declaredRoot = pkg.main || pkg.module || (pkg.exports && pkg.exports['.'])
  if (declaredRoot) return false
  // No root entry declared: the package is reached by subpath. Legitimate only
  // if it actually shipped files — an empty directory is still breakage.
  const entries = readdirSync(dir).filter((f) => f !== 'package.json')
  return entries.length > 0
}

const seen = new Set()
const failures = []
const skipped = []
let loaded = 0

function isSkipped(name) {
  if (SKIP.has(name)) return true
  for (const key of SKIP.keys()) {
    if (name.startsWith(`${key}/`)) return true
  }
  return false
}

function attempt(dir, name) {
  if (seen.has(dir)) return
  seen.add(dir)
  if (isSkipped(name)) {
    skipped.push(name)
    return
  }
  if (!existsSync(join(dir, 'package.json'))) return

  let entry
  try {
    entry = require.resolve(dir)
  } catch (error) {
    // A declarations-only or subpath-only package has no root entry by design.
    if (hasNoRootEntry(dir, name)) {
      skipped.push(name)
      return
    }
    failures.push([name, `entry not resolvable: ${error.message.split('\n')[0]}`])
    return
  }

  try {
    require(entry)
    loaded++
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (BENIGN.some((b) => message.includes(b))) {
      loaded++
      return
    }
    failures.push([name, message.split('\n')[0]])
  }
}

for (const entry of readdirSync(NM, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith('.')) continue
  const full = join(NM, entry.name)
  if (entry.name.startsWith('@')) {
    for (const sub of readdirSync(full, { withFileTypes: true })) {
      if (sub.isDirectory()) attempt(join(full, sub.name), `${entry.name}/${sub.name}`)
    }
  } else {
    attempt(full, entry.name)
  }
}

console.log(`load check: ${loaded} packages loaded, ${skipped.length} skipped, ${failures.length} broken\n`)
if (failures.length === 0) {
  process.exitCode = 0
} else {
  for (const [name, message] of failures) console.log(`  ${name}\n    ${message}\n`)
  console.log('delete the listed directories and reinstall to repair them')
  process.exitCode = 1
}
