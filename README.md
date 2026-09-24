# Ollama Harness

A local-first coding agent for [Ollama](https://ollama.com) models. Electron app,
React UI, no cloud dependency — your prompts and your code never leave the machine.

## What it does

You describe a change. The agent reads the relevant files, edits them, runs
whatever verifies the work, and tells you what it did. It has six tools: `read`,
`glob`, `grep`, `edit`, `write`, `bash`.

## Requirements

- Node 22+
- [Ollama](https://ollama.com/download) running locally (`ollama serve`)
- At least one model pulled, e.g. `ollama pull qwen2.5:7b`

A 7B-class model is the practical floor for tool calling. Smaller models work but
lose the thread across long tool sequences.

## Getting started

```bash
npm install
npm run dev
```

`npm run build && npm start` runs the built app. `npm run typecheck` checks both
the Node and browser TypeScript projects.

`npm run check:all` is the full health check and is worth running after any
dependency change. It runs, in order: both type checks, the core logic tests,
the dependency loader check, the dependency structure check, the renderer build,
a smoke test that loads the compiled main process inside Electron's own runtime,
and a render probe that confirms the UI actually mounts.

| Command | What it verifies |
|---|---|
| `npm run typecheck` | all three TypeScript projects compile |
| `npm run check` | 22 assertions over the log fold, assembler, arg validation, glob, and the preload contract |
| `npm run check:load` | every installed package can actually be `require`d |
| `npm run check:deps` | every package's declared entry points resolve on disk |
| `npm run check:smoke` | the compiled bundle loads under Electron's Node |
| `npm run check:render` | the built app opens a window and React mounts |

If anything behaves oddly after an interrupted install, `check:load` is the
command that finds it. npm will not refetch a package it believes is present, so
a half-extracted dependency stays broken and silent until something imports it.

`check:render` is the one to reach for when the window opens but shows nothing.
It launches the built app with a debugging port and asks the page whether React
mounted, so a blank window is a failing assertion rather than a mystery. Point it
at the dev server with `npm run check:render:dev`.

## How it is put together

```
src/
  shared/          vocabulary shared by every layer
    message.ts       provider-neutral message + streaming types
    session.ts       the event log and the folds that derive state from it
    ipc.ts           the main↔renderer contract
  core/            no Electron imports — runs in plain Node
    llm/
      adapter.ts       the LlmAdapter base class
      ollama-adapter.ts  Ollama's /api/chat NDJSON protocol
      assembler.ts     folds StreamChunks into content blocks
    tools/           the six tools plus path containment
    loop.ts          the agent loop
    prompt.ts        system prompt assembly
    session-store.ts JSONL persistence
  main/            Electron main process
    agent-service.ts   orchestrates loop + adapter + store
    main.ts            window, IPC handlers, lifecycle
    preload.ts         the contextBridge surface (compiled to CommonJS)
  renderer/        React UI
    hooks/useHarness.ts  folds pushed events into the node tree
    components/
```

The main process is built as ES modules, except for `preload.ts`, which Electron
loads with `require()` and so must be CommonJS. `tsconfig.preload.json` compiles
it alone, and `scripts/finalize-preload.mjs` renames it to `.cjs`. Because the
preload cannot import `shared/ipc.ts` at runtime under that constraint, it
inlines the channel names — and `npm run check` asserts those copies still match.

### Three decisions worth knowing

**The request is derived, never mutated.** Every model call rebuilds its message
list by folding the session log. Nothing accumulates in a "current messages"
variable. That is what makes cancel, resume, and replay exact rather than
approximately right — and it is why `deriveMessages` in `shared/session.ts` is
the most important function in the repo.

**Adapters are the only provider-aware code.** `shared/message.ts` defines a
provider-neutral vocabulary; an adapter translates between it and one wire
protocol. Adding a provider means writing one adapter, not touching the loop, the
tools, or the UI. The Ollama adapter lives in `core/llm/ollama-adapter.ts`.

**The renderer is a pure view.** It talks to Ollama only through IPC, and it
rebuilds the conversation by folding the same events the main process does. The
two can never disagree about what the conversation contains, because they run the
same fold.

## Adding a tool

Implement the `Tool` interface in `src/core/tools/` and register it in
`createDefaultRegistry()`. The JSON Schema you write *is* the prompt the model
sees, so it is worth writing carefully — `validateArgs` enforces it before your
`execute` runs.

If the tool can change the user's files, add its name to `MUTATING_TOOLS` so it
becomes an approval candidate.

## Adding a provider

Subclass `LlmAdapter` from `src/core/llm/adapter.ts`. You need to implement
`stream()` (yielding `StreamChunk`s and a terminal `finish`) and `listModels()`.
Then pick your adapter in `AgentService.buildAdapter()`.

Two rules the loop depends on: yield a `finish` chunk on success, and *throw*
rather than ending the stream silently — an adapter that returns without
finishing makes a truncated answer look complete.

## Configuration

Stored in the Electron user-data directory as `config.json`:

| Key | Meaning |
|---|---|
| `ollamaBaseUrl` | Ollama endpoint, default `http://127.0.0.1:11434` |
| `model` | Selected model id |
| `workdir` | Directory the tools operate in |
| `temperature` | Sampling temperature |
| `maxTokens` | Per-request output cap |
| `approvalRequiredFor` | Tools that must be confirmed before each run |

Sessions are stored beside it, one JSONL file per session.

## Troubleshooting

Failures that cost real time during setup, recorded so they are cheap next time.

### The window opens but the body is blank

The most misleading failure in an Electron app, because a crashed renderer looks
exactly like a healthy one: the chrome paints, the body is empty, and the main
process logs nothing. `npm run check:render` reports which of these it is.

The causes seen here, in the order they appeared:

**The preload failed to load, so `window.harness` was undefined.** Electron loads
preload scripts with `require()`. This package is `"type": "module"`, so every
`.js` in it is an ES module to Node — require() of one throws `ERR_REQUIRE_ESM`,
the bridge never installs, and the first IPC call in `useHarness` throws. The
whole React tree unmounts and `#root` goes empty. So the preload is compiled
separately to `dist/preload/main/preload.cjs` (see `tsconfig.preload.json`),
`scripts/finalize-preload.mjs` asserts it stays self-contained, and
`src/main/preload.ts` inlines its channel names so it needs no runtime imports.
`npm run check` guards both properties.

**The Content-Security-Policy blocked an inline script.** Vite injects its HMR
client as an inline `<script>`, and `script-src 'self'` blocks inline scripts
outright — so React never even starts. The policy therefore differs by mode: dev
allows `'unsafe-inline'` and `ws:`, production allows neither. It is injected by
the `ollama-harness-csp` plugin in `vite.config.ts` rather than written into
`index.html`, because the two modes need different policies and a hardcoded one
is wrong for one of them.

**The GPU process could not start, and Electron killed itself.** Chromium retries
the GPU process several times and then aborts with `GPU process isn't usable.
Goodbye.`, taking the window down with it. `--disable-gpu` alone does not help —
the GPU process still spawns and still fails. `--in-process-gpu` folds it into
the browser process so there is no separate process left to die, and that is what
`main.ts` sets when no GPU flag was passed. The remaining `Unable to move the
cache` / `Gpu Cache Creation failed` lines are noise.

### Install problems

**`npm error Invalid Version:`** — a corrupt `package-lock.json` entry with a
null `version` field crashes npm's dedupe pass before it can build the tree. The
lockfile is the authority, so a bad entry poisons every later install. Fix:
delete `package-lock.json` and reinstall; npm regenerates it from the manifest.

**A package exists but its files do not.** An interrupted install can leave a
directory holding only `package.json`. npm sees the package as present and never
refetches it. `npm run check:load` finds these by requiring each package in turn,
which is the only check that catches a package whose entry point resolves but
whose entry point then requires a file that was never extracted. Fix: delete the
offending directories and reinstall.

**Vite fails with `Cannot find module '.../dist/index.mjs'`.** That is the
symptom of the above, not a Vite bug — the dependency's `exports` map points at
a file that was never extracted.

**Electron's binary did not download.** `node_modules/electron/install.js`
fetches ~110 MB from GitHub, which can stall. Point it at a mirror
(`ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`) or download
`electron-v<version>-win32-x64.zip` yourself and extract it into
`node_modules/electron/dist`, then confirm `dist/version` matches the version in
`node_modules/electron/package.json`. The mirror's `SHASUMS256.txt` is a valid
check on the download.

Note that `electron --version` can report a system Electron rather than the one
in `node_modules`. Read `node_modules/electron/dist/version` when it matters.

### Config details that are easy to get wrong

- `tsconfig.main.json` needs `"DOM"` in `lib`, because the main process uses
  `fetch` and `Response`.
- Both projects use `module`/`moduleResolution: "NodeNext"`, which is what lets
  a `./foo.js` import resolve to `foo.ts`. Switching to `"bundler"` breaks every
  relative import with `TS2307`.
- `npm run build:main` deletes `dist/{main,core,shared,preload}` first. This is
  not tidiness: a stale `dist/main/preload.js` beside the real `preload.cjs` can
  be loaded instead, which is one of the ways the window goes blank.

## Safety

`bash` executes whatever the model writes — that is the point of a local agent,
and it is also the largest risk here. The mitigations:

- `bash` and the write tools are approval candidates; add them to
  `approvalRequiredFor` to guard them.
- Destructive command shapes (`rm -rf`, `git push --force`, piping a download
  into a shell, and others) always prompt, even when `bash` is not guarded.
- File tools resolve every path through `resolveToolPath`, which realpaths the
  deepest existing ancestor so a symlink cannot escape the working directory
  unnoticed. Paths outside the workdir require approval.
- The renderer runs with `contextIsolation: true` and `nodeIntegration: false`.

The file boundary is deliberately soft — the user can approve — because a coding
agent that cannot touch anything outside its cwd is not much use.

## License

MIT
