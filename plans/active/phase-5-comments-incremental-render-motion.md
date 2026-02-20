# Execution Plan: Phase 5 - Incremental Renderer and Motion System

## Metadata
- Status: proposed
- Owner: @abocha
- Priority: p0
- Related Issue/PR: `plans/active/comments-ux-package-roadmap.md`

## Summary
Phase 5 replaces full comments-list rerendering with keyed incremental patching and introduces polished, accessibility-aware motion. The objective is to keep interactions responsive while making hierarchy changes easier to follow visually.

## Goals
- Implement keyed incremental render updates for comments tree changes.
- Eliminate routine `comments-list.replaceChildren()` in normal rerender paths.
- Add expand/collapse/load transitions that are smooth but deterministic and optional under reduced-motion.

## Non-Goals
- New ranking policies.
- Complex animation timelines or third-party animation libraries.
- Cross-page redesign outside comments interactions.

## Work Breakdown
1. Incremental renderer module
   - Add `src/pages/comments-renderer.ts` with:
     - DOM index by `commentId`
     - `renderInitialProjection(rootProjection)`
     - `applyProjectionPatch(previousProjection, nextProjection)`
   - Define patch operations:
     - insert node
     - update node meta/body
     - reorder siblings
     - remove node subtree
     - toggle collapsed state

2. Host integration
   - In `src/pages/reader-host.ts`, compute projection then call renderer patch API.
   - Keep full rerender fallback for catastrophic mismatch/debug mode.
   - Preserve focus/scroll anchors before/after patch commit.

3. Motion system
   - Add `src/pages/comments-motion.ts` and CSS hooks in `src/pages/reader-host.css`.
   - Motion primitives:
     - collapse/expand (`max-height` + opacity)
     - inserted reply reveal (subtle translate/opacity)
     - load batch stagger (small bounded delay)
   - Implement reduced-motion bypass (`prefers-reduced-motion: reduce`) with instant state transitions.

4. Interaction correctness
   - Ensure existing controls behave identically under incremental rendering:
     - toggle collapse
     - show low-score comment
     - show more replies
     - deep-load branch/root actions

## Risks
- Patch algorithm bugs causing duplicate or stale nodes -> strict keyed index invariants + fallback full rerender.
- Motion causing layout thrash -> measure once/write once per frame and keep animations lightweight.
- Focus loss on DOM moves -> explicit focus capture/restore by comment id.

## Test and Validation Plan
- Add/extend tests in:
  - `src/tests/reader-host.test.ts`
  - `src/tests/reader-ui.test.ts`
  - `src/tests/ui-loading-states.test.ts`
- New scenarios:
  - incremental updates do not replace untouched root branches
  - collapse/expand preserves target focus and keyboard operability
  - deep-load inserts nodes in correct branch order
  - reduced-motion path skips animation classes/timing dependencies
- Manual checks:
  - rapid toggle spam
  - search query changes while load is in flight
  - expand/collapse with large thread
- Commands:
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test`

## Acceptance Criteria
- Normal comment rerenders are patch-based and branch-local.
- Expand/collapse/load transitions are smooth on typical thread sizes.
- Reduced-motion users get functionally equivalent instant behavior.
- No regressions in existing curation/deep-load controls.

## Assumptions and Defaults
- Animation durations reuse existing token system (`--dur-*`, `--ease-*`).
- Default motion remains subtle and low-amplitude to avoid distraction.

## Decision Log
- 2026-02-20: Incremental patching chosen as primary render path; full rebuild retained only as guarded fallback.
