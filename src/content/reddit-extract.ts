export interface RedditPostPayload {
    title: string;
    author: string;
    subreddit: string;
    bodyHtml: string;
    isFallback: boolean;
    url: string;
    linkUrl?: string; // For link posts
    thumbnail?: string;
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

    try {
        const loc = window.location;
        // Basic validation
        if (!loc.hostname.includes('reddit.com') || !loc.pathname.includes('/comments/')) {
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
                let bodyHtml = finalPost.selftext_html || finalPost.selftext || '';
                bodyHtml = cleanRedditHtml(bodyHtml);

                const subreddit = isCrosspost
                    ? `${initialPost.subreddit_name_prefixed} 🔀 ${finalPost.subreddit_name_prefixed}`
                    : initialPost.subreddit_name_prefixed;

                return {
                    ok: true,
                    payload: {
                        title: initialPost.title || document.title,
                        author: initialPost.author || 'unknown',
                        subreddit: subreddit || "r/reddit",
                        bodyHtml: bodyHtml,
                        isFallback: false,
                        url: loc.href,
                        linkUrl: finalPost.url_overridden_by_dest, // External link
                        thumbnail: finalPost.thumbnail // 'default', 'self', or URL
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
                isFallback: true,
                url: loc.href
            }
        };

    } catch (e: any) {
        return { ok: false, error: e.message || 'Unknown extraction error' };
    }
}
