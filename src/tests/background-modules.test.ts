import { describe, it, expect, vi } from 'vitest';
import { __test__ as payloadCacheTest } from '../background/payload-cache';
import { __test__ as commentsCacheTest } from '../background/comments-cache';
import { __test__ as pendingCleanupTest } from '../background/pending-token-cleanup';
import { __test__ as runtimeMessagesTest } from '../background/runtime-messages';

describe('Background modules', () => {
    it('payload cache should enforce TTL and LRU recency', () => {
        let now = 0;
        const cache = payloadCacheTest.createPayloadCache({
            ttlMs: 100,
            maxEntries: 2,
            now: () => now,
        });

        cache.set('a', { value: 1 });
        cache.set('b', { value: 2 });
        expect(cache.get('a')).toEqual({ value: 1 }); // refresh recency
        cache.set('c', { value: 3 });

        expect(cache.get('b')).toBeNull(); // evicted as oldest
        expect(cache.get('a')).toEqual({ value: 1 });
        expect(cache.get('c')).toEqual({ value: 3 });

        now = 200;
        expect(cache.get('a')).toBeNull(); // expired
    });

    it('comments cache should enforce payload size and serialization validity', () => {
        const cache = commentsCacheTest.createCommentsCache({
            maxBytes: 10,
        });

        const tooLarge = cache.set('k1', { text: '12345678901' });
        expect(tooLarge.ok).toBe(false);
        if (!tooLarge.ok) {
            expect(tooLarge.reason).toBe('too_large');
            expect(typeof tooLarge.bytes).toBe('number');
        }

        const circular: Record<string, unknown> = {};
        circular.self = circular;
        const notSerializable = cache.set('k2', circular);
        expect(notSerializable.ok).toBe(false);
        if (!notSerializable.ok) {
            expect(notSerializable.reason).toBe('not_serializable');
        }
    });

    it('pending-token cleaner should normalize legacy entries and evict invalid/expired ones', async () => {
        const get = vi.fn().mockResolvedValue({
            'pending_token:legacy': 'legacy-token',
            'pending_token:empty': '',
            'pending_token:bad_obj': { token: '', createdAt: 100 },
            'pending_token:expired': { token: 'old-token', createdAt: 1 },
            'pending_token:valid': { token: 'fresh-token', createdAt: 95 },
            other: 'ignore-me',
        });
        const set = vi.fn().mockResolvedValue(undefined);
        const remove = vi.fn().mockResolvedValue(undefined);

        const { cleanup } = pendingCleanupTest.createPendingTokenCleaner(
            { get, set, remove },
            {
                ttlMs: 10,
                cleanupIntervalMs: 0,
                now: () => 100,
            },
        );

        await cleanup();

        expect(set).toHaveBeenCalledWith({
            'pending_token:legacy': { token: 'legacy-token', createdAt: 100 },
        });
        expect(remove).toHaveBeenCalledWith(
            expect.arrayContaining(['pending_token:empty', 'pending_token:bad_obj', 'pending_token:expired']),
        );
    });

    it('pending-token cleaner should skip runs inside the cleanup interval window', async () => {
        let now = 100;
        const get = vi.fn().mockResolvedValue({});
        const set = vi.fn().mockResolvedValue(undefined);
        const remove = vi.fn().mockResolvedValue(undefined);

        const { cleanup } = pendingCleanupTest.createPendingTokenCleaner(
            { get, set, remove },
            {
                cleanupIntervalMs: 1000,
                now: () => now,
            },
        );

        await cleanup();
        await cleanup();
        expect(get).toHaveBeenCalledTimes(1);

        now = 1200;
        await cleanup();
        expect(get).toHaveBeenCalledTimes(2);
    });

    it('runtime message handler should route perf, host requests, and cache operations', async () => {
        const onPerfReport = vi.fn();
        const onHostPayloadRequest = vi.fn().mockResolvedValue(undefined);
        const onCommentsCacheGet = vi.fn().mockReturnValue({ comments: [] });
        const onCommentsCacheSet = vi.fn().mockReturnValue({ ok: true, bytes: 42 });

        const handler = runtimeMessagesTest.createRuntimeMessageHandler({
            onPerfReport,
            onHostPayloadRequest,
            onCommentsCacheGet,
            onCommentsCacheSet,
        });

        await handler({ type: 'PERF_REPORT', report: { traceId: 't1', events: [] } });
        expect(onPerfReport).toHaveBeenCalledWith(expect.objectContaining({ traceId: 't1' }));

        await handler({ type: 'HOST_PAYLOAD_REQUEST', traceId: 'trace-1', url: 'https://www.reddit.com/r/a/comments/abc/p/' });
        expect(onHostPayloadRequest).toHaveBeenCalledWith('trace-1', 'https://www.reddit.com/r/a/comments/abc/p/');

        const getRes = await handler({ type: 'COMMENTS_CACHE_GET', key: 'abc' });
        expect(getRes).toEqual({ hit: true, value: { comments: [] } });

        const setRes = await handler({ type: 'COMMENTS_CACHE_SET', key: 'abc', value: { comments: [] } });
        expect(setRes).toEqual({ ok: true, bytes: 42 });

        const badSetRes = await handler({ type: 'COMMENTS_CACHE_SET', key: 'x'.repeat(401), value: {} });
        expect(badSetRes).toEqual({ ok: false, reason: 'bad_key' });
    });
});
