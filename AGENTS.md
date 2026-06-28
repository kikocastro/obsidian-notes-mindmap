# Agent guide

Canonical instructions for coding agents in this repo. `CLAUDE.md` and `GEMINI.md` are symlinks to this file, so every tool reads one source.

## What this is

An Obsidian plugin that renders leveled left-to-right mind maps from note frontmatter links. One ` ```mindmap ` code block per map; config is inline YAML (see `README.md`).

## Architecture

- `src/graph.ts` — **pure core.** Zero imports, no `obsidian` coupling. Node collection, edges, visibility, layout, search. All unit-tested.
- `main.ts` — the **Obsidian adapter** and the only file importing `obsidian`. Owns DOM/SVG, the toolbar, pan/zoom, and the note `Modal`. It feeds plain data into the core and draws what the core returns.
- `styles.css` — theme-aware styling via Obsidian CSS variables.
- `test/` — vitest, exercising the core through plain `NoteLike` data (host-agnostic, no Obsidian runtime).

**Invariant: keep `src/graph.ts` host-free.** No `from "obsidian"`, no DOM. New pure logic and its tests go there; only rendering/vault glue goes in `main.ts`.

## Commands

```bash
npm run build      # typecheck (tsc --noEmit) + esbuild production -> main.js
npm run dev        # esbuild watch
npm test           # vitest run --coverage
npm run typecheck  # tsc --noEmit, strict + noUnused* + noImplicit*
```

Obsidian loads only `main.js`, `manifest.json`, `styles.css`. `main.js` is generated (gitignored).

## Conventions

- **TDD on the core.** Test-first for anything in `src/graph.ts`: red, watch it fail, green. Pre-commit and pre-push hooks run typecheck + tests.
- DOM code in `main.ts` is validated by build + manual Obsidian check (not unit-tested; the established split is "pure logic is tested, rendering is not").
- Mark deliberate simplifications with a `// ponytail:` comment naming the ceiling.

## Local install (personal, gitignored)

`.claude/skills/update-local-plugin/` builds and copies the runtime files into the local vaults. Vault folders live outside the workspace, so run it with the sandbox disabled and verify with a separate command.
