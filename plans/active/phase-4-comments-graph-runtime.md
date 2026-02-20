# Execution Plan: Phase 4 - Comments Graph Runtime Foundation

## Metadata
- Status: proposed
- Owner: @abocha
- Priority: p0
- Related Issue/PR: `plans/active/comments-ux-package-roadmap.md`

## Summary
Phase 4 establishes a canonical graph runtime for comment data and UI state. It replaces nested-tree mutation as the primary model with deterministic graph construction, merge, and projection inputs. This is the structural foundation for incremental rendering and motion in later phases.

## Goals
- Introduce a canonical graph state that captures comment structure, parent/child links, placeholder IDs, and UI-relevant metadata.
- Refactor deep-load merge to operate against graph state without losing current safeguards.
- Preserve current user-visible behavior while moving internals to a stable long-term model.

## Non-Goals
- Animation or visual transition work.
- Broad UI copy/styling redesign.
- Changing smart-capture policy formulas.

## Work Breakdown
1. Graph module and types
   - Add `src/pages/comments-graph.ts` with:
     - `buildGraphFromCommentsListing(children)`
     - `mergeMoreChildrenThingsIntoGraph(graph, things, postId)`
     - `collectPlaceholdersForScope(graph, parentId)`
     - `refreshHasMoreState(graph)`
   - Define data structures:
     - node map keyed by `commentId`
     - child order list by parent id
     - parent map
     - root ids list
     - per-node placeholder IDs and root placeholder IDs

2. Reader host integration
   - Add a `commentsState` holder in `src/pages/reader-host.ts`:
     - graph state
     - UI sets (`collapsed`, `expandedMore`, `expandedLow`, `autoModeratorExpanded`)
     - async/load flags and marker flags
   - Adapt existing parsing/load flow to write/read graph state instead of mutating nested trees directly.
   - Keep temporary compatibility adapter for functions/tests expecting nested tree inputs.

3. Deep-load merge and has-more coherence
   - Update `loadMoreCommentsForScope` pipeline to:
     - fetch batch
     - merge into graph
     - consume placeholders
     - recompute marker-vs-placeholder availability correctly
   - Ensure nested placeholder-only cases do not flip marker state incorrectly.

4. Cache persistence/restore
   - Persist marker signal and placeholder signal independently.
   - Restore graph + flags without inferring marker from placeholder availability.

5. Export and projection compatibility
   - Keep current export contract unchanged.
   - Build projection input from graph in deterministic order.

## Risks
- State model drift during migration -> maintain adapter and run parity tests against known fixtures.
- Ordering regressions after merge -> enforce stable child ordering policy and test it.
- Cache restore mismatch -> explicit fields for marker and placeholders with regression tests.

## Test and Validation Plan
- Add/extend tests in:
  - `src/tests/reader-comments-logic.test.ts`
  - `src/tests/reader-host.test.ts`
  - `src/tests/reader-ui-coverage.test.ts`
- New scenarios:
  - graph build from listing (roots, parents, child order)
  - merge behavior for t1 + more things with orphan handling
  - placeholder consumption and replenishment after merges
  - marker-only vs placeholder-only `hasMore` correctness across cache restore
- Commands:
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test`

## Acceptance Criteria
- Graph runtime becomes source of truth for comment structure and deep-load placeholders.
- Deep loading continues to work with existing budget limits and deterministic ordering.
- Cache restore no longer causes stale marker-style "more comments" affordances.
- Existing visible behavior remains stable for non-animation flows.

## Assumptions and Defaults
- Existing parse/sanitize logic remains in `reader-host.ts` initially; extraction to module is limited to graph concerns.
- No schema changes required in background runtime message types.

## Decision Log
- 2026-02-20: Graph model chosen as prerequisite for incremental render and motion.
