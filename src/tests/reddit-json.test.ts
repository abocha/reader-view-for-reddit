import { describe, it, expect } from 'vitest';
import { buildRedditPostJsonUrl } from '../background/reddit-json';

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
