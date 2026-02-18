# Security

## Trust Boundaries
- Untrusted input: Reddit JSON/HTML payloads and URL parameters.
- Trusted code: extension background/pages/content scripts in this repo.
- Runtime messaging is internal to extension contexts unless explicitly exposed.

## Security Controls
## URL handling
- Parse external URLs through protocol checks (`http:`/`https:` only).
- Reject malformed/unsupported link schemes in rendering paths.

## HTML handling
- Post/comment HTML is sanitized before DOM insertion.
- Dangerous tags/attributes/events are stripped.
- Relative and protocol-relative URLs are normalized safely.

## Messaging and storage
- Runtime message handlers validate message shape and key lengths.
- Pending token/session entries are TTL-scoped and periodically cleaned.
- Performance/reporting storage is bounded.

## Markdown export safety
- Copy/export output is plain markdown text only; it does not introduce a new execution boundary.
- Comment tree connectors are presentation-only; downstream parsing should rely on explicit structural fields.

## Required Review Checklist for Changes
- Are all new URLs parsed and protocol-validated?
- Is any new HTML rendered through existing sanitization?
- Did runtime message handlers gain any new message type or broad surface?
- Are storage keys/values bounded and failure-safe?
- Are tests added for invalid input paths, not only happy paths?

## High-Risk Areas
- `src/pages/reader-host.ts` sanitization and render functions.
- `src/background/runtime-messages.ts` message parsing/routing.
- `src/content/reddit-extract.ts` fallback extraction and payload construction.

## Incident Response
- Reproduce with minimal URL/payload sample.
- Add failing test first.
- Patch with explicit validation/sanitization.
- Re-run `pnpm test` and `pnpm test:coverage` before merge.
