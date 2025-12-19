
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// @ts-ignore
import browser from 'webextension-polyfill';

	describe('Reader UI Coverage', () => {

	    beforeEach(() => {
	        vi.resetModules();
	        document.body.innerHTML = `
	            <div id="reader-toolbar">
	                 <button class="theme-btn" data-theme="dark"></button>
	                 <button class="theme-btn" data-theme="light"></button>
                 <button class="font-btn" data-font="serif"></button>
                 <button class="font-btn" data-font="sans"></button>
                 <button class="align-btn" data-align="left"></button>
                 <button class="align-btn" data-align="center"></button>
                 <div id="open-mode-toggle">
                     <button class="toggle-option" data-value="new-tab" type="button" role="radio" aria-checked="false"></button>
                     <button class="toggle-option" data-value="same-tab" type="button" role="radio" aria-checked="false"></button>
                 </div>
            </div>
            <div id="settings-drawer">
                <select id="open-mode">
                    <option value="new-tab">New Tab</option>
                    <option value="same-tab">Same Tab</option>
                </select>
                <input id="comments-depth" type="range" value="5" />
                <span id="depth-val"></span>
                <input id="comments-auto-depth" type="checkbox" checked />
                <input id="comments-hide-low" type="checkbox" />
                <select id="comments-limit"><option value="100" selected>100</option></select>
                <select id="comments-sort">
                    <option value="best" selected>Best</option>
                    <option value="top">Top</option>
                </select>
                <div id="toggle-drawer"></div>
                <div id="close-drawer"></div>
                <button id="copy-post-md"></button>
                <button id="copy-post-comments-md"></button>
            </div>
            <div id="spike-article"></div>
        `;

        localStorage.clear();
        vi.clearAllMocks();

        // Reset dataset
        delete document.body.dataset.rvrrEventsBound;
    });

	    describe('initPreferences', () => {
	        it('should restore saved preferences from localStorage', async () => {
	            const { initPreferences } = await import('../pages/reader-host');
	            localStorage.setItem('reader-theme', 'dark');
	            localStorage.setItem('reader-font', 'sans');

	            initPreferences();

            expect(document.body.classList.contains('theme-dark')).toBe(true);
            expect(document.body.classList.contains('font-sans')).toBe(true);
	            expect(document.querySelector('.theme-btn[data-theme="dark"]')?.classList.contains('active')).toBe(true);
	        });

	        it('should guard against double-binding events', async () => {
	            const { initPreferences } = await import('../pages/reader-host');
	            const addSpy = vi.spyOn(document.body, 'addEventListener');

	            initPreferences();
	            initPreferences();

	            // Click + keydown handlers are bound once (guarded by rvrrEventsBound).
	            expect(addSpy).toHaveBeenCalledTimes(2);
	        });

	        it('should handle theme change via click', async () => {
	            const { initPreferences } = await import('../pages/reader-host');
	            initPreferences();

            const darkBtn = document.querySelector('.theme-btn[data-theme="dark"]') as HTMLElement;
            darkBtn.click();

            expect(document.body.classList.contains('theme-dark')).toBe(true);
            expect(localStorage.getItem('reader-theme')).toBe('dark');
        });

	        it('should handle font change via click', async () => {
	            const { initPreferences } = await import('../pages/reader-host');
	            initPreferences();

            const sansBtn = document.querySelector('.font-btn[data-font="sans"]') as HTMLElement;
            sansBtn.click();

            expect(document.body.classList.contains('font-sans')).toBe(true);
            expect(localStorage.getItem('reader-font')).toBe('sans');
        });

	        it('should handle align change via click', async () => {
	            const { initPreferences } = await import('../pages/reader-host');
	            initPreferences();

            const alignBtn = document.querySelector('.align-btn[data-align="center"]') as HTMLElement;
            alignBtn.click();

            expect(document.body.classList.contains('align-center')).toBe(true);
            expect(localStorage.getItem('reader-align')).toBe('center');
        });

	        it('should handle open mode toggle click', async () => {
	            const { initPreferences } = await import('../pages/reader-host');
	            const select = document.getElementById('open-mode') as HTMLSelectElement;
	            let eventFired = false;
	            select.addEventListener('change', () => {
	                eventFired = true;
            });

            initPreferences();

            const opt = document.querySelector('.toggle-option[data-value="new-tab"]') as HTMLElement;
            opt.click();

            expect(opt.classList.contains('active')).toBe(true);
            expect(select.value).toBe('new-tab');
            expect(eventFired).toBe(true);
        });
    });

	    describe('updateActiveControls', () => {
	        it('should update active classes on buttons', async () => {
	            const { updateActiveControls } = await import('../pages/reader-host');
	            updateActiveControls('light', 'serif', 'left');

            expect(document.querySelector('.theme-btn[data-theme="light"]')?.classList.contains('active')).toBe(true);
            expect(document.querySelector('.font-btn[data-font="serif"]')?.classList.contains('active')).toBe(true);
            expect(document.querySelector('.align-btn[data-align="left"]')?.classList.contains('active')).toBe(true);

            expect(document.querySelector('.theme-btn[data-theme="dark"]')?.classList.contains('active')).toBe(false);
        });
    });

    describe('Actions & Data Loading', () => {
        it('should copy post markdown to clipboard', async () => {
            // Mock clipboard
            const writeText = vi.fn().mockResolvedValue(undefined);
            Object.defineProperty(navigator, 'clipboard', {
                value: { writeText },
                configurable: true
            });

            // We need a currentPost set in reader-host. 
            // Ideally we'd set it via renderArticle, but we can also just trigger the button 
            // and see if it fails safely or tries to copy if we can set the state.
            // But 'currentPost' is module-level private. We must call renderArticle first.
            // We need to import renderArticle.
            const { renderArticle, initActions } = await import('../pages/reader-host');

            // Mock behavior
            const { default: browser } = await import('webextension-polyfill') as any;
            browser.storage.sync.get.mockResolvedValue({});

            // initActions attaches listeners. We called it via local import in test setup? 
            // No, previous tests called initPreferences directly.
            // We need to call initActions to bind buttons.
            initActions();

            renderArticle({
                title: 'Post', author: 'me', subreddit: 'r/test',
                bodyHtml: '', bodyMarkdown: 'md',
                url: 'http://test.com', isFallback: false
            });

            const btn = document.getElementById('copy-post-md');
            btn?.click();

            // Wait for async handler
            await new Promise(r => setTimeout(r, 0));

            expect(writeText).toHaveBeenCalledWith(expect.stringContaining('# Post'));

            // Check toast
            const toast = document.getElementById('__rvrr_toast');
            expect(toast).not.toBeNull();
            expect(toast?.textContent).toContain('Copied!');
        });

	        it('should include "(No comments loaded)" when copying without loaded comments', async () => {
	            const writeText = vi.fn().mockResolvedValue(undefined);
	            Object.defineProperty(navigator, 'clipboard', {
	                value: { writeText },
	                configurable: true
	            });

	            const { renderArticle, initActions } = await import('../pages/reader-host');

	            const { default: browser } = await import('webextension-polyfill') as any;
	            browser.storage.sync.get.mockResolvedValue({});

	            const limitEl = document.getElementById('comments-limit') as HTMLInputElement | null;
	            if (limitEl) limitEl.value = '5'; // should clamp to 10

	            renderArticle({
	                title: 'Post', author: 'me', subreddit: 'r/test',
	                bodyHtml: '', bodyMarkdown: 'md',
	                url: 'http://test.com', isFallback: false,
                permalink: '/r/test/123/post'
            });

            initActions();

	            const btn = document.getElementById('copy-post-comments-md');
	            btn?.click();
	            await new Promise(r => setTimeout(r, 0));

	            const text = writeText.mock.calls[0]?.[0] as string;
	            expect(text).toContain('(No comments loaded)');
	            expect(text).toContain('limit 10');
	        });

        it('should fallback to execCommand when clipboard write fails (and include nested replies)', async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

            // Mock clipboard to fail
            const writeText = vi.fn().mockRejectedValue(new Error('Denied'));
            Object.defineProperty(navigator, 'clipboard', {
                value: { writeText },
                configurable: true
            });

            let copiedText = '';
            (document as any).execCommand = vi.fn(() => {
                const textarea = document.querySelector('textarea') as HTMLTextAreaElement | null;
                copiedText = textarea?.value ?? '';
                return true;
            });

            const { renderArticle, initActions, initCommentsUI } = await import('../pages/reader-host');

            const toggle = document.createElement('input');
            toggle.type = 'checkbox';
            toggle.id = 'toggle-comments-switch';
            toggle.checked = true;
            document.body.appendChild(toggle);

            const status = document.createElement('div');
            status.id = 'comments-status';
            document.body.appendChild(status);

            const section = document.createElement('div');
            section.id = 'comments';
            document.body.appendChild(section);

            const list = document.createElement('div');
            list.id = 'comments-list';
            document.body.appendChild(list);

            (globalThis.fetch as any).mockResolvedValue({
                ok: true,
                json: async () => [
                    { kind: 'Listing', data: { children: [] } },
                    {
                        kind: 'Listing',
                        data: {
                            children: [
                                {
                                    kind: 't1',
                                    data: {
                                        id: 'c1',
                                        author: 'a',
                                        body: 'parent',
                                        score: 10,
                                        replies: {
                                            data: {
                                                children: [
                                                    {
                                                        kind: 't1',
                                                        data: {
                                                            id: 'c2',
                                                            author: 'b',
                                                            body: 'child',
                                                            score: 5,
                                                            replies: ''
                                                        }
                                                    }
                                                ]
                                            }
                                        }
                                    }
                                }
                            ]
                        }
                    }
                ]
            });

            renderArticle({
                title: 'Post', author: 'me', subreddit: 'r/test',
                bodyHtml: '', bodyMarkdown: 'md',
                url: 'http://test.com', isFallback: false,
                permalink: '/r/test/123/post'
            });

            initCommentsUI();
            await new Promise(r => setTimeout(r, 0));

            // Bind actions after post + comments state are available
            const { default: browser } = await import('webextension-polyfill') as any;
            browser.storage.sync.get.mockResolvedValue({});
            initActions();

            const btn = document.getElementById('copy-post-comments-md');
            btn?.click();
            await new Promise(r => setTimeout(r, 0));

            expect((document as any).execCommand).toHaveBeenCalledWith('copy');
            expect(copiedText).toContain('- **u/a**');
            expect(copiedText).toContain('  - **u/b**');
            expect(copiedText).toContain('child');
            expect(document.querySelector('textarea')).toBeNull();

            warn.mockRestore();
        });

        it('should load comments when toggle is checked', async () => {
            const { renderArticle, initCommentsUI } = await import('../pages/reader-host');

            // Ensure element exists (was missing in previous HTML setup?)
            // It IS missing.
            const toggle = document.createElement('input');
            toggle.type = 'checkbox';
            toggle.id = 'toggle-comments-switch';
            document.body.appendChild(toggle);

            const status = document.createElement('div');
            status.id = 'comments-status';
            document.body.appendChild(status);

            const section = document.createElement('div');
            section.id = 'comments';
            document.body.appendChild(section);

            const list = document.createElement('div');
            list.id = 'comments-list';
            document.body.appendChild(list);

            // Setup fetch mock
            (globalThis.fetch as any).mockResolvedValue({
                ok: true,
                json: async () => [
                    { kind: 'Listing', data: { children: [] } },
                    {
                        kind: 'Listing',
                        data: {
                            children: [
                                { kind: 't1', data: { id: 'c1', author: 'abc', body: 'comment' } }
                            ]
                        }
                    }
                ]
            });

            renderArticle({
                title: 'Post', author: 'me', subreddit: 'r/test',
                bodyHtml: '', bodyMarkdown: 'md',
                url: 'http://test.com', isFallback: false,
                permalink: '/r/test/123/post'
            });

            initCommentsUI();

            // Trigger toggle
            toggle.click();

            // Wait for fetch
            await new Promise(r => setTimeout(r, 0));

            expect(globalThis.fetch).toHaveBeenCalled();
            expect(list.children.length).toBeGreaterThan(0);
        });

        it('should show "comments unavailable" when permalink is missing', async () => {
            const { renderArticle, initCommentsUI } = await import('../pages/reader-host');

            const toggle = document.createElement('input');
            toggle.type = 'checkbox';
            toggle.id = 'toggle-comments-switch';
            toggle.checked = true;
            document.body.appendChild(toggle);

            const status = document.createElement('div');
            status.id = 'comments-status';
            document.body.appendChild(status);

            const section = document.createElement('div');
            section.id = 'comments';
            document.body.appendChild(section);

            const list = document.createElement('div');
            list.id = 'comments-list';
            document.body.appendChild(list);

            renderArticle({
                title: 'Post', author: 'me', subreddit: 'r/test',
                bodyHtml: '', bodyMarkdown: 'md',
                url: 'http://test.com', isFallback: false,
            } as any);

            initCommentsUI();
            await new Promise(r => setTimeout(r, 0));

            expect(status.textContent).toContain('Comments are unavailable');
            expect(section.hidden).toBe(false);
            expect(list.childNodes.length).toBe(0);
        });

        it('should show fallback-specific message when permalink is missing', async () => {
            const { renderArticle, initCommentsUI } = await import('../pages/reader-host');

            const toggle = document.createElement('input');
            toggle.type = 'checkbox';
            toggle.id = 'toggle-comments-switch';
            toggle.checked = true;
            document.body.appendChild(toggle);

            const status = document.createElement('div');
            status.id = 'comments-status';
            document.body.appendChild(status);

            const section = document.createElement('div');
            section.id = 'comments';
            document.body.appendChild(section);

            const list = document.createElement('div');
            list.id = 'comments-list';
            document.body.appendChild(list);

            renderArticle({
                title: 'Post', author: 'me', subreddit: 'r/test',
                bodyHtml: '', bodyMarkdown: 'md',
                url: 'http://test.com', isFallback: true,
            } as any);

            initCommentsUI();
            await new Promise(r => setTimeout(r, 0));

            expect(status.textContent).toContain('Comments are unavailable');
            expect(section.hidden).toBe(false);
            expect(list.childNodes.length).toBe(0);
        });

        it('should surface comment fetch failures', async () => {
            const { renderArticle, initCommentsUI } = await import('../pages/reader-host');

            const toggle = document.createElement('input');
            toggle.type = 'checkbox';
            toggle.id = 'toggle-comments-switch';
            toggle.checked = true;
            document.body.appendChild(toggle);

            const status = document.createElement('div');
            status.id = 'comments-status';
            document.body.appendChild(status);

            const section = document.createElement('div');
            section.id = 'comments';
            document.body.appendChild(section);

            const list = document.createElement('div');
            list.id = 'comments-list';
            document.body.appendChild(list);

            (globalThis.fetch as any).mockResolvedValue({ ok: false, status: 500 });

            renderArticle({
                title: 'Post', author: 'me', subreddit: 'r/test',
                bodyHtml: '', bodyMarkdown: 'md',
                url: 'http://test.com', isFallback: false,
                permalink: '/r/test/123/post'
            } as any);

            initCommentsUI();
            await new Promise(r => setTimeout(r, 0));

            expect(status.textContent).toContain('Failed to load comments.');
            expect(list.childNodes.length).toBe(0);
        });
    });
});
