/**
 * Smoke test: load the built main-process bundle inside Electron's own Node.
 *
 * This proves the three things a type check cannot: the compiled output exists,
 * it loads under Electron's Node (not just the host Node), and the wiring
 * between the core modules is intact. Run with:
 *
 *   ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/smoke-main.mjs
 *
 * The bundles are ESM, so this file is ESM too and uses dynamic import().
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let failed = 0

function ok(label, detail) {
  console.log(`  ok    ${label}${detail ? `  (${detail})` : ''}`)
}

function bad(label, detail) {
  failed++
  console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ''}`)
}

const load = (rel) => import(new URL(`../${rel}`, import.meta.url).href)

console.log('\nbuilt artefacts')

for (const rel of [
  'dist/main/main.js',
  // CommonJS, not .js: Electron require()s the preload and this package is
  // "type": "module", so a .js preload would be read as ESM and fail to load.
  'dist/preload/main/preload.cjs',
  'dist/main/agent-service.js',
  'dist/core/loop.js',
  'dist/core/llm/ollama-adapter.js',
  'dist/core/tools/index.js',
  'dist/shared/session.js',
  'dist/renderer/index.html',
]) {
  const p = join(root, rel)
  if (existsSync(p)) ok(rel, `${statSync(p).size} B`)
  else bad(rel, 'missing')
}

console.log('\nmodule wiring')

// The preload is CommonJS and loads through require(), not import(). Verify both
// halves of that contract: the file parses as CommonJS, and it stays
// self-contained — a relative require() would drag in a sibling module that
// would then need its own CJS handling, and a stray one is easy to reintroduce.
// Electron itself is never required here; under ELECTRON_RUN_AS_NODE the module
// resolves but has no window to attach a bridge to.
try {
  const source = readFileSync(join(root, 'dist/preload/main/preload.cjs'), 'utf8')
  const hasEsm = /^\s*(import|export)\s/m.test(source)
  const stray = [...source.matchAll(/require\("(\.[^"]+)"\)/g)].map((m) => m[1])
  const requiresElectron = /require\("electron"\)/.test(source)

  if (hasEsm) {
    bad('preload is CommonJS', 'contains import/export syntax')
  } else if (stray.length > 0) {
    bad('preload is self-contained', `requires ${stray.join(', ')}`)
  } else if (!requiresElectron) {
    bad('preload requires electron', 'no require("electron") found')
  } else {
    // Parse it without executing: proves it is syntactically valid CommonJS.
    createRequire(new URL('../dist/preload/main/preload.cjs', import.meta.url))
    new Function('require', 'module', 'exports', source)
    ok('preload parses as CommonJS', 'self-contained, no relative requires')
  }
} catch (error) {
  bad('parse preload.cjs', String(error.message).split('\n')[0])
}

try {
  const { runTurn } = await load('dist/core/loop.js')
  typeof runTurn === 'function' ? ok('runTurn exported') : bad('runTurn is not a function')
} catch (error) {
  bad('import dist/core/loop.js', String(error.message).split('\n')[0])
}

try {
  const { OllamaAdapter } = await load('dist/core/llm/ollama-adapter.js')
  const adapter = new OllamaAdapter({ baseUrl: 'http://127.0.0.1:11434', fetch: globalThis.fetch })
  adapter.provider === 'ollama'
    ? ok('OllamaAdapter constructs', `provider=${adapter.provider}`)
    : bad('OllamaAdapter.provider', String(adapter.provider))
} catch (error) {
  bad('construct OllamaAdapter', String(error.message).split('\n')[0])
}

try {
  const { createDefaultRegistry } = await load('dist/core/tools/index.js')
  const registry = createDefaultRegistry()
  const names = registry.names()
  // The default (no-deps) registry. `web` is always registered; `search` is not,
  // because it needs an embedding model and agent-service wires it in later. This
  // list must stay in step with createDefaultRegistry — a stale name here is how
  // the smoke quietly drifts from what the app actually ships.
  const expected = ['read', 'list', 'glob', 'grep', 'web', 'edit', 'write', 'bash']
  const missing = expected.filter((n) => !names.includes(n))
  missing.length === 0
    ? ok('tool registry', names.join(', '))
    : bad('tool registry missing', missing.join(', '))
  const definitions = registry.definitions()
  definitions.length === expected.length
    ? ok('tool definitions', `${definitions.length} schemas`)
    : bad('tool definitions', `expected ${expected.length}, got ${definitions.length}`)
} catch (error) {
  bad('build tool registry', String(error.message).split('\n')[0])
}

try {
  const { deriveMessages, deriveUsage } = await load('dist/shared/session.js')
  const messages = deriveMessages([])
  Array.isArray(messages) && messages.length === 0
    ? ok('deriveMessages([]) is empty')
    : bad('deriveMessages([])', `got ${JSON.stringify(messages)}`)
  const usage = deriveUsage([])
  usage.inputTokens === 0 && usage.outputTokens === 0
    ? ok('deriveUsage([]) is zeroed')
    : bad('deriveUsage([])', JSON.stringify(usage))
} catch (error) {
  bad('session folds', String(error.message).split('\n')[0])
}

console.log(failed === 0 ? '\nmain-process smoke: OK\n' : `\nmain-process smoke: ${failed} failure(s)\n`)
process.exit(failed === 0 ? 0 : 1)
