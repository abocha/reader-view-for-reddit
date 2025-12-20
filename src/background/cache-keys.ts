const isRedditHostname = (hostname: string): boolean =>
    hostname === 'reddit.com' || hostname.endsWith('.reddit.com');

export function normalizeRedditPostCacheKey(pageUrl: string): string | null {
    try {
        const url = new URL(pageUrl);
        if (!isRedditHostname(url.hostname) || !url.pathname.includes('/comments/')) return null;
        const path = url.pathname.replace(/\/$/, '');
        return `${url.origin}${path}`;
    } catch {
        return null;
    }
}
