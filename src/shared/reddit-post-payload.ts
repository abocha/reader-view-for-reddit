import type { RedditPostPayload } from '../content/reddit-extract';

type RedditPostData = any;

type ResolvedRedditPost = {
    viewedPost: RedditPostData;
    contentPost: RedditPostData;
    isCrosspost: boolean;
};

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

export function resolveRedditPostData(initialPost: RedditPostData): ResolvedRedditPost {
    const isCrosspost = Array.isArray(initialPost?.crosspost_parent_list) && initialPost.crosspost_parent_list.length > 0;
    const contentPost = isCrosspost ? initialPost.crosspost_parent_list[0] : initialPost;
    return {
        viewedPost: initialPost,
        contentPost,
        isCrosspost,
    };
}

export function buildRedditPostPayload(pageUrl: string, initialPost: RedditPostData): RedditPostPayload {
    const { viewedPost, contentPost, isCrosspost } = resolveRedditPostData(initialPost);

    const bodyMarkdown = contentPost?.selftext || '';
    let bodyHtml = contentPost?.selftext_html || '';
    if (!bodyHtml && bodyMarkdown) bodyHtml = `<pre>${escapeHtml(bodyMarkdown)}</pre>`;
    bodyHtml = cleanRedditHtml(bodyHtml);

    const subreddit = isCrosspost
        ? `${viewedPost.subreddit_name_prefixed} 🔀 ${contentPost.subreddit_name_prefixed}`
        : viewedPost.subreddit_name_prefixed;

    let media: RedditPostPayload['media'] = undefined;

    if (contentPost?.is_gallery && contentPost.gallery_data?.items && contentPost.media_metadata) {
        const items = contentPost.gallery_data.items as Array<{ media_id?: string }>;
        const firstId = items?.[0]?.media_id;
        const first = firstId ? contentPost.media_metadata[firstId] : null;
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

    if (!media && contentPost?.is_video) {
        const videoUrl =
            tryHttpUrl(contentPost.secure_media?.reddit_video?.fallback_url) ||
            tryHttpUrl(contentPost.media?.reddit_video?.fallback_url);
        if (videoUrl) media = { type: 'video', url: videoUrl };
    }

    if (!media) {
        const previewUrl =
            tryHttpUrl(contentPost?.preview?.images?.[0]?.source?.url) ||
            tryHttpUrl(contentPost?.url_overridden_by_dest);
        const previewThumb =
            tryHttpUrl(contentPost?.preview?.images?.[0]?.resolutions?.[0]?.url) ||
            tryHttpUrl(contentPost?.thumbnail);
        if (previewUrl && (contentPost?.post_hint === 'image' || contentPost?.preview?.images?.length)) {
            media = {
                type: 'image',
                url: previewUrl,
                thumbnailUrl: previewThumb || undefined,
            };
        }
    }

    return {
        title: viewedPost?.title || 'Reddit Post',
        author: viewedPost?.author || 'unknown',
        subreddit: subreddit || 'r/reddit',
        bodyHtml,
        bodyMarkdown,
        isFallback: false,
        url: pageUrl,
        linkUrl: contentPost?.url_overridden_by_dest,
        thumbnail: contentPost?.thumbnail,
        permalink: viewedPost?.permalink,
        postId: viewedPost?.id,
        nsfw: Boolean(viewedPost?.over_18),
        spoiler: Boolean(viewedPost?.spoiler),
        score: typeof viewedPost?.score === 'number' ? viewedPost.score : undefined,
        media,
    };
}
