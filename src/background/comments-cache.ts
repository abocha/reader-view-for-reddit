type CommentsCacheOptions = {
    ttlMs?: number;
    maxEntries?: number;
    maxBytes?: number;
    now?: () => number;
};

type CommentsCacheEntry = {
    value: unknown;
    expiresAt: number;
};

type CommentsCacheSetResult = { ok: true; bytes: number } | { ok: false; reason: string; bytes?: number };

type CommentsCacheApi = {
    get(key: string): unknown | null;
    set(key: string, value: unknown): CommentsCacheSetResult;
    clear(): void;
};

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 10;
const DEFAULT_MAX_BYTES = 8_000_000;

export function createCommentsCache(options: CommentsCacheOptions = {}): CommentsCacheApi {
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    const now = options.now ?? (() => Date.now());
    const cache = new Map<string, CommentsCacheEntry>();

    const get = (key: string): unknown | null => {
        const entry = cache.get(key);
        if (!entry) return null;
        if (now() > entry.expiresAt) {
            cache.delete(key);
            return null;
        }
        cache.delete(key);
        cache.set(key, entry);
        return entry.value;
    };

    const set = (key: string, value: unknown): CommentsCacheSetResult => {
        let bytes = 0;
        try {
            bytes = JSON.stringify(value).length;
            if (bytes > maxBytes) return { ok: false, reason: 'too_large', bytes };
        } catch {
            return { ok: false, reason: 'not_serializable' };
        }

        cache.set(key, { value, expiresAt: now() + ttlMs });
        while (cache.size > maxEntries) {
            const oldestKey = cache.keys().next().value as string | undefined;
            if (!oldestKey) break;
            cache.delete(oldestKey);
        }
        return { ok: true, bytes };
    };

    const clear = (): void => {
        cache.clear();
    };

    return { get, set, clear };
}

const defaultCommentsCache = createCommentsCache();

export function getCachedComments(key: string): unknown | null {
    return defaultCommentsCache.get(key);
}

export function setCachedComments(key: string, value: unknown): CommentsCacheSetResult {
    return defaultCommentsCache.set(key, value);
}

export const __test__ = {
    createCommentsCache,
    clearDefaultCommentsCache: () => defaultCommentsCache.clear(),
};
