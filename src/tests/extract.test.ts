
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractRedditPost } from '../content/reddit-extract';

// Mock Fetch and Window
const originalFetch = globalThis.fetch;
const originalLocation = window.location;
const originalDocumentTitle = document.title;

describe('extractRedditPost', () => {
    beforeEach(() => {
        globalThis.fetch = vi.fn();
        // Reset DOM
        document.body.innerHTML = '';
        document.title = 'Reddit - Dive into anything';

        // Mock Location
        // @ts-ignore
        delete window.location;
        // @ts-ignore
        window.location = {
            hostname: 'www.reddit.com',
            pathname: '/r/science/comments/12345/new_discovery/',
            origin: 'https://www.reddit.com',
            href: 'https://www.reddit.com/r/science/comments/12345/new_discovery/'
        };
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        // @ts-ignore
        window.location = originalLocation;
        document.title = originalDocumentTitle;
    });

    it('should extract via JSON API successfully', async () => {
        const mockPayload = [
            {
                kind: 'Listing',
                data: {
                    children: [
                        {
                            kind: 't3',
                            data: {
                                id: '12345',
                                title: 'New Discovery',
                                author: 'scientist',
                                subreddit_name_prefixed: 'r/science',
                                selftext_html: '<div class="md"><p>This is the body</p></div>',
                                selftext: 'This is the body',
                                permalink: '/r/science/comments/12345/new_discovery/',
                                url_overridden_by_dest: 'https://example.com'
                            }
                        }
                    ]
                }
            }
        ];

        (globalThis.fetch as any).mockResolvedValue({
            ok: true,
            json: async () => mockPayload
        });

        const result = await extractRedditPost();

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.payload.title).toBe('New Discovery');
            expect(result.payload.author).toBe('scientist');
            expect(result.payload.bodyHtml).toContain('<p>This is the body</p>'); // Extractor decodes HTML
            expect(result.payload.isFallback).toBe(false);
            expect(result.payload.linkUrl).toBe('https://example.com');
        }
    });

    it('should fail gracefuly if JSON parse fails and fallback to DOM', async () => {
        (globalThis.fetch as any).mockResolvedValue({
            ok: false,
            status: 500
        });

        // Setup DOM for Fallback
        document.title = 'Fallback Title';
        const h1 = document.createElement('h1');
        h1.textContent = 'Fallback Title';
        document.body.appendChild(h1);

        const contentDiv = document.createElement('div');
        contentDiv.setAttribute('data-testid', 'post-content');
        contentDiv.innerHTML = '<p>Fallback body content</p>';
        document.body.appendChild(contentDiv);

        const result = await extractRedditPost();

        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.payload.title).toBe('Fallback Title');
            expect(result.payload.bodyHtml).toBe('<p>Fallback body content</p>');
            expect(result.payload.isFallback).toBe(true);
        }
    });

    it('should return error if not a reddit post url', async () => {
        // @ts-ignore
        window.location = {
            hostname: 'google.com',
            pathname: '/'
        };

        const result = await extractRedditPost();
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('Not a Reddit post URL');
        }
    });

    it('should reject lookalike reddit hostnames', async () => {
        // @ts-ignore
        window.location = {
            hostname: 'reddit.com.evil.tld',
            pathname: '/r/test/comments/123/post/'
        };

        const result = await extractRedditPost();
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.error).toContain('Not a Reddit post URL');
        }
    });
});
