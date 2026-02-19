# Execution Plan: Phase 2 - Comments Power UX

## Metadata
- Status: completed
- Owner: @abocha
- Priority: p1
- Related Issue/PR: `plans/completed/comments-experience-roadmap.md`

## Completion
- Completed: 2026-02-19
- Verification: feature set present in code/tests and full checks passing (`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm docs:check`).

## Summary
Phase 2 adds focused power-user controls without bloating UI complexity: in-thread search/filtering, bulk expand/collapse/reset actions, and downloadable markdown export parity with copy flows.

## Goals
- Make long-thread navigation faster with local search/filter.
- Add one-click tree state controls for predictable exploration.
- Support file-based markdown export for human + agent workflows.

## Non-Goals
- New ranking policy knobs.
- Server-backed indexing/search.
- Thread loading beyond current endpoint limits.

## Work Breakdown
1. Search/filter
   - Add query input (supports text and optional `author:` token).
   - Apply filter during render (no extra fetches).
   - Preserve deterministic behavior with smart mode ON/OFF.
2. Bulk controls
   - Add `Expand all`, `Collapse all`, `Reset thread view`.
   - Wire to existing state sets (`collapsedById`, `expandedMoreById`, `expandedLowScoreById`).
3. Download markdown
   - Add `Download post.md` and `Download post+comments.md`.
   - Ensure output matches existing copy builders.
4. Tests
   - Add regression tests for search semantics, bulk actions, and file export payload parity.

## Validation
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm docs:check`

## Acceptance Criteria
- Search narrows visible comments deterministically and remains responsive.
- Bulk controls consistently update tree state with no stale UI artifacts.
- Downloaded markdown content matches copied markdown content byte-for-byte.
