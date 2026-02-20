import { describe, expect, it } from 'vitest';
import { createCommentsRenderer } from '../pages/comments-renderer';

type Node = { id: string; label: string };

describe('comments-renderer', () => {
    it('keeps untouched root elements when signatures are unchanged', () => {
        const list = document.createElement('div');
        const renderer = createCommentsRenderer<Node, object>(
            list,
            (top) => {
                const el = document.createElement('div');
                el.className = 'comment';
                el.dataset.commentId = top.id;
                el.textContent = top.label;
                return el;
            },
            { forceMotionOff: true },
        );

        renderer.apply([
            { key: 'a', signature: 'sig-a-1', top: { id: 'a', label: 'A1' }, settings: {} },
            { key: 'b', signature: 'sig-b-1', top: { id: 'b', label: 'B1' }, settings: {} },
        ]);

        const aEl = list.children.item(0);
        const bEl = list.children.item(1);

        renderer.apply([
            { key: 'a', signature: 'sig-a-1', top: { id: 'a', label: 'A1' }, settings: {} },
            { key: 'b', signature: 'sig-b-2', top: { id: 'b', label: 'B2' }, settings: {} },
        ]);

        expect(list.children.item(0)).toBe(aEl);
        expect(list.children.item(1)).not.toBe(bEl);
        expect((list.children.item(1) as HTMLElement).textContent).toBe('B2');
    });

    it('reorders existing roots without recreation when signatures match', () => {
        const list = document.createElement('div');
        const renderer = createCommentsRenderer<Node, object>(
            list,
            (top) => {
                const el = document.createElement('div');
                el.className = 'comment';
                el.dataset.commentId = top.id;
                el.textContent = top.label;
                return el;
            },
            { forceMotionOff: true },
        );

        renderer.apply([
            { key: 'a', signature: 'sig-a', top: { id: 'a', label: 'A' }, settings: {} },
            { key: 'b', signature: 'sig-b', top: { id: 'b', label: 'B' }, settings: {} },
        ]);

        const aEl = list.children.item(0);
        const bEl = list.children.item(1);

        renderer.apply([
            { key: 'b', signature: 'sig-b', top: { id: 'b', label: 'B' }, settings: {} },
            { key: 'a', signature: 'sig-a', top: { id: 'a', label: 'A' }, settings: {} },
        ]);

        expect(list.children.item(0)).toBe(bEl);
        expect(list.children.item(1)).toBe(aEl);
    });
});
