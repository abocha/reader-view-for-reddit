import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Drawer accessibility', () => {
    beforeEach(() => {
        vi.resetModules();
        document.body.innerHTML = `
            <button id="toggle-drawer" aria-expanded="false">Open</button>
            <div id="settings-drawer" class="drawer" role="dialog" aria-hidden="true" tabindex="-1">
                <button id="close-drawer" type="button">Close</button>
                <button id="drawer-action" type="button">Action</button>
                <input id="drawer-input" />
            </div>
        `;
    });

    it('should trap focus when open and restore focus when closed', async () => {
        const { initActions } = await import('../pages/reader-host');
        initActions();

        const toggle = document.getElementById('toggle-drawer') as HTMLButtonElement;
        const drawer = document.getElementById('settings-drawer') as HTMLElement;
        const close = document.getElementById('close-drawer') as HTMLButtonElement;
        const action = document.getElementById('drawer-action') as HTMLButtonElement;
        const input = document.getElementById('drawer-input') as HTMLInputElement;

        toggle.focus();
        toggle.click();

        expect(drawer.classList.contains('open')).toBe(true);
        expect(drawer.getAttribute('aria-hidden')).toBe('false');
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(document.activeElement).toBe(close);

        // Tab from last -> first
        input.focus();
        expect(document.activeElement).toBe(input);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
        expect(document.activeElement).toBe(close);

        // Shift+Tab from first -> last
        close.focus();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }));
        expect(document.activeElement).toBe(input);

        // Escape closes and returns focus to opener
        action.focus();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        expect(drawer.classList.contains('open')).toBe(false);
        expect(drawer.getAttribute('aria-hidden')).toBe('true');
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(document.activeElement).toBe(toggle);
    });
});

