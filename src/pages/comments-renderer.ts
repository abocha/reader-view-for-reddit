import {
    animateRootInsert,
    animateRootMove,
    animateRootReplace,
    getMotionMode,
    type MotionMode,
} from './comments-motion';

export type RootRenderItem<TNode, TSettings> = {
    key: string;
    signature: string;
    top: TNode;
    settings: TSettings;
};

export type RendererApplyResult = {
    changedRoots: HTMLElement[];
    insertedKeys: string[];
    replacedKeys: string[];
    movedKeys: string[];
    removedKeys: string[];
};

export type CommentsRenderer<TNode, TSettings> = {
    apply(items: Array<RootRenderItem<TNode, TSettings>>): RendererApplyResult;
    reset(items: Array<RootRenderItem<TNode, TSettings>>): RendererApplyResult;
    invalidate(): void;
    isMounted(): boolean;
};

type RootRecord = {
    el: HTMLElement;
    signature: string;
};

export function createCommentsRenderer<TNode, TSettings>(
    listEl: HTMLElement,
    renderRoot: (top: TNode, settings: TSettings) => HTMLElement,
    options?: { forceMotionOff?: boolean },
): CommentsRenderer<TNode, TSettings> {
    const recordsByKey = new Map<string, RootRecord>();
    let mounted = false;

    const motionMode: MotionMode = getMotionMode(Boolean(options?.forceMotionOff));

    const invalidate = () => {
        recordsByKey.clear();
        mounted = false;
    };

    const mountInitial = (items: Array<RootRenderItem<TNode, TSettings>>): RendererApplyResult => {
        listEl.replaceChildren();
        recordsByKey.clear();
        const changedRoots: HTMLElement[] = [];
        const insertedKeys: string[] = [];

        for (const item of items) {
            const el = renderRoot(item.top, item.settings);
            el.dataset.rootKey = item.key;
            listEl.appendChild(el);
            recordsByKey.set(item.key, { el, signature: item.signature });
            animateRootInsert(el, motionMode);
            changedRoots.push(el);
            insertedKeys.push(item.key);
        }

        mounted = true;
        return {
            changedRoots,
            insertedKeys,
            replacedKeys: [],
            movedKeys: [],
            removedKeys: [],
        };
    };

    const apply = (items: Array<RootRenderItem<TNode, TSettings>>): RendererApplyResult => {
        if (!mounted) return mountInitial(items);

        const changedRoots: HTMLElement[] = [];
        const insertedKeys: string[] = [];
        const replacedKeys: string[] = [];
        const movedKeys: string[] = [];
        const removedKeys: string[] = [];

        const nextKeys = new Set(items.map(item => item.key));
        for (const [key, record] of Array.from(recordsByKey.entries())) {
            if (nextKeys.has(key)) continue;
            if (record.el.parentElement === listEl) record.el.remove();
            recordsByKey.delete(key);
            removedKeys.push(key);
        }

        const childAt = (index: number): HTMLElement | null => {
            const child = listEl.children.item(index);
            return child instanceof HTMLElement ? child : null;
        };

        for (let i = 0; i < items.length; i += 1) {
            const item = items[i]!;
            const currentAtIndex = childAt(i);
            const record = recordsByKey.get(item.key);

            if (!record) {
                const el = renderRoot(item.top, item.settings);
                el.dataset.rootKey = item.key;
                if (currentAtIndex) listEl.insertBefore(el, currentAtIndex);
                else listEl.appendChild(el);

                recordsByKey.set(item.key, { el, signature: item.signature });
                animateRootInsert(el, motionMode);
                changedRoots.push(el);
                insertedKeys.push(item.key);
                continue;
            }

            if (record.signature !== item.signature) {
                const replacement = renderRoot(item.top, item.settings);
                replacement.dataset.rootKey = item.key;

                if (record.el.parentElement === listEl) {
                    listEl.replaceChild(replacement, record.el);
                } else if (currentAtIndex) {
                    listEl.insertBefore(replacement, currentAtIndex);
                } else {
                    listEl.appendChild(replacement);
                }

                recordsByKey.set(item.key, { el: replacement, signature: item.signature });
                animateRootReplace(replacement, motionMode);
                changedRoots.push(replacement);
                replacedKeys.push(item.key);
                continue;
            }

            if (currentAtIndex !== record.el) {
                listEl.insertBefore(record.el, currentAtIndex);
                animateRootMove(record.el, motionMode);
                movedKeys.push(item.key);
            }
        }

        return {
            changedRoots,
            insertedKeys,
            replacedKeys,
            movedKeys,
            removedKeys,
        };
    };

    const reset = (items: Array<RootRenderItem<TNode, TSettings>>): RendererApplyResult => {
        invalidate();
        return mountInitial(items);
    };

    return {
        apply,
        reset,
        invalidate,
        isMounted: () => mounted,
    };
}
