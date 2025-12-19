export interface RedditPostPayload {
    title: string;
    author: string;
    subreddit: string;
    bodyHtml: string;
    bodyMarkdown: string;
    isFallback: boolean;
    url: string;
    linkUrl?: string; // For link posts
    thumbnail?: string;
    permalink?: string;
    postId?: string;
    nsfw?: boolean;
    spoiler?: boolean;
    score?: number;
    media?: {
        type: 'image' | 'gallery' | 'video';
        url: string;
        thumbnailUrl?: string;
        galleryCount?: number;
    };
}

export type ExtractionResult =
    | { ok: true; payload: RedditPostPayload }
    | { ok: false; error: string };

/**
 * Self-contained function to extract Reddit post content.
 * Must not rely on external imports when injected via executeScript({ func }).
 */
export async function extractRedditPost(): Promise<ExtractionResult> {
    // --- Helper: Clean Reddit HTML (internal to this scope) ---
    const cleanRedditHtml = (html: string): string => {
        if (!html) return '';
        let decoded = html;

        // Remove Reddit specific comment markers
        decoded = decoded.replace(/<!-- SC_OFF -->/g, '').replace(/<!-- SC_ON -->/g, '');
        return decoded;
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

    try {
        const loc = window.location;
        // Basic validation
        if (!isRedditHostname(loc.hostname) || !loc.pathname.includes('/comments/')) {
            return { ok: false, error: 'Not a Reddit post URL' };
        }

        // --- Strategy 1: JSON API ---
        try {
            // Construct URL: current origin + pathname (no trailing slash) + .json?raw_json=1
            const jsonUrl = loc.origin + loc.pathname.replace(/\/$/, '') + '.json?raw_json=1';

            const response = await fetch(jsonUrl, { credentials: 'include' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            const data = await response.json();

            // Navigate: [0] -> data -> children[0] -> data
            const initialPost = data?.[0]?.data?.children?.[0]?.data;

            if (initialPost) {
                // Check for Crosspost
                const isCrosspost = initialPost.crosspost_parent_list && initialPost.crosspost_parent_list.length > 0;
                const finalPost = isCrosspost ? initialPost.crosspost_parent_list[0] : initialPost;

                // Prefer selftext_html, fallback to selftext
                const bodyMarkdown = finalPost.selftext || '';
                let bodyHtml = finalPost.selftext_html || '';
                if (!bodyHtml && bodyMarkdown) {
                    bodyHtml = `<pre>${escapeHtml(bodyMarkdown)}</pre>`;
                }
                bodyHtml = cleanRedditHtml(bodyHtml);

                const subreddit = isCrosspost
                    ? `${initialPost.subreddit_name_prefixed} 🔀 ${finalPost.subreddit_name_prefixed}`
                    : initialPost.subreddit_name_prefixed;

                let media: RedditPostPayload['media'] = undefined;

                // Gallery (use first item for preview)
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

                // Video (link to Reddit-hosted fallback url)
                if (!media && finalPost.is_video) {
                    const videoUrl =
                        tryHttpUrl(finalPost.secure_media?.reddit_video?.fallback_url) ||
                        tryHttpUrl(finalPost.media?.reddit_video?.fallback_url);
                    if (videoUrl) {
                        media = { type: 'video', url: videoUrl };
                    }
                }

                // Image (prefer preview/source and fallback to overridden url)
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
                    ok: true,
                    payload: {
                        title: initialPost.title || document.title,
                        author: initialPost.author || 'unknown',
                        subreddit: subreddit || "r/reddit",
                        bodyHtml: bodyHtml,
                        bodyMarkdown: bodyMarkdown,
                        isFallback: false,
                        url: loc.href,
                        linkUrl: finalPost.url_overridden_by_dest, // External link
                        thumbnail: finalPost.thumbnail, // 'default', 'self', or URL
                        permalink: finalPost.permalink,
                        postId: finalPost.id,
                        nsfw: Boolean(finalPost.over_18),
                        spoiler: Boolean(finalPost.spoiler),
                        score: typeof finalPost.score === 'number' ? finalPost.score : undefined,
                        media,
                    }
                };
            }
        } catch (err) {
            console.warn('[Reader Helper] JSON extraction failed, trying DOM fallback', err);
        }

        // --- Strategy 2: DOM Fallback ---
        // Title
        const titleEl = document.querySelector('h1') ||
            document.querySelector('shreddit-title') ||
            document.querySelector('meta[property="og:title"]');

        let title = '';
        if (titleEl instanceof HTMLMetaElement) title = titleEl.content;
        else if (titleEl) title = (titleEl as HTMLElement).innerText || titleEl.getAttribute('title') || '';

        // Body
        // Try modern Reddit selectors
        const bodyEl = document.querySelector('div[data-testid="post-content"]') ||
            document.querySelector('div[id^="t3_"]'); // old reddit style

        let bodyHtml = '';
        if (bodyEl) {
            bodyHtml = bodyEl.innerHTML;
        } else {
            // Last resort: meta description
            const metaDesc = document.querySelector('meta[name="description"]');
            if (metaDesc) bodyHtml = `<p>${(metaDesc as HTMLMetaElement).content}</p>`;
        }

        if (!title && !bodyHtml) {
            return { ok: false, error: 'Could not extract content via JSON or DOM' };
        }

        return {
            ok: true,
            payload: {
                title: title || document.title,
                author: 'unknown', // Hard to unreliable extract from DOM consistently
                subreddit: 'r/reddit',
                bodyHtml: bodyHtml,
                bodyMarkdown: '',
                isFallback: true,
                url: loc.href,
                nsfw: false,
                spoiler: false,
                score: undefined,
            }
        };

    } catch (e: any) {
        return { ok: false, error: e.message || 'Unknown extraction error' };
    }
}
