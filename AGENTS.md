# Repository Guidelines

## Project Structure & Module Organization
- `src/background/`: extension background orchestration, runtime messaging, caching, and Reddit JSON fetch logic.
- `src/content/`: in-page extraction logic (`extractRedditPost`) used via `browser.scripting.executeScript`.
- `src/pages/`: Reader UI (`reader-host.ts`, HTML, CSS, and style tokens/components).
- `src/shared/`: shared cross-cutting utilities (for example, payload/session token helpers).
- `src/tests/`: Vitest suites for background, extraction, UI logic, loading states, and coverage paths.
- `dist/`: build output consumed by Firefox/web-ext.
- `manifest.json`, `build.js`: extension manifest and bundling pipeline entrypoints.

## Build, Test, and Development Commands
- `pnpm build`: clean and bundle into `dist/`.
- `pnpm dev`: watch build for local iteration.
- `pnpm lint`: run ESLint (TS + Node scripts).
- `pnpm lint:fix`: apply ESLint auto-fixes.
- `pnpm typecheck`: run strict TypeScript checks (`tsc -p tsconfig.json`).
- `pnpm test`: run all Vitest tests.
- `pnpm test:coverage`: run tests with V8 coverage report.
- `pnpm start:firefox`: run extension in Firefox via `web-ext`.
- `pnpm package`: build installable artifact from `dist/`.
- `pnpm release:patch|minor|major`: run local release orchestration (preflight, version bump, commit/tag/push).
- `pnpm release:fix-assets -- --tag <vX.Y.Z> --version <X.Y.Z>`: rebuild/package and upload missing release artifact to an existing GitHub release tag.

## Coding Style & Naming Conventions
- Language: TypeScript (ES modules, strict mode).
- Indentation: 4 spaces; keep semicolons and explicit types in public/shared paths.
- Naming: `camelCase` for functions/variables, `PascalCase` for types/interfaces, `UPPER_SNAKE_CASE` for module-level constants.
- Prefer small, focused modules in `src/background/` and `src/shared/` over large monoliths.
- Important: injected content function must stay self-contained (no runtime import dependency inside `extractRedditPost`).

## Testing Guidelines
- Framework: Vitest with Happy DOM.
- Test files use `*.test.ts` under `src/tests/`.
- Add regression tests for bug fixes, especially around:
  - crosspost metadata/permalink behavior,
  - async comments loading/races,
  - background runtime message handling and caches.
- This repo commonly ships via direct commits to `main`; run `pnpm test` before pushing to `main` and before tagging a release.
- Run `pnpm test:coverage` for non-trivial changes.

## Commit & Pull Request Guidelines
- Commit style in history is short, imperative, and scoped (examples: `a11y hardening`, `Harden pending payload handling...`).
- Prefer concise commit subjects describing user-visible or risk-reducing change.
- If using PRs, include:
  - clear summary and rationale,
  - testing evidence (commands + outcomes),
  - screenshots/GIFs for Reader UI changes,
  - notes on extension behavior changes (open mode, comments, extraction, caching).
