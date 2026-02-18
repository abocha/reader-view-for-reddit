import { describe, it, expect, vi } from 'vitest';
import { buildRedditPostJsonUrl, fetchRedditPostPayloadFromJson } from '../background/reddit-json';

describe('buildRedditPostJsonUrl', () => {
    it('accepts reddit.com and subdomains', () => {
        const direct = buildRedditPostJsonUrl('https://reddit.com/r/test/comments/abc/post/');
        const sub = buildRedditPostJsonUrl('https://www.reddit.com/r/test/comments/abc/post/');

        expect(direct).toContain('/r/test/comments/abc/post.json');
        expect(sub).toContain('/r/test/comments/abc/post.json');
        expect(sub).toContain('raw_json=1');
    });

    it('rejects lookalike hostnames', () => {
        const bad = buildRedditPostJsonUrl('https://reddit.com.evil.tld/r/test/comments/abc/post/');
        const bad2 = buildRedditPostJsonUrl('https://notreddit.com/r/test/comments/abc/post/');

        expect(bad).toBeNull();
        expect(bad2).toBeNull();
    });
});

describe('fetchRedditPostPayloadFromJson', () => {
    it('keeps viewed thread metadata for crossposts while using parent body content', async () => {
        (globalThis.fetch as any) = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                data: {
                    children: [
                        {
                            kind: 't3',
                            data: {
                                id: 'cross123',
                                title: 'Crosspost title',
                                author: 'viewer',
                                subreddit_name_prefixed: 'r/crosspost',
                                permalink: '/r/crosspost/comments/cross123/viewed_post/',
                                over_18: true,
                                spoiler: false,
                                score: 42,
                                crosspost_parent_list: [
                                    {
                                        id: 'orig999',
                                        selftext_html: '<p>From parent</p>',
                                        selftext: 'From parent',
                                        subreddit_name_prefixed: 'r/original',
                                        permalink: '/r/original/comments/orig999/original_post/',
                                        score: 999,
                                    },
                                ],
                            },
                        },
                    ],
                },
            }),
        });

        const { payload } = await fetchRedditPostPayloadFromJson('https://www.reddit.com/r/crosspost/comments/cross123/viewed_post/');
        expect(payload.bodyHtml).toContain('From parent');
        expect(payload.permalink).toBe('/r/crosspost/comments/cross123/viewed_post/');
        expect(payload.postId).toBe('cross123');
        expect(payload.nsfw).toBe(true);
        expect(payload.score).toBe(42);
        expect(payload.subreddit).toBe('r/crosspost 🔀 r/original');
    });
});
