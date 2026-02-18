type PayloadCacheOptions = {
    ttlMs?: number;
    maxEntries?: number;
    now?: () => number;
};

type PayloadCacheEntry = {
    payload: unknown;
    expiresAt: number;
};

type PayloadCacheApi = {
    get(key: string): unknown | null;
    set(key: string, payload: unknown): void;
    clear(): void;
};

const DEFAULT_TTL_MS = 3 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 30;

export function createPayloadCache(options: PayloadCacheOptions = {}): PayloadCacheApi {
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    const now = options.now ?? (() => Date.now());
    const cache = new Map<string, PayloadCacheEntry>();

    const get = (key: string): unknown | null => {
        const entry = cache.get(key);
        if (!entry) return null;
        if (now() > entry.expiresAt) {
            cache.delete(key);
            return null;
        }
        cache.delete(key);
        cache.set(key, entry);
        return entry.payload;
    };

    const set = (key: string, payload: unknown): void => {
        cache.set(key, { payload, expiresAt: now() + ttlMs });
        while (cache.size > maxEntries) {
            const oldestKey = cache.keys().next().value as string | undefined;
            if (!oldestKey) break;
            cache.delete(oldestKey);
        }
    };

    const clear = (): void => {
        cache.clear();
    };

    return { get, set, clear };
}

const defaultPayloadCache = createPayloadCache();

export function getCachedPayload(key: string): unknown | null {
    return defaultPayloadCache.get(key);
}

export function setCachedPayload(key: string, payload: unknown): void {
    defaultPayloadCache.set(key, payload);
}

export const __test__ = {
    createPayloadCache,
    clearDefaultPayloadCache: () => defaultPayloadCache.clear(),
};
