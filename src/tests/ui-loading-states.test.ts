import { describe, it, expect, vi, beforeEach } from 'vitest';

type Deferred<T> = {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (err: unknown) => void;
};

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe('Loading states', () => {
    beforeEach(() => {
        vi.resetModules();
        document.body.innerHTML = `
            <button id="copy-post-md"></button>
            <button id="copy-post-comments-md"></button>
            <button id="toggle-drawer"></button>
            <button id="close-drawer"></button>
            <select id="open-mode"><option value="same-tab"></option></select>
            <div id="open-mode-toggle">
              <button class="toggle-option" data-value="same-tab" type="button" role="radio" aria-checked="true" tabindex="0">Same Tab</button>
              <button class="toggle-option" data-value="new-tab" type="button" role="radio" aria-checked="false" tabindex="-1">New Tab</button>
            </div>
            <input id="comments-depth" type="range" value="1" />
            <span id="depth-val"></span>
            <input id="comments-auto-depth" type="checkbox" checked />
            <input id="comments-hide-low" type="checkbox" checked />
            <select id="comments-limit"><option value="100" selected>100</option></select>
            <select id="comments-sort">
                <option value="best" selected>Best</option>
                <option value="top">Top</option>
            </select>
            <input id="toggle-comments-switch" type="checkbox" checked />
            <section id="comments"></section>
            <div id="comments-status"></div>
            <div id="comments-list"></div>
            <div id="comments-footer"></div>
            <div id="spike-article"></div>
            <div id="settings-drawer"></div>
        `;
        localStorage.clear();
        vi.clearAllMocks();
    });

    it('should mark copy button busy while copying and show toast', async () => {
        const clip = deferred<void>();
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText: vi.fn(() => clip.promise) },
            configurable: true,
        });

        const { renderArticle, initActions } = await import('../pages/reader-host');
        renderArticle({
            title: 'Post',
            author: 'me',
            subreddit: 'r/test',
            bodyHtml: '',
            bodyMarkdown: 'md',
            url: 'http://test.com',
            isFallback: false,
            permalink: '/r/test/123/post',
        } as any);

        const { default: browser } = await import('webextension-polyfill') as any;
        browser.storage.sync.get.mockResolvedValue({});

        initActions();

        const btn = document.getElementById('copy-post-md') as HTMLButtonElement;
        btn.click();

        expect(btn.disabled).toBe(true);
        expect(btn.classList.contains('is-busy')).toBe(true);
        expect(btn.getAttribute('aria-busy')).toBe('true');

        clip.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(btn.disabled).toBe(false);
        expect(btn.classList.contains('is-busy')).toBe(false);
        expect(btn.getAttribute('aria-busy')).toBeNull();

        const toast = document.getElementById('__rvrr_toast');
        expect(toast).not.toBeNull();
        expect(toast?.getAttribute('role')).toBe('status');
        expect(toast?.getAttribute('aria-live')).toBe('polite');
    });

    it('should render retry action when comments fail to load', async () => {
        const { renderArticle, initCommentsUI } = await import('../pages/reader-host');

        (globalThis.fetch as any) = vi
            .fn()
            .mockResolvedValueOnce({ ok: false, status: 500 })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => [
                    { kind: 'Listing', data: { children: [] } },
                    { kind: 'Listing', data: { children: [] } },
                ],
            });

        renderArticle({
            title: 'Post',
            author: 'me',
            subreddit: 'r/test',
            bodyHtml: '',
            bodyMarkdown: 'md',
            url: 'http://test.com',
            isFallback: false,
            permalink: '/r/test/123/post',
        } as any);

        initCommentsUI();
        await new Promise(r => setTimeout(r, 0));

        const status = document.getElementById('comments-status') as HTMLElement;
        expect(status.textContent).toContain('Failed to load comments.');

        const retry = status.querySelector('button') as HTMLButtonElement | null;
        expect(retry?.textContent).toBe('Retry');

        retry?.click();
        await new Promise(r => setTimeout(r, 0));

        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('should keep existing comments when load-more fails', async () => {
        const { renderArticle, initCommentsUI } = await import('../pages/reader-host');

        (globalThis.fetch as any) = vi
            .fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => [
                    { kind: 'Listing', data: { children: [{ kind: 't3', data: { num_comments: 2 } }] } },
                    {
                        kind: 'Listing',
                        data: {
                            children: [
                                {
                                    kind: 't1',
                                    data: {
                                        id: 'c1',
                                        author: 'tester',
                                        body: 'Hello',
                                        body_html: '<p>Hello</p>',
                                        score: 3,
                                        replies: '',
                                    },
                                },
                                { kind: 'more', data: {} },
                            ],
                        },
                    },
                ],
            })
            .mockResolvedValueOnce({ ok: false, status: 500 });

        renderArticle({
            title: 'Post',
            author: 'me',
            subreddit: 'r/test',
            bodyHtml: '',
            bodyMarkdown: 'md',
            url: 'http://test.com',
            isFallback: false,
            permalink: '/r/test/123/post',
        } as any);

        initCommentsUI();
        await new Promise(r => setTimeout(r, 0));

        const listEl = document.getElementById('comments-list') as HTMLElement;
        expect(listEl.querySelectorAll('.comment').length).toBeGreaterThan(0);

        const loadMore = document.querySelector('button[data-role="load-more-comments"]') as HTMLButtonElement | null;
        loadMore?.click();
        await new Promise(r => setTimeout(r, 0));

        expect(globalThis.fetch).toHaveBeenCalledTimes(2);
        expect(listEl.querySelectorAll('.comment').length).toBeGreaterThan(0);
    });
});
