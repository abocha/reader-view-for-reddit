# Reader View for Reddit

Firefox extension that opens Reddit posts in a clean, distraction-free Reader View page (native Firefox Reader View doesn’t support Reddit well).

## Documentation Map

This repository uses in-repo documentation as the system of record.

- `README.md` (this file): install, usage, packaging, and quick-start development.
- `DESIGN.md`: architecture map, invariants, and dependency boundaries.
- `RELIABILITY.md`: failure modes, recovery behavior, and regression checklist.
- `SECURITY.md`: trust boundaries, sanitization rules, and security review checklist.
- `PLANS.md`: how to write lightweight and execution plans.
- `plans/templates/lightweight-plan.md`: template for small scoped changes.
- `plans/templates/execution-plan.md`: template for multi-step/complex work.

## Usage

- **Open Reader View**
  - Click the extension icon, or use the keyboard shortcut (default: `Alt+Shift+R`).
  - Right-click on a Reddit post page → `Read in Reader View`.
  - Right-click a Reddit post link → `Open link in Reader View` (useful from feeds).
- **Settings (in Reader View)**
  - Theme, font, and alignment toggles.
  - Open mode: same tab vs new tab.
- **Markdown Export**
  - Copy post as Markdown, or post + comments as Markdown.
  - Download post Markdown, or post + comments Markdown.
  - Comments export uses explicit structural fields (`id`, `p`, `x`, `d`) and ASCII tree connectors for human + agent readability.
- **Comments**
  - Default limit is `100` (configurable up to `500`).
  - Single toggle `Smart thread curation`:
    - `ON`: expands useful deep branches and collapses hard-low-value noise.
    - `OFF`: depth-only behavior.
  - Local search supports free text and `author:<name>`.
    - Active search force-expands matching branches, highlights matched terms, and shows a match-count status summary.
  - Bulk controls: `Expand all`, `Collapse all`, `Reset view`.
  - Deep loading supports branch/root expansion via Reddit `morechildren` with bounded safety budgets (requests/nodes/time).
  - The footer falls back to limit-step loading and “See more comments on Reddit” when placeholders are unavailable but Reddit still signals more comments.

## Notes / Limitations

- Works on Reddit post URLs (`/comments/...`).
- Initial Reddit listing fetch is still practically limited (~500) and may include `"more"` placeholders.
- Deep loading is implemented with `morechildren`, but intentionally bounded to keep casual browsing smooth and responsive.
- Extremely large/locked/removed threads can still require opening the canonical Reddit page for full context.

## Development

- Build: `pnpm build`
- Dev watch: `pnpm dev`
- Lint: `pnpm lint`
- Typecheck: `pnpm typecheck`
- Test: `pnpm test`
- Run in Firefox: `pnpm start:firefox`
- Compatibility launch helpers:
  - `pnpm start:firefox:verbose`
  - `pnpm start:firefox:compat`
  - `pnpm start:firefox:compat:verbose`

## Package & Install

### Package

- `pnpm build`
- `pnpm package`
  - Output: `web-ext-artifacts/*.zip` (can be renamed to `*.xpi`)

## Release Automation

- Preflight checks only:
  - `pnpm release:preflight`
  - Includes: `lint`, `typecheck`, `test`, `build`
- Create and publish a semver release tag (script commits, tags, and pushes from clean `main`):
  - `pnpm release:patch`
  - `pnpm release:minor`
  - `pnpm release:major`
- Generate release notes locally:
  - `node scripts/release-notes.mjs --tag vX.Y.Z --output /tmp/release-notes.md`
- Backfill or replace a missing release asset on an existing tag:
  - `pnpm release:fix-assets -- --tag v2.3.1 --version 2.3.1`
- Manually rerun release packaging for an existing tag from GitHub Actions:
  - `gh workflow run release.yml -f tag=v2.3.1`

Tag release flow:
1. Local script validates clean `main`, runs preflight, bumps `package.json` + `manifest.json`, commits, tags, and pushes.
2. GitHub Actions `release` workflow runs `typecheck`, `test`, `package` (`package` includes build).
3. CI publishes/updates GitHub release and uploads `web-ext-artifacts/reader_view_for_reddit-<version>.zip`.

Main-only workflow note:
- This repo ships by commits directly to `main` (no PR requirement).
- A dedicated `ci` workflow runs `lint` + `typecheck` + `test` on every push to `main`.
- Cut release tags only after `main` CI is green.

Action pinning note:
- Workflow actions are pinned to commit SHAs for reproducibility.
- Refresh pinned SHAs periodically during dependency/tooling maintenance.

## Source Code Submission (AMO reviewers)

This repo uses a build step (TypeScript + bundling), so AMO requires submitting the unbuilt source code and reproducible build steps.

### Build Requirements

- OS: Linux, macOS, or Windows (any OS supported by Node.js)
- Node.js: `22.x` (recommended; matches the default AMO reviewer environment; see `.nvmrc`)
- pnpm: `11.x` (recommended via Corepack)

### Install Tooling

- Install Node.js 22: https://nodejs.org/
- Enable/install pnpm:
  - `corepack enable`
  - `corepack prepare pnpm@11.12.0 --activate`

### Reproducible Build (produces `dist/`)

- `pnpm install --frozen-lockfile`
- `pnpm build`

Build script: `build.js` (invoked by `pnpm build`).

### Package the Extension (produces `web-ext-artifacts/`)

- `pnpm package`

This runs `web-ext build` against `dist/` and writes the installable artifact to `web-ext-artifacts/`.

### Install (temporary, for local testing)

- Open `about:debugging#/runtime/this-firefox`
- Click “Load Temporary Add-on…”
- Select `dist/manifest.json` (or the packaged `*.zip/*.xpi`)

### Install (persistent)

Firefox Release/Beta requires signed add-ons for permanent installation. To install persistently you generally need to:

- Upload to AMO and use a signed build, then install the resulting `*.xpi`, or
- Use Firefox Developer Edition/Nightly in a dev environment that allows unsigned add-ons.

## Notes

- Firefox stable currently rejects MV3 `background.service_worker` for temporary installs via `web-ext`, so this repo uses `background.scripts` even with `manifest_version: 3`.
