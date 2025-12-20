import browser from 'webextension-polyfill';
import { normalizeRedditPostCacheKey } from './cache-keys';

export async function showInPageToast(tabId: number, message: string) {
    const func = (text: string) => {
        const existing = document.getElementById('__reader_view_for_reddit_toast');
        existing?.remove();

        const toast = document.createElement('div');
        toast.id = '__reader_view_for_reddit_toast';
        toast.style.cssText = [
            'position: fixed',
            'right: 16px',
            'bottom: 16px',
            'z-index: 2147483647',
            'max-width: 360px',
            'padding: 12px 14px',
            'border-radius: 10px',
            'background: rgba(17, 24, 39, 0.92)',
            'color: white',
            'font: 13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
            'box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25)',
        ].join(';');

        const title = document.createElement('div');
        title.textContent = 'Reader View for Reddit';
        title.style.cssText = 'font-weight: 700; margin-bottom: 4px;';

        const body = document.createElement('div');
        body.textContent = `Reader View Error: ${text}`;

        const close = document.createElement('button');
        close.type = 'button';
        close.textContent = '×';
        close.setAttribute('aria-label', 'Close');
        close.style.cssText = [
            'border: none',
            'background: transparent',
            'color: white',
            'font-size: 18px',
            'line-height: 1',
            'cursor: pointer',
            'position: absolute',
            'top: 10px',
            'right: 12px',
        ].join(';');
        close.addEventListener('click', () => toast.remove());

        toast.append(title, body, close);
        document.documentElement.appendChild(toast);

        window.setTimeout(() => toast.remove(), 4000);
    };

    await browser.scripting.executeScript({
        target: { tabId },
        func,
        args: [message],
    });
}

export const __test__ = {
    showInPageToast,
    normalizeRedditPostCacheKey,
};
