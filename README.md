# Reader View for Reddit

Firefox extension to open Reddit posts in a dedicated “reader view” page, as the native Firefox Reader View feature does not currently support Reddit.

## Development

- Build: `pnpm build`
- Typecheck: `pnpm typecheck`
- Run in Firefox: `pnpm start:firefox`

## Package & Install

### Package

- `pnpm build`
- `pnpm package`
  - Output: `web-ext-artifacts/*.zip` (can be renamed to `*.xpi`)

## Source Code Submission (AMO reviewers)

This repo uses a build step (TypeScript + bundling), so AMO requires submitting the unbuilt source code and reproducible build steps.

### Build Requirements

- OS: Linux, macOS, or Windows (any OS supported by Node.js)
- Node.js: `22.x` (recommended; matches the default AMO reviewer environment; see `.nvmrc`)
- pnpm: `10.x` (recommended via Corepack)

### Install Tooling

- Install Node.js 22: https://nodejs.org/
- Enable/install pnpm:
  - `corepack enable`
  - `corepack prepare pnpm@10.25.0 --activate`

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
