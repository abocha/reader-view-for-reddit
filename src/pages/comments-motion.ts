export type MotionMode = 'full' | 'reduced' | 'off';

const ENTER_CLASS = 'rvrr-comment-root-enter';
const ENTER_ACTIVE_CLASS = 'rvrr-comment-root-enter-active';
const REPLACE_CLASS = 'rvrr-comment-root-replace';
const MOVE_CLASS = 'rvrr-comment-root-move';

const ENTER_DURATION_MS = 180;
const REPLACE_DURATION_MS = 180;
const MOVE_DURATION_MS = 140;

function prefersReducedMotion(): boolean {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    try {
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
        return false;
    }
}

export function getMotionMode(forceOff = false): MotionMode {
    if (forceOff) return 'off';
    return prefersReducedMotion() ? 'reduced' : 'full';
}

function cleanupClassLater(el: HTMLElement, className: string, delayMs: number): void {
    window.setTimeout(() => {
        el.classList.remove(className);
    }, delayMs);
}

export function animateRootInsert(el: HTMLElement, mode: MotionMode): void {
    if (mode !== 'full') return;

    el.classList.add(ENTER_CLASS);
    requestAnimationFrame(() => {
        el.classList.add(ENTER_ACTIVE_CLASS);
        cleanupClassLater(el, ENTER_CLASS, ENTER_DURATION_MS);
        cleanupClassLater(el, ENTER_ACTIVE_CLASS, ENTER_DURATION_MS);
    });
}

export function animateRootReplace(el: HTMLElement, mode: MotionMode): void {
    if (mode !== 'full') return;
    el.classList.add(REPLACE_CLASS);
    cleanupClassLater(el, REPLACE_CLASS, REPLACE_DURATION_MS);
}

export function animateRootMove(el: HTMLElement, mode: MotionMode): void {
    if (mode !== 'full') return;
    el.classList.add(MOVE_CLASS);
    cleanupClassLater(el, MOVE_CLASS, MOVE_DURATION_MS);
}

export const __motion_test__ = {
    prefersReducedMotion,
};
