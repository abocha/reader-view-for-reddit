
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    renderArticle,
    renderMedia,
    renderCommentTree,
    initPreferences,
    sanitizeHtmlToFragment
} from '../pages/reader-host';

// Mock getElementById to return elements from our simulated body
const getEl = (id: string) => document.getElementById(id);

describe('Reader UI Rendering', () => {

    beforeEach(() => {
        // Setup base DOM
        document.body.innerHTML = `
            <div id="spike-article"></div>
            <div id="comments-list"></div>
            <div id="reader-toolbar">
                 <button class="theme-btn" data-theme="dark"></button>
                 <button class="theme-btn" data-theme="light"></button>
            </div>
            <div id="settings-drawer"></div>
        `;
    });

    describe('renderArticle', () => {
        it('should render post title and meta', () => {
            const post = {
                title: 'Test Post',
                author: 'tester',
                subreddit: 'r/test',
                bodyHtml: '<p>Content</p>',
                url: 'http://reddit.com',
                isFallback: false,
                bodyMarkdown: ''
            };

            renderArticle(post);

            const article = getEl('spike-article');
            expect(article?.querySelector('h1')?.textContent).toBe('Test Post');
            expect(article?.querySelector('.meta')?.textContent).toContain('r/test • u/tester');
            expect(article?.querySelector('.content')?.innerHTML).toContain('Content');
        });

        it('should show fallback badge if isFallback', () => {
            const post = {
                title: 'Fallback',
                author: 'unknown',
                subreddit: 'r/reddit',
                bodyHtml: '',
                url: '',
                isFallback: true,
                bodyMarkdown: ''
            };
            renderArticle(post);
            expect(document.querySelector('.fallback-badge')).not.toBeNull();
        });

        it('should render media if present', () => {
            const post = {
                title: 'Image Post',
                author: 'u',
                subreddit: 'r',
                bodyHtml: '',
                url: '',
                isFallback: false,
                bodyMarkdown: '',
                media: { type: 'image', url: 'http://img.com/a.jpg' } as any
            };
            renderArticle(post);
            // Media is rendered into content
            const img = document.querySelector('.content img');
            expect(img).not.toBeNull();
            expect(img?.getAttribute('src')).toBe('http://img.com/a.jpg');
        });
    });

    describe('renderMedia', () => {
        it('should render image media', () => {
            const media = { type: 'image', url: 'http://foo.com/img.jpg' } as any;
            const post = { media } as any;
            const el = renderMedia(post);

            expect(el?.querySelector('img')?.getAttribute('src')).toBe('http://foo.com/img.jpg');
            expect(el?.textContent).toContain('Image');
        });

        it('should render video placeholder link', () => {
            const media = { type: 'video', url: 'http://v.redd.it/1' } as any;
            const post = { media } as any;
            const el = renderMedia(post);

            expect(el?.textContent).toContain('Video');
            const link = el?.querySelector('.media-link') as HTMLAnchorElement | null;
            expect(link?.textContent).toBe('View on Reddit');
            expect(el?.querySelector('img')).toBeNull(); // No inline player
        });
    });

    describe('renderCommentTree', () => {
        it('should render comment structure', () => {
            const comment = {
                id: 'c1',
                author: 'replier',
                bodyHtml: '<p>Reply</p>',
                score: 5,
                bodyMarkdown: '',
                replies: []
            };

            const el = renderCommentTree(comment, {
                depthLimit: 5,
                autoDepth: true,
                hideLow: false,
                promotedPathIds: new Set()
            }, 0, false);

            expect(el.className).toBe('comment');
            expect(el.querySelector('.comment-meta-text')?.textContent).toContain('u/replier • 5 points');
            expect(el.innerHTML).toContain('Reply');
        });
    });

    describe('initPreferences', () => {
        it('should apply saved theme', () => {
            localStorage.setItem('reader-theme', 'dark');
            initPreferences();
            expect(document.body.classList.contains('theme-dark')).toBe(true);
            expect(document.querySelector('.theme-btn[data-theme="dark"]')?.classList.contains('active')).toBe(true);
        });
    });
});
