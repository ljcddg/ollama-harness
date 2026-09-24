/**
 * Electron main process entry.
 *
 * Responsibilities: create the window, wire IPC to the AgentService, and keep the
 * renderer sandboxed — `contextIsolation` on, `nodeIntegration` off, so the UI
 * can only reach the harness through the preload bridge. Everything privileged
 * (filesystem, child processes, network) happens on this side of that line.
 */

import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from 'electron'
import { cp, mkdir, open, readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentService } from './agent-service.js'
import { installAppMenu } from './menu.js'
import { ConfigStore, configPath } from '../core/config-store.js'
import { extractText, isDocumentPath } from '../core/extract.js'
import { SessionStore, defaultSessionRoot } from '../core/session-store.js'
import {
  IPC,
  type AgentStatus,
  type AppConfig,
  type ApprovalRequest,
  type FileAttachment,
  type MenuCommand,
} from '../shared/ipc.js'
import type { SessionId } from '../shared/message.js'
import { asSessionId, asToolCallId } from '../shared/message.js'
import type { SessionEvent } from '../shared/session.js'

const isDev = !app.isPackaged
const __dirname = fileURLToPath(new URL('.', import.meta.url))

// A GPU process that cannot start makes Electron abort with
// "GPU process isn't usable. Goodbye." — which happens inside containers, under
// restrictive sandboxes, and on machines with no usable driver. Chromium retries
// the GPU process a handful of times and then kills the whole app, taking the
// window with it.
//
// `--disable-gpu` alone is not enough: the GPU *process* still spawns and still
// fails. `--in-process-gpu` folds it into the browser process, so there is no
// separate process left to die, and `--disable-gpu-compositing` keeps the UI on
// the software path. A text interface loses nothing from this.
const GPU_FLAGS = ['--disable-gpu', '--enable-gpu', '--use-gl', '--use-angle', '--in-process-gpu']
const userChoseGpu = process.argv.some((arg) => GPU_FLAGS.some((flag) => arg.startsWith(flag)))
if (!userChoseGpu) {
  app.commandLine.appendSwitch('in-process-gpu')
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
  app.commandLine.appendSwitch('disable-software-rasterizer')
  app.commandLine.appendSwitch('disable-gpu-sandbox')
  app.commandLine.appendSwitch('no-sandbox')
}

let mainWindow: BrowserWindow | null = null
let service: AgentService | null = null
let configStore: ConfigStore | null = null

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 720,
    minHeight: 520,
    show: false,
    backgroundColor: '#faf9f5',
    title: 'Ollama Harness',
    webPreferences: {
      // `.cjs`, not `.js`: Electron require()s the preload and the package is
      // `"type": "module"`, so a `.js` preload would be treated as ESM and fail
      // to load. See tsconfig.preload.json and scripts/finalize-preload.mjs.
      preload: join(__dirname, '../preload/main/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  window.once('ready-to-show', () => window.show())

  // A renderer that fails to load shows an empty shell, which looks identical to
  // "the app started fine" — the toolbar paints but the body is blank. Surface the
  // real cause instead: a failed load, an uncaught exception, or a console error
  // from the page. Without this the window gives no clue at all.
  window.webContents.on('did-fail-load', (_e, code, description, url) => {
    console.error(`[renderer] failed to load ${url} (${code} ${description})`)
  })
  window.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[renderer] process gone: ${details.reason} (exit ${details.exitCode})`)
  })
  window.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) console.error(`[renderer console] ${message} (${source}:${line})`)
  })

  // External links open in the real browser rather than replacing the app shell.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // `--dev` / `--prod` override the packaged check. The heuristic alone cannot
  // express "run the production bundle without packaging it", which is exactly
  // what you want when verifying the file:// loading path.
  const forceProd = process.argv.includes('--prod')
  const forceDev = process.argv.includes('--dev')
  const useDevServer = forceProd ? false : forceDev || isDev

  if (useDevServer) {
    // Point the window at whatever port Vite actually landed on. Hardcoding 5173
    // means a port collision silently yields a blank window against a dead URL.
    const devUrl = process.env.VITE_DEV_SERVER_URL ?? `http://localhost:${process.env.VITE_PORT ?? '5173'}`
    console.log(`[main] loading ${devUrl}`)
    void window.loadURL(devUrl)
  } else {
    const file = join(__dirname, '../renderer/index.html')
    console.log(`[main] loading ${file}`)
    void window.loadFile(file)
  }

  return window
}

