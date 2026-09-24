/**
 * Config and session persistence for the main process.
 *
 * Config is a single JSON file under the user data directory. Writes are
 * debounced because settings are saved on every keystroke in some fields, and a
 * disk write per keystroke is both wasteful and a source of partial files.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { AppConfig } from '../shared/ipc.js'
import { DEFAULT_CONFIG } from '../shared/ipc.js'

export class ConfigStore {
  private cache: AppConfig | null = null
  private writeTimer: NodeJS.Timeout | null = null

  constructor(private readonly filePath: string) {}

  async load(): Promise<AppConfig> {
    if (this.cache) return this.cache
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AppConfig>
      // Merge over defaults so a config written by an older build is still valid
      // — missing keys take their default rather than becoming undefined.
      this.cache = { ...DEFAULT_CONFIG, ...parsed }
    } catch {
      this.cache = { ...DEFAULT_CONFIG }
    }
    return this.cache
  }

  async save(patch: Partial<AppConfig>): Promise<AppConfig> {
    const current = await this.load()
    const next = { ...current, ...patch }
    this.cache = next
    this.scheduleWrite(next)
    return next
  }

  private scheduleWrite(config: AppConfig): void {
    if (this.writeTimer) clearTimeout(this.writeTimer)
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null
      void this.writeNow(config)
    }, 250)
  }

  /** Force an immediate write — used on app quit, where a debounce would be lost. */
  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer)
      this.writeTimer = null
    }
    if (this.cache) await this.writeNow(this.cache)
  }

  private async writeNow(config: AppConfig): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    await writeFile(this.filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  }
}

export function configPath(userDataDir: string): string {
  return join(userDataDir, 'config.json')
}
