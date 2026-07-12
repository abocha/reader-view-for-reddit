# Cheap-ROI Maintenance Implementation Plan

**Status:** completed

**Goal:** Fix four demonstrated reliability/UX issues and refresh the project toolchain without broad refactoring.

**Approach:** Add focused regression tests before each behavior change. Keep production edits local to the existing modules, update dependencies and pinned CI tooling, then run the complete release and packaging checks.

## Tasks

- [x] Correct search match counts so retained ancestor context is not counted as a match.
- [x] Restrict sanitized image sources to HTTP(S) and normalized Reddit-relative URLs.
- [x] Open the new-tab loading host before extraction begins.
- [x] Serialize session-token index mutations to prevent lost concurrent updates.
- [x] Refresh dependencies, pnpm, the pinned pnpm setup action, and README tooling instructions.
- [x] Add extension linting to release preflight and CI validation.
- [x] Run targeted tests, coverage, release preflight, package validation, docs checks, audit, and `web-ext lint`.

## Non-goals

- Broad `reader-host.ts` refactoring.
- Additional speculative review findings.
- Feature or UI redesign work.
