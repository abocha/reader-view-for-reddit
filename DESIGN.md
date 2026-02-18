# Design

## Purpose
Reader View for Reddit is a Firefox MV3 extension that extracts Reddit post content and renders it in a clean host page with optional comments loading and Markdown export.

## Architecture Goals
- Fast open flow with graceful fallback behavior.
- Stable behavior on Reddit URL variants and crossposts.
- Clear separation between extraction, orchestration, rendering, and shared utilities.

## Module Map
- `src/background/`: orchestration, runtime message handling, payload/comment caches, pending token protocol.
- `src/content/`: self-contained in-page extraction function used by `browser.scripting.executeScript`.
- `src/pages/`: reader UI rendering, preferences, comments loading, HTML sanitization.
- `src/shared/`: cross-cutting logic (payload shaping and token index maintenance).

## Core Flows
1. User triggers action/shortcut/menu.
2. Background extracts payload (JSON first, then executeScript fallback).
3. Payload is stored in `storage.session` with token + pending trace marker.
4. Reader host loads by token and renders article; comments load on demand.

## Invariants
- Extractor injected into page must remain self-contained (no runtime imports).
- Crosspost metadata (`permalink`, `postId`, flags) follows the viewed thread.
- Reader UI sanitizes post/comment HTML before rendering.
- `README.md` is the top-level navigation point for docs.

## Dependency Boundaries
- `background` may import from `shared` and `content` (for injected function only).
- `pages` must not depend on `background` internals; communication is via runtime messaging/storage protocol.
- Shared modules must remain framework-agnostic and side-effect-light where possible.
