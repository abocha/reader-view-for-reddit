import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import browser from 'webextension-polyfill';
import { recordSessionToken, touchSessionToken } from '../shared/session-token-cache';

describe('session token cache', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('records a token with metadata', async () => {
        vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
        (browser.storage.session.get as any).mockResolvedValueOnce({});

        await recordSessionToken('t1', 'https://www.reddit.com/r/test/comments/abc/post');

        const setArgs = (browser.storage.session.set as any).mock.calls[0][0];
        const entries = setArgs.rvrr_tokens as any[];
        expect(entries).toHaveLength(1);
        expect(entries[0].token).toBe('t1');
        expect(entries[0].createdAt).toBe(Date.now());
        expect(entries[0].lastAccessed).toBe(Date.now());
        expect(entries[0].url).toBe('https://www.reddit.com/r/test/comments/abc/post');
    });

    it('evicts oldest token when max is exceeded', async () => {
        vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
        const entries = Array.from({ length: 15 }, (_, idx) => ({
            token: `t${idx}`,
            createdAt: Date.now() - (idx + 1) * 1000,
            lastAccessed: Date.now() - (idx + 1) * 1000,
        }));
        (browser.storage.session.get as any).mockResolvedValueOnce({ rvrr_tokens: entries });

        await recordSessionToken('t-new', 'https://www.reddit.com/r/test/comments/abc/post');

        expect(browser.storage.session.remove).toHaveBeenCalled();
        const removed = (browser.storage.session.remove as any).mock.calls[0][0] as string[];
        expect(removed.length).toBeGreaterThan(0);
    });

    it('touches token and drops expired entries', async () => {
        vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
        const entries = [
            { token: 'keep', createdAt: Date.now(), lastAccessed: Date.now() - 1000 },
            { token: 'expired', createdAt: Date.now() - 99999999, lastAccessed: Date.now() - 99999999 },
        ];
        (browser.storage.session.get as any).mockResolvedValueOnce({ rvrr_tokens: entries });

        await touchSessionToken('keep');

        const setArgs = (browser.storage.session.set as any).mock.calls[0][0];
        const next = setArgs.rvrr_tokens as any[];
        expect(next).toHaveLength(1);
        expect(next[0].token).toBe('keep');
        expect(next[0].lastAccessed).toBe(Date.now());
        expect(browser.storage.session.remove).toHaveBeenCalledWith(['expired']);
    });
});
