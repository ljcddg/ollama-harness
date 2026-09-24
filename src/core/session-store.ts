/**
 * Session persistence, one JSONL file per session.
 *
 * Why JSONL and not one JSON document: a session is an append-only event log, so
 * appending one line per event is the natural fit. It also means a crash mid-write
 * loses at most the last line, and a partially-written file is still replayable up
 * to the truncation point — with a JSON array, a half-written file is unreadable.
 *
 * Line 1 is always the header. Every subsequent line is one SessionEvent.
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionEvent, SessionHeader, SessionMeta } from '../shared/session.js'
import { SESSION_FORMAT_VERSION, deriveTitle } from '../shared/session.js'
import { asSessionId } from '../shared/message.js'

export class SessionStore {
  constructor(private readonly root: string) {}

  private fileFor(sessionId: string): string {
    return join(this.root, `${sessionId}.jsonl`)
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true })
  }

  /** Write a whole session. Uses a temp file + rename so readers never see a partial write. */
  async save(header: SessionHeader, events: readonly SessionEvent[]): Promise<void> {
    await this.ensureRoot()
    const target = this.fileFor(header.sessionId)
    const temp = `${target}.tmp-${process.pid}`
    const lines = [JSON.stringify(header), ...events.map((e) => JSON.stringify(e))]
    await writeFile(temp, `${lines.join('\n')}\n`, 'utf8')
    await rename(temp, target)
  }

  async load(sessionId: string): Promise<{ header: SessionHeader; events: SessionEvent[] } | null> {
    let raw: string
    try {
      raw = await readFile(this.fileFor(sessionId), 'utf8')
    } catch {
      return null
    }
    const lines = raw.split('\n').filter((l) => l.trim().length > 0)
    if (lines.length === 0) return null

    let header: SessionHeader
    try {
      header = JSON.parse(lines[0]!) as SessionHeader
    } catch {
      return null
    }
    if (header.version !== SESSION_FORMAT_VERSION) {
      // Refuse rather than misinterpret: a future format read as this one would
      // silently drop whatever the new version added.
      throw new Error(
        `Session ${sessionId} uses format version ${header.version}, but this build reads version ${SESSION_FORMAT_VERSION}.`,
      )
    }

    const events: SessionEvent[] = []
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!
      try {
        events.push(JSON.parse(line) as SessionEvent)
      } catch {
        // A truncated final line is the expected shape of a crash. Everything
        // before it is still valid, so stop here rather than discarding the file.
        break
      }
    }
    return { header, events }
  }

  async list(): Promise<SessionMeta[]> {
    await this.ensureRoot()
    let names: string[]
    try {
      names = await readdir(this.root)
    } catch {
      return []
    }
    const metas: SessionMeta[] = []
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const sessionId = name.slice(0, -'.jsonl'.length)
      const loaded = await this.load(sessionId).catch(() => null)
      if (!loaded) continue
      const { header, events } = loaded
      metas.push({
        ...header,
        path: this.fileFor(sessionId),
        messageCount: events.filter((e) => e.type === 'user/message').length,
        title: header.title || deriveTitle(events),
      })
    }
    metas.sort((a, b) => b.updatedAt - a.updatedAt)
    return metas
  }

  async remove(sessionId: string): Promise<void> {
    await rm(this.fileFor(sessionId), { force: true })
  }

  /** Build a fresh header for a new session. */
  static newHeader(sessionId: string, cwd: string): SessionHeader {
    const now = Date.now()
    return {
      version: SESSION_FORMAT_VERSION,
      sessionId: asSessionId(sessionId),
      cwd,
      title: '',
      createdAt: now,
      updatedAt: now,
    }
  }
}

/** Where sessions live under the user's home. Kept beside the app's own data. */
export function defaultSessionRoot(homeDir: string): string {
  return join(homeDir, 'sessions')
}
