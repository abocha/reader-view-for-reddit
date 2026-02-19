import { describe, it, expect, vi } from 'vitest';
import {
    parseCommentsListing,
    parseComment,
    collectNodeStats,
    scoreSiblingGroup,
    buildVisibilityPlan,
    sanitizeHtmlToFragment,
    renderCommentTree,
    enhanceInlineMedia,
} from '../pages/reader-host';

type CommentNode = {
    id: string;
    author: string;
    bodyMarkdown: string;
    bodyHtml: string;
    score?: number;
    replies: CommentNode[];
};

function createNode(id: string, score: number, replies: CommentNode[] = []): CommentNode {
    return {
        id,
        score,
        replies,
        author: 'u',
        bodyHtml: '',
        bodyMarkdown: '',
    };
}

function makePolicy(depthLimit: number, smartMode: boolean) {
    return {
        depthLimit,
        smartMode,
        utilityThreshold: 0.75,
        siblingCloseDelta: 0.6,
        maxExtraDeepVisiblePerRoot: 12,
    };
}

function emptyViewState() {
    return {
        expandedMoreIds: new Set<string>(),
        expandedLowScoreIds: new Set<string>(),
    };
}

function stablePlanShape(plan: ReturnType<typeof buildVisibilityPlan>) {
    return {
        visible: Array.from(plan.visibleChildrenByParentId.entries()),
        collapsedLow: Array.from(plan.collapsedLowByParentId.entries()),
        hiddenDepth: Array.from(plan.hiddenDepthCountByParentId.entries()),
    };
}

