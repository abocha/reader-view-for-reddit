# Execution Plan: Phase 1 - Comments Foundations

## Metadata
- Status: completed
- Owner: @abocha
- Priority: p0
- Related Issue/PR: `plans/completed/comments-experience-roadmap.md`

## Completion
- Completed: 2026-02-19
- Verification: feature set present in code/tests and full checks passing (`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm docs:check`).

## Summary
Phase 1 delivers the highest-impact quality improvements with minimal risk: persistent comments preferences, fallback permalink/post ID derivation, and richer comment metadata actions (time + permalink). This phase strengthens core daily UX without changing the smart curation model.

## Goals
- Persist and restore comment UI preferences across sessions.
- Preserve comments availability for fallback extraction mode when thread path is known.
- Improve comment readability/navigation with time context and direct permalink access.

## Non-Goals
- Search/filter controls.
- Bulk tree controls.
- `morechildren` support or render chunking.

## Work Breakdown
1. Preferences persistence
   - Add localStorage keys for comments visibility/depth/smart mode/limit/sort.
   - Restore values in `initCommentsUI` before wiring listeners.
   - Persist on change events and load-more limit step-up.
2. Fallback thread metadata
   - Derive `permalink` and `postId` from URL path in `extractRedditPost` fallback branch.
3. Comment metadata actions
   - Add relative time display from `createdUtc` with absolute timestamp tooltip.
   - Add per-comment Reddit permalink link in comment meta row.
4. Regression coverage
   - Add tests for restored/persisted preferences.
   - Extend extraction fallback tests for permalink/postId.
   - Add render test for comment timestamp/permalink.

## Validation
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm docs:check`

## Acceptance Criteria
- Comment controls retain user settings between sessions.
- Fallback extraction comments remain available on valid Reddit thread URLs.
- Comment rows show time context when available and include working permalink links.
