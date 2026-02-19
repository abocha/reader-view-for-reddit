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
- Markdown export tree consistency: node `id`/`p`/`x`/`d` align with visible comment order and depth filtering.

## Known Limits
- Reddit comments endpoint effectively caps practical loading around ~500 comments.
- Full `morechildren` traversal is intentionally out of scope today.
