# Execution Plan: Phase 5 - Incremental Comments Renderer and
Motion

## Summary

Phase 5 replaces full comment-list re-rendering with keyed,
branch-local patching while preserving current behavior and
smart-capture semantics. The implementation introduces a
projection layer and renderer module that can update only
changed nodes/branches, then adds lightweight animations for
expand/collapse/insert paths with strict reduced-motion
compliance. This phase is behavior-preserving first,
performance/motion second.

## Target Plan File

- plans/active/phase-5-comments-incremental-render-motion.md
- Replace the current file with this decision-complete content.

## Goals

- Remove routine comments-list.replaceChildren() from normal
rerender paths.
- Keep existing comment controls and outcomes identical
(collapse, low-score reveal, show-more replies, deep-load
insertions).
- Add subtle, deterministic motion for structural changes.
- Preserve focus restoration, scroll anchoring, and render
supersession safety.

## Non-Goals

- Smart planner formula changes.
- Search semantics redesign.
- Full virtualized rendering.
- Third-party animation/state libraries.

## Public/Internal Interface Changes

- External APIs: no runtime message schema changes.
- New internal modules:
  - src/pages/comments-projection.ts
  - src/pages/comments-renderer.ts
  - src/pages/comments-motion.ts
- New internal types:
  - ProjectedCommentNode
  - CommentProjection (roots, byId, parentById, orderKeyById,
	collapsed, hiddenReason)
  - RenderPatchOp (insert, remove, move, update_meta,
	update_body, update_actions, set_collapsed)
  - RendererState (nodeElsById, repliesElsById, revision)
  - MotionMode (full, reduced, off)
- reader-host.ts changes:
  - rerenderComments() becomes “build projection + patch
	renderer”.
  - Keep full rebuild fallback behind guarded path for
	mismatch recovery.

## Architecture and Data Flow

1. Graph-backed canonical state remains in reader-host.ts (from
 Phase 4).
2. Build projection from:
  - graph roots + search filtering
  - visibility plan + collapsed sets + low-score collapse
	sets
  - per-node action affordances (show more, show low-score,
	load from Reddit)
3. Compare previous and next projections to derive patch ops.
4. Apply patch ops to DOM via keyed renderer.
5. Run motion hooks based on op type and motion mode.
6. Run post-patch scheduleEnhance only on inserted/updated
 bodies (not whole list).

## Work Breakdown

### 1) Projection Layer (src/pages/comments-projection.ts)

- Implement pure buildCommentProjection(input):
CommentProjection.
- Input includes:
  - currentComments (compat projected tree), visibility plan,
	search state, collapsed/manual state sets, deep-load
	state.
- Output must include stable traversal ordering and parent/
child linkage for patch planning.
- Hidden reasons encoded explicitly:
  - manual_collapsed
  - low_score_collapsed
  - depth_hidden
  - search_hidden (if relevant for projection output)
- Add deterministic orderKeyById (e.g., 1.2.3) for move
detection.

### 2) Keyed Renderer (src/pages/comments-renderer.ts)

- Introduce createCommentsRenderer(listEl) returning:
  - mountInitial(projection)
  - applyPatch(prev, next, options)
  - reset(next) (full fallback)
- Maintain DOM index maps by comment id for wrappers and
replies containers.
- Patch algorithm:
  - remove nodes absent in next projection (children-first)
  - insert missing nodes at exact sibling index
  - move existing nodes when parent/order changed
  - update only changed fragments (meta/body/actions/
	collapsed snippet)
- Preserve existing DOM structure/classes used by CSS/tests
(.comment, .comment-meta, .comment-body, .comment-
actions, .comment-replies, .comment-collapsed).

### 3) Motion System (src/pages/comments-motion.ts + CSS)

- Implement motion hooks:
  - animateInsert(nodeEl, context)
  - animateCollapse(nodeEl, expanding:boolean)
  - animateRepliesBatch(containerEl, insertedIds)
