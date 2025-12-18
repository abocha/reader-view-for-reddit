# Reader View for Reddit

Firefox extension that opens Reddit posts in a clean, distraction-free Reader View page (native Firefox Reader View doesn’t support Reddit well).

## Usage

- **Open Reader View**
  - Click the extension icon, or use the keyboard shortcut (default: `Alt+Shift+R`).
  - Right-click on a Reddit post page → `Read in Reader View`.
  - Right-click a Reddit post link → `Open link in Reader View` (useful from feeds).
- **Settings (in Reader View)**
  - Theme, font, and alignment toggles.
  - Open mode: same tab vs new tab.
- **Copy**
  - Copy post as Markdown, or post + comments as Markdown.
- **Comments**
  - Default limit is `100` (configurable up to `500`).
  - “Load more comments” increases the limit in steps (keeps scroll position).
  - When Reddit indicates there are more than we can load, the footer offers a link to “See more comments on Reddit”.

## Notes / Limitations

- Works on Reddit post URLs (`/comments/...`).
- Comments are fetched from Reddit’s JSON listing endpoint, which tops out around ~500 and uses `"more"` placeholders; loading full 1000+ threads would require implementing `morechildren`.

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
