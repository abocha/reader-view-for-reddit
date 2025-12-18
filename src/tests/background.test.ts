
import { describe, it, expect, vi, beforeEach } from 'vitest';
import browser from 'webextension-polyfill';
import { processTab, getOpenMode, openHostPage } from '../background/index';

// Mock the extraction import if necessary, but processTab only calls keys.
// However, processTab imports extractRedditPost. We need to spy on executeScript return value.

describe('Background Script', () => {

    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('getOpenMode', () => {
        it('should return "new-tab" when stored value is new-tab', async () => {
            (browser.storage.sync.get as any).mockResolvedValue({ openMode: 'new-tab' });
            const mode = await getOpenMode();
            expect(mode).toBe('new-tab');
        });

        it('should default to "same-tab"', async () => {
            (browser.storage.sync.get as any).mockResolvedValue({});
            const mode = await getOpenMode();
            expect(mode).toBe('same-tab');
        });
    });

    describe('processTab', () => {
        it('should successfuly extract and open host page', async () => {
            const tab = { id: 101, url: 'https://www.reddit.com/r/foo/comments/abc123/test_post/' } as any;

            // Mock JSON extraction from background fetch
            (globalThis.fetch as any).mockResolvedValue({
                ok: true,
                status: 200,
                text: async () => JSON.stringify({
                    data: {
                        children: [
                            {
                                kind: 't3',
                                data: {
                                    title: 'Test Post',
                                    author: 'me',
                                    subreddit_name_prefixed: 'r/foo',
                                    selftext: '',
                                    selftext_html: '',
                                    permalink: '/r/foo/comments/abc123/test_post/',
                                    id: 'abc123',
                                },
                            },
                        ],
                    },
                }),
            });

            // Mock open mode
            (browser.storage.sync.get as any).mockResolvedValue({ openMode: 'same-tab' });

            // Mock runtime URL
            (browser.runtime.getURL as any).mockReturnValue('moz-extension://abc/pages/reader-host.html');

            await processTab(tab);

            // 1. Verify JSON fetch path (no executeScript)
            expect(globalThis.fetch).toHaveBeenCalledTimes(1);
            expect(browser.scripting.executeScript).not.toHaveBeenCalled();

            // 2. Verify Session Storage (Token)
            expect(browser.storage.session.set).toHaveBeenCalledTimes(1);
            // Check that a token was generated (random keys)
            const storeArgs = (browser.storage.session.set as any).mock.calls[0][0];
            const token = Object.keys(storeArgs)[0];
            expect(storeArgs[token].title).toBe('Test Post');

            // 3. Verify Tab Update (Same Tab mode)
            expect(browser.tabs.update).toHaveBeenCalledWith(101, {
                url: expect.stringContaining(`moz-extension://abc/pages/reader-host.html#token=${token}`),
                active: true
            });
        });

        it('should handle extraction failure', async () => {
            const tab = { id: 102, url: 'https://reddit.com/bad' } as any;

            (browser.scripting.executeScript as any).mockResolvedValue([
                {
                    result: { ok: false, error: 'Not a post' }
                }
            ]);
            (browser.runtime.getURL as any).mockReturnValue('host.html');
            (browser.storage.sync.get as any).mockResolvedValue({ openMode: 'same-tab' });

            await processTab(tab);

            // Should redirect to error page
            expect(browser.tabs.update).toHaveBeenCalledWith(102, expect.objectContaining({
                url: expect.stringContaining('#mode=error')
            }));
        });
    });

    describe('openHostPage', () => {
        it('should open in new tab if requested', async () => {
            (browser.runtime.getURL as any).mockReturnValue('host.html');

            await openHostPage(1, 'token123', 'new-tab');

            expect(browser.tabs.create).toHaveBeenCalledWith({
                url: expect.stringContaining('host.html#token=token123'),
                active: true
            });
            expect(browser.tabs.update).not.toHaveBeenCalled();
        });
    });
});
