import { RedditPostPayload } from '../content/reddit-extract';

type RedditPostData = any;

const cleanRedditHtml = (html: string): string => {
    if (!html) return '';
    return html.replace(/<!-- SC_OFF -->/g, '').replace(/<!-- SC_ON -->/g, '');
};

const escapeHtml = (value: string): string =>
    value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");

const normalizeUrl = (value: string): string => value.replace(/&amp;/g, '&');

const tryHttpUrl = (value: string | undefined | null): string | null => {
    if (!value) return null;
    try {
        const url = new URL(normalizeUrl(value));
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        return url.toString();
    } catch {
        return null;
    }
};

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
            const payload = buildPayloadFromPostData(pageUrl, initialPost);
            return { payload, meta: { endpoint: 'by_id', bytes, url: postOnlyUrl } };
        }
    }

    const permalinkUrl = buildRedditPostJsonUrl(pageUrl);
    if (!permalinkUrl) throw new Error('Not a Reddit post URL');

    const { data, bytes } = await fetchJsonWithMeta(permalinkUrl);
    const initialPost: RedditPostData | undefined = getInitialPostFromPermalinkListing(data);
    if (!initialPost) throw new Error('Missing post data');

    const isCrosspost = Array.isArray(initialPost.crosspost_parent_list) && initialPost.crosspost_parent_list.length > 0;
    const finalPost: RedditPostData = isCrosspost ? initialPost.crosspost_parent_list[0] : initialPost;

    const bodyMarkdown = finalPost.selftext || '';
    let bodyHtml = finalPost.selftext_html || '';
    if (!bodyHtml && bodyMarkdown) bodyHtml = `<pre>${escapeHtml(bodyMarkdown)}</pre>`;
    bodyHtml = cleanRedditHtml(bodyHtml);

    const subreddit = isCrosspost
        ? `${initialPost.subreddit_name_prefixed} 🔀 ${finalPost.subreddit_name_prefixed}`
        : initialPost.subreddit_name_prefixed;

    let media: RedditPostPayload['media'] = undefined;

    if (finalPost.is_gallery && finalPost.gallery_data?.items && finalPost.media_metadata) {
        const items = finalPost.gallery_data.items as Array<{ media_id?: string }>;
        const firstId = items?.[0]?.media_id;
        const first = firstId ? finalPost.media_metadata[firstId] : null;
        const firstUrl = tryHttpUrl(first?.s?.u);
        const firstThumb = tryHttpUrl(first?.p?.[0]?.u);
        if (firstUrl) {
            media = {
                type: 'gallery',
                url: firstUrl,
                thumbnailUrl: firstThumb || undefined,
                galleryCount: items?.length || undefined,
            };
        }
    }

    if (!media && finalPost.is_video) {
        const videoUrl =
            tryHttpUrl(finalPost.secure_media?.reddit_video?.fallback_url) ||
            tryHttpUrl(finalPost.media?.reddit_video?.fallback_url);
        if (videoUrl) media = { type: 'video', url: videoUrl };
    }

    if (!media) {
        const previewUrl =
            tryHttpUrl(finalPost.preview?.images?.[0]?.source?.url) ||
            tryHttpUrl(finalPost.url_overridden_by_dest);
        const previewThumb =
            tryHttpUrl(finalPost.preview?.images?.[0]?.resolutions?.[0]?.url) ||
            tryHttpUrl(finalPost.thumbnail);
        if (previewUrl && (finalPost.post_hint === 'image' || finalPost.preview?.images?.length)) {
            media = {
                type: 'image',
                url: previewUrl,
                thumbnailUrl: previewThumb || undefined,
            };
        }
    }

    return {
        payload: {
            title: initialPost.title || 'Reddit Post',
            author: initialPost.author || 'unknown',
            subreddit: subreddit || 'r/reddit',
            bodyHtml,
            bodyMarkdown,
            isFallback: false,
            url: pageUrl,
            linkUrl: finalPost.url_overridden_by_dest,
            thumbnail: finalPost.thumbnail,
            permalink: finalPost.permalink,
            postId: finalPost.id,
            media,
        },
        meta: { endpoint: 'permalink', bytes, url: permalinkUrl },
    };
}

function buildPayloadFromPostData(pageUrl: string, initialPost: RedditPostData): RedditPostPayload {
    const isCrosspost = Array.isArray(initialPost.crosspost_parent_list) && initialPost.crosspost_parent_list.length > 0;
    const finalPost: RedditPostData = isCrosspost ? initialPost.crosspost_parent_list[0] : initialPost;

    const bodyMarkdown = finalPost.selftext || '';
    let bodyHtml = finalPost.selftext_html || '';
    if (!bodyHtml && bodyMarkdown) bodyHtml = `<pre>${escapeHtml(bodyMarkdown)}</pre>`;
    bodyHtml = cleanRedditHtml(bodyHtml);

    const subreddit = isCrosspost
        ? `${initialPost.subreddit_name_prefixed} 🔀 ${finalPost.subreddit_name_prefixed}`
        : initialPost.subreddit_name_prefixed;

    let media: RedditPostPayload['media'] = undefined;

    if (finalPost.is_gallery && finalPost.gallery_data?.items && finalPost.media_metadata) {
        const items = finalPost.gallery_data.items as Array<{ media_id?: string }>;
        const firstId = items?.[0]?.media_id;
        const first = firstId ? finalPost.media_metadata[firstId] : null;
        const firstUrl = tryHttpUrl(first?.s?.u);
        const firstThumb = tryHttpUrl(first?.p?.[0]?.u);
        if (firstUrl) {
            media = {
                type: 'gallery',
                url: firstUrl,
                thumbnailUrl: firstThumb || undefined,
                galleryCount: items?.length || undefined,
            };
        }
    }

    if (!media && finalPost.is_video) {
        const videoUrl =
            tryHttpUrl(finalPost.secure_media?.reddit_video?.fallback_url) ||
            tryHttpUrl(finalPost.media?.reddit_video?.fallback_url);
        if (videoUrl) media = { type: 'video', url: videoUrl };
    }

    if (!media) {
        const previewUrl =
            tryHttpUrl(finalPost.preview?.images?.[0]?.source?.url) ||
            tryHttpUrl(finalPost.url_overridden_by_dest);
        const previewThumb =
            tryHttpUrl(finalPost.preview?.images?.[0]?.resolutions?.[0]?.url) ||
            tryHttpUrl(finalPost.thumbnail);
        if (previewUrl && (finalPost.post_hint === 'image' || finalPost.preview?.images?.length)) {
            media = {
                type: 'image',
                url: previewUrl,
                thumbnailUrl: previewThumb || undefined,
            };
        }
    }

    return {
        title: initialPost.title || 'Reddit Post',
        author: initialPost.author || 'unknown',
        subreddit: subreddit || 'r/reddit',
        bodyHtml,
        bodyMarkdown,
        isFallback: false,
        url: pageUrl,
        linkUrl: finalPost.url_overridden_by_dest,
        thumbnail: finalPost.thumbnail,
        permalink: finalPost.permalink,
        postId: finalPost.id,
        media,
    };
}
