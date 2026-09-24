/**
 * Preload bridge.
 *
 * The only thing the renderer can reach. Every method here is an explicit
 * capability — there is no generic `invoke(channel, ...)` escape hatch, because
 * that would hand the UI the entire IPC surface and defeat context isolation.
 *
 * ── Why this file has no runtime imports from src/shared ─────────────────────
 * Electron loads preload scripts with `require()`. The root package.json declares
 * `"type": "module"`, so every `.js` in this package is an ES module as far as
 * Node is concerned, and require() of one throws ERR_REQUIRE_ESM — the bridge
 * never installs, `window.harness` is undefined, and React dies on its first IPC
 * call, leaving the window painted but empty.
 *
 * The fix is to ship this file as `.cjs`, and the only way tsc can output a
 * single unambiguous CommonJS file is if it imports nothing at runtime. So the
 * types below are `import type` (erased at compile time) and the channel names
 * are inlined literals.
 *
 * `src/shared/ipc.ts` stays canonical. `scripts/check-core.mjs` asserts that the
 * `CH` table below and `IPC` there agree, so a rename on one side fails the
 * build rather than silently breaking IPC at runtime.
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { AgentStatus, ApprovalRequest, AppConfig, HarnessBridge, MenuCommand } from '../shared/ipc.js'
import type { SessionId, ToolCallId } from '../shared/message.js'
import type { SessionEvent } from '../shared/session.js'

/** Mirrors `IPC.invoke` / `IPC.push` in src/shared/ipc.ts. */
const CH = {
  listModels: 'models:list',
  listSessions: 'sessions:list',
  loadSession: 'sessions:load',
  deleteSession: 'sessions:delete',
  createSession: 'sessions:create',
  sendMessage: 'agent:send',
  cancelTurn: 'agent:cancel',
  respondApproval: 'agent:approval',
  getState: 'agent:state',
  setModel: 'agent:set-model',
  setWorkdir: 'agent:set-workdir',
  pickDirectory: 'dialog:pick-directory',
  pickFiles: 'dialog:pick-files',
  readAttachment: 'files:read-attachment',
  reviewSession: 'agent:review',
  getConfig: 'config:get',
  setConfig: 'config:set',
  editMessage: 'agent:edit-message',
  compactSession: 'agent:compact',
  writeClipboard: 'clipboard:write',
  dataPath: 'app:data-path',
  revealPath: 'shell:reveal-path',
  sessionEvent: 'push:session-event',
  status: 'push:status',
  approvalRequest: 'push:approval-request',
  menuCommand: 'push:menu-command',
} as const

// Ids are branded strings; the brand is compile-time only, so a cast is the
// honest way to re-attach it on this side of the process boundary.
const sessionId = (value: string) => value as SessionId
const toolCallId = (value: string) => value as ToolCallId

const bridge: HarnessBridge = {
  listModels: () => ipcRenderer.invoke(CH.listModels),
  listSessions: () => ipcRenderer.invoke(CH.listSessions),
  loadSession: (id: SessionId) => ipcRenderer.invoke(CH.loadSession, id),
  deleteSession: (id: SessionId) => ipcRenderer.invoke(CH.deleteSession, id),
  createSession: (workdir?: string) => ipcRenderer.invoke(CH.createSession, workdir),
  sendMessage: (req) => ipcRenderer.invoke(CH.sendMessage, req),
  cancelTurn: () => ipcRenderer.invoke(CH.cancelTurn),
  respondApproval: (callId: ToolCallId, approved: boolean) =>
    ipcRenderer.invoke(CH.respondApproval, callId, approved),
  getState: () => ipcRenderer.invoke(CH.getState),
  setModel: (model: string) => ipcRenderer.invoke(CH.setModel, model),
  setWorkdir: (dir: string) => ipcRenderer.invoke(CH.setWorkdir, dir),
  pickDirectory: () => ipcRenderer.invoke(CH.pickDirectory),
  pickFiles: () => ipcRenderer.invoke(CH.pickFiles),
  readAttachment: (path: string, workdir?: string) =>
    ipcRenderer.invoke(CH.readAttachment, path, workdir),
  reviewSession: (prompt: string) => ipcRenderer.invoke(CH.reviewSession, prompt),
  getConfig: () => ipcRenderer.invoke(CH.getConfig),
  setConfig: (patch) => ipcRenderer.invoke(CH.setConfig, patch),
  editMessage: (id: SessionId, targetSeq: number, text: string) =>
    ipcRenderer.invoke(CH.editMessage, id, targetSeq, text),
  compactSession: (id: SessionId) => ipcRenderer.invoke(CH.compactSession, id),
  writeClipboard: (text: string) => ipcRenderer.invoke(CH.writeClipboard, text),
  dataPath: () => ipcRenderer.invoke(CH.dataPath),
  revealPath: (path: string) => ipcRenderer.invoke(CH.revealPath, path),

  onSessionEvent: (fn) => {
    const handler = (_event: unknown, id: string, event: SessionEvent): void =>
      fn(sessionId(id), event)
    ipcRenderer.on(CH.sessionEvent, handler)
    return () => ipcRenderer.removeListener(CH.sessionEvent, handler)
  },

  onStatus: (fn) => {
    const handler = (_event: unknown, status: AgentStatus): void => fn(status)
    ipcRenderer.on(CH.status, handler)
    return () => ipcRenderer.removeListener(CH.status, handler)
  },

  onApprovalRequest: (fn) => {
    const handler = (_event: unknown, request: ApprovalRequest): void =>
      fn({ ...request, callId: toolCallId(String(request.callId)) })
    ipcRenderer.on(CH.approvalRequest, handler)
    return () => ipcRenderer.removeListener(CH.approvalRequest, handler)
  },

  onMenuCommand: (fn) => {
    const handler = (_event: unknown, command: MenuCommand): void => fn(command)
    ipcRenderer.on(CH.menuCommand, handler)
    return () => ipcRenderer.removeListener(CH.menuCommand, handler)
  },
}

contextBridge.exposeInMainWorld('harness', bridge)

export type { AppConfig }