function pushToRenderer(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

/** Cap on how much of an attached file is inlined into the prompt. */
const MAX_ATTACHMENT_BYTES = 128 * 1024

/** Cap for documents, which are decoded first and are mostly non-text bytes. */
const MAX_ATTACHMENT_DOCUMENT_BYTES = 64 * 1024 * 1024

/** Extensions the file dialog offers on the "all text and code" branch. */
const TEXT_EXTENSIONS = [
  'txt', 'md', 'markdown', 'json', 'jsonc', 'yaml', 'yml', 'toml', 'ini', 'env', 'cfg', 'conf',
  'csv', 'tsv', 'log', 'xml', 'html', 'htm', 'css', 'scss', 'less', 'sql', 'sh', 'bash', 'ps1',
  'bat', 'cmd', 'py', 'java', 'kt', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'go', 'rs', 'rb',
  'php', 'c', 'h', 'cpp', 'hpp', 'cs', 'swift', 'vue', 'svelte',
]

/**
 * Read a file the user attached, for inlining into the next message.
 *
 * Two paths, because the two kinds of file fail differently:
 *
 * - Text goes through a utf8 read with the raw bytes checked for NUL first. A
 *   binary file inlined as mojibake wastes the context window and teaches the
 *   model nothing, so it is refused by name.
 * - Documents (PDF, docx) are decoded to text. This is the same extractor the
 *   `read` tool uses, so a file the user attached and a file the model opens
 *   itself produce identical text.
 *
 * `workdir` only decides whether the inlined excerpt is generous or capped —
 * the user picked this file through the OS dialog, which is a clearer statement
 * of intent than any path check.
 */
async function readAttachment(path: string, workdir?: string): Promise<FileAttachment> {
  const name = basename(path)
  try {
    const info = await stat(path)
    if (info.isDirectory()) {
      return { path, name, content: '', bytes: 0, truncated: false, error: '这是一个目录，不是文件' }
    }
    const bytes = info.size

    if (isDocumentPath(path)) {
      if (bytes > MAX_ATTACHMENT_DOCUMENT_BYTES) {
        return {
          path,
          name,
          content: '',
          bytes,
          truncated: false,
          error: `文件有 ${(bytes / 1024 / 1024).toFixed(1)} MB，太大了，无法内联。`,
        }
      }
      const buffer = await readFile(path)
      const result = extractText(path, new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength))
      if (result.error !== undefined) {
        return { path, name, content: '', bytes, truncated: false, error: result.error }
      }
      // Inside the working directory the excerpt can be generous; outside it,
      // keep the inlined portion small enough that it cannot push the actual
      // conversation out of the window.
      const insideWorkdir = isInside(workdir, path)
      const budget = insideWorkdir ? ATTACHMENT_DOCUMENT_BUDGET : ATTACHMENT_DOCUMENT_BUDGET_FAR
      const cut = result.text.length > budget
      const text = cut ? result.text.slice(0, budget) : result.text
      const notes = [...(result.notes ?? [])]
      if (cut) {
        notes.push(`只内联了前 ${budget.toLocaleString('zh-CN')} 个字符，后面还有 ${(result.text.length - budget).toLocaleString('zh-CN')} 个。需要后面的内容可以让我用 read 工具继续读。`)
      }
      return {
        path,
        name,
        content: notes.length > 0 ? `[${notes.join(' ')}]\n\n${text}` : text,
        bytes,
        truncated: cut || result.truncated,
      }
    }

    if (bytes > MAX_ATTACHMENT_BYTES) {
      // Still read the head rather than refusing: the top of a large log file
      // is frequently the part the user wants, and the flag says it was cut.
      const handle = await open(path, 'r')
      try {
        const take = Math.min(bytes, MAX_ATTACHMENT_BYTES)
        const buffer = Buffer.alloc(take)
        await handle.read(buffer, 0, take, 0)
        const extracted = extractText(path, new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength))
        if (extracted.error !== undefined) {
          return { path, name, content: '', bytes, truncated: false, error: extracted.error }
        }
        return { path, name, content: extracted.text, bytes, truncated: true }
      } finally {
        await handle.close()
      }
    }

    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(bytes)
      await handle.read(buffer, 0, bytes, 0)
      const extracted = extractText(path, new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength))
      if (extracted.error !== undefined) {
        return { path, name, content: '', bytes, truncated: false, error: extracted.error }
      }
      return { path, name, content: extracted.text, bytes, truncated: extracted.truncated }
    } finally {
      await handle.close()
    }
  } catch (error) {
    return {
      path,
      name,
      content: '',
      bytes: 0,
      truncated: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** How much of an attached document to inline, in characters. */
const ATTACHMENT_DOCUMENT_BUDGET = 60_000
const ATTACHMENT_DOCUMENT_BUDGET_FAR = 20_000

/** Cheap containment check on the resolved paths, case-insensitive on Windows. */
function isInside(root: string | undefined, target: string): boolean {
  if (!root) return false
  const normalize = (value: string): string => {
    const slashed = value.split('\\').join('/').replace(/\/+$/, '')
    return process.platform === 'win32' ? slashed.toLowerCase() : slashed
  }
  const base = normalize(resolve(root))
  const full = normalize(resolve(target))
  return full === base || full.startsWith(`${base}/`)
}

function registerIpc(agent: AgentService, config: ConfigStore): void {
  ipcMain.handle(IPC.invoke.listModels, async () => {
    try {
      return await agent.listModels()
    } catch (error) {
      // A refused connection is the single most likely failure here, and the UI
      // needs to tell the user "Ollama is not running" rather than show nothing.
      throw new Error(error instanceof Error ? error.message : String(error))
    }
  })

  ipcMain.handle(IPC.invoke.listSessions, async () => await agent.listSessions())

  ipcMain.handle(IPC.invoke.loadSession, async (_e, id: string) => {
    const loaded = await agent.loadSession(asSessionId(id))
    if (!loaded) throw new Error(`Session ${id} not found`)
    return loaded
  })

  ipcMain.handle(IPC.invoke.deleteSession, async (_e, id: string) => {
    await agent.deleteSession(asSessionId(id))
  })

  ipcMain.handle(IPC.invoke.createSession, async (_e, workdir?: string) => {
    const current = await config.load()
    // An explicit directory comes from the sidebar's "+" — either on a group, so
    // the session lands where the user clicked, or on the header, so it lands in
    // the folder the current conversation uses. The config value is only the
    // fallback for the very first conversation, when there is nothing to inherit.
    const dir = typeof workdir === 'string' && workdir.trim().length > 0 ? workdir : current.workdir
    // Not `process.cwd()`: for a packaged build that is the app bundle's own
    // directory, which is never somewhere the user wants an agent to work.
    return await agent.createSession(dir || app.getPath('home'), current.model)
  })

  ipcMain.handle(
    IPC.invoke.sendMessage,
    async (_e, req: { sessionId: string; text: string; attachments?: FileAttachment[] }) => {
      const current = await config.load()
      if (req.sessionId && agent.activeSessionId !== req.sessionId) {
        await agent.loadSession(asSessionId(req.sessionId))
      }
      await agent.send(req.text, current, req.attachments)
    },
  )

  ipcMain.handle(IPC.invoke.cancelTurn, async () => {
    agent.cancel()
  })

  ipcMain.handle(
    IPC.invoke.respondApproval,
    async (_e, callId: string, approved: boolean, remember: boolean) => {
      agent.resolveApproval(asToolCallId(callId), approved, remember === true)
    },
  )

  ipcMain.handle(IPC.invoke.getState, async () => ({
    config: await config.load(),
    sessions: await agent.listSessions(),
    activeSessionId: agent.activeSessionId,
    status: agent.currentStatus,
  }))

  ipcMain.handle(IPC.invoke.setModel, async (_e, model: string) => {
    await config.save({ model })
  })

  ipcMain.handle(IPC.invoke.setWorkdir, async (_e, dir: string) => {
    await config.save({ workdir: dir })
  })

  ipcMain.handle(IPC.invoke.pickDirectory, async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0] ?? null
  })

  ipcMain.handle(IPC.invoke.pickFiles, async () => {
    if (!mainWindow) return []
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        // Documents first: a PDF or a Word file is the reason this filter list
        // exists at all, and the OS dialog opens on the first entry.
        { name: '文档', extensions: ['pdf', 'docx', 'doc', 'odt', 'rtf'] },
        { name: '文本与代码', extensions: TEXT_EXTENSIONS },
        { name: '所有文件', extensions: ['*'] },
      ],
    })
    if (result.canceled) return []
    return result.filePaths
  })

  // The working directory is a fallback for how much of a document to inline,
  // not a permission boundary — the user picked the file through the OS dialog,
  // which is a stronger signal of intent than the path is.
  ipcMain.handle(IPC.invoke.readAttachment, async (_e, path: string, workdir?: string) =>
    readAttachment(path, workdir),
  )

  ipcMain.handle(IPC.invoke.reviewSession, async (_e, prompt: string) => {
    const current = await config.load()
    return await agent.review(prompt, current)
  })

  ipcMain.handle(IPC.invoke.getConfig, async () => await config.load())

  ipcMain.handle(IPC.invoke.setConfig, async (_e, patch: Partial<AppConfig>) => {
    const next = await config.save(patch)
    if (patch.ollamaBaseUrl !== undefined) await agent.reconfigure(next)
    return next
  })

  ipcMain.handle(
    IPC.invoke.editMessage,
    async (_e, sessionId: string, targetSeq: number, text: string) => {
      if (agent.activeSessionId !== sessionId) {
        await agent.loadSession(asSessionId(sessionId))
      }
      await agent.editMessage(targetSeq, text)
    },
  )

  ipcMain.handle(IPC.invoke.compactSession, async (_e, sessionId: string) => {
    const current = await config.load()
    if (agent.activeSessionId !== sessionId) {
      await agent.loadSession(asSessionId(sessionId))
    }
    return await agent.compactSession(current)
  })

  ipcMain.handle(IPC.invoke.writeClipboard, async (_e, text: string) => {
    // Through the main process rather than `navigator.clipboard` in the page:
    // the Async Clipboard API is gated on a secure context plus user-activation,
    // and under `file://` in production builds that combination is unreliable.
    // Electron's clipboard has neither restriction — and the renderer stays a
    // pure view, which is the rule this whole IPC surface is built around.
    clipboard.writeText(text)
  })

  ipcMain.handle(IPC.invoke.dataPath, async () => app.getPath('userData'))

  ipcMain.handle(IPC.invoke.revealPath, async (_e, path: string) => {
    if (typeof path !== 'string' || path.trim().length === 0) {
      return '没有可打开的路径'
    }
    // showItemInFolder needs an existing path, and the "folder" the user is
    // opening may have been deleted or renamed since the session was recorded.
    // Fall back to path.dirname so a stale file still lands somewhere useful
    // rather than silently doing nothing.
    try {
      const info = await stat(path)
      if (info.isDirectory()) {
        const error = await shell.openPath(path)
        return error === '' ? null : error
      }
      // Selects the file inside its folder, which is what "打开文件夹" should do
      // for a file path.
      shell.showItemInFolder(path)
      return null
    } catch {
      const parent = dirname(path)
      if (parent && parent !== path) {
        const error = await shell.openPath(parent)
        return error === '' ? null : error
      }
      return `路径不存在：${path}`
    }
  })
}

