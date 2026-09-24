/**
 * Which working directory does a turn actually run in?
 *
 * Regression guard for a real report: the sidebar showed a conversation under
 * `D:\desktop1\test` while the model answered "当前的默认工作目录是
 * D:\desktop1\论文" — the global workdir — because `AgentService.send` preferred
 * `config.workdir` over the session header.
 *
 * It drives real turns through the real AgentService with a recording adapter,
 * so what is asserted is the system prompt the model would receive, not an
 * intermediate variable. No network and no Ollama: the response is synthetic.
 *
 * Usage: node scripts/probe-cwd.mjs
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentService } from '../dist/main/agent-service.js'
import { ConfigStore } from '../dist/core/config-store.js'
import { SessionStore } from '../dist/core/session-store.js'
import { DEFAULT_CONFIG } from '../dist/shared/ipc.js'

/** The folder the user is actually in. */
const TEST_DIR = 'D:\\desktop1\\test'
/** The folder the global default points at — deliberately a different one. */
const OTHER_DIR = 'D:\\desktop1\\论文'
const DELETED_DIR = 'D:\\definitely\\not\\here'

let failures = 0

function check(label, actual, expected) {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${label}`)
  if (!ok) {
    console.log(`        got      ${JSON.stringify(actual)}`)
    console.log(`        expected ${JSON.stringify(expected)}`)
  }
}

/** An adapter that records the request and replies with one fixed sentence. */
function recordingAdapter(seen) {
  return {
    provider: 'probe',
    async listModels() {
      return []
    },
    async *stream(options) {
      seen.push(options.systemPrompt)
      yield { type: 'text-delta', text: '好的。' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

/** Pull the working-directory line back out of the system prompt. */
function cwdFrom(systemPrompt) {
  const match = /^- Working directory: (.*)$/m.exec(systemPrompt)
  return match ? match[1].trim() : '(no working directory line)'
}

const root = await mkdtemp(join(tmpdir(), 'harness-cwd-'))
const config = new ConfigStore(join(root, 'config.json'))
await config.save({ ...DEFAULT_CONFIG, model: 'probe:model', workdir: OTHER_DIR })

function makeService(dirName) {
  const service = new AgentService({
    config,
    sessions: new SessionStore(join(root, dirName)),
    pushEvent: () => {},
    pushStatus: () => {},
    pushApproval: () => {},
  })
  const seen = []
  // `adapter` is private in TypeScript, which is erased at runtime. Injecting
  // here keeps the test on the real orchestration path instead of a stub.
  service.adapter = recordingAdapter(seen)
  return { service, seen }
}

const loaded = await config.load()
const { service, seen } = makeService('sessions')

console.log('working directory resolution\n')

console.log('case A — the open conversation owns its directory')
await service.createSession(TEST_DIR, loaded.model)
await service.send('当前工作目录是什么', loaded)
check('runs in the session folder, not the global default', cwdFrom(seen.at(-1)), TEST_DIR)

console.log('\ncase B — a second conversation in a different folder')
const { service: other, seen: seenB } = makeService('sessions-b')
await other.createSession(OTHER_DIR, loaded.model)
await other.send('这里呢', loaded)
check('the other conversation uses its own folder', cwdFrom(seenB.at(-1)), OTHER_DIR)

console.log('\ncase C — switching sessions does not leak the previous folder')
await service.createSession(OTHER_DIR, loaded.model)
await service.send('再看一次', loaded)
const first = (await service.listSessions()).find((s) => s.cwd === TEST_DIR)
await service.loadSession(first.sessionId)
await service.send('回到第一个', loaded)
check('the reopened conversation is back in its own folder', cwdFrom(seen.at(-1)), TEST_DIR)

console.log('\ncase D — a session with no recorded directory falls back')
await service.createSession('', loaded.model)
await service.send('没有记录目录', loaded)
check('empty header falls back to the configured default', cwdFrom(seen.at(-1)), OTHER_DIR)

console.log('\ncase E — a session whose folder no longer exists')
// The folder being gone is something the agent should report, not paper over.
// Falling back to a directory that DOES exist would have it read the wrong
// files while sounding confident, which is worse than a clear error.
await service.createSession(DELETED_DIR, loaded.model)
await service.send('还在吗', loaded)
check('a missing folder is named, not swapped for a valid one', cwdFrom(seen.at(-1)), DELETED_DIR)

console.log()
if (failures > 0) {
  console.log(`RESULT: FAIL (${failures})`)
  process.exit(2)
}
console.log('RESULT: OK — the session header, not the global workdir, decides')
