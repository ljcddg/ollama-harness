/**
 * Dependency integrity check.
 *
 * `npm install` was interrupted twice during setup, which left several packages
 * on disk with metadata but no payload. npm will not refetch a package it
 * believes is present, so the breakage is silent until something imports it.
 *
 * This walks node_modules and, for every package, verifies that the paths in
 * `main`, `module`, `types`, `bin` and the `exports` map actually resolve.
 * Run it after any suspicious install:
 *
 *   node scripts/check-deps.mjs
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const NM = join(ROOT, 'node_modules')

/** True when `spec` resolves to a real file, trying Node's extension probes. */
function fileExists(spec) {
  const p = resolve(spec)
  if (existsSync(p) && statSync(p).isFile()) return true
  for (const ext of ['.js', '.mjs', '.cjs', '.json', '.node']) {
    if (existsSync(p + ext)) return true
  }
  if (existsSync(p) && statSync(p).isDirectory()) {
    return ['index.js', 'index.mjs', 'index.cjs', 'package.json'].some((f) =>
      existsSync(join(p, f)),
    )
  }
  return false
}

/** Collect every concrete filesystem target declared by an `exports` value. */
function exportTargets(value, out = []) {
  if (typeof value === 'string') {
    if (value.startsWith('./')) out.push(value)
    return out
  }
  if (Array.isArray(value)) {
    for (const v of value) exportTargets(v, out)
    return out
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) exportTargets(v, out)
  }
  return out
}

const problems = []
const seen = new Set()

function checkPackage(dir, label) {
  const pkgPath = join(dir, 'package.json')
  if (!existsSync(pkgPath)) return
  if (seen.has(dir)) return
  seen.add(dir)

  let pkg
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch (error) {
    problems.push(`${label}: unreadable package.json (${error.message})`)
    return
  }

  if (!pkg.version) problems.push(`${label}: package.json has no "version"`)

  // Runtime entry points. `types`/`typings` are deliberately excluded: they are
  // compile-time only, several packages ship them at a different depth than the
  // field implies, and a missing one cannot break a runtime import.
  for (const field of ['main', 'module']) {
    const value = pkg[field]
    if (typeof value === 'string' && value.length > 0 && !fileExists(join(dir, value))) {
      problems.push(`${label}: "${field}" -> ${value} does not resolve`)
    }
  }

  // `bin` may be a string or a name->path map.
  if (typeof pkg.bin === 'string' && !fileExists(join(dir, pkg.bin))) {
    problems.push(`${label}: "bin" -> ${pkg.bin} does not resolve`)
  } else if (pkg.bin && typeof pkg.bin === 'object') {
    for (const [name, target] of Object.entries(pkg.bin)) {
      if (typeof target === 'string' && !fileExists(join(dir, target))) {
        problems.push(`${label}: bin["${name}"] -> ${target} does not resolve`)
      }
    }
  }

  // `exports` is the field that actually gates modern ESM resolution, and the
  // one whose absence caused the Vite failure this script exists to catch.
  if (pkg.exports) {
    const targets = exportTargets(pkg.exports)
    const missing = targets.filter((t) => !fileExists(join(dir, t)))
    // A package may ship only one of several conditional targets; report only
    // when NONE of the declared targets exist, which is real breakage.
    if (targets.length > 0 && missing.length === targets.length) {
      problems.push(`${label}: every "exports" target is missing (${missing.slice(0, 3).join(', ')})`)
    }
  }
}

function walk(dir, label) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.name.startsWith('@')) {
      walk(full, `${label}${entry.name}/`)
    } else if (entry.name === 'node_modules') {
      walk(full, `${label}${entry.name}/`)
    } else {
      checkPackage(full, label + entry.name)
    }
  }
}

walk(NM, '')

// esbuild ships its real binary in a platform-specific optional package; a
// missing one makes Vite fail with a confusing transform error.
const esbuildPkg = join(NM, 'esbuild', 'package.json')
if (existsSync(esbuildPkg)) {
  const arch = { x64: 'x64', arm64: 'arm64', ia32: 'ia32' }[process.arch] ?? process.arch
  const osName = { win32: 'win32', darwin: 'darwin', linux: 'linux' }[process.platform] ?? process.platform
  const expected = join(NM, '@esbuild', `${osName}-${arch}`)
  if (!existsSync(expected)) {
    problems.push(`esbuild: platform binary missing at ${expected.replace(ROOT, '.')}`)
  }
}

if (problems.length === 0) {
  console.log(`dependency check: OK (${seen.size} packages verified)`)
} else {
  console.log(`dependency check: ${problems.length} problem(s)\n`)
  for (const p of problems) console.log(`  - ${p}`)
  process.exitCode = 1
}