// Must run before the first `app.getPath('userData')`: Electron resolves the
// userData directory from the app name *once*, and a later setName only changes
// the display name — the folder would stay `ollama-harness` (the package name)
// while the window title says "Ollama Harness". Renaming later also strands any
// existing config and sessions in the old folder.
const APP_NAME = 'Ollama Harness'
const LEGACY_APP_NAME = 'ollama-harness'
app.setName(APP_NAME)

/**
 * `app.setName` changes where userData points from now on. Anyone who ran an
 * earlier build already has their config and sessions under the package-name
 * folder; without this they would silently reappear as a first run with no
 * history. Copy the old tree forward once, then leave the original in place as a
 * safety net rather than deleting the user's conversations.
 */
async function migrateLegacyUserData(current: string): Promise<void> {
  try {
    const parent = app.getPath('appData')
    const legacy = join(parent, LEGACY_APP_NAME)
    if (legacy === current || !existsSync(legacy)) return

    const carried = ['config.json', 'sessions']
    let moved = 0
    for (const name of carried) {
      const from = join(legacy, name)
      if (!existsSync(from)) continue
      const to = join(current, name)
      if (existsSync(to)) {
        // Already migrated (or a fresh install chose the same name): only fill
        // in the gaps so a newer session list is never overwritten by an older.
        if (name === 'sessions') moved += await mergeSessions(from, to)
        continue
      }
      await mkdir(current, { recursive: true })
      await cp(from, to, { recursive: true, errorOnExist: false })
      moved += 1
    }
    if (moved > 0) console.log(`[main] migrated ${moved} item(s) from ${legacy}`)
  } catch (error) {
    // Never let a migration problem stop the app from starting.
    console.error(`[main] userData migration failed: ${String(error)}`)
  }
}

