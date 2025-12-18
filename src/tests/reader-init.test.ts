import { describe, it, expect, vi, beforeEach } from 'vitest';
import browser from 'webextension-polyfill';
import { __test__ } from '../pages/reader-host';

describe('Reader Host init flow', () => {
    beforeEach(() => {
        document.body.innerHTML = '<div id="spike-article"></div>';
        window.location.hash = '';
        vi.clearAllMocks();
    });

    it('renders an error when token is missing', async () => {
        window.location.hash = '#foo=bar';
        await __test__.init();

        const errorBox = document.querySelector('.error-box') as HTMLElement | null;
        expect(errorBox?.textContent).toContain('No token provided');
    });

    it('renders error mode with link when url is valid', async () => {
        window.location.hash = '#mode=error&error=Oops&url=https%3A%2F%2Fwww.reddit.com%2Fr%2Ftest';
        await __test__.init();

        const errorBox = document.querySelector('.error-box') as HTMLElement | null;
        expect(errorBox?.textContent).toContain('Oops');

        const link = document.querySelector('a.error-open-link') as HTMLAnchorElement | null;
        expect(link?.getAttribute('href')).toBe('https://www.reddit.com/r/test');
    });

    it('loads from session storage token and renders the article', async () => {
        const payload = {
            title: 'T',
            author: 'a',
            subreddit: 'r/x',
            bodyHtml: '<p>Body</p>',
            bodyMarkdown: '',
            url: 'https://www.reddit.com/r/x',
            isFallback: false,
        } as any;

        (browser.storage.session.get as any).mockResolvedValueOnce({ t: payload });
        (browser.runtime.sendMessage as any).mockResolvedValueOnce(undefined);

        window.location.hash = '#token=t';
        await __test__.init();

        expect(document.querySelector('#spike-article h1')?.textContent).toBe('T');
        expect(document.querySelector('#spike-article .content')?.textContent).toContain('Body');
    });

    it('renders an error when token payload is missing/expired', async () => {
        (browser.storage.session.get as any).mockResolvedValueOnce({});

        window.location.hash = '#token=missing';
        await __test__.init();

        const errorBox = document.querySelector('.error-box') as HTMLElement | null;
        expect(errorBox?.textContent).toContain('expired');
    });
});
