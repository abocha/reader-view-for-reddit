import { describe, expect, it } from 'vitest';
import { buildCommentProjection } from '../pages/comments-projection';
import type { CommentNode } from '../pages/comments-graph';

function node(
    id: string,
    replies: CommentNode[] = [],
    moreChildrenIds?: string[],
    overrides?: Partial<CommentNode>,
): CommentNode {
    return {
        id,
        author: 'u',
        bodyMarkdown: `body-${id}`,
        bodyHtml: `<p>body-${id}</p>`,
        replies,
        moreChildrenIds,
        ...overrides,
    };
}

describe('comments-projection', () => {
    it('builds deterministic root signatures and child order', () => {
        const root = node('r1', [node('c1'), node('c2')]);
        const plan = {
            visibleChildrenByParentId: new Map([[root.id, ['c1', 'c2']]]),
            collapsedLowByParentId: new Map<string, string[]>(),
            hiddenDepthCountByParentId: new Map([[root.id, 0]]),
        };

        const first = buildCommentProjection([
            { top: root, settings: { depthLimit: 2, visibilityPlan: plan } },
        ], {
            collapsedById: new Set<string>(),
            expandedMoreById: new Set<string>(),
            expandedLowScoreById: new Set<string>(),
            autoModeratorExpandedById: new Set<string>(),
        });

        const second = buildCommentProjection([
            { top: root, settings: { depthLimit: 2, visibilityPlan: plan } },
        ], {
            collapsedById: new Set<string>(),
            expandedMoreById: new Set<string>(),
            expandedLowScoreById: new Set<string>(),
            autoModeratorExpandedById: new Set<string>(),
        });

        expect(first.roots[0]?.signature).toBe(second.roots[0]?.signature);
        expect(first.roots[0]?.key).toBe('r1');
    });

    it('includes forced low-score collapsed children in projection order', () => {
        const root = node('r1', [node('v1'), node('l1')]);
        const plan = {
            visibleChildrenByParentId: new Map([[root.id, ['v1']]]),
            collapsedLowByParentId: new Map([[root.id, ['l1']]]),
            hiddenDepthCountByParentId: new Map([[root.id, 1]]),
        };

        const projection = buildCommentProjection([
            { top: root, settings: { depthLimit: 1, visibilityPlan: plan } },
        ], {
            collapsedById: new Set<string>(),
            expandedMoreById: new Set<string>(),
            expandedLowScoreById: new Set<string>(),
            autoModeratorExpandedById: new Set<string>(),
        });

        const rootNode = projection.byId.get('r1');
        expect(rootNode?.childIds).toEqual(['v1', 'l1']);
        expect(projection.byId.get('l1')?.forcedLowScoreCollapse).toBe(true);
        expect(rootNode?.hiddenDepthCount).toBe(1);
    });

    it('keeps per-root signature stable across pure root reorder', () => {
        const a = node('a');
        const b = node('b');
        const plan = {
            visibleChildrenByParentId: new Map<string, string[]>(),
            collapsedLowByParentId: new Map<string, string[]>(),
            hiddenDepthCountByParentId: new Map<string, number>(),
        };
        const state = {
            collapsedById: new Set<string>(),
            expandedMoreById: new Set<string>(),
            expandedLowScoreById: new Set<string>(),
            autoModeratorExpandedById: new Set<string>(),
        };

        const first = buildCommentProjection([
            { top: a, settings: { depthLimit: 1, visibilityPlan: plan } },
            { top: b, settings: { depthLimit: 1, visibilityPlan: plan } },
        ], state);
        const second = buildCommentProjection([
            { top: b, settings: { depthLimit: 1, visibilityPlan: plan } },
            { top: a, settings: { depthLimit: 1, visibilityPlan: plan } },
        ], state);

        const firstByKey = new Map(first.roots.map(root => [root.key, root.signature] as const));
        const secondByKey = new Map(second.roots.map(root => [root.key, root.signature] as const));
        expect(firstByKey.get('a')).toBe(secondByKey.get('a'));
        expect(firstByKey.get('b')).toBe(secondByKey.get('b'));
    });

    it('changes signature when rendered fields change with same body length', () => {
        const base = node('r1', [node('c1')], undefined, { score: 10 });
        const edited = node(
            'r1',
            [node('c1')],
            undefined,
            {
                score: 11,
                bodyMarkdown: 'abcd',
                bodyHtml: '<p>abcd</p>',
            },
        );
        const sameLengthEdited = node(
            'r1',
            [node('c1')],
            undefined,
            {
                score: 11,
                bodyMarkdown: 'wxyz',
                bodyHtml: '<p>wxyz</p>',
            },
        );
        const plan = {
            visibleChildrenByParentId: new Map([[base.id, ['c1']]]),
            collapsedLowByParentId: new Map<string, string[]>(),
            hiddenDepthCountByParentId: new Map([[base.id, 0]]),
        };
        const state = {
            collapsedById: new Set<string>(),
            expandedMoreById: new Set<string>(),
            expandedLowScoreById: new Set<string>(),
            autoModeratorExpandedById: new Set<string>(),
        };

        const initial = buildCommentProjection([
            { top: base, settings: { depthLimit: 2, visibilityPlan: plan } },
        ], state);
        const changed = buildCommentProjection([
            { top: edited, settings: { depthLimit: 2, visibilityPlan: plan } },
        ], state);
        const changedSameLen = buildCommentProjection([
            { top: sameLengthEdited, settings: { depthLimit: 2, visibilityPlan: plan } },
        ], state);

        expect(initial.roots[0]?.signature).not.toBe(changed.roots[0]?.signature);
        expect(changed.roots[0]?.signature).not.toBe(changedSameLen.roots[0]?.signature);
    });
});
