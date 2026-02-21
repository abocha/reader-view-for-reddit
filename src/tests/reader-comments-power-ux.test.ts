import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __test__, initActions, renderArticle } from '../pages/reader-host';

type TestComment = {
    id: string;
    author: string;
    bodyMarkdown: string;
    bodyHtml: string;
    replies: TestComment[];
};

function makeComment(id: string, author: string, body: string, replies: TestComment[] = []): TestComment {
    return {
        id,
        author,
        bodyMarkdown: body,
        bodyHtml: `<p>${body}</p>`,
        replies,
    };
}

describe('comments power UX helpers', () => {
    beforeEach(() => {
        __test__.collapsedById.clear();
        __test__.expandedMoreById.clear();
        __test__.expandedLowScoreById.clear();
    });

    it('filters comments by text and preserves ancestor path', () => {
        const tree = [
            makeComment('c1', 'alice', 'parent text', [
                makeComment('c2', 'bob', 'needle value'),
                makeComment('c3', 'carol', 'other'),
            ]),
            makeComment('c4', 'dave', 'noise'),
        ];

        const filtered = __test__.filterCommentsBySearch(tree as any, 'needle');
        expect(filtered.length).toBe(1);
        expect(filtered[0]?.id).toBe('c1');
        expect(filtered[0]?.replies.map(reply => reply.id)).toEqual(['c2']);
    });

    it('filters comments by author: token', () => {
        const tree = [
            makeComment('c1', 'alice', 'hello'),
            makeComment('c2', 'bob', 'hello'),
        ];

        const filtered = __test__.filterCommentsBySearch(tree as any, 'author:alice');
        expect(filtered.map(comment => comment.id)).toEqual(['c1']);
    });

    it('applies expand/collapse/reset bulk actions', () => {
        const tree = [
            makeComment('c1', 'alice', 'root', [makeComment('c2', 'bob', 'child')]),
            makeComment('c3', 'AutoModerator', 'rules'),
        ];

        __test__.applyCommentsBulkAction('collapse_all', tree as any);
        expect(__test__.collapsedById.has('c1')).toBe(true);
        expect(__test__.collapsedById.has('c2')).toBe(true);
        expect(__test__.collapsedById.has('c3')).toBe(true);

        __test__.applyCommentsBulkAction('expand_all', tree as any);
        expect(__test__.collapsedById.size).toBe(0);
        expect(__test__.expandedMoreById.has('c1')).toBe(true);
        expect(__test__.expandedLowScoreById.has('c2')).toBe(true);

        __test__.applyCommentsBulkAction('reset_view', tree as any);
        expect(__test__.collapsedById.size).toBe(0);
        expect(__test__.expandedMoreById.size).toBe(0);
        expect(__test__.expandedLowScoreById.size).toBe(0);
    });
});

describe('markdown download actions', () => {
    it('downloads post markdown from toolbar action', async () => {
        document.body.innerHTML = `
            <div id="reader-toolbar"></div>
            <main></main>
            <div id="settings-drawer"></div>
            <button id="toggle-drawer" type="button"></button>
            <button id="close-drawer" type="button"></button>
            <select id="open-mode"><option value="same-tab">Same Tab</option></select>
            <button id="copy-post-md" type="button"></button>
            <button id="copy-post-comments-md" type="button"></button>
            <button id="download-post-md" type="button"></button>
            <button id="download-post-comments-md" type="button"></button>
            <article id="spike-article"></article>
        `;

        const urlAny = URL as any;
        const originalCreateObjectURL = urlAny.createObjectURL;
        const originalRevokeObjectURL = urlAny.revokeObjectURL;

        const createObjectURL = vi.fn(() => 'blob:test');
        const revokeObjectURL = vi.fn();
        urlAny.createObjectURL = createObjectURL;
        urlAny.revokeObjectURL = revokeObjectURL;

        const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
        try {
            initActions();
            renderArticle({
                title: 'Power UX Post',
                author: 'me',
                subreddit: 'r/test',
                bodyHtml: '<p>Body</p>',
                bodyMarkdown: 'Body',
                url: 'https://www.reddit.com/r/test/comments/abc123/power-ux-post/',
                postId: 'abc123',
                isFallback: false,
            } as any);

            (document.getElementById('download-post-md') as HTMLButtonElement).click();
            await Promise.resolve();

            expect(createObjectURL).toHaveBeenCalled();
            expect(clickSpy).toHaveBeenCalled();
            expect(revokeObjectURL).toBeTypeOf('function');
        } finally {
            clickSpy.mockRestore();
            urlAny.createObjectURL = originalCreateObjectURL;
            urlAny.revokeObjectURL = originalRevokeObjectURL;
        }
    });

    it('keeps post+comments markdown identical between copy and download paths', async () => {
        document.body.innerHTML = `
            <div id="reader-toolbar"></div>
            <main></main>
            <div id="settings-drawer"></div>
            <button id="toggle-drawer" type="button"></button>
            <button id="close-drawer" type="button"></button>
            <select id="open-mode"><option value="same-tab">Same Tab</option></select>
            <button id="copy-post-md" type="button"></button>
            <button id="copy-post-comments-md" type="button"></button>
            <button id="download-post-md" type="button"></button>
            <button id="download-post-comments-md" type="button"></button>
            <select id="comments-limit"><option value="100" selected>100</option></select>
            <input id="comments-depth" value="2" />
            <input id="comments-smart-mode" type="checkbox" checked />
            <article id="spike-article"></article>
        `;

        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText },
            configurable: true,
        });

        const urlAny = URL as any;
        const originalCreateObjectURL = urlAny.createObjectURL;
        const originalRevokeObjectURL = urlAny.revokeObjectURL;
        urlAny.createObjectURL = vi.fn((_blob: Blob) => {
            return 'blob:test';
        });
        urlAny.revokeObjectURL = vi.fn();

        const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
        try {
            initActions();
            renderArticle({
                title: 'Parity Post',
                author: 'me',
                subreddit: 'r/test',
                bodyHtml: '<p>Body</p>',
                bodyMarkdown: 'Body',
                url: 'https://www.reddit.com/r/test/comments/abc123/parity-post/',
                permalink: '/r/test/comments/abc123/parity-post/',
                postId: 'abc123',
                isFallback: false,
            } as any);

            (document.getElementById('copy-post-comments-md') as HTMLButtonElement).click();
            await Promise.resolve();
            const copied = String(writeText.mock.calls[0]?.[0] || '');

            (document.getElementById('download-post-comments-md') as HTMLButtonElement).click();
            await Promise.resolve();
            const downloadedBlob = (urlAny.createObjectURL as any).mock.calls[0]?.[0] as Blob | undefined;
            const downloaded = downloadedBlob ? await downloadedBlob.text() : '';

            expect(copied.length).toBeGreaterThan(0);
            expect(downloaded).toBe(copied);
        } finally {
            clickSpy.mockRestore();
            urlAny.createObjectURL = originalCreateObjectURL;
            urlAny.revokeObjectURL = originalRevokeObjectURL;
        }
    });
});
