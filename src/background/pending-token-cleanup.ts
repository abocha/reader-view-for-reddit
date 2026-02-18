import browser from 'webextension-polyfill';

export type PendingTokenEntry = {
    token: string;
    createdAt: number;
};

type StorageSessionLike = {
    get: (key: string | string[] | Record<string, unknown> | null) => Promise<Record<string, unknown>>;
    set: (items: Record<string, unknown>) => Promise<void>;
    remove: (keys: string | string[]) => Promise<void>;
};

type PendingTokenCleanerOptions = {
    ttlMs?: number;
    cleanupIntervalMs?: number;
    now?: () => number;
};

const DEFAULT_PENDING_TOKEN_TTL_MS = 5 * 60 * 1000;
const DEFAULT_PENDING_CLEANUP_INTERVAL_MS = 30 * 1000;

export function createPendingTokenCleaner(
    storageSession: StorageSessionLike,
    options: PendingTokenCleanerOptions = {},
): { cleanup: () => Promise<void>; resetWindow: () => void } {
    const ttlMs = options.ttlMs ?? DEFAULT_PENDING_TOKEN_TTL_MS;
    const cleanupIntervalMs = options.cleanupIntervalMs ?? DEFAULT_PENDING_CLEANUP_INTERVAL_MS;
    const now = options.now ?? (() => Date.now());
    let lastCleanupAt = 0;

    const cleanup = async (): Promise<void> => {
        const nowMs = now();
        if (lastCleanupAt !== 0 && nowMs - lastCleanupAt < cleanupIntervalMs) return;
        lastCleanupAt = nowMs;

        try {
            const data = await storageSession.get(null);
            const updates: Record<string, PendingTokenEntry> = {};
            const remove: string[] = [];

            for (const [key, value] of Object.entries(data)) {
                if (!key.startsWith('pending_token:')) continue;

                if (typeof value === 'string') {
                    if (!value) {
                        remove.push(key);
                        continue;
                    }
                    updates[key] = { token: value, createdAt: nowMs };
                    continue;
                }

                if (!value || typeof value !== 'object') {
                    remove.push(key);
                    continue;
                }

                const token = (value as any).token;
                const createdAt = Number((value as any).createdAt);
                if (typeof token !== 'string' || !token || !Number.isFinite(createdAt)) {
                    remove.push(key);
                    continue;
                }
                if (nowMs - createdAt > ttlMs) {
                    remove.push(key);
                }
            }

            if (Object.keys(updates).length > 0) {
                await storageSession.set(updates);
            }
            if (remove.length > 0) {
                await storageSession.remove(remove);
            }
        } catch {
            // ignore cleanup failures
        }
    };

    const resetWindow = (): void => {
        lastCleanupAt = 0;
    };

    return { cleanup, resetWindow };
}

const defaultCleaner = createPendingTokenCleaner(browser.storage.session as StorageSessionLike);

export async function cleanupPendingTokens(): Promise<void> {
    await defaultCleaner.cleanup();
}

export const __test__ = {
    createPendingTokenCleaner,
    resetDefaultPendingCleanupWindow: () => defaultCleaner.resetWindow(),
};
