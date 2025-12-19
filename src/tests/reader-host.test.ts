
import { describe, it, expect, vi } from 'vitest';
import {
    sanitizeHtmlToFragment,
    cleanRedditHtml,
    parseCommentsListing,
    parseComment,
    renderArticle,
    buildPostMarkdown,
    computePromotedPathIds,
    renderCommentTree,
    __test__
} from '../pages/reader-host';

describe('Reader Host Logic', () => {
    it('should render a stable "View on Reddit" meta pill link', () => {
        document.body.innerHTML = `<article id="spike-article"></article>`;

        renderArticle({
            title: 'Test Post',
            author: 'me',
            subreddit: 'r/test',
            bodyHtml: '<p>Hello</p>',
            bodyMarkdown: 'Hello',
            url: 'https://www.reddit.com/r/test/comments/abc123/test_post/',
            isFallback: false,
            permalink: '/r/test/comments/abc123/test_post/',
        } as any);

        const link = document.querySelector('a.meta-pill.original-link') as HTMLAnchorElement | null;
        expect(link).toBeTruthy();
        expect(link?.textContent).toContain('Reddit');
        expect(link?.getAttribute('href')).toBe('https://www.reddit.com/r/test/comments/abc123/test_post/');
        expect(link?.getAttribute('target')).toBe('_blank');
        expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
        expect(link?.getAttribute('title')).toContain('Reddit');
        expect(link?.getAttribute('aria-label')).toContain('Reddit');
    });

    describe('sanitizeHtmlToFragment', () => {
        it('should remove script tags', () => {
            const input = '<div><script>alert(1)</script><p>Safe</p></div>';
            const fragment = sanitizeHtmlToFragment(input);
            const div = document.createElement('div');
            div.appendChild(fragment);

            expect(div.innerHTML).not.toContain('script');
            expect(div.innerHTML).toContain('Safe');
        });

        it('should allow img tags', () => {
            const input = '<p>Check this: <img src="test.jpg" alt="test" /></p>';
            const fragment = sanitizeHtmlToFragment(input);
            const div = document.createElement('div');
            div.appendChild(fragment);

            expect(div.querySelectorAll('img').length).toBe(1);
            expect(div.querySelector('img')?.getAttribute('src')).toBe('test.jpg');
        });

        it('should allow table tags', () => {
            const input = '<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>D</td></tr></tbody></table>';
            const fragment = sanitizeHtmlToFragment(input);
            const div = document.createElement('div');
            div.appendChild(fragment);

            expect(div.querySelectorAll('table').length).toBe(1);
            expect(div.querySelectorAll('td').length).toBe(1);
        });

        it('should strip event handlers', () => {
            const input = '<a href="#" onclick="steal()">Click me</a>';
            const fragment = sanitizeHtmlToFragment(input);
            const div = document.createElement('div');
            div.appendChild(fragment);

            const a = div.querySelector('a');
            expect(a).toBeTruthy();
            expect(a?.hasAttribute('onclick')).toBe(false);
        });

        it('should strip disallowed attributes', () => {
            const input = '<img src="test.jpg" alt="x" style="color:red" data-x="1" loading="lazy" />';
            const fragment = sanitizeHtmlToFragment(input);
            const div = document.createElement('div');
            div.appendChild(fragment);

            const img = div.querySelector('img');
            expect(img).toBeTruthy();
            expect(img?.getAttribute('src')).toBe('test.jpg');
            expect(img?.getAttribute('loading')).toBe('lazy');
            expect(img?.hasAttribute('style')).toBe(false);
            expect(img?.hasAttribute('data-x')).toBe(false);
        });

	        it('should normalize and sanitize links', () => {
	            const input = [
	                '<a href="/user/test">Rel</a>',
	                '<a href="giphy|abc-123">Gif</a>',
	                '<a href="GIPHY|Abc_123">GifCase</a>',
	                '<a href="javascript:alert(1)">Bad</a>',
	                '<a href="//example.com/x">ProtoRel</a>',
	                '<a href="mailto:test@example.com">Mail</a>',
	                '<a href="https://example.com">Ok</a>',
	            ].join('');
	            const fragment = sanitizeHtmlToFragment(input);
	            const div = document.createElement('div');
            div.appendChild(fragment);

	            const links = Array.from(div.querySelectorAll('a')) as HTMLAnchorElement[];
	            const rel = links.find(l => l.textContent === 'Rel')!;
	            const g = links.find(l => l.textContent === 'Gif')!;
	            const gCase = links.find(l => l.textContent === 'GifCase')!;
	            const bad = links.find(l => l.textContent === 'Bad')!;
	            const protoRel = links.find(l => l.textContent === 'ProtoRel')!;
	            const mail = links.find(l => l.textContent === 'Mail')!;
	            const ok = links.find(l => l.textContent === 'Ok')!;

	            expect(rel.getAttribute('href')).toBe('https://www.reddit.com/user/test');
	            expect(rel.getAttribute('rel')).toBe('noopener noreferrer');
	            expect(rel.getAttribute('target')).toBe('_blank');

	            expect(g.getAttribute('href')).toBe('https://giphy.com/gifs/abc-123');
	            expect(g.getAttribute('rel')).toBe('noopener noreferrer');
	            expect(g.getAttribute('target')).toBe('_blank');

	            expect(gCase.getAttribute('href')).toBe('https://giphy.com/gifs/Abc_123');
	            expect(gCase.getAttribute('rel')).toBe('noopener noreferrer');
	            expect(gCase.getAttribute('target')).toBe('_blank');

	            expect(bad.hasAttribute('href')).toBe(false);
	            expect(protoRel.getAttribute('href')).toBe('https://example.com/x');
	            expect(protoRel.getAttribute('rel')).toBe('noopener noreferrer');
	            expect(protoRel.getAttribute('target')).toBe('_blank');
	            expect(mail.hasAttribute('href')).toBe(false);

	            expect(ok.getAttribute('href')).toBe('https://example.com/');
	            expect(ok.getAttribute('rel')).toBe('noopener noreferrer');
	            expect(ok.getAttribute('target')).toBe('_blank');
	        });

        it('should remove comments and unwrap unknown tags', () => {
            const input = '<div><!-- comment --><rvrr-unknown><p>Keep</p></rvrr-unknown></div>';
            const fragment = sanitizeHtmlToFragment(input);
            const div = document.createElement('div');
            div.appendChild(fragment);

            expect(div.innerHTML).not.toContain('<!--');
            expect(div.querySelector('rvrr-unknown')).toBeNull();
            expect(div.querySelector('p')?.textContent).toBe('Keep');
        });
    });

    describe('cleanRedditHtml', () => {
        it('should remove SC_OFF/ON comments', () => {
            const input = '<!-- SC_OFF -->Hello<!-- SC_ON -->';
            expect(cleanRedditHtml(input)).toBe('Hello');
        });
    });

    describe('parseComment', () => {
        it('should parse a standard comment', () => {
            const raw = {
                data: {
                    id: 'c1',
                    author: 'user1',
                    body_html: '<div class="md"><p>Hello</p></div>',
                    score: 100,
                    created_utc: 1600000000,
                    replies: ''
                }
            };
            const node = parseComment(raw, 10);
            expect(node?.id).toBe('c1');
            expect(node?.author).toBe('user1');
            expect(node?.bodyHtml).toContain('<p>Hello</p>');
            expect(node?.replies).toEqual([]);
        });

        it('should handle nested replies', () => {
            const raw = {
                data: {
                    id: 'c1',
                    replies: {
                        data: {
                            children: [
                                {
                                    kind: 't1',
                                    data: { id: 'c2', author: 'user2' }
                                }
                            ]
                        }
                    }
                }
            };
            const node = parseComment(raw, 10);
            expect(node?.replies.length).toBe(1);
            expect(node?.replies[0].id).toBe('c2');
        });
    });

    describe('parseCommentsListing', () => {
        it('should detect "more" placeholders', () => {
            const result = parseCommentsListing([
                { kind: 'more', data: {} },
                { kind: 't1', data: { id: 'c1', author: 'a', body: 'hi', replies: '' } },
            ]);

            expect(result.hasMore).toBe(true);
            expect(result.loadedCount).toBe(1);
            expect(result.comments.length).toBe(1);
        });
    });

    describe('Markdown Builder', () => {
        it('should format post markdown', () => {
            const post = {
                title: 'Test Title',
                url: 'http://test.com',
                bodyMarkdown: 'Some **bold** text',
                author: 'au',
                subreddit: 'sub',
                bodyHtml: '',
                isFallback: false
            };
            const md = buildPostMarkdown(post);
            expect(md).toContain('# Test Title');
            expect(md).toContain('http://test.com');
            expect(md).toContain('Some **bold** text');
        });

        it('should handle missing post body content', () => {
            const post = {
                title: 'No Body',
                url: 'http://test.com',
                bodyMarkdown: '',
                author: 'au',
                subreddit: 'sub',
                bodyHtml: '',
                isFallback: false
            };
            const md = buildPostMarkdown(post);
            expect(md).toContain('(No text content found)');
        });

        it('should warn when only HTML is available', () => {
            const post = {
                title: 'HTML Only',
                url: 'http://test.com',
                bodyMarkdown: '',
                author: 'au',
                subreddit: 'sub',
                bodyHtml: '<p>hi</p>',
                isFallback: false
            };
            const md = buildPostMarkdown(post);
            expect(md).toContain('(No Markdown content available)');
        });
    });

	    describe('computePromotedPathIds (Auto-Expand)', () => {
	        it('should promote high scoring deep comments', () => {
	            // Mock structure: top -> child(score 50) -> ...
	            // We need to construct a graph manually
	            // This logic is complex, just testing basic eligibility
	            const deepChild = { id: 'c3', score: 100, replies: [] } as any;
	            const child = { id: 'c2', score: 10, replies: [deepChild] } as any;
	            const root = { id: 'c1', score: 200, replies: [child] } as any;

	            const promoted = computePromotedPathIds(root, 0, 200);
	            expect(promoted.has('c3')).toBe(true);
	            expect(promoted.has('c2')).toBe(true); // Parent of promoted node
	        });
	    });

    describe('buildCommentSnippet', () => {
        it('should collapse empty comments', () => {
            expect(__test__.buildCommentSnippet({ bodyMarkdown: '' } as any)).toBe('(collapsed)');
        });

        it('should replace giphy markdown with [GIF]', () => {
            const snippet = __test__.buildCommentSnippet({
                bodyMarkdown: 'Look ![gif](giphy|abc-123) and [gif](giphy|def-456)'
            } as any);
            expect(snippet).toContain('[GIF]');
            expect(snippet).not.toContain('giphy|');
        });

        it('should truncate long comments', () => {
            const long = 'x'.repeat(200);
            const snippet = __test__.buildCommentSnippet({ bodyMarkdown: long } as any);
            expect(snippet.endsWith('…')).toBe(true);
            expect(snippet.length).toBe(91);
        });
    });

    describe('Inline media helpers', () => {
        it('should return false for invalid URLs', () => {
            expect(__test__.isProbablyImageUrl('not a url')).toBe(false);
            expect(__test__.isGiphyGifPage('not a url')).toBe(false);
        });

        it('should open the preview url when clicking an image preview', () => {
            const open = vi.spyOn(window, 'open').mockImplementation(() => null as any);
            const preview = __test__.createImagePreview('https://i.redd.it/test.png');
            document.body.appendChild(preview);

            const img = preview.querySelector('img') as HTMLImageElement | null;
            img?.click();

            expect(open).toHaveBeenCalledWith('https://i.redd.it/test.png', '_blank', 'noopener,noreferrer');
            open.mockRestore();
        });
    });

    describe('renderCommentTree actions', () => {
        it('should wire up "show more" and "show low-score" buttons', () => {
            const wrapper = renderCommentTree(
                {
                    id: 'p',
                    author: 'parent',
                    bodyMarkdown: 'p',
                    bodyHtml: '<p>p</p>',
                    replies: [
                        { id: 'low', author: 'low', bodyMarkdown: 'low', bodyHtml: '<p>low</p>', score: -10, replies: [] },
                        { id: 'deep', author: 'deep', bodyMarkdown: 'deep', bodyHtml: '<p>deep</p>', score: 1, replies: [] },
                    ],
                } as any,
                { depthLimit: 0, autoDepth: false, hideLow: true, promotedPathIds: new Set() },
                0,
                false,
            );

            const buttons = Array.from(wrapper.querySelectorAll('button')) as HTMLButtonElement[];
            const showMore = buttons.find(b => b.textContent?.includes('Show') && b.textContent.includes('more replies'));
            const showLow = buttons.find(b => b.textContent?.includes('low-score replies'));

            expect(showMore).toBeTruthy();
            expect(showLow).toBeTruthy();

            showMore?.click();
            showLow?.click();
        });
    });

    describe('renderCommentTree collapse', () => {
        it('should render a collapsed snippet when collapsed', () => {
            __test__.collapsedById.clear();
            __test__.collapsedById.add('c1');

            const wrapper = renderCommentTree(
                {
                    id: 'c1',
                    author: 'user',
                    bodyMarkdown: 'Hello world',
                    bodyHtml: '<p>Hello world</p>',
                    replies: [],
                } as any,
                { depthLimit: 5, autoDepth: false, hideLow: false, promotedPathIds: new Set() },
                0,
                false,
            );

            const collapsed = wrapper.querySelector('.comment-collapsed') as HTMLElement | null;
            expect(collapsed).not.toBeNull();
            expect(collapsed?.textContent).toContain('Hello world');
        });

        it('should toggle collapse state on click', () => {
            __test__.collapsedById.clear();
            document.body.innerHTML = '<div id="comments-list"></div>';

            const wrapper = renderCommentTree(
                {
                    id: 'c2',
                    author: 'user',
                    bodyMarkdown: 'Hello',
                    bodyHtml: '<p>Hello</p>',
                    replies: [],
                } as any,
                { depthLimit: 5, autoDepth: false, hideLow: false, promotedPathIds: new Set() },
                0,
                false,
            );

            document.getElementById('comments-list')?.appendChild(wrapper);
            const toggle = wrapper.querySelector('.comment-toggle') as HTMLButtonElement | null;
            toggle?.click();

            expect(__test__.collapsedById.has('c2')).toBe(true);
        });
    });
});
