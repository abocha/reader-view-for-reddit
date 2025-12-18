
	import { describe, it, expect, vi } from 'vitest';
import {
    parseCommentsListing,
    parseComment,
    computePromotedPathIds,
    sanitizeHtmlToFragment,
    renderCommentTree,
    enhanceInlineMedia
} from '../pages/reader-host';

// Type shim since it's not exported
type CommentNode = {
    id: string;
    author: string;
    bodyMarkdown: string;
    bodyHtml: string;
    score?: number;
    replies: CommentNode[];
};

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
	                    replies: ''
	                }
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
                                        data: { id: 'child' }
                                    }
                                ]
                            }
                        }
                    }
                }
            ];

            const result = parseCommentsListing(rawListing);
            expect(result.loadedCount).toBe(2); // parent + child
            expect(result.comments.length).toBe(1);
            expect(result.comments[0].replies.length).toBe(1);
            expect(result.comments[0].replies[0].id).toBe('child');
        });
    });

	    describe('computePromotedPathIds', () => {
	        const createNode = (id: string, score: number, replies: CommentNode[] = []): CommentNode => ({
	            id, score, replies, author: 'u', bodyHtml: '', bodyMarkdown: ''
	        });

	        it('should return empty set if no nodes qualify', () => {
	            // Root -> Child (score 4, depth 2) -> Grandchild (score 4, depth 3)
	            // Best deep score is < 5, so nothing should be auto-expanded.
	            const root = createNode('root', 100, [
	                createNode('c1', 4, [
	                    createNode('gc1', 4)
	                ])
	            ]);

	            const set = computePromotedPathIds(root, 1, 100);
	            expect(set.size).toBe(0);
	        });

	        it('should promote high score nodes deep in the tree', () => {
            // Root -> Child (depth 2) -> Grandchild (depth 3, score 50)
            // Depth limit 1.
            // Grandchild is at depth 3 > 1. Score 50 >= 25. Should promote.
            // Result should include gc1 AND c1 (path to it).

            const gc1 = createNode('gc1', 50);
            const c1 = createNode('c1', 5, [gc1]);
            const root = createNode('root', 100, [c1]);

	            const set = computePromotedPathIds(root, 1, 100);
	            expect(set.has('gc1')).toBe(true);
	            expect(set.has('c1')).toBe(true);
	        });

	        it('should promote best deep nodes even when top score is low', () => {
	            // Root -> Child -> Grandchild(score 20). Depth limit 0.
	            // Even though root's score is low, the best deep comment should still be promoted.
	            const gc1 = createNode('gc1', 20);
	            const c1 = createNode('c1', 1, [gc1]);
	            const root = createNode('root', 1, [c1]);

	            const set = computePromotedPathIds(root, 0, 1);
	            expect(set.has('gc1')).toBe(true);
	            expect(set.has('c1')).toBe(true);
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
            // Check that onclick is gone
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

    describe('renderCommentTree Visibility logic', () => {
        const createNode = (id: string, score: number, replies: CommentNode[] = []): CommentNode => ({
            id, score, replies, author: 'u', bodyHtml: '', bodyMarkdown: ''
        });

        it('should show "Show more replies" button when depth limit reached', () => {
            // Root (d0) passed to render.
            // Child (d1) visible.
            // Grandchild (d2) hidden if limit is 1.

            const gc = createNode('gc', 10);
            const child = createNode('child', 10, [gc]);

            const el = renderCommentTree(child, {
                depthLimit: 1,
                autoDepth: false,
                hideLow: false,
                promotedPathIds: new Set()
            }, 1, false); // currentDepth 1. Replies will be at depth 2.

            // child is rendered. child.replies loop -> children at depth 2.
            // limit 1. 2 <= 1 is false.
            // So gc is hidden.

            const btn = el.querySelector('.action-btn');
            expect(btn).not.toBeNull();
            expect(btn?.textContent).toContain('Show 1 more replies');
        });

        it('should show "Show low-score replies" button when score is low', () => {
            const lowChild = createNode('low', -10);
            const parent = createNode('parent', 10, [lowChild]);

            const el = renderCommentTree(parent, {
                depthLimit: 10,
                autoDepth: false,
                hideLow: true,
                promotedPathIds: new Set()
            }, 0, false);

            // lowChild is hidden
            const btn = el.querySelector('.action-btn');
            expect(btn).not.toBeNull();
            expect(btn?.textContent).toContain('low-score');
        });
    });

	    describe('Inline Media Enhancement', () => {
        const createNode = (html: string): CommentNode => ({
            id: 'c1', author: 'u', bodyMarkdown: '', bodyHtml: html, replies: []
        });

	        it('should enhance image links with previews', () => {
	            const html = '<a href="https://example.com/foo.png">Link</a>';
	            const node = createNode(html);

	            const el = renderCommentTree(node, {
	                depthLimit: 10, autoDepth: false, hideLow: false, promotedPathIds: new Set()
	            }, 0, false);
                enhanceInlineMedia(el);

	            const img = el.querySelector('.inline-media-img');
	            expect(img).not.toBeNull();
	            expect(img?.getAttribute('src')).toBe('https://example.com/foo.png');
	            // Image links should be replaced by the preview (no raw link text left behind)
	            expect(el.textContent).not.toContain('https://example.com/foo.png');
	            expect(el.textContent).not.toContain('Link');
	        });

	        it('should open preview image only once when clicked', () => {
	            const open = vi.spyOn(window, 'open').mockImplementation(() => null as any);
	            const html = '<a href="https://example.com/foo.png">Link</a>';
	            const node = createNode(html);

	            const el = renderCommentTree(node, {
	                depthLimit: 10, autoDepth: false, hideLow: false, promotedPathIds: new Set(),
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
            const node = createNode(html);

            const el = renderCommentTree(node, {
                depthLimit: 10, autoDepth: false, hideLow: false, promotedPathIds: new Set()
            }, 0, false);
            enhanceInlineMedia(el);

            const note = el.querySelector('.inline-gif-note');
            expect(note).not.toBeNull();
            expect(el.textContent).toContain('Giphy GIF');
        });
    });
});
