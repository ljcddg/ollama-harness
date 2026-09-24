---
description: How to build, check and commit a change in the ollama-harness repository — the exact commands, and the traps that have actually bitten.
---

# Verifying a change to this repository

## Run the gates with `node`, not `npm run`

`npm run <script>` does not work in this project's Git Bash: the shell shim has no
`dirname`, so npm's launcher aborts before the script starts. Call the scripts
directly, with an absolute path to the managed Node binary if `node` is not on
`PATH`:

    node scripts/check-core.mjs
    node scripts/run-smoke.mjs
    node scripts/probe-cwd.mjs
    node scripts/check-deps.mjs
    node scripts/check-load.mjs
    node node_modules/typescript/bin/tsc -p tsconfig.main.json

## The order that catches the most, earliest

1. Typecheck all three projects — they are separate and all three must be clean:
   `tsc -p tsconfig.json --noEmit`, then `tsconfig.main.json`, then
   `tsconfig.preload.json`.
2. Build what the checks read. `check-core` imports from `dist/`, so it tests the
   **compiled** output; running it before a build silently checks the previous
   one:
   `tsc -p tsconfig.main.json`, `tsc -p tsconfig.preload.json`,
   `node scripts/finalize-preload.mjs`.
3. `node scripts/check-core.mjs` — the assertion suite. Read the count, do not
   just look for green.
4. `node scripts/check-deps.mjs` and `node scripts/check-load.mjs`.
5. `node node_modules/vite/bin/vite.js build` for the renderer.
6. Anything touching the UI also needs `node scripts/probe-render.mjs --prod`,
   and the matching `probe-*.mjs` for the surface you changed.

## Things that will bite

- **Never run `git stash` in this environment.** A `git stash push -u` removed the
  entire `.git` directory once. If you need the pre-change version of a file, copy
  it aside instead.
- `.gitattributes` pins LF. Do not let an editor rewrite line endings.
- Adding or removing a tool means updating the `expected` list in
  `scripts/smoke-main.mjs` in the same change, or `check:smoke` fails.
- `check-core` asserts that `dist/shared/ipc.js` agrees with the channel table in
  `src/main/preload.ts`, so a new IPC channel means editing several places at once.
- The app is pinned to a software raster path, so `backdrop-filter` and large
  blurs cost a full-window CPU blur every frame. There is a probe that shouts if
  one comes back.

## Before you say you are done

Report **which** gates you ran and **what they printed**. "The gates pass" is not
evidence; the counts are.
