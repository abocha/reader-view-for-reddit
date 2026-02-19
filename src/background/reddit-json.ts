import type { RedditPostPayload } from '../content/reddit-extract';
import { buildRedditPostPayload } from '../shared/reddit-post-payload';

type RedditPostData = any;

const isRedditHostname = (hostname: string): boolean =>
    hostname === 'reddit.com' || hostname.endsWith('.reddit.com');

export function buildRedditPostJsonUrl(pageUrl: string): string | null {
    try {
        const url = new URL(pageUrl);
        if (!isRedditHostname(url.hostname) || !url.pathname.includes('/comments/')) return null;

        const basePath = url.pathname.replace(/\/$/, '');
        const jsonUrl = new URL(url.origin + basePath + '.json');
        jsonUrl.searchParams.set('raw_json', '1');
        return jsonUrl.toString();
    } catch {
        return null;
    }
}

function extractPostIdFromRedditUrl(pageUrl: string): { origin: string; postId: string } | null {
    try {
        const url = new URL(pageUrl);
        if (!isRedditHostname(url.hostname) || !url.pathname.includes('/comments/')) return null;
        const match = url.pathname.match(/\/comments\/([a-z0-9]+)(?:\/|$)/i);
        const postId = match?.[1];
        if (!postId) return null;
        return { origin: url.origin, postId };
    } catch {
        return null;
    }
}

function buildRedditPostOnlyJsonUrl(pageUrl: string): string | null {
    const info = extractPostIdFromRedditUrl(pageUrl);
    if (!info) return null;
    const jsonUrl = new URL(`/by_id/t3_${info.postId}.json`, info.origin);
    jsonUrl.searchParams.set('raw_json', '1');
    return jsonUrl.toString();
}

async function fetchJsonWithMeta(url: string): Promise<{ data: any; bytes: number }> {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const bytes = new TextEncoder().encode(text).byteLength;
    return { data: JSON.parse(text), bytes };
}

function getInitialPostFromPostOnlyListing(data: any): RedditPostData | undefined {
    // by_id endpoint: { data: { children: [ { kind: 't3', data: {...} } ] } }
    return data?.data?.children?.[0]?.data;
}

function getInitialPostFromPermalinkListing(data: any): RedditPostData | undefined {
    // permalink endpoint: [ { data: { children: [ { data: {...} } ] } }, ... ]
    return data?.[0]?.data?.children?.[0]?.data;
}

export async function fetchRedditPostPayloadFromJson(pageUrl: string): Promise<{ payload: RedditPostPayload; meta: { endpoint: 'by_id' | 'permalink'; bytes: number; url: string } }> {
    const postOnlyUrl = buildRedditPostOnlyJsonUrl(pageUrl);
    if (postOnlyUrl) {
        const { data, bytes } = await fetchJsonWithMeta(postOnlyUrl);
        const initialPost = getInitialPostFromPostOnlyListing(data);
        if (initialPost) {
            const payload = buildRedditPostPayload(pageUrl, initialPost);
            return { payload, meta: { endpoint: 'by_id', bytes, url: postOnlyUrl } };
        }
    }

    const permalinkUrl = buildRedditPostJsonUrl(pageUrl);
    if (!permalinkUrl) throw new Error('Not a Reddit post URL');

    const { data, bytes } = await fetchJsonWithMeta(permalinkUrl);
    const initialPost: RedditPostData | undefined = getInitialPostFromPermalinkListing(data);
    if (!initialPost) throw new Error('Missing post data');

    return {
        payload: buildRedditPostPayload(pageUrl, initialPost),
        meta: { endpoint: 'permalink', bytes, url: permalinkUrl },
    };
}
