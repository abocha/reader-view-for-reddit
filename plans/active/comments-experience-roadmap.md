# Execution Plan: Comments Experience Roadmap

## Metadata
- Status: proposed
- Owner: @abocha
- Priority: p0
- Related Issue/PR: n/a (direct commits to `main`)

## Summary
This plan turns the current “too good to miss” opportunities into a phased implementation roadmap focused on everyday browsing quality. It prioritizes low-effort, high-impact UX wins first, then adds power features, and finally tackles deeper thread coverage/performance work. The goal is a cleaner, faster, more useful Reader View for both humans and AI-agent workflows.

Companion phase plans:
- `plans/active/phase-1-comments-foundations.md`
- `plans/active/phase-2-comments-power-ux.md`
- `plans/active/phase-3-comments-depth-and-performance.md`

## Goals
- Improve day-to-day comment usability with minimal UI complexity.
- Preserve existing reliability/security invariants while adding capabilities.
- Keep interactions smooth on typical laptops at 100-500 loaded comments.

## Non-Goals
- Remote ML ranking/personalization.
- New backend services.
- Breaking extension APIs or broad visual redesign.

## Constraints
- Firefox MV3 extension context only.
- Existing comment curation contract remains deterministic.
- Existing markdown export must stay parse-stable for agents.

## Architecture / Design Notes
- Persist comment UI prefs in `localStorage`:
  - `comments-depth`, `comments-smart-mode`, `comments-limit`, `comments-sort`, `comments-visible`.
- Fallback extraction should populate `permalink` and `postId` when URL path includes `/comments/<id>/...`.
- Add comment metadata actions in render path:
  - relative/absolute time display from `createdUtc`,
  - permalink button to `https://www.reddit.com/comments/<postId>/_/<commentId>`.
- Add comment search state (`query`, optional `author:` token) and filter during render (not fetch).
- Add bulk actions: `Expand all`, `Collapse all`, `Reset thread view`.
- Add “Download Markdown” buttons alongside existing copy buttons.
- Implement `morechildren` as an opt-in “Load full thread” action with batching and safety caps.
- For large trees, chunk comment render work (`requestIdleCallback`/time-sliced loop) to avoid long main-thread stalls.

## Work Breakdown
1. Phase 1 (Quick Wins, p0)
   - Persist and restore comment preferences.
   - Ensure fallback payload includes usable `permalink`/`postId`.
   - Add comment timestamp + permalink actions.
2. Phase 2 (Power UX, p1)
   - Add in-thread search/filter UI and logic.
   - Add bulk thread controls (expand/collapse/reset).
   - Add markdown file download actions (`post` and `post+comments`).
3. Phase 3 (Depth + Perf, p1/p2)
   - Add `morechildren`-based full-thread loading path with cap/timeout guards.
   - Add chunked rendering mode for large visible node counts.

## Risks and Failure Modes
- Increased UI state complexity -> isolate state helpers + targeted regression tests.
- `morechildren` response variability/rate limits -> batch size caps, retries, and clear partial-state messaging.
- Render chunking regressions -> deterministic ordering tests + manual keyboard/focus checks.
- Export changes breaking agent parsing -> preserve current `[node ...]` schema and add snapshot tests.

## Test and Validation Plan
- Unit:
  - preference serialization/deserialization helpers,
  - fallback permalink derivation,
  - search filtering and bulk action state transitions.
- Integration:
  - comments load/reload with persisted settings,
  - export copy vs download parity,
  - `morechildren` merge behavior and caps.
- Manual:
  - long-thread browsing responsiveness,
  - keyboard and drawer behavior,
  - permalink actions and external link safety.
- Commands:
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm test:coverage`
  - `pnpm docs:check`

## Acceptance Criteria
- Preferences persist across Reader reloads and new sessions.
- Fallback extraction still allows comments when thread URL is available.
- Each comment shows time context and can open its Reddit permalink.
- Search and bulk actions work without breaking smart curation behavior.
- Downloaded markdown matches clipboard markdown content.
- Optional full-thread load can exceed current practical limit with safe guards.
- Rendering remains responsive under high comment counts.

## Decision Log
- 2026-02-19: Sequenced work by impact-to-effort ratio; quick wins first, deep-thread/perf second.
- 2026-02-19: Kept single-toggle smart curation contract unchanged while layering search and controls.
- 2026-02-19: Chose additive export download instead of replacing clipboard flow.
