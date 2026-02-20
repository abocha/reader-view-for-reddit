# Execution Plan: Comments UX Package (Graph Runtime + Incremental Rendering + Motion)

## Metadata
- Status: proposed
- Owner: @abocha
- Priority: p0
- Related Issue/PR: n/a (direct commits to `main`)

## Summary
This roadmap packages comments UX into one coherent system: graph-based comment state, non-destructive incremental rendering, and polished motion/accessibility behavior. The target is smooth, local-first performance on a typical laptop while preserving deterministic behavior for both humans and AI-agent workflows. It extends completed phases 1-3 and keeps existing curation/export contracts stable.

## Goals
- Replace routine tree rebuild rendering with keyed incremental updates.
- Move comment data/state to a canonical graph model that supports reliable deep loading and visibility planning.
- Add meaningful expand/collapse/load animations with strong reduced-motion behavior.
- Improve in-thread discovery (search, counters, branch affordances) without UI bloat.

## Non-Goals
- Remote ML ranking/personalization.
- Backend services, workers, or external dependencies.
- Whole-page Reader redesign outside comments UX.

## Constraints
- Firefox MV3 extension context only.
- Local deterministic processing; no network beyond existing Reddit endpoints.
- Preserve markdown contract (`[node id= p= x= d= ...]`) and ASCII tree readability.
- Preserve current smart curation semantics unless explicitly improved and regression-covered.

## Architecture / Design Notes
- Keep `src/pages/reader-host.ts` as orchestration layer; extract domain logic into focused modules.
- Introduce graph and projection helpers:
  - `src/pages/comments-graph.ts`
  - `src/pages/comments-projection.ts`
  - `src/pages/comments-renderer.ts`
  - `src/pages/comments-motion.ts`
- Keep planner functions pure and deterministic; projection is structural truth for render/export.
- Shift from full `comments-list` replacement to branch-local keyed patching.
- Motion is additive only: no motion path can alter state correctness.

## Public/Internal Interface Changes
- External extension APIs: no breaking runtime message/API changes required.
- Internal types to introduce:
  - `CommentGraphNode`, `CommentGraphState`, `GraphMergeResult`
  - `VisibleProjection`, `VisibleChildSet`, `RenderPatch`
- Internal contracts to preserve:
  - Deep-load safety budgets (`requests`, `nodes`, `time`).
  - Export structural field invariants (`id`, `p`, `x`, `d`).
- Optional additive export metadata allowed (for diagnostics only), but no required parser changes.

## Work Breakdown
1. Phase 4: Graph Runtime Foundation
   - Canonical graph model, merge logic, placeholder tracking, and state coherence.
2. Phase 5: Incremental Renderer + Motion
   - Keyed DOM patching and animation choreography with reduced-motion compliance.
3. Phase 6: Discovery + UX Completion
   - Search reveal quality, branch counters/actions, status/footer coherence, and export parity checks.

Linked plans:
- `plans/active/phase-4-comments-graph-runtime.md`
- `plans/active/phase-5-comments-incremental-render-motion.md`
- `plans/active/phase-6-comments-discovery-polish.md`

## Risks and Failure Modes
- Graph migration regressions -> maintain adapter period and parity tests against current behavior.
- DOM patch ordering bugs -> deterministic render/projection tests and stable id ordering checks.
- Animation jank -> cap animated batch size and skip animation under load/reduced-motion.
- Async race regressions -> retain sequence guards and stale-response bailout paths.

## Test and Validation Plan
- Unit: graph construction/merge, projection correctness, planner determinism.
- Integration: deep-load merge + cache restore + render patch correctness.
- UX: focus retention, keyboard behavior, branch action behavior while loading.
- Performance: verify smoothness at 100/300/500 comment scales.
- Commands:
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm test:coverage`
  - `pnpm docs:check`

## Acceptance Criteria
- Comments update without routine full-list replacement.
- Smart mode remains deterministic and functionally improved.
- Search consistently reveals matching content without manual ancestor expansion.
- Expand/collapse/load animations feel smooth and remain accessible under reduced-motion.
- Deep-load/footer/cache state remains coherent with no stale "has more" loops.
- Markdown copy/download output remains parse-stable and parity-aligned.

## Assumptions and Defaults
- Direct commits to `main` remain the delivery workflow.
- No additional user-facing advanced tuning controls in this package.
- Native DOM/CSS/TypeScript implementation only (no new UI framework dependency).

## Decision Log
- 2026-02-20: Chosen architecture is graph-first state + projection + incremental render.
- 2026-02-20: Chosen delivery is a master roadmap with phase execution plans in `plans/active/`.
- 2026-02-20: Markdown and smart curation invariants remain non-negotiable.
