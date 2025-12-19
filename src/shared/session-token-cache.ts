import browser from 'webextension-polyfill';

type SessionTokenEntry = {
    token: string;
    createdAt: number;
    lastAccessed: number;
    url?: string;
};

const TOKEN_INDEX_KEY = 'rvrr_tokens';
const TOKEN_TTL_MS = 30 * 60 * 1000;
const TOKEN_MAX_ENTRIES = 15;

const sanitizeEntries = (value: unknown): SessionTokenEntry[] => {
    if (!Array.isArray(value)) return [];
    const entries: SessionTokenEntry[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const token = (item as any).token;
        const createdAt = Number((item as any).createdAt);
        const lastAccessed = Number((item as any).lastAccessed);
        const url = (item as any).url;
        if (typeof token !== 'string' || !token) continue;
        if (!Number.isFinite(createdAt) || !Number.isFinite(lastAccessed)) continue;
        const entry: SessionTokenEntry = { token, createdAt, lastAccessed };
        if (typeof url === 'string' && url) entry.url = url;
        entries.push(entry);
    }
    return entries;
};

const isExpired = (entry: SessionTokenEntry, now: number): boolean =>
    now - entry.lastAccessed > TOKEN_TTL_MS;

const persistEntries = async (entries: SessionTokenEntry[]): Promise<void> => {
    await browser.storage.session.set({ [TOKEN_INDEX_KEY]: entries });
};

const removeTokens = async (tokens: string[]): Promise<void> => {
    if (tokens.length === 0) return;
    try {
        await browser.storage.session.remove(tokens);
    } catch {
        // ignore cleanup failures
    }
};

async function loadEntries(): Promise<SessionTokenEntry[]> {
    const data = await browser.storage.session.get(TOKEN_INDEX_KEY);
    return sanitizeEntries((data as any)?.[TOKEN_INDEX_KEY]);
}

export async function recordSessionToken(token: string, url?: string): Promise<void> {
    const now = Date.now();
    const entries = await loadEntries();

    const expiredTokens: string[] = [];
    const active = entries.filter(entry => {
        if (isExpired(entry, now)) {
            expiredTokens.push(entry.token);
            return false;
        }
        return true;
    });

    const existing = active.find(entry => entry.token === token);
    if (existing) {
        existing.lastAccessed = now;
        if (url && !existing.url) existing.url = url;
    } else {
        active.push({ token, createdAt: now, lastAccessed: now, url });
    }

    active.sort((a, b) => a.lastAccessed - b.lastAccessed);
    const evicted: string[] = [];
    while (active.length > TOKEN_MAX_ENTRIES) {
        const removed = active.shift();
        if (removed) evicted.push(removed.token);
    }

    await persistEntries(active);
    await removeTokens([...expiredTokens, ...evicted]);
}

export async function touchSessionToken(token: string): Promise<void> {
    const now = Date.now();
    const entries = await loadEntries();

    let touched = false;
    for (const entry of entries) {
        if (entry.token === token) {
            entry.lastAccessed = now;
            touched = true;
            break;
        }
    }

    if (!touched) return;

    const expiredTokens: string[] = [];
    const active = entries.filter(entry => {
        if (entry.token === token) return true;
        if (isExpired(entry, now)) {
            expiredTokens.push(entry.token);
            return false;
        }
        return true;
    });

    await persistEntries(active);
    await removeTokens(expiredTokens);
}

export async function forgetSessionToken(token: string): Promise<void> {
    const entries = await loadEntries();
    const next = entries.filter(entry => entry.token !== token);
    if (next.length === entries.length) return;
    await persistEntries(next);
    await removeTokens([token]);
}