/** Copy session files that the new directory does not already have. */
async function mergeSessions(from: string, to: string): Promise<number> {
  let copied = 0
  const entries = await readdir(from, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
    const target = join(to, entry.name)
    if (existsSync(target)) continue
    await cp(join(from, entry.name), target, { errorOnExist: false })
    copied += 1
  }
  return copied
}

void app.whenReady().then(async () => {
  const userData = app.getPath('userData')
  await migrateLegacyUserData(userData)
  configStore = new ConfigStore(configPath(userData))
  const loaded = await configStore.load()
  // First run: default the working directory to the user's documents, which is
  // the least surprising place for an agent to start.
  if (!loaded.workdir) {
    await configStore.save({ workdir: app.getPath('documents') })
  }

  const sessions = new SessionStore(defaultSessionRoot(userData))

  service = new AgentService({
    config: configStore,
    sessions,
    pushEvent: (sessionId: SessionId, event: SessionEvent) =>
      pushToRenderer(IPC.push.sessionEvent, sessionId, event),
    pushStatus: (status: AgentStatus) => pushToRenderer(IPC.push.status, status),
    // The renderer answers through `respondApproval`, which resolves the promise
    // the service is awaiting — so this hook only needs to deliver the prompt.
    pushApproval: (request: ApprovalRequest) => pushToRenderer(IPC.push.approvalRequest, request),
  })

  registerIpc(service, configStore)

  installAppMenu({
    getWindow: () => mainWindow,
    send: (command: MenuCommand) => pushToRenderer(IPC.push.menuCommand, command),
    userDataPath: () => app.getPath('userData'),
  })

  mainWindow = createWindow()
  await service.reconfigure(await configStore.load())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  // Flush a debounced config write that would otherwise be lost.
  void configStore?.flush()
})
