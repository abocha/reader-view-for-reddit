# Execution Plan: Phase 3 - Comments Depth and Performance

## Metadata
- Status: proposed
- Owner: @abocha
- Priority: p1/p2
- Related Issue/PR: `plans/active/comments-experience-roadmap.md`

## Summary
Phase 3 tackles deeper thread coverage and performance scaling. It introduces optional `morechildren`-based expansion for fuller threads and chunked rendering to keep interactions snappy on typical laptops.

## Goals
- Load deeper portions of Reddit threads safely beyond current practical limits.
- Prevent long blocking renders on high-comment pages.
- Maintain deterministic ordering and export integrity.

## Non-Goals
- Unlimited deep crawl without safeguards.
- Remote/offline preprocessing pipelines.
- ML-based summarization/ranking.

## Work Breakdown
1. `morechildren` integration
   - Add explicit “Load full thread” action (opt-in).
   - Request children in bounded batches with retry/backoff.
   - Merge results into existing tree preserving stable ordering.
2. Guardrails
   - Hard caps (requests/nodes/time budget) and clear partial-load status.
   - Fail-safe recovery with existing comments preserved.
3. Chunked rendering
   - Time-slice comment render for large visible trees.
   - Preserve focus/keyboard interactions and collapse/expand semantics.
4. Tests/perf checks
   - Integration tests for merge correctness and cap behavior.
   - Deterministic output checks for render and markdown export under chunking.

## Validation
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:coverage`
- `pnpm docs:check`

## Acceptance Criteria
- Users can opt into loading substantially deeper replies with clear safety limits.
- Large threads remain interactive without visible jank regressions.
- Smart curation, focus handling, and markdown contract remain stable.
