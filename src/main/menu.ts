/**
 * Application menu.
 *
 * Electron ships a default English menu when nobody installs one, which leaves
 * a fully translated UI with an English menubar hanging off the top — jarring,
 * and "Force Reload" is not discoverable if you do not already know the word.
 *
 * Roles are kept wherever a standard behaviour exists (`undo`, `copy`, `paste`,
 * …) so platform conventions stay intact; only the labels are Chinese.
 *
 * Menu items reach the UI through a single `push:menu-command` channel rather
 * than each item opening its own IPC call. The renderer owns focus and session
 * state, so it needs to be the one to decide what "new session" means right now
 * (for example: refuse while a turn is running). The menu just announces intent.
 */

import { app, type BrowserWindow, Menu, type MenuItemConstructorOptions, shell } from 'electron'
import type { MenuCommand } from '../shared/ipc.js'

interface MenuDeps {
  getWindow(): BrowserWindow | null
  /** Deliver a command to the renderer. */
  send(command: MenuCommand): void
  /** Absolute path of the userData directory, for "open data folder". */
  userDataPath(): string
}

export function installAppMenu(deps: MenuDeps): void {
  const run = (command: MenuCommand) => () => deps.send(command)

  const appMenu: MenuItemConstructorOptions[] =
    process.platform === 'darwin'
      ? [
        {
          label: app.getName(),
          submenu: [
            { role: 'about', label: `关于 ${app.getName()}` },
            { type: 'separator' },
            { role: 'hide', label: '隐藏' },
            { role: 'hideOthers', label: '隐藏其他窗口' },
            { role: 'unhide', label: '显示全部' },
            { type: 'separator' },
            { role: 'quit', label: '退出' },
          ],
        },
      ]
      : []

  const template: MenuItemConstructorOptions[] = [
    ...appMenu,

    {
      label: '文件',
      submenu: [
        {
          label: '新建会话',
          accelerator: 'CmdOrCtrl+N',
          click: run('session:new'),
        },
        { type: 'separator' },
        {
          label: '打开数据文件夹',
          // Where sessions and config actually live. Nobody should have to guess
          // that it is %APPDATA%\Ollama Harness\sessions.
          click: () => void shell.openPath(deps.userDataPath()),
        },
        { type: 'separator' },
        { role: 'close', label: '关闭窗口' },
      ],
    },

    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        // Mac apps get Paste and Match Style for free; adding it elsewhere would
        // show two spellings of the same action.
        ...(process.platform === 'darwin' ? [{ role: 'pasteAndMatchStyle' as const, label: '粘贴并匹配样式' }] : []),
        { role: 'selectAll', label: '全选' },
        { type: 'separator' },
        { role: 'delete', label: '删除' },
      ],
    },

    {
      label: '会话',
      submenu: [
        {
          label: '压缩上下文',
          // The mitigation for a long transcript outgrowing a local model's
          // window: summarise the early part so later turns still fit.
          click: run('session:compact'),
        },
        {
          label: '模型自审',
          // No accelerator: Cmd/Ctrl+R and Cmd/Ctrl+Shift+R are both reload
          // gestures baked into muscle memory, and borrowing one for a model
          // call would be a nasty surprise.
          click: run('session:review'),
        },
        { type: 'separator' },
        {
          label: '停止生成',
          accelerator: 'CmdOrCtrl+.',
          click: run('session:cancel'),
        },
        {
          label: '回到最新消息',
          click: run('view:back-to-latest'),
        },
        { type: 'separator' },
        {
          label: '设置',
          accelerator: 'CmdOrCtrl+,',
          click: run('view:settings'),
        },
      ],
    },

    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '切换开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏' },
      ],
    },

    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'front', label: '置于最前' },
      ],
    },

    {
      label: '帮助',
      submenu: [
        {
          label: 'Ollama 官网',
          click: () => void shell.openExternal('https://ollama.com'),
        },
        {
          label: 'Ollama 官方文档',
          click: () => void shell.openExternal('https://github.com/ollama/ollama/tree/main/docs'),
        },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
