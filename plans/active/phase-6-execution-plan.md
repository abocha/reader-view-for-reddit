  # Execution Plan: Phase 6 - Discovery, Clarity, and Export
  Coherence

  ## Summary

  Phase 6 finishes the comments UX package by tightening search
  discoverability, clarifying hidden/collapsed branch
  affordances, and making footer/status behavior fully coherent
  with graph-backed availability. It preserves current
  interaction semantics and focuses on making outcomes obvious
  for both casual users and agent workflows.

  ## Scope

  - In scope:
      - Search match count + query-state messaging.
      - Search highlight rendering (author/body/snippet).
      - Clearer collapsed/hidden branch affordances and labels.
      - Footer/status precedence and stale-action prevention.
      - Markdown copy/download parity assertions.
  - Out of scope:
      - New ranking/personalization logic.
      - New search syntax beyond text + author:.
      - Runtime API/permission changes.

  ## Public/Internal Interface Changes

  - External APIs: no changes.
  - Internal additions in src/pages/reader-host.ts:
      - parseCommentSearchQuery returns structured query +
        optional compile helper.
      - buildSearchMatchMeta(comment, query) for deterministic
        match counting/highlighting.
      - getFooterActionState(...) pure helper for footer
        precedence.
  - Internal additions in rendering pipeline:
      - RenderTreeSettings gains optional searchQuery and
        searchMetaById.
  - CSS updates:
      - Add stable highlight class (for example .comment-search-
        hit) in src/pages/reader-host.css.
  - Test utilities:
      - Extend __test__ exports with search/footer pure helpers
        where needed.

  ## Current-State Facts (Grounded)

  - Search already filters to matching branches and prevents
    manual collapse while active.
  - Empty-query message currently exists, but no match-count/
    status summary.
  - Branch hidden controls exist (Show N more replies, Show low-
    score comment) but labels can be made more explicit.
  - Footer currently depends on hasMore, placeholders, marker
    fallback; needs explicit precedence encoding.
  - Copy and download both use buildPostAndCommentsMarkdown;
    parity should be locked with tests.

  ## Detailed Implementation

  ### 1) Search Reveal + Highlight + Status

  1. Keep current filter semantics (filterCommentsBySearch)
     unchanged for compatibility.
  2. Add search metadata pass:
      - Build a Map<commentId, { bodyRanges, authorMatch,
        matchedTerms }> for visible filtered nodes.
      - Count total matched comments and matched roots.
  3. Render behavior:
      - While search active:
          - retain current “force expanded” behavior.
          - add visual highlights in author text and rendered
            body text wrappers.
  4. Status behavior:
      - No comments match "<query>". remains when zero results.
      - Otherwise show deterministic summary in comments status:
          - Found X matching comments in Y threads.

  ### 2) Branch Clarity Improvements

  1. Keep current actions; improve label clarity only:
      - Show N more replies -> Show N hidden replies
      - Show low-score comment -> Show hidden low-score comment
  2. Add compact reason cues for forced-collapsed low-score
     nodes/snippets:
      - e.g. Hidden by smart curation (low score).
  3. Keep parse-stable markdown unchanged (no contract break).

  ### 3) Footer/Status Coherence (Decision-Complete Precedence)

  Implement one pure precedence helper used by
  updateCommentsFooter:

  1. If loading: show loading state only.
  2. Else if resolvable placeholders exist: show Load more from
     Reddit.
  3. Else if no resolvable placeholders, hasMoreMarker=true, and
     limit < 500: show limit-step behavior.
  4. Else if no resolvable placeholders, hasMoreMarker=true, and
     limit >= 500: show See more comments on Reddit.
  5. Else: hide actionable footer.
     This removes stale impossible actions after exhaustion.

  ### 4) Export Parity Lock

  1. Keep a single markdown builder source
     (buildPostAndCommentsMarkdown).
  2. Add tests confirming copy/download paths produce identical
     bytes for same state.
  3. Add one regression test for parity with search-active state.

  ### 5) Docs Update

  - README.md: mention search match highlighting/count summary
    and refined footer behavior.
  - DESIGN.md: add “footer precedence helper” and “search
    metadata pass” invariants.
  - RELIABILITY.md: add regressions for query-state status and
    footer-action coherence.

  ## File-by-File Plan

  - src/pages/reader-host.ts
      - Add search match metadata helpers and status summary
        wiring.
      - Add highlight rendering path in comment meta/body.
      - Refactor footer decision logic into pure precedence
        helper.
      - Keep existing controls/callbacks and async flow.
  - src/pages/reader-host.css
      - Add search-highlight styles and subtle hidden-reason cue
        styles.
  - src/tests/reader-comments-power-ux.test.ts
      - Add search match count/highlight behavior tests.
      - Add low-score/depth label clarity assertions.
  - src/tests/ui-loading-states.test.ts
      - Add stale-footer-action prevention regressions.

  ## Test Scenarios

  1. Search active with matches in previously collapsed branches
     -> content visible + highlighted.
  2. Search cleared -> manual collapse state preserved (non-
     destructive).
  3. Match summary shown for non-empty result sets; no-results
     message for zero.
  4. Low-score/depth hidden action labels are explicit and
     stable.
  5. Footer action follows precedence exactly across:
      - placeholder available
      - marker-only with limit step
      - marker-only at max limit
      - exhausted/no marker.
  6. Copy vs download markdown are byte-identical for same
     runtime state.

  ## Validation Commands

  - pnpm lint
  - pnpm typecheck
  - pnpm test
  - pnpm test:coverage
  - pnpm docs:check

  ## Acceptance Criteria

  - Search is clearly actionable: visible matches, highlights,
    and count summary.
  - Hidden branch affordances communicate why content is hidden.
  - Footer/status never offers impossible next actions.
  - Markdown copy/download parity is regression-locked.
  - No regressions in smart curation, deep-load flow, or existing
    controls.

  ## Assumptions and Defaults

  - Keep existing query grammar (text, author:).
  - No new toggle/settings surface in Phase 6.
  - Preserve current markdown structure contract and ASCII tree
    format.
  - Keep direct-to-main workflow with full local checks before
    commit.