- CSS in src/pages/reader-host.css:
  - transition tokens tied to existing --dur-* / --ease-*.
  - class-based animations (is-entering, is-collapsing, is-
	expanding).
- Reduced motion:
  - prefers-reduced-motion: reduce disables timing and
	transforms.
  - JS motion module checks matchMedia and no-ops when
	reduced.
- Hard limits:
  - cap stagger to first N inserted replies per batch (e.g.,
	12), rest instant.

### 4) Host Integration (src/pages/reader-host.ts)

- Add module-level renderer state instance for #comments-list.
- Replace body of rerenderComments():
  - compute projection
  - if first render: initial mount
  - else: patch apply
  - if invariant mismatch or superseded revision: fallback
	reset(next) once
- Keep existing commentsRenderSeq supersession semantics.
- Keep captureCommentFocus() / restoreCommentFocus() around
patch commit.
- Keep pendingScrollAnchor behavior unchanged.
- Update call sites that currently depend on implicit full
rerender side effects.

### 5) Enhance Scheduling Optimization

- Replace broad scheduleEnhance(listEl) on every rerender.
- New behavior:
  - run enhance for inserted/updated bodies only.
  - keep full-container enhance only on explicit fallback
	reset.

### 6) Guardrails and Fallback Strategy

- Renderer invariant checks:
  - every projected id has exactly one wrapper in DOM
  - parent reply container exists for non-root nodes
- On invariant failure:
  - log warning in dev
  - one-shot full rebuild reset
  - continue with next revision.

## Test Cases and Scenarios

### Unit

- src/tests/comments-projection.test.ts
  - stable output for fixed inputs
  - collapsed/low-score/depth hidden reasons
  - deterministic order keys and parent links
- src/tests/comments-renderer.test.ts
  - insert/remove/move/update patch op behavior
  - branch-local updates do not recreate untouched roots
  - fallback reset triggers on synthetic mismatch
- src/tests/comments-motion.test.ts
  - reduced-motion no-op behavior
  - class application/removal lifecycle

### Integration

- src/tests/reader-host.test.ts
  - rerender updates specific changed branches only
  - search + collapse interactions preserve visibility rules
  - deep-load additions appear in correct parent/order
- src/tests/ui-loading-states.test.ts
  - load-more status/action states unchanged
  - no stale busy/collapsed artifact after patch updates
- src/tests/reader-ui.test.ts
  - focus restoration after toggle and after deep-load patch

### Regression Performance Checks

- Add lightweight instrumentation assertions:
  - rerender with one branch toggle does not clear entire
	list container.
  - large tree path still supersedes older render jobs
	safely.

- pnpm lint
- pnpm test:coverage
- pnpm docs:check

- Patch ordering bugs:
  - enforce deterministic traversal and child-index
	insertion.
- Focus/keyboard regressions:
  - keep focus capture/restore contract unchanged and tested.
- Animation jank:
  - transform/opacity-only; avoid layout-heavy animation
	loops.
- Hidden state drift:
  - projection is single truth for renderer decisions; no ad-
	hoc DOM state derivation.

## Acceptance Criteria

- rerenderComments() no longer uses routine full
replaceChildren() for normal updates.
- Unchanged branches keep their DOM nodes across updates.
- Existing controls produce same visible outcomes as pre-Phase-
5 behavior.
- Expand/collapse/insert motion is present in normal mode and
absent in reduced-motion mode.
- All tests pass with added projection/renderer/motion
coverage.

## Assumptions and Defaults

- Keep existing compatibility tree (currentComments) for this
phase; full renderer-over-graph direct mode can wait.
- No new user setting for animations; system reduced-motion is
authoritative.
- Keep action labels/text unchanged unless required for
correctness.
- Continue direct commits to main workflow.

## Decision Log

- 2026-02-20: Phase 5 will be projection+patch architecture,
not VDOM/library adoption.
- 2026-02-20: Motion remains additive and cannot alter logical
visibility/state outcomes.
- 2026-02-20: Full rebuild path retained as guarded recovery
fallback only.