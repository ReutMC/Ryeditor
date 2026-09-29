# AGENTS.md — Ryeditor project instructions

This file is read by the Ryeditor agent when working inside this repository.

## Project layout

- `src/main/` — Electron main process (Node.js): `main.ts` (IPC + window), `ai/providers.ts` (provider abstraction), `ai/tools.ts` (permissions + agent loop), `fsapi.ts`, `terminal.ts`, `settings.ts`
- `src/preload/preload.ts` — contextBridge API (`window.ry`)
- `src/renderer/` — plain-script renderer (`app.ts` compiled to `app.js`, no bundler, no imports)
- `scripts/build-renderer.mjs` — assembles `dist/renderer` (monaco `vs/`, xterm vendor files)
- `build/` — electron-builder resources (icon.ico / icon.png)

## Commands

- `npm run typecheck` — strict TS check (two tsconfigs)
- `npm run compile` — emit to `dist/` + assemble renderer assets
- `npm run smoke` — launch app with `--smoke-test` (prints `RYEDITOR_SMOKE_OK` on success)
- `npm run dist:win` — Windows NSIS installer + portable exe via electron-builder

## Conventions

- Renderer is a single plain script: **no `import`/`export`** in `src/renderer/app.ts`.
- Main/preload use CommonJS; strict TypeScript everywhere.
- Never weaken the permission classifier in `ai/tools.ts`; new shell utilities go into SAFE/CONFIRMATION lists explicitly.
- Brand colors: blue `#2F6FED`, teal `#2BD9C7`, dark base `#0B1220`. Do not introduce new accent colors.
- Do not commit API keys or tokens. Settings live in `~/.ryeditor/settings.json` at runtime.
