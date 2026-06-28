# Agent guide

Canonical instructions for coding agents in this repo. `CLAUDE.md` and `GEMINI.md` are symlinks to this file, so every tool reads one source.

## What this is

Leveled left-to-right mind maps from note frontmatter links, with **two adapters over one shared core**: an Obsidian plugin and a VS Code extension. One ` ```mindmap ` YAML block per map (see `README.md`).

## Architecture

- `src/graph.ts` — **pure core.** Zero imports, no host coupling. Node collection, edges, visibility, layout, search. All unit-tested. **Shared by both adapters.**
- `src/obsidian/main.ts` — **Obsidian adapter**, the only file importing `obsidian`. Owns DOM/SVG, toolbar, pan/zoom, the note `Modal`. Builds `main.js`.
- `src/vscode/` — **VS Code adapter.** `extension.ts` (host: reads workspace markdown, runs the core, posts a `payload.ts` view-model), `webview.ts` (pure SVG drawing + pan/zoom + click-to-open). Builds `dist/extension.js` + `dist/webview.js`.
- `styles.css` — Obsidian theming via CSS variables. (VS Code styling is inline in the webview, using `--vscode-*` vars.)
- `test/` — vitest, exercising the core through plain `NoteLike` data (host-agnostic).

**Invariant: keep `src/graph.ts` host-free.** No `from "obsidian"`, no `from "vscode"`, no DOM. New pure logic and its tests go there; only host glue goes in the adapters.

## Commands

```bash
npm run build      # typecheck + esbuild production -> main.js (Obsidian) + dist/ (VS Code)
npm run dev        # esbuild watch (all targets)
npm test           # vitest run --coverage
npm run typecheck  # tsc --noEmit, strict + noUnused* + noImplicit*
```

Obsidian loads `main.js` + `manifest.json` + `styles.css`. VS Code loads `dist/extension.js` (command **Markdown Mindmap: Open Map**) which reads the `mindmap` block from the active note. `main.js` and `dist/` are generated (gitignored).

## Conventions

- **TDD on the core.** Test-first for anything in `src/graph.ts`: red, watch it fail, green. Pre-commit and pre-push hooks run typecheck + tests.
- DOM code in `main.ts` is validated by build + manual Obsidian check (not unit-tested; the established split is "pure logic is tested, rendering is not").
- Mark deliberate simplifications with a `// ponytail:` comment naming the ceiling.

## Local install (personal, gitignored)

`.claude/skills/update-local-plugin/` builds and copies the runtime files into the local vaults. Vault folders live outside the workspace, so run it with the sandbox disabled and verify with a separate command.
