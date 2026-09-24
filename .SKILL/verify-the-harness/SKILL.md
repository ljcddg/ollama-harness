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
- A skill in `.SKILL/` is only live if the loader accepts it: a bundle
  (`<name>/SKILL.md`), or a flat `.md` that opens with `---`; a kebab-case name
  (taken from the path, so there is no `name:` field); and a `description`, which
  is the only thing routing reads. A malformed one is reported in the prompt
  rather than skipped, so it fails late — confirm it is discovered, not merely
  written:

      node -e "import('./dist/core/skills.js').then(m => m.discoverSkills(process.cwd()).then(c => console.log(c.skills.map(s => s.name), c.problems)))"

- **Deletions go through the `delete` tool, not the shell.** `rm`, `del`, `erase`,
  `rd`, `rmdir` and `Remove-Item` are all in the shell guard's `DANGEROUS_PATTERNS`.
  The guard is there because `del /q *.*` once removed 2 files out of 27, printed
  nothing and exited 0, so nothing in the output could contradict the model
  reporting that it had emptied the directory.

- **A recycle-bin delete cannot be judged by an exit code or an exception.**
  Measured on this machine: `Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile`
  and `DeleteDirectory` with `SendToRecycleBin` throw
  `MethodInvocationException: 无法找到指定文件` on every *successful* deletion. That
  is why `src/core/tools/delete.ts` re-checks the path afterwards and treats the
  platform's output as diagnostics only. To verify the real path end to end, run
  the throwaway probe if it is still in `.trash/`:
  `node .trash/tmp-probe-delete-live.mjs` — it bins three test files and does not
  empty the bin.

## Before you say you are done

Report **which** gates you ran and **what they printed**. "The gates pass" is not
evidence; the counts are.