describe('Reader Comments Logic', () => {
    describe('parseComment & parseCommentsListing', () => {
        it('should parse a simple comment', () => {
            const raw = {
                kind: 't1',
                data: {
                    id: 'c1',
                    author: 'user1',
                    body: 'markdown',
                    body_html: '&lt;p&gt;html&lt;/p&gt;',
                    score: 10,
                    replies: '',
                },
            };

            const node = parseComment(raw, 5);
            expect(node).toMatchObject({
                id: 'c1',
                author: 'user1',
                bodyMarkdown: 'markdown',
                bodyHtml: '&lt;p&gt;html&lt;/p&gt;',
                score: 10,
            });
            expect(node?.createdUtc).toBeUndefined();
            expect(node?.replies).toEqual([]);
        });

        it('should fallback to escaped <pre> when body_html is missing', () => {
            const raw = {
                kind: 't1',
                data: {
                    id: 'c2',
                    author: 'user2',
                    body: '<b>md</b>',
                    body_html: '',
                    replies: '',
                },
            };

            const node = parseComment(raw, 5);
            expect(node?.bodyHtml).toBe('<pre>&lt;b&gt;md&lt;/b&gt;</pre>');
        });

        it('should parse nested comments', () => {
            const rawListing = [
                {
                    kind: 't1',
                    data: {
                        id: 'parent',
                        replies: {
                            data: {
                                children: [
                                    {
                                        kind: 't1',
                                        data: { id: 'child' },
                                    },
                                ],
                            },
                        },
                    },
                },
            ];

            const result = parseCommentsListing(rawListing);
            expect(result.loadedCount).toBe(2);
            expect(result.comments.length).toBe(1);
            expect(result.comments[0].replies.length).toBe(1);
            expect(result.comments[0].replies[0].id).toBe('child');
        });
    });

    describe('Smart Planner', () => {
        it('collectNodeStats computes subtree signals', () => {
            const root = createNode('root', 5, [
                createNode('c1', 2, [createNode('gc1', 11)]),
                createNode('c2', -3),
            ]);
            const stats = collectNodeStats(root);
            const rootStats = stats.get('root')!;

            expect(rootStats.subtreeSize).toBe(4);
            expect(rootStats.bestDescendantScore).toBe(11);
            expect(rootStats.positiveDescendantCount).toBe(2);
        });

        it('promotes a strong deep branch', () => {
            const root = createNode('root', 10, [
                createNode('a', 1, [createNode('a1', 25)]),
                createNode('b', 2, [createNode('b1', 0)]),
            ]);

            const plan = buildVisibilityPlan(root, makePolicy(1, true), emptyViewState());
            expect(plan.visibleChildrenByParentId.get('a')).toContain('a1');
        });

        it('uses sibling budget 2 when deep utilities are close', () => {
            const root = createNode('root', 20, [
                createNode('mid', 10, [
                    createNode('x1', 20),
                    createNode('x2', 18),
                    createNode('x3', 0),
                ]),
            ]);

            const plan = buildVisibilityPlan(root, makePolicy(1, true), emptyViewState());
            const deepVisible = plan.visibleChildrenByParentId.get('mid') ?? [];
            expect(deepVisible.length).toBe(2);
            expect(deepVisible).toContain('x1');
            expect(deepVisible).toContain('x2');
        });

        it('keeps a negative deep child when descendants are strong', () => {
            const root = createNode('root', 10, [
                createNode('mid', 4, [
                    createNode('neg', -5, [createNode('signal', 30)]),
                    createNode('other', 2),
                ]),
            ]);

            const plan = buildVisibilityPlan(root, makePolicy(1, true), emptyViewState());
            const deepVisible = plan.visibleChildrenByParentId.get('mid') ?? [];
            expect(deepVisible).toContain('neg');
        });

        it('caps total deep auto-expansion per root', () => {
            const children: CommentNode[] = [];
            for (let i = 0; i < 20; i += 1) {
                children.push(createNode(`c${i}`, 4, [createNode(`g${i}`, 10)]));
            }
            const root = createNode('root', 100, children);
            const plan = buildVisibilityPlan(root, makePolicy(1, true), emptyViewState());

            let deepVisibleCount = 0;
            for (let i = 0; i < 20; i += 1) {
                deepVisibleCount += (plan.visibleChildrenByParentId.get(`c${i}`) ?? []).length;
            }
            expect(deepVisibleCount).toBeLessThanOrEqual(12);
        });

        it('does not spend deep-expansion cap on hidden branches', () => {
            const root = createNode('root', 10, [
                createNode('a', 0, [
                    createNode('a1', 50),
                    createNode('a2', 49),
                    createNode('a3', 1),
                ]),
                createNode('z', 100, [createNode('z1', 60)]),
            ]);

            const plan = buildVisibilityPlan(root, {
                depthLimit: 0,
                smartMode: true,
                utilityThreshold: 0.75,
                siblingCloseDelta: 0.6,
                maxExtraDeepVisiblePerRoot: 3,
            }, emptyViewState());

            const visibleAtRoot = plan.visibleChildrenByParentId.get('root') ?? [];
            expect(visibleAtRoot).toContain('z');
            expect(visibleAtRoot).not.toContain('a');

            const visibleUnderZ = plan.visibleChildrenByParentId.get('z') ?? [];
            expect(visibleUnderZ).toContain('z1');
        });

        it('is deterministic for fixed input', () => {
            const root = createNode('root', 10, [
                createNode('a', 1, [createNode('a1', 11), createNode('a2', 10)]),
                createNode('b', -2, [createNode('b1', 20)]),
            ]);

            const policy = makePolicy(1, true);
            const first = buildVisibilityPlan(root, policy, emptyViewState());
            const second = buildVisibilityPlan(root, policy, emptyViewState());
            expect(stablePlanShape(first)).toEqual(stablePlanShape(second));
        });

        it('scoreSiblingGroup marks hard-low correctly', () => {
            const children = [createNode('a', -13), createNode('b', 3)];
            const root = createNode('root', 1, children);
            const stats = collectNodeStats(root);
            const scored = scoreSiblingGroup(children, { stats, depthLimit: 0 });
            const hardLow = scored.find(item => item.id === 'a');
            expect(hardLow?.isHardLow).toBe(true);
        });
    });

    describe('sanitizeHtmlToFragment', () => {
        it('should remove script tags', () => {
            const html = '<div>Safe<script>alert(1)</script></div>';
            const frag = sanitizeHtmlToFragment(html);
            const div = document.createElement('div');
            div.appendChild(frag);
            expect(div.innerHTML).not.toContain('<script');
            expect(div.textContent).toContain('Safe');
        });

        it('should remove event handlers', () => {
            const html = '<a href="#" onclick="alert(1)">Link</a>';
            const frag = sanitizeHtmlToFragment(html);
            const div = document.createElement('div');
            div.appendChild(frag);
            expect(div.querySelector('a')?.hasAttribute('onclick')).toBe(false);
            expect(div.innerHTML).toContain('Link');
        });

        it('should resolve reddit relative links', () => {
            const html = '<a href="/r/foo">Sub</a>';
            const frag = sanitizeHtmlToFragment(html);
            const div = document.createElement('div');
            div.appendChild(frag);
            const a = div.querySelector('a');
            expect(a?.href).toBe('https://www.reddit.com/r/foo');
            expect(a?.target).toBe('_blank');
        });
    });

    describe('renderCommentTree visibility', () => {
        it('shows "Show more replies" in depth-only mode', () => {
            const child = createNode('child', 10, [createNode('gc', 10)]);
            const visibilityPlan = buildVisibilityPlan(child, makePolicy(0, false), emptyViewState());

            const el = renderCommentTree(child as any, {
                depthLimit: 0,
                visibilityPlan,
            }, 1, false);

            const btn = el.querySelector('.action-btn');
            expect(btn).not.toBeNull();
            expect(btn?.textContent).toContain('Show 1 more replies');
        });

        it('shows low-score reveal in smart mode', () => {
            const parent = createNode('parent', 10, [createNode('low', -15)]);
            const visibilityPlan = buildVisibilityPlan(parent, makePolicy(10, true), emptyViewState());

            const el = renderCommentTree(parent as any, {
                depthLimit: 10,
                visibilityPlan,
            }, 0, false);

            const btn = Array.from(el.querySelectorAll('button')).find(node => node.textContent?.includes('low-score'));
            expect(btn).not.toBeUndefined();
        });
    });

    describe('Inline Media Enhancement', () => {
        const createMediaNode = (html: string): CommentNode => ({
            id: 'c1',
            author: 'u',
            bodyMarkdown: '',
            bodyHtml: html,
            replies: [],
        });

        it('should enhance image links with previews', () => {
            const html = '<a href="https://example.com/foo.png">Link</a>';
            const node = createMediaNode(html);
            const visibilityPlan = buildVisibilityPlan(node, makePolicy(10, false), emptyViewState());
            const el = renderCommentTree(node as any, {
                depthLimit: 10,
                visibilityPlan,
            }, 0, false);
            enhanceInlineMedia(el);

            const img = el.querySelector('.inline-media-img');
            expect(img).not.toBeNull();
            expect(img?.getAttribute('src')).toBe('https://example.com/foo.png');
            expect(el.textContent).not.toContain('https://example.com/foo.png');
            expect(el.textContent).not.toContain('Link');
        });

        it('should open preview image only once when clicked', () => {
            const open = vi.spyOn(window, 'open').mockImplementation(() => null as any);
            const html = '<a href="https://example.com/foo.png">Link</a>';
            const node = createMediaNode(html);
            const visibilityPlan = buildVisibilityPlan(node, makePolicy(10, false), emptyViewState());
            const el = renderCommentTree(node as any, {
                depthLimit: 10,
                visibilityPlan,
            }, 0, false);
            enhanceInlineMedia(el);

            const img = el.querySelector('.inline-media-img') as HTMLImageElement | null;
            expect(img).not.toBeNull();
            img?.click();

            expect(open).toHaveBeenCalledTimes(1);
            expect(open).toHaveBeenCalledWith('https://example.com/foo.png', '_blank', 'noopener,noreferrer');
            open.mockRestore();
        });

        it('should mark giphy links as gif text', () => {
            const html = '<a href="https://giphy.com/gifs/abc-123">[gif]</a>';
            const node = createMediaNode(html);
            const visibilityPlan = buildVisibilityPlan(node, makePolicy(10, false), emptyViewState());
            const el = renderCommentTree(node as any, {
                depthLimit: 10,
                visibilityPlan,
            }, 0, false);
            enhanceInlineMedia(el);

            const note = el.querySelector('.inline-gif-note');
            expect(note).not.toBeNull();
            expect(el.textContent).toContain('Giphy GIF');
        });
    });
});
