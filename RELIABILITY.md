# Reliability

## Reliability Goals
- Open Reader View quickly and deterministically.
- Preserve usable UI state during transient network failures.
- Avoid stale payload/comment races across async boundaries.

## Failure Modes and Handling
## Extraction failures
- JSON extraction failures fall back to in-page extraction.
- If both fail, Reader opens error mode with source URL context.

## Pending payload protocol failures
- New-tab mode uses a pending trace/token handshake.
- Pending token cleanup normalizes malformed entries and evicts expired markers.
- Host timeout path renders a recoverable error message.

## Comments loading failures
- In-flight requests are abortable.
- If comments are hidden mid-load, stale responses are ignored.
- Retry/filter refresh preserves existing rendered comments when possible.
- Deep-loading (`morechildren`) resolves placeholders in bounded passes and preserves already-rendered comments on partial failure.
- Budget truncation is explicit and non-fatal: users keep loaded results and can retry.

## Cache behavior
- Payload cache: in-memory LRU with TTL.
- Comments cache: in-memory LRU + TTL + serialized size cap.
- Session token index: capped and TTL-trimmed in `storage.session`.

## Regression Checklist
- Crosspost permalink/comment thread correctness.
- Toggle comments off while fetch is in progress.
- Retry after comments fetch `500`.
- Pending token timeout and cleanup behavior.
- Cache hit/miss + eviction paths.
- Smart curation ON/OFF parity on same tree (deterministic plan output for fixed input).
- Deep expansion cap (`maxExtraDeepVisiblePerRoot`) respected under high-branch threads.
- Negative-with-signal guard works (strong descendant branches are not auto-hidden).
- Markdown export tree consistency: node `id`/`p`/`x`/`d` align with visible comment order and depth filtering.
- Placeholder integrity: `rootMoreChildrenIds` and per-node `moreChildrenIds` stay deduplicated and reachable after merges.
- Deep-load merge behavior: no duplicate comment nodes, no orphan insertion without parent.
- Chunked rendering: superseded render jobs do not overwrite newer UI state.

## Known Limits
- Initial Reddit listing endpoint effectively caps practical first-pass loading around ~500 comments.
- `morechildren` traversal is intentionally bounded (request/node/time caps) to preserve UI responsiveness.
