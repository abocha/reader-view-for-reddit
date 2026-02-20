import { describe, expect, it } from 'vitest';
import {
    buildGraphFromListing,
    collectPlaceholdersForScope,
    consumePlaceholderIds,
    createEmptyCommentGraphState,
    mergeMoreChildrenThingsIntoGraph,
    projectRootsFromGraph,
    rebuildGraphFromRoots,
    refreshHasMoreState,
} from '../pages/comments-graph';

describe('comments-graph', () => {
    it('builds graph from listing with root marker placeholders', () => {
        const listing = [
            { kind: 'more', data: { children: ['c10', 'c11'] } },
            {
                kind: 't1',
                data: {
                    id: 'c1',
                    author: 'root',
                    body: 'root body',
                    body_html: '<p>root body</p>',
                    replies: {
                        data: {
                            children: [
                                {
                                    kind: 't1',
                                    data: {
                                        id: 'c2',
                                        author: 'child',
                                        body: 'child body',
                                        body_html: '<p>child body</p>',
                                        replies: '',
                                    },
                                },
                            ],
                        },
                    },
                },
            },
        ];

        const { graph, loadedCount } = buildGraphFromListing(listing as any, (wrapper: any) => {
            const data = wrapper?.data;
            if (!data?.id) return null;
            const replies = Array.isArray(data?.replies?.data?.children)
                ? data.replies.data.children
                    .filter((child: any) => child?.kind === 't1')
                    .map((child: any) => ({
                        id: String(child.data.id),
                        author: String(child.data.author || 'unknown'),
                        bodyMarkdown: String(child.data.body || ''),
                        bodyHtml: String(child.data.body_html || ''),
                        replies: [],
                    }))
                : [];
            return {
                id: String(data.id),
                author: String(data.author || 'unknown'),
                bodyMarkdown: String(data.body || ''),
                bodyHtml: String(data.body_html || ''),
                replies,
            };
        });

        expect(loadedCount).toBe(2);
        expect(graph.rootIds).toEqual(['c1']);
        expect(graph.rootMoreChildrenIds).toEqual(['c10', 'c11']);
        expect(graph.hasMoreMarker).toBe(true);
        expect(graph.hasMore).toBe(true);
    });

    it('collects and consumes placeholders by scope', () => {
        const graph = rebuildGraphFromRoots([
            {
                id: 'c1',
                author: 'root',
                bodyMarkdown: 'root',
                bodyHtml: '<p>root</p>',
                moreChildrenIds: ['c5'],
                replies: [
                    {
                        id: 'c2',
                        author: 'child',
                        bodyMarkdown: 'child',
                        bodyHtml: '<p>child</p>',
                        moreChildrenIds: ['c6'],
                        replies: [],
                    },
                ],
            },
        ], {
            hasMoreMarker: false,
            rootMoreChildrenIds: ['c4'],
        });

        const rootScope = collectPlaceholdersForScope(graph, null);
        expect(rootScope.map(item => item.parentId)).toEqual([null, 'c1', 'c2']);

        consumePlaceholderIds(graph, 'c1', ['c5']);
        consumePlaceholderIds(graph, null, ['c4']);
        refreshHasMoreState(graph);

        expect(graph.rootMoreChildrenIds).toEqual([]);
        expect(graph.nodesById.get('c1')?.moreChildrenIds).toEqual([]);
        expect(graph.hasMore).toBe(true); // c2 still has unresolved placeholders
    });

    it('merges morechildren results and preserves parent links', () => {
        const graph = rebuildGraphFromRoots([
            {
                id: 'c1',
                author: 'root',
                bodyMarkdown: 'root',
                bodyHtml: '<p>root</p>',
                replies: [],
            },
        ], {
            hasMoreMarker: false,
            rootMoreChildrenIds: [],
        });

        const result = mergeMoreChildrenThingsIntoGraph(
            graph,
            [
                {
                    kind: 't1',
                    data: {
                        id: 'c2',
                        parent_id: 't1_c1',
                        author: 'child',
                        body: 'child',
                        body_html: '<p>child</p>',
                        replies: '',
                    },
                },
                {
                    kind: 'more',
                    data: {
                        parent_id: 't1_c2',
                        children: ['c3'],
                    },
                },
            ] as any,
            'post123',
            (wrapper: any) => {
                const data = wrapper?.data;
                if (!data?.id) return null;
                return {
                    id: String(data.id),
                    author: String(data.author || 'unknown'),
                    bodyMarkdown: String(data.body || ''),
                    bodyHtml: String(data.body_html || ''),
                    replies: [],
                };
            },
        );

        const projected = projectRootsFromGraph(graph);
        expect(result.insertedCount).toBe(1);
        expect(projected[0]?.replies[0]?.id).toBe('c2');
        expect(graph.nodesById.get('c2')?.moreChildrenIds).toEqual(['c3']);
    });

    it('keeps marker and placeholder availability independent', () => {
        const graph = createEmptyCommentGraphState();
        graph.hasMoreMarker = true;
        refreshHasMoreState(graph);
        expect(graph.hasMore).toBe(true);

        graph.hasMoreMarker = false;
        graph.rootMoreChildrenIds = ['c10'];
        refreshHasMoreState(graph);
        expect(graph.hasMore).toBe(true);

        graph.rootMoreChildrenIds = [];
        refreshHasMoreState(graph);
        expect(graph.hasMore).toBe(false);
    });
});
