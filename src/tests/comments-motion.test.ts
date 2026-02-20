import { describe, expect, it, vi } from 'vitest';
import { animateRootInsert, getMotionMode } from '../pages/comments-motion';

describe('comments-motion', () => {
    it('returns off mode when forceOff is true', () => {
        expect(getMotionMode(true)).toBe('off');
    });

    it('applies insert classes in full motion mode', () => {
        const el = document.createElement('div');
        const raf = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback): number => {
            cb(0);
            return 1;
        });

        animateRootInsert(el, 'full');
        expect(el.classList.contains('rvrr-comment-root-enter')).toBe(true);
        expect(el.classList.contains('rvrr-comment-root-enter-active')).toBe(true);

        raf.mockRestore();
    });

    it('does not apply classes in reduced mode', () => {
        const el = document.createElement('div');
        animateRootInsert(el, 'reduced');
        expect(el.className).toBe('');
    });
});
