import { beforeEach, describe, expect, it } from 'vitest';
import { initCommentsUI } from '../pages/reader-host';

function mountCommentsControls() {
    document.body.innerHTML = `
        <input id="toggle-comments-switch" type="checkbox" checked />
        <section id="comments"></section>
        <div id="comments-status"></div>
        <div id="comments-list"></div>
        <div id="comments-footer"></div>
        <input id="comments-depth" type="range" value="1" />
        <span id="depth-val"></span>
        <input id="comments-smart-mode" type="checkbox" checked />
        <select id="comments-limit">
            <option value="50">50</option>
            <option value="100" selected>100</option>
            <option value="200">200</option>
            <option value="300">300</option>
            <option value="400">400</option>
            <option value="500">500</option>
        </select>
        <select id="comments-sort">
            <option value="best" selected>Best</option>
            <option value="top">Top</option>
            <option value="new">New</option>
            <option value="old">Old</option>
            <option value="controversial">Controversial</option>
        </select>
    `;
}

describe('comments preferences', () => {
    beforeEach(() => {
        localStorage.clear();
        mountCommentsControls();
    });

    it('restores comments preferences from localStorage', () => {
        localStorage.setItem('reader-comments-visible', 'false');
        localStorage.setItem('reader-comments-depth', '4');
        localStorage.setItem('reader-comments-smart-mode', 'false');
        localStorage.setItem('reader-comments-limit', '300');
        localStorage.setItem('reader-comments-sort', 'top');

        initCommentsUI();

        const toggle = document.getElementById('toggle-comments-switch') as HTMLInputElement;
        const depth = document.getElementById('comments-depth') as HTMLInputElement;
        const depthVal = document.getElementById('depth-val') as HTMLElement;
        const smartMode = document.getElementById('comments-smart-mode') as HTMLInputElement;
        const limit = document.getElementById('comments-limit') as HTMLSelectElement;
        const sort = document.getElementById('comments-sort') as HTMLSelectElement;
        const commentsSection = document.getElementById('comments') as HTMLElement;

        expect(toggle.checked).toBe(false);
        expect(depth.value).toBe('4');
        expect(depthVal.textContent).toBe('4');
        expect(smartMode.checked).toBe(false);
        expect(limit.value).toBe('300');
        expect(sort.value).toBe('top');
        expect(commentsSection.hidden).toBe(true);
    });

    it('persists comments preferences on control changes', async () => {
        initCommentsUI();

        const toggle = document.getElementById('toggle-comments-switch') as HTMLInputElement;
        const depth = document.getElementById('comments-depth') as HTMLInputElement;
        const smartMode = document.getElementById('comments-smart-mode') as HTMLInputElement;
        const limit = document.getElementById('comments-limit') as HTMLSelectElement;
        const sort = document.getElementById('comments-sort') as HTMLSelectElement;

        depth.value = '5';
        depth.dispatchEvent(new Event('change'));

        smartMode.checked = false;
        smartMode.dispatchEvent(new Event('change'));

        limit.value = '400';
        limit.dispatchEvent(new Event('change'));

        sort.value = 'controversial';
        sort.dispatchEvent(new Event('change'));

        toggle.checked = false;
        toggle.dispatchEvent(new Event('change'));

        await Promise.resolve();

        expect(localStorage.getItem('reader-comments-visible')).toBe('false');
        expect(localStorage.getItem('reader-comments-depth')).toBe('5');
        expect(localStorage.getItem('reader-comments-smart-mode')).toBe('false');
        expect(localStorage.getItem('reader-comments-limit')).toBe('400');
        expect(localStorage.getItem('reader-comments-sort')).toBe('controversial');
    });
});
