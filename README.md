# Ryeditor

**Ryeditor** is an original, AI-native code editor built with Electron + TypeScript + Monaco.
It is not a fork of VS Code or any existing editor — all code, name and assets in this repository are original.

![brand](assets/icon.svg)

## Features (v0.1.0)

- **Multi-provider AI** — OpenAI · Anthropic · Gemini · OpenAI-compatible (LM Studio, vLLM, custom) · **Ollama (local & free)**
- **Three AI modes** — *Ask* (read-only chat) · *Plan* (review plan, then approve execution) · *Agent* (multi-step autonomous execution with tool calls)
- **Permission system** — commands are classified **SAFE / CONFIRMATION / DANGEROUS / BLOCKED**; file writes always require approval; workspace path-guarding prevents escapes
- **Inline autocomplete** — ghost text via your configured "autocomplete" model (independent of the agent model), plus `Alt+\` direct insert
- **Real terminal** — node-pty when available, real shell process fallback (`node-pty` vs `child_process` backend is shown honestly in the UI)
- **Monaco editor** — tabs, dirty markers, 25+ languages, custom brand themes
- **AGENTS.md support** — workspace `AGENTS.md` is injected into the agent system prompt
- **Project memory** — persistent per-workspace notes included in every AI request
- **Checkpoints** — every AI file-write snapshots the previous content; one-click revert
- **Command palette** (`Ctrl+Shift+P`), **3 themes** (dark brand / light / high-contrast)

## Build

```bash
npm install
npm run build          # typecheck + compile + assemble renderer
npm start              # run the app from source
npm run dist:win       # Windows NSIS installer + portable .exe
npm run dist:linux     # Linux AppImage
```

CI builds the Windows `.exe` on every push to `main` (see `.github/workflows/build.yml`);
pushing a tag `v*` publishes a GitHub Release with the installer + portable exe.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `Ctrl+O` | Open folder |
| `Ctrl+S` | Save file |
| `Ctrl+\`` | Toggle terminal |
| `Ctrl+Shift+P` | Command palette |
| `Alt+\` | Insert AI suggestion at cursor |
| `Enter` (AI input) | Send message |

## Honest limitations (v0.1.0)

- Tool-calling uses a documented fenced-block convention (` ```rytool `), not provider-native function calling — maximally portable across providers, but less structured.
- Autocomplete quality depends entirely on the configured model; small local models may produce noisy suggestions.
- No code signing — Windows SmartScreen may warn on first run (expected for unsigned OSS installers).
- MCP (Model Context Protocol) and embedded browser preview are on the roadmap, not in v0.1.0.

## License

MIT © Ryeditor Contributors
