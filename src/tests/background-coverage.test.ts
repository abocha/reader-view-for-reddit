import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// @ts-ignore
import browser from 'webextension-polyfill';

describe('Background Script Coverage', () => {

    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    describe('getOpenMode', () => {
        it('should return "same-tab" by default', async () => {
            const { getOpenMode } = await import('../background/index');
            (browser.storage.sync.get as any).mockResolvedValue({});
            const mode = await getOpenMode();
            expect(mode).toBe('same-tab');
        });

        it('should return "new-tab" when stored', async () => {
            const { getOpenMode } = await import('../background/index');
            (browser.storage.sync.get as any).mockResolvedValue({ openMode: 'new-tab' });
            const mode = await getOpenMode();
            expect(mode).toBe('new-tab');
        });
    });

    describe('Command Listener', () => {
        it('should trigger processTab on "open-reader-view" command', async () => {
            // Setup listener capture BEFORE importing
            let registeredCallback: Function | undefined;
            (browser.commands.onCommand.addListener as any).mockImplementation((fn: Function) => {
                registeredCallback = fn;
            });

            // Import triggers listener registration
            await import('../background/index');

            expect(registeredCallback).toBeDefined();

            // Mock tabs query and script injection
            const mockTab = { id: 123, url: 'https://reddit.com/r/foo' };
            (browser.tabs.query as any).mockResolvedValue([mockTab]);

            // Mock executeScript to return success so processTab continues
            (browser.scripting.executeScript as any).mockResolvedValue([{ result: { ok: true, payload: { title: 'T' } } }]);

            // Trigger the command
            if (registeredCallback) {
                await registeredCallback('open-reader-view');
            }

            expect(browser.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
            expect(browser.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({
                target: { tabId: 123 }
            }));
        });

    });

    describe('Action Listener', () => {
        it('should trigger processTab on action click', async () => {
            let onClickedCB: Function | undefined;
            (browser.action.onClicked.addListener as any).mockImplementation((fn: Function) => {
                onClickedCB = fn;
            });

            await import('../background/index');

            expect(onClickedCB).toBeDefined();

            const mockTab = { id: 222, url: 'https://reddit.com/r/foo' };
            (browser.scripting.executeScript as any).mockResolvedValue([{ result: { ok: true, payload: { title: 'T' } } }]);
            (browser.runtime.getURL as any).mockReturnValue('moz-extension://abc/pages/reader-host.html');
            (browser.storage.sync.get as any).mockResolvedValue({ openMode: 'same-tab' });

            if (onClickedCB) await onClickedCB(mockTab);

            expect(browser.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({
                target: { tabId: 222 }
            }));
        });
    });

    describe('processTab edge cases', () => {
        it('should early-return on invalid tab', async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
            const { processTab } = await import('../background/index');

            await processTab({} as any);

            expect(warn).toHaveBeenCalledWith('[Reader Helper] processTab: invalid tab', {});
            expect(browser.scripting.executeScript).not.toHaveBeenCalled();
        });

        it('should handle script injection errors by opening error host', async () => {
            const { processTab } = await import('../background/index');
            const tab = { id: 333, url: 'https://reddit.com/r/foo' } as any;

            (browser.scripting.executeScript as any).mockRejectedValue(new Error('Boom'));
            (browser.runtime.getURL as any).mockReturnValue('moz-extension://abc/pages/reader-host.html');
            (browser.storage.sync.get as any).mockResolvedValue({ openMode: 'same-tab' });

            await processTab(tab);

            expect(browser.tabs.update).toHaveBeenCalledWith(333, expect.objectContaining({
                url: expect.stringContaining('#mode=error')
            }));
        });

        it('should open error host in a new tab when configured', async () => {
            const { processTab } = await import('../background/index');
            const tab = { id: 444, url: 'https://reddit.com/r/foo' } as any;

            (browser.scripting.executeScript as any).mockResolvedValue([{ result: { ok: false, error: 'Nope' } }]);
            (browser.runtime.getURL as any).mockReturnValue('moz-extension://abc/pages/reader-host.html');
            (browser.storage.sync.get as any).mockResolvedValue({ openMode: 'new-tab' });

            await processTab(tab);

            expect(browser.tabs.create).toHaveBeenCalledWith(expect.objectContaining({
                url: expect.stringContaining('#mode=error'),
                active: true,
            }));
        });
    });

    describe('Context Menu Listener', () => {
        it('should create context menu on installed', async () => {
            let onInstalledCB: Function | undefined;
            (browser.runtime.onInstalled.addListener as any).mockImplementation((fn: Function) => {
                onInstalledCB = fn;
            });

            await import('../background/index');

            expect(onInstalledCB).toBeDefined();

            if (onInstalledCB) {
                await onInstalledCB();
                expect(browser.menus.removeAll).toHaveBeenCalled();
                expect(browser.menus.create).toHaveBeenCalledWith(expect.objectContaining({
                    id: "open-reddit-reader",
                    title: "Read in Reader View"
                }));
            }
        });

        it('should process tab on menu click', async () => {
            let onClickedCB: Function | undefined;
            (browser.menus.onClicked.addListener as any).mockImplementation((fn: Function) => {
                onClickedCB = fn;
            });

            await import('../background/index');

            expect(onClickedCB).toBeDefined();

            if (onClickedCB) {
                const mockTab = { id: 456, url: 'https://reddit.com/r/bar' };
                (browser.scripting.executeScript as any).mockResolvedValue([{ result: { ok: true, payload: { title: 'T' } } }]);

                await onClickedCB({ menuItemId: "open-reddit-reader" }, mockTab);

                expect(browser.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({
                    target: { tabId: 456 }
                }));
            }
        });

    });

    describe('In-page toast helper', () => {
        it('should inject and render an in-page toast', async () => {
            vi.useFakeTimers();

            const { __test__ } = await import('../background/index');
            (browser.scripting.executeScript as any).mockImplementation(async ({ func, args }: any) => {
                func(...(args ?? []));
                return [{ result: null }];
            });

            await __test__.showInPageToast(1, 'Hello');

            const toast = document.getElementById('__reader_view_for_reddit_toast');
            expect(toast).not.toBeNull();
            expect(toast?.textContent).toContain('Reader View Error: Hello');

            // Ensure close button removes it
            const close = toast?.querySelector('button') as HTMLButtonElement | null;
            close?.click();
            expect(document.getElementById('__reader_view_for_reddit_toast')).toBeNull();

            // Ensure timeout removal path is covered too
            await __test__.showInPageToast(1, 'Again');
            expect(document.getElementById('__reader_view_for_reddit_toast')).not.toBeNull();
            vi.runAllTimers();
            expect(document.getElementById('__reader_view_for_reddit_toast')).toBeNull();

            vi.useRealTimers();
        });
    });

    describe('Reddit cache key helpers', () => {
        it('should reject lookalike hostnames', async () => {
            const { __test__ } = await import('../background/index');

            const bad = __test__.normalizeRedditPostCacheKey('https://reddit.com.evil.tld/r/test/comments/abc/post/');
            const bad2 = __test__.normalizeRedditPostCacheKey('https://notreddit.com/r/test/comments/abc/post/');
            const good = __test__.normalizeRedditPostCacheKey('https://www.reddit.com/r/test/comments/abc/post/');

            expect(bad).toBeNull();
            expect(bad2).toBeNull();
            expect(good).toContain('/r/test/comments/abc/post');
        });
    });

    describe('openReaderViewForUrl fallback', () => {
        it('should fall back to executeScript when JSON fetch fails', async () => {
            const { openReaderViewForUrl } = await import('../background/index');

            (globalThis.fetch as any).mockResolvedValue({ ok: false, status: 500 });

            (browser.tabs as any).onUpdated = {
                addListener: (fn: any) => { fn(2, { status: 'complete' }); },
                removeListener: () => { /* noop */ },
            };

            (browser.tabs.create as any)
                .mockResolvedValueOnce({ id: 1 }) // pending host
                .mockResolvedValueOnce({ id: 2 }); // temp tab for extraction
            (browser.tabs.remove as any) = vi.fn().mockResolvedValue(undefined);

            (browser.scripting.executeScript as any).mockResolvedValueOnce([
                {
                    result: {
                        ok: true,
                        payload: {
                            title: 'T',
                            author: 'a',
                            subreddit: 'r/x',
                            bodyHtml: '',
                            bodyMarkdown: '',
                            url: 'https://www.reddit.com/r/x',
                            isFallback: false,
                        },
                    },
                },
            ]);

            const readySpy = (browser.runtime.sendMessage as any).mockResolvedValue(undefined);

            await openReaderViewForUrl('https://www.reddit.com/r/x/comments/abc/post');

            expect(browser.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({
                target: { tabId: 2 },
            }));
            expect(browser.tabs.remove).toHaveBeenCalledWith(2);
            expect(readySpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'HOST_PAYLOAD_READY' }));
        });
    });
});
