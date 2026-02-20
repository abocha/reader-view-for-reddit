# Execution Plan: Phase 6 - Discovery and UX Completion

## Metadata
- Status: proposed
- Owner: @abocha
- Priority: p1
- Related Issue/PR: `plans/active/comments-ux-package-roadmap.md`

## Summary
Phase 6 completes the comments UX package with discovery and clarity improvements: search reveal quality, branch visibility cues, and coherent status/footer messaging. It locks a polished end-to-end experience for casual browsing and agent-readable exports.

## Goals
- Make search behavior predictably reveal matching content and context.
- Improve branch affordances so hidden/collapsed state is obvious and actionable.
- Align status/footer/deep-load messaging with real availability state.
- Preserve markdown copy/download parity after renderer and graph changes.

## Non-Goals
- Personalization or recommendation systems.
- Advanced multi-filter query language beyond current text + `author:`.
- New extension permissions or external services.

## Work Breakdown
1. Search reveal and highlighting
   - Ensure active search force-expands ancestor paths of all matches.
   - Add visible match highlighting in comment body/meta snippets.
   - Add deterministic no-results and match-count status behavior.

2. Branch clarity
   - Improve collapsed branch affordances:
     - clearer low-score collapse labels
     - clearer depth-hidden reply counts
   - Ensure action labels remain stable and parseable.

3. Status/footer coherence
   - Unify messaging for:
     - loading
     - partial deep-load truncation
     - exhausted placeholders
     - marker-based fallback availability
   - Prevent stale "load more" actions after effective exhaustion.

4. Export parity and docs
   - Verify copy vs download markdown parity after graph/projection migration.
   - Update docs:
     - `DESIGN.md` (graph + incremental render architecture)
     - `RELIABILITY.md` (new regression checklist items)
     - `README.md` (updated comments UX behavior)

## Risks
- Search override confusion with manual collapse state -> scope override to active query only and restore on clear.
- UI noise from extra cues -> keep labels concise and re-use existing styles.
- Footer regressions from mixed signals -> define strict precedence (marker vs placeholder vs exhausted).

## Test and Validation Plan
- Add/extend tests in:
  - `src/tests/reader-comments-power-ux.test.ts`
  - `src/tests/reader-host.test.ts`
  - `src/tests/reader-ui-coverage.test.ts`
- New scenarios:
  - match inside collapsed branch is visible during search
  - clearing search returns non-destructive prior manual state
  - footer action visibility follows real has-more state
  - markdown copy/download stay byte-parity for same state
- Commands:
  - `pnpm lint`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm docs:check`

## Acceptance Criteria
- Search always surfaces matching content without manual ancestor expansion.
- Branch affordances clearly communicate what is hidden and why.
- Footer/status actions do not offer impossible operations.
- Export behavior remains clean for humans and AI agents.

## Assumptions and Defaults
- Existing search syntax remains (`text` + optional `author:` token).
- No new control toggles added unless a clear usability gap appears during implementation.

## Decision Log
- 2026-02-20: Phase 6 scoped to UX completion and coherence, not new ranking or backend work.
