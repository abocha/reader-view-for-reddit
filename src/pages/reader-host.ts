import browser from 'webextension-polyfill';
import type { RedditPostPayload } from '../content/reddit-extract';
import type { PerfReport } from '../perf/trace';
import { perf } from '../perf/trace';
import { touchSessionToken } from '../shared/session-token-cache';
import {
    buildGraphFromListing,
    collectPlaceholdersForScope as collectGraphPlaceholdersForScope,
    consumePlaceholderIds as consumeGraphPlaceholderIds,
    createEmptyCommentGraphState,
    hasResolvableMorePlaceholders as graphHasResolvableMorePlaceholders,
    mergeMoreChildrenThingsIntoGraph,
    parseMoreChildrenIds as parseGraphMoreChildrenIds,
    projectRootsFromGraph,
    rebuildGraphFromRoots,
    refreshHasMoreState as refreshGraphHasMoreState,
    dedupeIds as dedupeGraphIds,
} from './comments-graph';
import type {
    CommentGraphState,
    CommentNode,
    GraphMergeResult,
    GraphPlaceholder,
} from './comments-graph';
import { buildCommentProjection } from './comments-projection';
import { createCommentsRenderer } from './comments-renderer';
import type { CommentsRenderer, RootRenderItem } from './comments-renderer';

const SHOULD_DEBUG_LOG = typeof __DEV__ !== 'undefined' && __DEV__;
if (SHOULD_DEBUG_LOG) {
    console.log("[Reader Host] Script loaded");
}

type MorePlaceholder = GraphPlaceholder;

type LoadBudget = {
    maxRequests: number;
    maxNodes: number;
    maxMillis: number;
};

type LoadProgress = {
    requestsUsed: number;
    nodesLoaded: number;
    placeholdersResolved: number;
    truncated: boolean;
    errors: string[];
};

type CommentsMergeResult = GraphMergeResult;

type NodeStats = {
    id: string;
    parentId: string | null;
    depth: number;
    score: number;
    childCount: number;
    bestDescendantScore: number;
    positiveDescendantCount: number;
    subtreeSize: number;
};

type ScoredChild = {
    id: string;
    utility: number;
    isHardLow: boolean;
    reasonFlags: string[];
};

type VisibilityPlan = {
    visibleChildrenByParentId: Map<string, string[]>;
    collapsedLowByParentId: Map<string, string[]>;
    hiddenDepthCountByParentId: Map<string, number>;
};

type VisibilityPolicy = {
    depthLimit: number;
    smartMode: boolean;
    utilityThreshold: number;
    siblingCloseDelta: number;
    maxExtraDeepVisiblePerRoot: number;
};

type VisibilityViewState = {
    expandedMoreIds: Set<string>;
    expandedLowScoreIds: Set<string>;
};

type RenderTreeSettings = {
    depthLimit: number;
    visibilityPlan: VisibilityPlan;
    searchActive?: boolean;
    searchQuery?: ReturnType<typeof parseCommentSearchQuery>;
    searchHighlightTerms?: string[];
};

type CommentsBulkAction = 'expand_all' | 'collapse_all' | 'reset_view';

let currentPost: RedditPostPayload | null = null;
let currentComments: CommentNode[] = [];
let commentsGraph: CommentGraphState = createEmptyCommentGraphState();
let commentsRenderer: CommentsRenderer<CommentNode, RenderTreeSettings> | null = null;
let commentsVisible = true;
const expandedMoreById = new Set<string>();
const expandedLowScoreById = new Set<string>();
const collapsedById = new Set<string>();
const autoModeratorExpandedById = new Set<string>();
let traceId: string | null = null;
let commentsAbort: AbortController | null = null;
let commentsLoadSeq = 0;
let isBenchmark = false;
let benchmarkLimitOverride: number | null = null;
let benchmarkSortOverride: string | null = null;
let benchmarkAutoComments = false;
let pendingScrollAnchor: { commentId: string; top: number } | null = null;
let pendingCommentFocusId: string | null = null;
let currentCommentsHasMore = false;
let currentHasMoreMarker = false;
let currentRootMoreChildrenIds: string[] = [];
let commentsRenderSeq = 0;
let commentsDeepLoadSeq = 0;
let activeDeepLoadParentId: string | null = null;
let hasActiveSearchStatus = false;
let activeSearchHighlightKey = '';
let backToTopCleanup: (() => void) | null = null;
let deepLoadState: {
    loaded: boolean;
    scope: 'none' | 'branch' | 'root';
    truncated: boolean;
} = {
    loaded: false,
    scope: 'none',
    truncated: false,
};

function syncCommentsStateFromGraph(updateProjection = true): void {
    if (updateProjection) {
        currentComments = projectRootsFromGraph(commentsGraph);
    }
    currentRootMoreChildrenIds = [...commentsGraph.rootMoreChildrenIds];
    currentHasMoreMarker = commentsGraph.hasMoreMarker;
    currentCommentsHasMore = commentsGraph.hasMore;
}

function resetCommentsGraphState(): void {
    commentsGraph = createEmptyCommentGraphState();
    syncCommentsStateFromGraph(true);
}

function rebuildCommentsGraphFromRoots(
    roots: CommentNode[],
    options?: { hasMoreMarker?: boolean; rootMoreChildrenIds?: string[] },
): void {
    commentsGraph = rebuildGraphFromRoots(roots, options);
    syncCommentsStateFromGraph(true);
}

const COMMENTS_LIMIT_OPTIONS = [50, 100, 200, 300, 400, 500] as const;
const COMMENTS_SORT_OPTIONS = new Set(['best', 'top', 'new', 'old', 'controversial']);
const DEFAULT_VISIBILITY_POLICY: Omit<VisibilityPolicy, 'depthLimit' | 'smartMode'> = {
    utilityThreshold: 0.75,
    siblingCloseDelta: 0.6,
    maxExtraDeepVisiblePerRoot: 12,
};
const DEFAULT_DEEP_LOAD_BUDGET: LoadBudget = {
    maxRequests: 10,
    maxNodes: 350,
    maxMillis: 3500,
};
const MORECHILDREN_BATCH_SIZE = 25;
const COMMENTS_PREF_KEYS = {
    visible: 'reader-comments-visible',
    depth: 'reader-comments-depth',
    smartMode: 'reader-comments-smart-mode',
    limit: 'reader-comments-limit',
    sort: 'reader-comments-sort',
} as const;

function readLocalStorageValue(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function writeLocalStorageValue(key: string, value: string): void {
    try {
        localStorage.setItem(key, value);
    } catch {
        // ignore localStorage failures
    }
}

function persistCommentsPreference(key: keyof typeof COMMENTS_PREF_KEYS, value: string): void {
    if (isBenchmark) return;
    writeLocalStorageValue(COMMENTS_PREF_KEYS[key], value);
}

function normalizeSearchToken(value: string): string {
    return value.trim().toLowerCase();
}

function parseCommentSearchQuery(raw: string): { author: string | null; terms: string[] } {
    const tokens = raw
        .split(/\s+/)
        .map(token => token.trim())
        .filter(Boolean);

    let author: string | null = null;
    const terms: string[] = [];

    for (const token of tokens) {
        if (token.toLowerCase().startsWith('author:')) {
            const candidate = normalizeSearchToken(token.slice('author:'.length).replace(/^u\//i, ''));
            if (candidate) author = candidate;
            continue;
        }
        terms.push(normalizeSearchToken(token));
    }

    return { author, terms };
}

type FooterActionState = 'hidden' | 'loading' | 'load_from_reddit' | 'increase_limit' | 'open_reddit';

function getFooterActionState(options: {
    hasMore: boolean;
    hasResolvable: boolean;
    hasMoreMarker: boolean;
    limit: number;
    loading: boolean;
}): FooterActionState {
    if (options.loading) return 'loading';
    if (!options.hasMore) return 'hidden';
    if (options.hasResolvable) return 'load_from_reddit';
    if (options.hasMoreMarker && options.limit < 500) return 'increase_limit';
    if (options.hasMoreMarker && options.limit >= 500) return 'open_reddit';
    return 'hidden';
}

function commentMatchesSearch(comment: CommentNode, query: { author: string | null; terms: string[] }): boolean {
    const author = normalizeSearchToken(comment.author);
    if (query.author && !author.includes(query.author)) return false;

    if (query.terms.length === 0) return true;

    const haystack = [
        comment.author,
        comment.bodyMarkdown,
    ].join('\n').toLowerCase();

    return query.terms.every(term => haystack.includes(term));
}

function filterCommentTree(comment: CommentNode, query: { author: string | null; terms: string[] }): CommentNode | null {
    const filteredReplies: CommentNode[] = [];
    for (const reply of comment.replies) {
        const filtered = filterCommentTree(reply, query);
        if (filtered) filteredReplies.push(filtered);
    }

    if (commentMatchesSearch(comment, query) || filteredReplies.length > 0) {
        return { ...comment, replies: filteredReplies };
    }
    return null;
}

function filterCommentsBySearch(comments: CommentNode[], rawQuery: string): CommentNode[] {
    const queryText = rawQuery.trim();
    if (!queryText) return comments;

    const query = parseCommentSearchQuery(queryText);
    return comments
        .map(comment => filterCommentTree(comment, query))
        .filter((node): node is CommentNode => Boolean(node));
}

function countMatchingComments(comments: CommentNode[], rawQuery: string): number {
    const query = parseCommentSearchQuery(rawQuery);
    let count = 0;
    const visit = (comment: CommentNode): void => {
        if (commentMatchesSearch(comment, query)) count += 1;
        for (const reply of comment.replies) visit(reply);
    };
    for (const comment of comments) visit(comment);
    return count;
}

function coerceCommentsLimit(value: number | null | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return 100;
    let best: (typeof COMMENTS_LIMIT_OPTIONS)[number] = COMMENTS_LIMIT_OPTIONS[0];
    let bestDist = Math.abs(value - best);
    for (const opt of COMMENTS_LIMIT_OPTIONS) {
        const dist = Math.abs(value - opt);
        if (dist < bestDist) {
            best = opt;
            bestDist = dist;
        }
    }
    return best;
}

function normalizeCommentsCacheKey(permalink: string, sort: string, limit: number): string {
    const path = (permalink.startsWith('/') ? permalink : `/${permalink}`)
        .split('?')[0]!
        .split('#')[0]!
        .replace(/\/$/, '');
    return `${path}|${(sort || 'top').toLowerCase()}|${String(limit)}`;
}

function formatCommentsLoadedMessage(loadedCount: number, totalCount?: number): string {
    if (typeof totalCount === 'number' && Number.isFinite(totalCount) && totalCount > 0) {
        const shown = Math.min(totalCount, Math.max(0, loadedCount));
        return `Showing ${shown} of ${totalCount} comments.`;
    }
    return `Showing ${loadedCount} comments.`;
}

function updateCommentsFooter(options: { hasMore: boolean; limit: number; loading?: boolean; permalink?: string }) {
    const footer = document.getElementById('comments-footer') as HTMLElement | null;
    if (!footer) return;

    const hasResolvable = hasResolvableMorePlaceholders();
    const loading = Boolean(options.loading);
    const state = getFooterActionState({
        hasMore: options.hasMore,
        hasResolvable,
        hasMoreMarker: currentHasMoreMarker,
        limit: options.limit,
        loading,
    });
    footer.classList.toggle('is-hidden', state === 'hidden');

    let btn = footer.querySelector<HTMLButtonElement>('button[data-role="load-more-comments"]');
    if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn--outline btn--sm';
        btn.dataset.role = 'load-more-comments';
        footer.appendChild(btn);
    }

    btn.onclick = null;
    btn.disabled = state === 'hidden';
    if (state === 'loading') {
        btn.classList.add('is-busy');
        btn.setAttribute('aria-busy', 'true');
        btn.textContent = 'Loading more…';
    } else {
        btn.classList.remove('is-busy');
        btn.removeAttribute('aria-busy');
        btn.textContent = state === 'open_reddit'
            ? 'See more comments on Reddit'
            : state === 'load_from_reddit'
                ? 'Load more from Reddit'
                : 'Load more comments';
    }

    if (state === 'open_reddit') {
        btn.disabled = false;
        btn.onclick = (e) => {
            e.preventDefault();
            const permalink = options.permalink;
            if (!permalink) return;
            const url = `https://www.reddit.com${permalink.startsWith('/') ? permalink : `/${permalink}`}`;
            window.open(url, '_blank', 'noopener,noreferrer');
        };
        return;
    }

    if (state === 'increase_limit' || state === 'load_from_reddit') {
        btn.disabled = false;
        btn.onclick = () => {
            pendingScrollAnchor = captureCommentsScrollAnchor();
            if (state === 'increase_limit') {
                const currentLimit = getCommentsLimit();
                const limitEl = document.getElementById('comments-limit') as HTMLSelectElement | null;
                const idx = COMMENTS_LIMIT_OPTIONS.indexOf(currentLimit as any);
                const next = COMMENTS_LIMIT_OPTIONS[Math.min(COMMENTS_LIMIT_OPTIONS.length - 1, Math.max(0, idx) + 1)] ?? 500;
                if (limitEl) limitEl.value = String(next);
                persistCommentsPreference('limit', String(next));
                void loadComments({ reason: 'load_more', preserveExisting: true });
                return;
            }
            void loadMoreCommentsForScope(null);
        };
    }
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getSearchHighlightTerms(query: ReturnType<typeof parseCommentSearchQuery> | undefined): string[] {
    if (!query) return [];
    const terms: string[] = [];
    if (query.author) terms.push(query.author.toLowerCase());
    for (const term of query.terms) terms.push(term.toLowerCase());
    return dedupeIds(terms.filter(Boolean));
}

function highlightSearchTerms(container: HTMLElement, terms: string[]): void {
    if (terms.length === 0) return;
    const pattern = new RegExp(`(${terms.map(term => escapeRegExp(term)).join('|')})`, 'ig');
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
        if (!(node instanceof Text)) continue;
        if (!node.nodeValue || !node.nodeValue.trim()) continue;
        nodes.push(node);
    }

    for (const textNode of nodes) {
        const text = textNode.nodeValue || '';
        pattern.lastIndex = 0;
        if (!pattern.test(text)) continue;

        const frag = document.createDocumentFragment();
        let lastIndex = 0;
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) {
            const index = match.index;
            const matched = match[0] || '';
            if (index > lastIndex) frag.appendChild(document.createTextNode(text.slice(lastIndex, index)));
            const mark = document.createElement('mark');
            mark.className = 'comment-search-hit';
            mark.textContent = matched;
            frag.appendChild(mark);
            lastIndex = index + matched.length;
        }
        if (lastIndex < text.length) frag.appendChild(document.createTextNode(text.slice(lastIndex)));
        textNode.replaceWith(frag);
    }
}

function captureCommentsScrollAnchor(): { commentId: string; top: number } | null {
    const listEl = document.getElementById('comments-list') as HTMLElement | null;
    if (!listEl) return null;

    const comments = Array.from(listEl.querySelectorAll<HTMLElement>('.comment[data-comment-id]'));
    for (const el of comments) {
        const rect = el.getBoundingClientRect();
        // First element whose bottom is on-screen (partially visible counts).
        if (rect.bottom > 0) {
            const commentId = el.dataset.commentId;
            if (!commentId) return null;
            return { commentId, top: rect.top };
        }
    }
    return null;
}

function captureCommentFocus() {
    const active = document.activeElement as HTMLElement | null;
    if (!active) return;
    const commentEl = active.closest<HTMLElement>('.comment[data-comment-id]');
    if (!commentEl) return;
    pendingCommentFocusId = commentEl.dataset.commentId || null;
}

function restoreCommentFocus() {
    const commentId = pendingCommentFocusId;
    if (!commentId) return;
    pendingCommentFocusId = null;
    const listEl = document.getElementById('comments-list') as HTMLElement | null;
    if (!listEl) return;
    const toggle = listEl.querySelector<HTMLElement>(
        `.comment[data-comment-id="${CSS.escape(commentId)}"] .comment-toggle`
    );
    toggle?.focus();
}

function restoreCommentsScrollAnchor() {
    const anchor = pendingScrollAnchor;
    if (!anchor) return;
    pendingScrollAnchor = null;

    const listEl = document.getElementById('comments-list') as HTMLElement | null;
    if (!listEl) return;
    const el = listEl.querySelector<HTMLElement>(`.comment[data-comment-id="${CSS.escape(anchor.commentId)}"]`);
    if (!el) return;

    const nextTop = el.getBoundingClientRect().top;
    const delta = nextTop - anchor.top;
    if (!Number.isFinite(delta) || Math.abs(delta) < 1) return;
    window.scrollBy({ top: delta, left: 0, behavior: 'auto' });
}

async function init() {
    const hostEvents: ReturnType<typeof perf.event>[] = [perf.event('host:init_start')];
    const hash = window.location.hash.slice(1); // remove #
    const params = new URLSearchParams(hash);
    traceId = params.get('trace');
    isBenchmark = params.get('bench') === '1' || params.get('bench') === 'true';
    benchmarkAutoComments = params.get('autocomments') === '1' || params.get('autocomments') === 'true';
    const lim = params.get('limit');
    if (lim) {
        const parsed = Number.parseInt(lim, 10);
        if (Number.isFinite(parsed)) benchmarkLimitOverride = parsed;
    }
    const sort = params.get('sort');
    if (sort) benchmarkSortOverride = sort;
    setupBackToTopButton();

    // Initial check for 'preferencesInitialized' logic (handled in initPreferences safely now)


    // Check for Error Mode
    if (params.get('mode') === 'error' || params.has('error')) {
        const errorMsg = params.get('error') || 'Unknown error';
        const origUrl = params.get('url');
        renderErrorMode(errorMsg, origUrl);
        return;
    }

    const token = params.get('token');
    if (!token) {
        const pending = params.get('pending') === '1' || params.get('pending') === 'true';
        if (pending && traceId) {
            renderLoadingShell(params.get('sourceUrl'));
            await waitForPendingPayload(traceId, hostEvents);
            return;
        }
        renderErrorMode("No token provided");
        return;
    }

    await initTokenProtocol(token, hostEvents);
}

function renderLoadingShell(sourceUrl?: string | null) {
    const articleEl = document.getElementById('spike-article');
    if (!articleEl) return;
    initPreferences();
    document.body.classList.remove('post-nsfw', 'post-spoiler');
    articleEl.replaceChildren();

    const header = document.createElement('header');
    header.className = 'post-header';

    const h1 = document.createElement('h1');
    h1.textContent = 'Loading…';
    header.appendChild(h1);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const metaRow = document.createElement('div');
    metaRow.className = 'meta-row';
    const metaText = document.createElement('span');
    metaText.className = 'meta-text';
    let hostLabel: string | null = null;
    if (sourceUrl) {
        try {
            hostLabel = new URL(sourceUrl).hostname.replace(/^www\./, '');
        } catch {
            hostLabel = null;
        }
    }
    metaText.textContent = hostLabel || 'Fetching post';
    metaRow.appendChild(metaText);
    meta.appendChild(metaRow);
    header.appendChild(meta);

    const content = document.createElement('section');
    content.className = 'content';
    const p = document.createElement('p');
    p.className = 'notice-details';
    p.textContent = 'Preparing Reader View…';
    content.appendChild(p);

    articleEl.append(header, content);
}

async function waitForPendingPayload(expectedTraceId: string, hostEvents: ReturnType<typeof perf.event>[]) {
    if (!browser.runtime?.onMessage?.addListener) return;

    const waitSpan = perf.span('host:wait_payload');
    hostEvents.push(waitSpan.startEvent);

    let resolved = false;
    const pendingKey = `pending_token:${expectedTraceId}`;
    let onMsg: (msg: unknown) => void = () => undefined;

    const timeoutId = window.setTimeout(() => {
        void resolveError('timeout', 'Timed out waiting for article data. Please try again.');
    }, 12000);

    // Poll storage to avoid missing a one-shot runtime message.
    const intervalId = window.setInterval(() => void tryStorage(), 200);

    const cleanup = () => {
        window.clearTimeout(timeoutId);
        window.clearInterval(intervalId);
        browser.runtime.onMessage.removeListener(onMsg as any);
    };

    const extractPendingToken = (value: unknown): string | null => {
        if (typeof value === 'string') return value;
        if (value && typeof value === 'object') {
            const token = (value as any).token;
            if (typeof token === 'string' && token) return token;
        }
        return null;
    };

    const resolveWithToken = async (token: string, via: 'storage' | 'message') => {
        if (resolved) return;
        resolved = true;
        cleanup();
        hostEvents.push(waitSpan.end({ ok: true, via }));
        persistTokenInUrl(token, expectedTraceId);
        try { await browser.storage.session.remove(pendingKey); } catch { /* ignore */ }
        void initTokenProtocol(token, hostEvents);
    };

    const resolveError = async (reason: 'timeout' | 'error', message: string) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        hostEvents.push(waitSpan.end({ ok: false, reason }));
        try { await browser.storage.session.remove(pendingKey); } catch { /* ignore */ }
        renderErrorMode(message);
    };

    const tryStorage = async () => {
        try {
            const data = await browser.storage.session.get(pendingKey);
            const token = extractPendingToken(data?.[pendingKey]);
            if (!token) return;
            await resolveWithToken(token, 'storage');
        } catch {
            // ignore
        }
    };
    void tryStorage();

    onMsg = (msg: unknown) => {
        if (!msg || typeof msg !== 'object') return;
        const type = (msg as any).type;
        if (type === 'HOST_PAYLOAD_READY' && (msg as any).traceId === expectedTraceId) {
            const token = (msg as any).token as string | undefined;
            if (!token) return;
            void resolveWithToken(token, 'message');
            return;
        }
        if (type === 'HOST_PAYLOAD_ERROR' && (msg as any).traceId === expectedTraceId) {
            void resolveError('error', (msg as any).error || 'Failed to load article.');
        }
    };

    browser.runtime.onMessage.addListener(onMsg as any);
}

function persistTokenInUrl(token: string, trace: string) {
    try {
        const params = new URLSearchParams(window.location.hash.slice(1));
        params.delete('pending');
        params.set('token', token);
        params.set('trace', trace);
        history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${params.toString()}`);
    } catch {
        // ignore
    }
}

function getSourceUrlFromHash(): string | null {
    try {
        const params = new URLSearchParams(window.location.hash.slice(1));
        return params.get('sourceUrl');
    } catch {
        return null;
    }
}

async function attemptAutoRetry(sourceUrl: string, hostEvents: ReturnType<typeof perf.event>[]): Promise<boolean> {
    const parsed = parseHttpUrl(sourceUrl);
    if (!parsed) return false;

    const nextTrace = crypto.randomUUID();
    traceId = nextTrace;
    try {
        const params = new URLSearchParams(window.location.hash.slice(1));
        params.delete('token');
        params.set('pending', '1');
        params.set('trace', nextTrace);
        params.set('sourceUrl', parsed.toString());
        history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${params.toString()}`);
    } catch {
        // ignore
    }

    renderLoadingShell(parsed.toString());
    try {
        await browser.runtime.sendMessage({ type: 'HOST_PAYLOAD_REQUEST', traceId: nextTrace, url: parsed.toString() });
    } catch {
        renderErrorMode('Failed to reload article. Please try again from the original Reddit post.', parsed.toString());
        return true;
    }

    await waitForPendingPayload(nextTrace, hostEvents);
    return true;
}

async function initTokenProtocol(token: string, hostEvents: ReturnType<typeof perf.event>[]) {
    // 2. Retrieve Payload from Session Storage
    const getSpan = perf.span('host:session_get');
    const data = await browser.storage.session.get(token);
    hostEvents.push(getSpan.startEvent, getSpan.end());
    const payload = data[token] as RedditPostPayload | undefined;

    if (!payload) {
        const sourceUrl = getSourceUrlFromHash();
        if (sourceUrl && await attemptAutoRetry(sourceUrl, hostEvents)) return;
        renderErrorMode('Article data expired. Please reload from the original Reddit post.');
        return;
    }

    await touchSessionToken(token);

    // 3. Cleanup Storage logic - DISABLED to allow page refreshes
    // Was: await browser.storage.session.remove(token);
    // If we remove it, the user cannot refresh the page without losing content.


    // 4. Render Content
    const renderSpan = perf.span('host:render_article');
    renderArticle(payload);
    hostEvents.push(renderSpan.startEvent, renderSpan.end());
    initPreferences(); // Initialize Themes & Fonts
    initActions();
    applyBenchmarkOverrides();
    initCommentsUI();
    setupResponsiveSpacing();

    // 5. Signal Ready (Optional, for logging)
    try {
        hostEvents.push(perf.event('host:ready'));
        if (traceId) {
            const report: PerfReport = { traceId, scope: 'host', events: hostEvents };
            await browser.runtime.sendMessage({ type: 'PERF_REPORT', report });
        }
        await browser.runtime.sendMessage({ type: 'READER_CONTENT_READY', traceId });
    } catch { /* ignore */ }
}

function applyBenchmarkOverrides() {
    if (!isBenchmark) return;

    if (benchmarkLimitOverride !== null) {
        const limitEl = document.getElementById('comments-limit') as HTMLSelectElement | null;
        if (limitEl) {
            limitEl.value = String(coerceCommentsLimit(benchmarkLimitOverride));
        }
    }

    if (benchmarkSortOverride) {
        const sortEl = document.getElementById('comments-sort') as HTMLSelectElement | null;
        if (sortEl) sortEl.value = benchmarkSortOverride;
    }

    if (benchmarkAutoComments) {
        const toggleSwitch = document.getElementById('toggle-comments-switch') as HTMLInputElement | null;
        if (toggleSwitch) toggleSwitch.checked = true;
        commentsVisible = true;
        setCommentsVisibility(true);
    }
}

export function initPreferences() {
    // 1. Restore Saved State
    const savedTheme = localStorage.getItem('reader-theme') || 'light';
    const savedFont = localStorage.getItem('reader-font') || 'serif';
    const savedAlign = localStorage.getItem('reader-align') || 'left';
    const blurNsfw = (localStorage.getItem('reader-blur-nsfw') ?? 'true') === 'true';
    const blurSpoilers = (localStorage.getItem('reader-blur-spoilers') ?? 'true') === 'true';

    // Apply classes
    document.body.classList.add(`theme-${savedTheme}`);
    document.body.classList.add(`font-${savedFont}`);
    document.body.classList.add(`align-${savedAlign}`);
    document.body.classList.toggle('blur-nsfw', blurNsfw);
    document.body.classList.toggle('blur-spoilers', blurSpoilers);

    updateActiveControls(savedTheme, savedFont, savedAlign);

    const blurNsfwEl = document.getElementById('blur-nsfw-media') as HTMLInputElement | null;
    if (blurNsfwEl) blurNsfwEl.checked = blurNsfw;
    const blurSpoilersEl = document.getElementById('blur-spoilers') as HTMLInputElement | null;
    if (blurSpoilersEl) blurSpoilersEl.checked = blurSpoilers;

    // 2. Global Event Delegation (Toolbar + Drawer)
    // We bind to document.body to catch clicks in both the toolbar and the drawer (since drawer is a sibling)
    // Guard against double-binding
    if (document.body.dataset.rvrrEventsBound === '1') return;
    document.body.dataset.rvrrEventsBound = '1';

    document.body.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;

        // Handle Theme Click
        const themeBtn = target.closest('.theme-btn');
        if (themeBtn) {
            const theme = themeBtn.getAttribute('data-theme');
            if (theme) {
                document.body.classList.forEach(cls => {
                    if (cls.startsWith('theme-')) document.body.classList.remove(cls);
                });
                document.body.classList.add(`theme-${theme}`);
                localStorage.setItem('reader-theme', theme);
                updateActiveControls(theme, null, null);
            }
        }

        // Handle Font Click
        const fontBtn = target.closest('[data-font]');
        if (fontBtn) {
            const font = fontBtn.getAttribute('data-font');
            if (font) {
                document.body.classList.forEach(cls => {
                    if (cls.startsWith('font-')) document.body.classList.remove(cls);
                });
                document.body.classList.add(`font-${font}`);
                localStorage.setItem('reader-font', font!);
                updateActiveControls(null, font, null);
            }
        }

        // Handle Align Click (Works in Drawer now)
        const alignBtn = target.closest('[data-align]');
        if (alignBtn) {
            const align = alignBtn.getAttribute('data-align');
            if (align) {
                document.body.classList.forEach(cls => {
                    if (cls.startsWith('align-')) document.body.classList.remove(cls);
                });
                document.body.classList.add(`align-${align}`);
                localStorage.setItem('reader-align', align!);
                updateActiveControls(null, null, align);
            }
        }

        // Handle Open Mode Toggle Pill
        const openToggleOption = target.closest('#open-mode-toggle .toggle-option');
        if (openToggleOption) {
            const val = openToggleOption.getAttribute('data-value');
            if (val) {
                // Update UI
                const parent = openToggleOption.parentElement;
                parent?.querySelectorAll<HTMLElement>('.toggle-option').forEach(el => {
                    el.classList.remove('active');
                    if (el.getAttribute('role') === 'radio') {
                        el.setAttribute('aria-checked', 'false');
                        el.tabIndex = -1;
                    }
                });
                openToggleOption.classList.add('active');
                openToggleOption.setAttribute('aria-checked', 'true');
                (openToggleOption as HTMLElement).tabIndex = 0;

                // Trigger Change
                const select = document.getElementById('open-mode') as HTMLSelectElement;
                if (select) {
                    select.value = val;
                    select.dispatchEvent(new Event('change'));
                }
            }
        }
    });

    document.body.addEventListener('keydown', (e) => {
        const target = e.target as HTMLElement | null;
        if (!target) return;
        if (target.getAttribute('role') !== 'radio') return;

        const group = target.closest('[role="radiogroup"]');
        if (!group) return;

        const isPrev = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
        const isNext = e.key === 'ArrowRight' || e.key === 'ArrowDown';
        if (!isPrev && !isNext) return;

        const radios = Array.from(group.querySelectorAll<HTMLElement>('[role="radio"]'));
        const index = radios.indexOf(target);
        if (index < 0 || radios.length === 0) return;

        e.preventDefault();
        const nextIndex = (index + (isNext ? 1 : -1) + radios.length) % radios.length;
        radios[nextIndex]?.click();
        radios[nextIndex]?.focus();
    });

    blurNsfwEl?.addEventListener('change', () => {
        const enabled = blurNsfwEl.checked;
        document.body.classList.toggle('blur-nsfw', enabled);
        localStorage.setItem('reader-blur-nsfw', String(enabled));
    });

    blurSpoilersEl?.addEventListener('change', () => {
        const enabled = blurSpoilersEl.checked;
        document.body.classList.toggle('blur-spoilers', enabled);
        localStorage.setItem('reader-blur-spoilers', String(enabled));
    });
}

function slugifyFilename(value: string): string {
    const slug = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return slug || 'reddit-post';
}

function buildMarkdownFilename(post: RedditPostPayload, includeComments: boolean): string {
    const stem = slugifyFilename(post.title || 'reddit-post').slice(0, 60);
    const idPart = post.postId ? `-${post.postId}` : '';
    const suffix = includeComments ? '-comments' : '';
    return `${stem}${idPart}${suffix}.md`;
}

function downloadMarkdownFile(filename: string, text: string): void {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

export function initActions() {
    const copyPostBtn = document.getElementById('copy-post-md') as HTMLButtonElement | null;
    const copyPostCommentsBtn = document.getElementById('copy-post-comments-md') as HTMLButtonElement | null;
    const downloadPostBtn = document.getElementById('download-post-md') as HTMLButtonElement | null;
    const downloadPostCommentsBtn = document.getElementById('download-post-comments-md') as HTMLButtonElement | null;
    const openModeSelect = document.getElementById('open-mode') as HTMLSelectElement | null;

    // Drawer Logic
    const drawer = document.getElementById('settings-drawer');
    const toggleDrawerBtn = document.getElementById('toggle-drawer');
    const closeDrawerBtn = document.getElementById('close-drawer');
    const toolbar = document.getElementById('reader-toolbar');
    const main = document.querySelector('main');
    let lastDrawerOpener: Element | null = null;
    let drawerKeyListenerBound = false;

    const getFocusableInDrawer = () => {
        if (!drawer) return [] as HTMLElement[];
        const selector = [
            'button:not([disabled])',
            '[href]',
            'input:not([disabled])',
            'select:not([disabled])',
            'textarea:not([disabled])',
            '[tabindex]:not([tabindex="-1"])',
        ].join(',');
        return Array.from(drawer.querySelectorAll<HTMLElement>(selector)).filter(el => {
            const style = window.getComputedStyle(el);
            if (style.visibility === 'hidden' || style.display === 'none') return false;
            return true;
        });
    };

    function toggleDrawer(open: boolean) {
        if (!drawer) return;

        if (open) {
            lastDrawerOpener = document.activeElement;
            drawer.classList.add('open', 'is-open');
            drawer.setAttribute('aria-hidden', 'false');
            toggleDrawerBtn?.setAttribute('aria-expanded', 'true');
            toolbar?.setAttribute('aria-hidden', 'true');
            if (toolbar) (toolbar as any).inert = true;
            main?.setAttribute('aria-hidden', 'true');
            if (main) (main as any).inert = true;
            const focusables = getFocusableInDrawer();
            (focusables[0] ?? closeDrawerBtn ?? drawer).focus();

            if (!drawerKeyListenerBound) {
                drawerKeyListenerBound = true;
                document.addEventListener('keydown', (e) => {
                    if (!drawer.classList.contains('open')) return;

                    if (e.key === 'Escape') {
                        e.preventDefault();
                        toggleDrawer(false);
                        return;
                    }

                    if (e.key === 'Tab') {
                        const items = getFocusableInDrawer();
                        if (items.length === 0) {
                            e.preventDefault();
                            drawer.focus();
                            return;
                        }

                        const first = items[0];
                        const last = items[items.length - 1];
                        const active = document.activeElement as HTMLElement | null;

                        if (e.shiftKey && active === first) {
                            e.preventDefault();
                            last.focus();
                        } else if (!e.shiftKey && active === last) {
                            e.preventDefault();
                            first.focus();
                        }
                    }
                });
            }
        } else {
            drawer.classList.remove('open', 'is-open');
            drawer.setAttribute('aria-hidden', 'true');
            toggleDrawerBtn?.setAttribute('aria-expanded', 'false');
            toolbar?.removeAttribute('aria-hidden');
            if (toolbar) {
                (toolbar as any).inert = false;
                toolbar.removeAttribute('inert');
            }
            main?.removeAttribute('aria-hidden');
            if (main) {
                (main as any).inert = false;
                main.removeAttribute('inert');
            }
            if (lastDrawerOpener instanceof HTMLElement) lastDrawerOpener.focus();
            lastDrawerOpener = null;
        }
    }

    toggleDrawerBtn?.addEventListener('click', () => {
        const isOpen = !!drawer?.classList.contains('open');
        toggleDrawer(!isOpen);
    });
    closeDrawerBtn?.addEventListener('click', () => toggleDrawer(false));

    // Close Drawer when clicking outside
    document.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        if (drawer?.classList.contains('open') &&
            !drawer.contains(target) &&
            !toggleDrawerBtn?.contains(target)) {
            toggleDrawer(false);
        }
    });

    copyPostBtn?.addEventListener('click', async () => {
        if (!currentPost) return;
        setBusy(copyPostBtn, true);
        try {
            const markdown = buildPostMarkdown(currentPost);
            await copyToClipboard(markdown);
            showToast('Copied!', 'success');
        } catch (e) {
            console.warn('[Reader Host] Copy failed', e);
            showToast('Copy failed.', 'error');
        } finally {
            setBusy(copyPostBtn, false);
        }
    });

    copyPostCommentsBtn?.addEventListener('click', async () => {
        if (!currentPost) return;
        setBusy(copyPostCommentsBtn, true);
        try {
            const limit = getCommentsLimit();
            const markdown = buildPostAndCommentsMarkdown(currentPost, currentComments, limit);
            await copyToClipboard(markdown);
            showToast('Copied!', 'success');
        } catch (e) {
            console.warn('[Reader Host] Copy failed', e);
            showToast('Copy failed.', 'error');
        } finally {
            setBusy(copyPostCommentsBtn, false);
        }
    });

    downloadPostBtn?.addEventListener('click', async () => {
        if (!currentPost) return;
        setBusy(downloadPostBtn, true);
        try {
            const markdown = buildPostMarkdown(currentPost);
            const filename = buildMarkdownFilename(currentPost, false);
            downloadMarkdownFile(filename, markdown);
            showToast(`Downloaded ${filename}`, 'success');
        } catch (e) {
            console.warn('[Reader Host] Download failed', e);
            showToast('Download failed.', 'error');
        } finally {
            setBusy(downloadPostBtn, false);
        }
    });

    downloadPostCommentsBtn?.addEventListener('click', async () => {
        if (!currentPost) return;
        setBusy(downloadPostCommentsBtn, true);
        try {
            const limit = getCommentsLimit();
            const markdown = buildPostAndCommentsMarkdown(currentPost, currentComments, limit);
            const filename = buildMarkdownFilename(currentPost, true);
            downloadMarkdownFile(filename, markdown);
            showToast(`Downloaded ${filename}`, 'success');
        } catch (e) {
            console.warn('[Reader Host] Download failed', e);
            showToast('Download failed.', 'error');
        } finally {
            setBusy(downloadPostCommentsBtn, false);
        }
    });

    // Depth Slider Live Update
    const depthInput = document.getElementById('comments-depth') as HTMLInputElement;
    const depthVal = document.getElementById('depth-val');

    if (depthInput && depthVal) {
        depthVal.textContent = depthInput.value;
        depthInput.addEventListener('input', () => {
            depthVal.textContent = depthInput.value;
        });
    }

    // Open Mode Logic
    void (async () => {
        if (!openModeSelect) return;
        const data = await browser.storage.sync.get('openMode');
        const mode = data.openMode === 'new-tab' ? 'new-tab' : 'same-tab';

        // Sync Select
        openModeSelect.value = mode;

        // Sync Pill
        const pill = document.querySelector(`#open-mode-toggle .toggle-option[data-value="${mode}"]`);
        if (pill) {
            pill.parentElement?.querySelectorAll<HTMLElement>('.toggle-option').forEach(el => {
                el.classList.remove('active');
                if (el.getAttribute('role') === 'radio') {
                    el.setAttribute('aria-checked', 'false');
                    el.tabIndex = -1;
                }
            });
            pill.classList.add('active');
            pill.setAttribute('aria-checked', 'true');
            (pill as HTMLElement).tabIndex = 0;
        }

        openModeSelect.addEventListener('change', async () => {
            const value = openModeSelect.value === 'new-tab' ? 'new-tab' : 'same-tab';
            await browser.storage.sync.set({ openMode: value });
            showToast(value === 'new-tab' ? 'Will open in a new tab.' : 'Will open in the same tab.', 'info');
        });
    })();
}

function setBusy(el: HTMLButtonElement | null, busy: boolean) {
    if (!el) return;
    if (busy) {
        el.classList.add('is-busy');
        el.setAttribute('aria-busy', 'true');
        el.disabled = true;
    } else {
        el.classList.remove('is-busy');
        el.removeAttribute('aria-busy');
        el.disabled = false;
    }
}

function setupResponsiveSpacing() {
    const toolbar = document.getElementById('reader-toolbar');
    if (!toolbar) return;

    const mediaBottomBar = window.matchMedia('(max-width: 860px)');
    const update = () => {
        const rect = toolbar.getBoundingClientRect();
        if (mediaBottomBar.matches) {
            const bottom = Math.ceil(rect.height + 24);
            document.documentElement.style.setProperty('--toolbar-offset-top', '0px');
            document.documentElement.style.setProperty('--toolbar-offset-bottom', `${bottom}px`);
            return;
        }

        document.documentElement.style.setProperty('--toolbar-offset-top', '0px');
        document.documentElement.style.setProperty('--toolbar-offset-bottom', '0px');
    };

    update();

    const observer = new ResizeObserver(update);
    observer.observe(toolbar);
    window.addEventListener('resize', update, { passive: true });
    mediaBottomBar.addEventListener('change', update);
}

function setupBackToTopButton() {
    const btn = document.getElementById('back-to-top-btn') as HTMLButtonElement | null;
    if (!btn) return;

    backToTopCleanup?.();
    backToTopCleanup = null;

    const showAfterPx = 380;
    let rafId = 0;

    const updateVisibility = () => {
        rafId = 0;
        const visible = window.scrollY > showAfterPx;
        btn.classList.toggle('is-visible', visible);
        btn.setAttribute('aria-hidden', visible ? 'false' : 'true');
        btn.tabIndex = visible ? 0 : -1;
    };

    const requestVisibilityUpdate = () => {
        if (rafId !== 0) return;
        rafId = window.requestAnimationFrame(updateVisibility);
    };

    const onClick = () => {
        const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        window.scrollTo({
            top: 0,
            left: 0,
            behavior: reduceMotion ? 'auto' : 'smooth',
        });
    };

    btn.addEventListener('click', onClick);
    window.addEventListener('scroll', requestVisibilityUpdate, { passive: true });
    window.addEventListener('resize', requestVisibilityUpdate, { passive: true });
    requestVisibilityUpdate();

    backToTopCleanup = () => {
        btn.removeEventListener('click', onClick);
        window.removeEventListener('scroll', requestVisibilityUpdate);
        window.removeEventListener('resize', requestVisibilityUpdate);
        if (rafId !== 0) window.cancelAnimationFrame(rafId);
    };
}

export function initCommentsUI() {
    const toggleSwitch = document.getElementById('toggle-comments-switch') as HTMLInputElement | null;
    // Reload logic merged into config changes
    const depthEl = document.getElementById('comments-depth') as HTMLInputElement | null;
    const smartModeEl = document.getElementById('comments-smart-mode') as HTMLInputElement | null;
    const limitEl = document.getElementById('comments-limit') as HTMLSelectElement | null;
    const sortEl = document.getElementById('comments-sort') as HTMLSelectElement | null;
    const searchEl = document.getElementById('comments-search') as HTMLInputElement | null;
    const expandAllBtn = document.getElementById('comments-expand-all') as HTMLButtonElement | null;
    const collapseAllBtn = document.getElementById('comments-collapse-all') as HTMLButtonElement | null;
    const resetViewBtn = document.getElementById('comments-reset-view') as HTMLButtonElement | null;
    const depthVal = document.getElementById('depth-val') as HTMLElement | null;

    if (!isBenchmark) {
        const storedVisible = readLocalStorageValue(COMMENTS_PREF_KEYS.visible);
        if (toggleSwitch && (storedVisible === 'true' || storedVisible === 'false')) {
            toggleSwitch.checked = storedVisible === 'true';
        }

        const storedDepth = readLocalStorageValue(COMMENTS_PREF_KEYS.depth);
        if (depthEl && storedDepth !== null) {
            const parsedDepth = Number.parseInt(storedDepth, 10);
            if (Number.isFinite(parsedDepth)) {
                depthEl.value = String(Math.min(5, Math.max(0, parsedDepth)));
            }
        }

        const storedSmartMode = readLocalStorageValue(COMMENTS_PREF_KEYS.smartMode);
        if (smartModeEl && (storedSmartMode === 'true' || storedSmartMode === 'false')) {
            smartModeEl.checked = storedSmartMode === 'true';
        }

        const storedLimit = readLocalStorageValue(COMMENTS_PREF_KEYS.limit);
        if (limitEl && storedLimit !== null) {
            const parsedLimit = Number.parseInt(storedLimit, 10);
            if (Number.isFinite(parsedLimit)) {
                limitEl.value = String(coerceCommentsLimit(parsedLimit));
            }
        }

        const storedSort = readLocalStorageValue(COMMENTS_PREF_KEYS.sort);
        if (sortEl && storedSort && COMMENTS_SORT_OPTIONS.has(storedSort)) {
            sortEl.value = storedSort;
        }
    }

    if (depthEl && depthVal) {
        depthVal.textContent = depthEl.value;
    }

    toggleSwitch?.addEventListener('change', () => {
        commentsVisible = toggleSwitch.checked;
        persistCommentsPreference('visible', String(commentsVisible));
        setCommentsVisibility(commentsVisible);
        if (!commentsVisible) {
            commentsAbort?.abort();
            commentsAbort = null;
            commentsLoadSeq += 1;
            commentsDeepLoadSeq += 1;
            activeDeepLoadParentId = null;
            return;
        }
        if (currentComments.length === 0) void loadComments({ reason: 'init' });
    });

    const onFetchConfigChange = () => {
        if (limitEl) persistCommentsPreference('limit', limitEl.value);
        if (sortEl && COMMENTS_SORT_OPTIONS.has(sortEl.value)) {
            persistCommentsPreference('sort', sortEl.value);
        }
        if (!commentsVisible) return;
        commentsDeepLoadSeq += 1;
        activeDeepLoadParentId = null;
        void loadComments({ reason: 'filter', preserveExisting: true });
    };

    const onViewConfigChange = () => {
        if (depthEl) persistCommentsPreference('depth', depthEl.value);
        if (smartModeEl) persistCommentsPreference('smartMode', String(smartModeEl.checked));
        if (!commentsVisible) return;
        rerenderComments();
    };

    limitEl?.addEventListener('change', onFetchConfigChange);
    sortEl?.addEventListener('change', onFetchConfigChange);
    depthEl?.addEventListener('change', onViewConfigChange);
    smartModeEl?.addEventListener('change', onViewConfigChange);
    searchEl?.addEventListener('input', () => {
        if (!commentsVisible) return;
        rerenderComments();
    });

    const bindBulkAction = (button: HTMLButtonElement | null, action: CommentsBulkAction) => {
        button?.addEventListener('click', () => {
            applyCommentsBulkAction(action, currentComments);
            if (!commentsVisible) return;
            rerenderComments();
        });
    };
    bindBulkAction(expandAllBtn, 'expand_all');
    bindBulkAction(collapseAllBtn, 'collapse_all');
    bindBulkAction(resetViewBtn, 'reset_view');

    // Initialize state
    if (toggleSwitch) {
        commentsVisible = toggleSwitch.checked;
        setCommentsVisibility(commentsVisible);
        if (commentsVisible) void loadComments({ reason: 'init' });
    }
}

export function updateActiveControls(activeTheme: string | null, activeFont: string | null, activeAlign: string | null) {
    const updateActive = (selector: string, attribute: string, activeValue: string) => {
        document.querySelectorAll<HTMLElement>(selector).forEach(btn => {
            const isActive = btn.getAttribute(attribute) === activeValue;
            btn.classList.toggle('active', isActive);
            if (btn.getAttribute('role') === 'radio') {
                btn.setAttribute('aria-checked', isActive ? 'true' : 'false');
                btn.tabIndex = isActive ? 0 : -1;
            }
        });
    };

    if (activeTheme) {
        updateActive('.theme-btn', 'data-theme', activeTheme);
    }

    if (activeFont) {
        updateActive('.font-btn', 'data-font', activeFont);
    }

    if (activeAlign) {
        updateActive('.align-btn', 'data-align', activeAlign);
    }
}

function renderErrorMode(msg: string, url?: string | null) {
    const articleEl = document.getElementById('spike-article');
    if (!articleEl) return;

    // Wire up theme even in error mode
    initPreferences();
    document.body.classList.remove('post-nsfw', 'post-spoiler');

    articleEl.replaceChildren();

    const header = document.createElement('header');
    header.className = 'error-header';

    const title = document.createElement('h1');
    title.className = 'error-title';
    title.textContent = 'Reader View Unavailable';
    header.appendChild(title);

    const section = document.createElement('section');
    section.className = 'content';

    const intro = document.createElement('p');
    intro.className = 'error-intro';
    intro.textContent = "We couldn't extract the content from this page.";
    section.appendChild(intro);

    const errorBox = document.createElement('div');
    errorBox.className = 'error-box';
    errorBox.textContent = msg;
    section.appendChild(errorBox);

    const parsedUrl = url ? parseHttpUrl(url) : null;
    if (parsedUrl) {
        const actions = document.createElement('div');
        actions.className = 'error-actions';

        const link = document.createElement('a');
        link.href = parsedUrl.toString();
        link.className = 'error-open-link';
        link.textContent = 'Open Original Post';

        actions.appendChild(link);
        section.appendChild(actions);
    }

    articleEl.append(header, section);

    document.title = "Error - Reader Helper";
}


export function renderArticle(post: RedditPostPayload) {
    const articleEl = document.getElementById('spike-article');
    if (!articleEl) return;

    currentPost = post;
    resetCommentsGraphState();
    commentsAbort?.abort();
    commentsAbort = null;
    commentsLoadSeq += 1;
    document.body.classList.toggle('post-nsfw', Boolean(post.nsfw));
    document.body.classList.toggle('post-spoiler', Boolean(post.spoiler));

    articleEl.replaceChildren();

    const header = document.createElement('header');

    const title = document.createElement('h1');
    title.textContent = post.title;
    header.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const metaRow = document.createElement('div');
    metaRow.className = 'meta-row';

    const metaText = document.createElement('span');
    metaText.className = 'meta-text';
    const scoreText = typeof post.score === 'number' ? ` • ${post.score} points` : '';
    metaText.textContent = `${post.subreddit} • u/${post.author}${scoreText}`;
    metaRow.appendChild(metaText);

    if (post.isFallback) {
        const fallbackBadge = document.createElement('span');
        fallbackBadge.className = 'meta-pill fallback-badge';
        fallbackBadge.textContent = 'Extracted via Fallback';
        metaRow.appendChild(fallbackBadge);
    }

    if (post.nsfw) {
        const nsfwBadge = document.createElement('span');
        nsfwBadge.className = 'meta-pill nsfw-badge';
        nsfwBadge.textContent = 'NSFW';
        metaRow.appendChild(nsfwBadge);
    }

    if (post.spoiler) {
        const spoilerBadge = document.createElement('span');
        spoilerBadge.className = 'meta-pill spoiler-badge';
        spoilerBadge.textContent = 'Spoiler';
        metaRow.appendChild(spoilerBadge);
    }

    const parsedOriginalUrl = parseHttpUrl(post.url);
    if (parsedOriginalUrl) {
        const originalLink = document.createElement('a');
        originalLink.href = parsedOriginalUrl.toString();
        originalLink.target = '_blank';
        originalLink.rel = 'noopener noreferrer';
        originalLink.className = 'meta-pill original-link';
        originalLink.textContent = 'View on Reddit';
        originalLink.title = 'View Original Discussion on Reddit';
        originalLink.setAttribute('aria-label', 'View original discussion on Reddit');
        metaRow.appendChild(originalLink);
    }

    meta.appendChild(metaRow);
    header.appendChild(meta);

    const content = document.createElement('section');
    content.className = 'content';

    const mediaEl = renderMedia(post);
    if (mediaEl) content.appendChild(mediaEl);
    const permalinkUrl = getPostPermalinkUrl(post);

    const bodyFragment = sanitizeHtmlToFragment(post.bodyHtml || '');
    const hasBody = bodyFragment.childNodes.length > 0;

    if (hasBody) {
        const bodyWrapper = document.createElement('div');
        bodyWrapper.className = 'post-body-wrapper';

        const body = document.createElement('div');
        body.className = 'post-body';
        body.appendChild(bodyFragment);

        if (post.media?.type === 'image' || post.media?.type === 'gallery') {
            // Avoid showing the post image twice (as media + in the body).
            body.querySelectorAll('img').forEach(el => el.remove());
            const mediaUrl = parseHttpUrl(post.media.url)?.toString();
            const thumbUrl = post.media.thumbnailUrl ? parseHttpUrl(post.media.thumbnailUrl)?.toString() : null;
            body.querySelectorAll('a[href]').forEach(el => {
                const href = (el as HTMLAnchorElement).getAttribute('href');
                if (!href) return;
                if (mediaUrl && href === mediaUrl) el.remove();
                else if (thumbUrl && href === thumbUrl) el.remove();
            });
        }

        if (post.spoiler) {
            const revealBtn = document.createElement('button');
            revealBtn.type = 'button';
            revealBtn.className = 'spoiler-reveal-btn';
            revealBtn.textContent = 'View spoiler';
            revealBtn.setAttribute('aria-pressed', 'false');
            revealBtn.setAttribute('aria-label', 'View spoiler');
            revealBtn.addEventListener('click', () => {
                body.classList.add('spoiler-revealed');
                bodyWrapper.classList.add('spoiler-revealed');
                revealBtn.remove();
            });
            bodyWrapper.append(body, revealBtn);
        } else {
            bodyWrapper.append(body);
        }

        content.appendChild(bodyWrapper);
        scheduleEnhance(body, { openUrl: permalinkUrl || undefined });
    } else {
        const notice = document.createElement('div');
        notice.className = 'notice-box';

        const heading = document.createElement('strong');
        heading.textContent = 'Unsupported post content.';

        const details = document.createElement('div');
        details.className = 'notice-details';
        details.textContent = 'This post has no text body to display in Reader View. Comments are shown below.';

        notice.append(heading, details);

        if (post.linkUrl) {
            const parsedLinkUrl = parseHttpUrl(post.linkUrl);
            const extra = document.createElement('div');
            extra.className = 'notice-extra';

            const label = document.createElement('span');
            label.className = 'notice-label';
            label.textContent = 'External link: ';

            if (parsedLinkUrl) {
                const a = document.createElement('a');
                a.href = parsedLinkUrl.toString();
                a.rel = 'noopener noreferrer';
                a.target = '_blank';
                a.textContent = parsedLinkUrl.hostname.replace(/^www\./, '');
                extra.append(label, a);
            } else {
                const code = document.createElement('code');
                code.textContent = post.linkUrl;
                extra.append(label, code);
            }
            notice.appendChild(extra);
        }

        content.appendChild(notice);
    }

    articleEl.append(header, content);

    // Update document title for history/tab
    document.title = post.title;
}

function scheduleEnhance(container: HTMLElement, options?: { openUrl?: string }) {
    const run = () => {
        try {
            enhanceInlineMedia(container, options);
            enhanceInlineImages(container, options);
            enhanceSpoilers(container);
        } catch {
            // ignore enhancement failures
        }
    };

    // Let the initial paint happen first.
    const ric = (window as any).requestIdleCallback as undefined | ((cb: () => void, opts?: { timeout?: number }) => void);
    if (typeof ric === 'function') {
        ric(run, { timeout: 1200 });
        return;
    }
    window.setTimeout(run, 0);
}

function enhanceSpoilers(container: HTMLElement) {
    const spoilers = Array.from(container.querySelectorAll<HTMLElement>('span.md-spoiler-text'));
    for (const spoiler of spoilers) {
        if (spoiler.dataset.rvrrSpoiler === '1') continue;
        spoiler.dataset.rvrrSpoiler = '1';
        spoiler.setAttribute('role', 'button');
        spoiler.setAttribute('tabindex', '0');
        spoiler.setAttribute('aria-pressed', 'false');
        spoiler.setAttribute('aria-label', 'Reveal spoiler');
        const toggle = () => {
            const revealed = spoiler.classList.toggle('spoiler-revealed');
            spoiler.setAttribute('aria-pressed', revealed ? 'true' : 'false');
            spoiler.setAttribute('aria-label', revealed ? 'Hide spoiler' : 'Reveal spoiler');
        };
        spoiler.addEventListener('click', (e) => {
            e.preventDefault();
            toggle();
        });
        spoiler.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            toggle();
        });
    }
}

function normalizeThreadPermalinkPath(pathname: string): string {
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length === 0) return '/';

    let commentsIndex = -1;
    if (segments[0]?.toLowerCase() === 'r' && segments[2]?.toLowerCase() === 'comments') {
        commentsIndex = 2;
    } else if (segments[0]?.toLowerCase() === 'comments') {
        commentsIndex = 0;
    }

    if (commentsIndex >= 0 && segments[commentsIndex + 1]) {
        // Keep thread path only: .../comments/<postId>/<slug?>/
        const parts = segments.slice(0, commentsIndex + 2);
        const slug = segments[commentsIndex + 2];
        if (slug) parts.push(slug);
        return `/${parts.join('/')}/`;
    }

    return pathname.endsWith('/') ? pathname : `${pathname}/`;
}

function getPostPermalinkPath(post: RedditPostPayload): string | null {
    if (post.permalink) {
        const path = post.permalink.startsWith('/') ? post.permalink : `/${post.permalink}`;
        return normalizeThreadPermalinkPath(path);
    }

    const parsed = parseHttpUrl(post.url);
    if (!parsed) return null;
    if (!/\/comments\/[^/]+/i.test(parsed.pathname)) return null;
    return normalizeThreadPermalinkPath(parsed.pathname);
}

function derivePostIdFromPath(pathname: string): string | null {
    const match = pathname.match(/\/comments\/([^/?#]+)/i);
    if (!match) return null;
    const id = match[1]?.trim();
    return id || null;
}

function getPostPermalinkUrl(post: RedditPostPayload): string | null {
    const path = getPostPermalinkPath(post);
    if (path) return `https://www.reddit.com${path}`;
    const parsed = parseHttpUrl(post.url);
    return parsed ? parsed.toString() : null;
}

function getCommentPermalinkUrl(commentId: string): string | null {
    if (!currentPost || !commentId) return null;

    const path = getPostPermalinkPath(currentPost);
    if (path) return `https://www.reddit.com${path}${encodeURIComponent(commentId)}/`;

    const parsed = parseHttpUrl(currentPost.url);
    const postId = currentPost.postId || (parsed ? derivePostIdFromPath(parsed.pathname) : null);
    if (!postId) return null;
    return `https://www.reddit.com/comments/${encodeURIComponent(postId)}/_/${encodeURIComponent(commentId)}/`;
}

function formatCommentRelativeTime(createdUtc: number | undefined): { label: string; title: string } | null {
    if (typeof createdUtc !== 'number' || !Number.isFinite(createdUtc)) return null;
    const createdMs = createdUtc * 1000;
    if (!Number.isFinite(createdMs)) return null;
    const createdDate = new Date(createdMs);
    if (Number.isNaN(createdDate.valueOf())) return null;

    const deltaSec = Math.round((createdMs - Date.now()) / 1000);
    const abs = Math.abs(deltaSec);

    let unit: Intl.RelativeTimeFormatUnit = 'second';
    let value = deltaSec;
    if (abs >= 60 * 60 * 24 * 365) {
        unit = 'year';
        value = Math.round(deltaSec / (60 * 60 * 24 * 365));
    } else if (abs >= 60 * 60 * 24 * 30) {
        unit = 'month';
        value = Math.round(deltaSec / (60 * 60 * 24 * 30));
    } else if (abs >= 60 * 60 * 24) {
        unit = 'day';
        value = Math.round(deltaSec / (60 * 60 * 24));
    } else if (abs >= 60 * 60) {
        unit = 'hour';
        value = Math.round(deltaSec / (60 * 60));
    } else if (abs >= 60) {
        unit = 'minute';
        value = Math.round(deltaSec / 60);
    }

    const title = createdDate.toLocaleString();
    if (typeof Intl === 'undefined' || typeof Intl.RelativeTimeFormat !== 'function') {
        return { label: title, title };
    }

    const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    return {
        label: formatter.format(value, unit),
        title,
    };
}

export function renderMedia(post: RedditPostPayload): HTMLElement | null {
    if (!post.media) return null;

    const wrapper = document.createElement('div');
    wrapper.className = 'media-wrapper';

    const heading = document.createElement('div');
    heading.className = 'media-heading';

    if (post.media.type === 'gallery') {
        const count = post.media.galleryCount ? ` (${post.media.galleryCount})` : '';
        heading.textContent = `Gallery${count}`;
    } else if (post.media.type === 'video') {
        heading.textContent = 'Video';
    } else {
        heading.textContent = 'Image';
    }

    wrapper.appendChild(heading);

    const link = document.createElement('a');
    const parsed = parseHttpUrl(post.media.url);
    if (!parsed) return null;
    const openOnReddit = post.media.type === 'gallery' || post.media.type === 'video';
    const permalinkUrl = openOnReddit ? getPostPermalinkUrl(post) : null;
    link.href = permalinkUrl || parsed.toString();
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'media-link-wrapper';

    if (post.media.type === 'image' || post.media.type === 'gallery') {
        const thumb = post.media.thumbnailUrl ? parseHttpUrl(post.media.thumbnailUrl) : null;
        const imgUrl = thumb || parsed;
        const img = document.createElement('img');
        img.className = 'thumb-img media-thumb-img';
        img.src = imgUrl.toString();
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        link.appendChild(img);
        wrapper.append(link);
        if (openOnReddit) {
            const caption = document.createElement('div');
            caption.className = 'media-caption';
            caption.textContent = 'View on Reddit';
            wrapper.append(caption);
        }
        return wrapper;
    }

    link.textContent = openOnReddit ? 'View on Reddit' : parsed.hostname.replace(/^www\./, '');
    link.classList.add('media-link');
    wrapper.append(link);
    return wrapper;
}

function parseHttpUrl(value: string): URL | null {
    try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        return url;
    } catch {
        return null;
    }
}

type CommentsLoadReason = 'init' | 'filter' | 'retry' | 'load_more';

type LoadCommentsOptions = {
    preserveExisting?: boolean;
    reason?: CommentsLoadReason;
};

async function loadComments(options: LoadCommentsOptions = {}) {
    const localTrace = traceId ?? crypto.randomUUID();
    const events: ReturnType<typeof perf.event>[] = [perf.event('comments:load_start')];
    const commentsSection = document.getElementById('comments') as HTMLElement | null;
    const statusEl = document.getElementById('comments-status') as HTMLElement | null;
    const listEl = document.getElementById('comments-list') as HTMLElement | null;
    const limitEl = document.getElementById('comments-limit') as HTMLSelectElement | null;
    const sortEl = document.getElementById('comments-sort') as HTMLSelectElement | null;

    if (!commentsSection || !statusEl || !listEl) return;
    if (!commentsVisible) return;

    const reason = options.reason ?? 'init';
    const preserveExisting = typeof options.preserveExisting === 'boolean'
        ? options.preserveExisting
        : reason === 'retry' || reason === 'load_more';

    if (!currentPost?.permalink) {
        commentsSection.hidden = false;
        setCommentsStatus(statusEl, 'info', currentPost?.isFallback
            ? 'Comments are unavailable (fallback extraction was used).'
            : 'Comments are unavailable for this post.');
        listEl.replaceChildren();
        commentsRenderer?.invalidate();
        resetCommentsGraphState();
        updateCommentsFooter({ hasMore: currentCommentsHasMore, limit: getCommentsLimit(), loading: false, permalink: currentPost?.permalink });
        deepLoadState = { loaded: false, scope: 'none', truncated: false };
        return;
    }

    const limit = getCommentsLimit();
    const sort = getCommentsSort();

    const requestSeq = ++commentsLoadSeq;
    commentsAbort?.abort();
    const abortController = new AbortController();
    commentsAbort = abortController;

    if (!commentsVisible) return;
    commentsSection.hidden = false;
    hasActiveSearchStatus = false;
    setCommentsStatus(statusEl, 'loading', 'Loading comments…');
    if (limitEl) limitEl.disabled = true;
    if (sortEl) sortEl.disabled = true;
    if (!preserveExisting) {
        listEl.replaceChildren();
        commentsRenderer?.invalidate();
    }
    updateCommentsFooter({
        hasMore: preserveExisting ? currentCommentsHasMore : false,
        limit,
        loading: preserveExisting,
        permalink: currentPost?.permalink
    });

    let aborted = false;

    try {
        const cacheKey = normalizeCommentsCacheKey(currentPost.permalink, sort, limit);
        const cacheSpan = perf.span('comments:cache', { key: cacheKey });
        events.push(cacheSpan.startEvent);
        try {
            const res = await browser.runtime.sendMessage({ type: 'COMMENTS_CACHE_GET', key: cacheKey });
            const hit = Boolean(res && typeof res === 'object' && (res as any).hit);
            const value = hit ? (res as any).value : null;
            events.push(cacheSpan.end({ hit }));

            if (hit && value && typeof value === 'object') {
                const cachedComments = (value as any).comments as CommentNode[] | undefined;
                const loadedCount = Number((value as any).loadedCount);
                const hasMore = Boolean((value as any).hasMore);
                const hasMoreMarker = typeof (value as any).hasMoreMarker === 'boolean'
                    ? Boolean((value as any).hasMoreMarker)
                    : hasMore;
                const rootMoreChildrenIds = dedupeIds(parseMoreChildrenIds((value as any).rootMoreChildrenIds));
                const totalCount = typeof (value as any).totalCount === 'number' ? (value as any).totalCount : undefined;

                if (Array.isArray(cachedComments) && requestSeq === commentsLoadSeq && commentsVisible) {
                    rebuildCommentsGraphFromRoots(cachedComments, {
                        hasMoreMarker,
                        rootMoreChildrenIds,
                    });
                    expandedMoreById.clear();
                    expandedLowScoreById.clear();
                    collapsedById.clear();
                    autoModeratorExpandedById.clear();
                    deepLoadState = { loaded: false, scope: 'none', truncated: false };
                    activeDeepLoadParentId = null;
                    refreshCommentsHasMore();

                    setCommentsStatus(
                        statusEl,
                        'success',
                        formatCommentsLoadedMessage(
                            Number.isFinite(loadedCount) ? loadedCount : cachedComments.length,
                            totalCount,
                        ),
                    );
                    const renderSpan = perf.span('comments:render');
                    rerenderComments();
                    events.push(renderSpan.startEvent, renderSpan.end({ cached: true }));
                    restoreCommentsScrollAnchor();
                    updateCommentsFooter({ hasMore: currentCommentsHasMore, limit, loading: false, permalink: currentPost?.permalink });
                    return;
                }
            }
        } catch {
            events.push(cacheSpan.end({ hit: false, error: true }));
        }

        const url = buildCommentsJsonUrl(currentPost.permalink, { limit, sort });
        const fetchSpan = perf.span('comments:fetch', { url: url.toString(), limit, sort });
        const response = await fetch(url.toString(), { credentials: 'include', signal: abortController.signal });
        events.push(fetchSpan.startEvent, fetchSpan.end({ ok: response.ok, status: response.status }));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const parseSpan = perf.span('comments:parse');
        const data = await response.json();
        const totalCount = typeof data?.[0]?.data?.children?.[0]?.data?.num_comments === 'number'
            ? (data[0].data.children[0].data.num_comments as number)
            : undefined;
        const commentsListing = data?.[1]?.data?.children;

        const parsed = parseCommentsListing(commentsListing);
        events.push(parseSpan.startEvent, parseSpan.end({
            loadedCount: parsed.loadedCount,
            hasMore: parsed.hasMore,
            rootMoreChildren: parsed.rootMoreChildrenIds.length,
            totalCount
        }));
        if (requestSeq !== commentsLoadSeq || !commentsVisible) return;
        rebuildCommentsGraphFromRoots(parsed.comments, {
            hasMoreMarker: parsed.hasMore,
            rootMoreChildrenIds: parsed.rootMoreChildrenIds,
        });
        expandedMoreById.clear();
        expandedLowScoreById.clear();
        collapsedById.clear();
        autoModeratorExpandedById.clear();
        deepLoadState = { loaded: false, scope: 'none', truncated: false };
        activeDeepLoadParentId = null;
        refreshCommentsHasMore();

        setCommentsStatus(
            statusEl,
            'success',
            formatCommentsLoadedMessage(parsed.loadedCount, totalCount),
        );
        const cacheSetSpan = perf.span('comments:cache_set', { key: cacheKey });
        events.push(cacheSetSpan.startEvent);
        try {
            const res = await browser.runtime.sendMessage({
                type: 'COMMENTS_CACHE_SET',
                key: cacheKey,
                value: {
                    comments: currentComments,
                    loadedCount: parsed.loadedCount,
                    hasMore: currentHasMoreMarker,
                    hasMoreMarker: currentHasMoreMarker,
                    rootMoreChildrenIds: currentRootMoreChildrenIds,
                    totalCount
                },
            });
            if (res && typeof res === 'object') {
                events.push(cacheSetSpan.end(res as any));
            } else {
                events.push(cacheSetSpan.end({ ok: false, reason: 'no_response' }));
            }
        } catch {
            events.push(cacheSetSpan.end({ ok: false, reason: 'send_failed' }));
        }
        updateCommentsFooter({ hasMore: currentCommentsHasMore, limit, loading: false, permalink: currentPost?.permalink });
        const renderSpan = perf.span('comments:render');
        rerenderComments();
        events.push(renderSpan.startEvent, renderSpan.end());
        restoreCommentsScrollAnchor();
    } catch (err) {
        if ((err as any)?.name === 'AbortError') {
            aborted = true;
            return;
        }
        console.error('[Reader Host] Failed to load comments', err);
        if (requestSeq !== commentsLoadSeq || !commentsVisible) return;
        setCommentsStatus(statusEl, 'error', 'Failed to load comments.', {
            actions: [
                {
                    label: 'Retry',
                    onClick: () => void loadComments({ reason: 'retry', preserveExisting: true }),
                }
            ],
        });
        if (!preserveExisting) {
            listEl.replaceChildren();
            commentsRenderer?.invalidate();
            resetCommentsGraphState();
            deepLoadState = { loaded: false, scope: 'none', truncated: false };
            activeDeepLoadParentId = null;
        }
        updateCommentsFooter({ hasMore: currentCommentsHasMore, limit, loading: false, permalink: currentPost?.permalink });
    } finally {
        if (requestSeq === commentsLoadSeq) {
            if (limitEl) limitEl.disabled = false;
            if (sortEl) sortEl.disabled = false;
            commentsAbort = null;
        }

        events.push(perf.event('comments:load_end'));
        if (!aborted && localTrace) {
            const report: PerfReport = { traceId: localTrace, scope: 'comments', events };
            try {
                await browser.runtime.sendMessage({ type: 'PERF_REPORT', report });
            } catch {
                // ignore
            }
        }
    }
}

type StatusVariant = 'info' | 'success' | 'loading' | 'error';

function setCommentsStatus(
    container: HTMLElement,
    variant: StatusVariant,
    message: string,
    options?: { actions?: Array<{ label: string; onClick: () => void }> },
) {
    container.replaceChildren();

    const status = document.createElement('div');
    status.className = `status${variant === 'info' ? '' : ` status--${variant}`}`;

    if (variant === 'loading') {
        const icon = document.createElement('span');
        icon.className = 'status__icon';
        icon.setAttribute('aria-hidden', 'true');
        status.appendChild(icon);
    }

    const msg = document.createElement('div');
    msg.className = 'status__message';
    msg.textContent = message;
    status.appendChild(msg);

    if (options?.actions && options.actions.length > 0) {
        const actions = document.createElement('div');
        actions.className = 'status__actions';

        for (const action of options.actions) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn btn--outline btn--sm';
            btn.textContent = action.label;
            btn.addEventListener('click', action.onClick);
            actions.appendChild(btn);
        }

        status.appendChild(actions);
    }

    container.appendChild(status);
}

function setCommentsVisibility(visible: boolean) {
    const section = document.getElementById('comments') as HTMLElement | null;
    if (!section) return;
    section.hidden = !visible;
}

function getCommentsDepth(): number {
    const depthEl = document.getElementById('comments-depth') as HTMLInputElement | null;
    const parsed = Number.parseInt(depthEl?.value ?? '1', 10);
    if (!Number.isFinite(parsed)) return 1;
    return Math.min(5, Math.max(0, parsed));
}

function getSmartCommentsMode(): boolean {
    const el = document.getElementById('comments-smart-mode') as HTMLInputElement | null;
    return el?.checked ?? true;
}

function getCommentsLimit(): number {
    const limitEl = document.getElementById('comments-limit') as HTMLSelectElement | null;
    const parsed = Number.parseInt(limitEl?.value ?? '100', 10);
    return coerceCommentsLimit(parsed);
}

function getCommentsSort(): string {
    const sortEl = document.getElementById('comments-sort') as HTMLSelectElement | null;
    return sortEl?.value || 'best';
}

function getCommentsSearchQuery(): string {
    const searchEl = document.getElementById('comments-search') as HTMLInputElement | null;
    return (searchEl?.value || '').trim();
}

function collectCommentIds(comments: CommentNode[]): {
    allIds: Set<string>;
    expandableIds: Set<string>;
    autoModeratorIds: Set<string>;
} {
    const allIds = new Set<string>();
    const expandableIds = new Set<string>();
    const autoModeratorIds = new Set<string>();

    const walk = (node: CommentNode) => {
        allIds.add(node.id);
        if (node.replies.length > 0) expandableIds.add(node.id);
        if (node.author.trim().toLowerCase() === 'automoderator') autoModeratorIds.add(node.id);
        for (const reply of node.replies) walk(reply);
    };

    for (const comment of comments) walk(comment);
    return { allIds, expandableIds, autoModeratorIds };
}

function applyCommentsBulkAction(action: CommentsBulkAction, comments: CommentNode[]): void {
    if (action === 'reset_view') {
        collapsedById.clear();
        expandedMoreById.clear();
        expandedLowScoreById.clear();
        autoModeratorExpandedById.clear();
        return;
    }

    const ids = collectCommentIds(comments);
    if (action === 'collapse_all') {
        collapsedById.clear();
        for (const id of ids.allIds) collapsedById.add(id);
        expandedMoreById.clear();
        expandedLowScoreById.clear();
        autoModeratorExpandedById.clear();
        return;
    }

    collapsedById.clear();
    expandedMoreById.clear();
    expandedLowScoreById.clear();
    autoModeratorExpandedById.clear();
    for (const id of ids.allIds) expandedLowScoreById.add(id);
    for (const id of ids.expandableIds) expandedMoreById.add(id);
    for (const id of ids.autoModeratorIds) autoModeratorExpandedById.add(id);
}

function buildCommentsJsonUrl(
    permalink: string,
    options: { limit: number; sort: string },
): URL {
    const base = new URL('https://www.reddit.com');
    const path = permalink.startsWith('/') ? permalink : `/${permalink}`;
    const jsonUrl = new URL(`${path.replace(/\/$/, '')}.json`, base);

    jsonUrl.searchParams.set('raw_json', '1');
    jsonUrl.searchParams.set('limit', String(options.limit));
    jsonUrl.searchParams.set('sort', options.sort);
    jsonUrl.searchParams.set('depth', '10');

    return jsonUrl;
}

export function cleanRedditHtml(html: string): string {
    return (html || '').replace(/<!-- SC_OFF -->/g, '').replace(/<!-- SC_ON -->/g, '');
}

function parseMoreChildrenIds(value: unknown): string[] {
    return parseGraphMoreChildrenIds(value);
}

function dedupeIds(ids: string[]): string[] {
    return dedupeGraphIds(ids);
}

function countCommentNodes(node: CommentNode): number {
    let n = 1;
    for (const child of node.replies) n += countCommentNodes(child);
    return n;
}

export function parseCommentsListing(children: any[] | undefined): {
    comments: CommentNode[];
    loadedCount: number;
    hasMore: boolean;
    rootMoreChildrenIds: string[];
} {
    const { graph, loadedCount } = buildGraphFromListing(children, parseComment);
    return {
        comments: projectRootsFromGraph(graph),
        loadedCount,
        hasMore: graph.hasMoreMarker,
        rootMoreChildrenIds: [...graph.rootMoreChildrenIds],
    };
}

export function parseComment(wrapper: any, remainingDepth: number): CommentNode | null {
    const data = wrapper?.data;
    if (!data) return null;

    const id = String(data.id || '');
    const author = String(data.author || 'unknown');
    const bodyMarkdown = String(data.body || '');
    let bodyHtml = cleanRedditHtml(String(data.body_html || ''));
    if (!bodyHtml && bodyMarkdown) {
        bodyHtml = `<pre>${escapeHtml(bodyMarkdown)}</pre>`;
    }

    const replies: CommentNode[] = [];
    const moreChildrenIds: string[] = [];
    if (data.replies && typeof data.replies === 'object') {
        const children = data?.replies?.data?.children;
        if (Array.isArray(children)) {
            for (const child of children) {
                if (child?.kind === 'more') {
                    moreChildrenIds.push(...parseMoreChildrenIds(child?.data?.children));
                    continue;
                }
                if (child?.kind !== 't1' || remainingDepth <= 0) continue;
                const reply = parseComment(child, remainingDepth - 1);
                if (reply) replies.push(reply);
            }
        }
    }

    return {
        id,
        author,
        bodyMarkdown,
        bodyHtml,
        score: typeof data.score === 'number' ? data.score : undefined,
        createdUtc: typeof data.created_utc === 'number' ? data.created_utc : undefined,
        moreChildrenIds: dedupeIds(moreChildrenIds),
        replies,
    };
}

function resolveCurrentPostId(): string | null {
    if (currentPost?.postId) return currentPost.postId;
    const permalink = currentPost?.permalink || '';
    const match = permalink.match(/\/comments\/([^/]+)/i);
    return match?.[1] ?? null;
}

function countLoadedComments(comments: CommentNode[]): number {
    let total = 0;
    for (const comment of comments) total += countCommentNodes(comment);
    return total;
}

function hasResolvableMorePlaceholders(): boolean {
    return graphHasResolvableMorePlaceholders(commentsGraph);
}

function refreshCommentsHasMore(): void {
    refreshGraphHasMoreState(commentsGraph);
    syncCommentsStateFromGraph(false);
}

function collectMorePlaceholdersForScope(scopeParentId: string | null): MorePlaceholder[] {
    return collectGraphPlaceholdersForScope(commentsGraph, scopeParentId);
}

function consumePlaceholderIdsForParent(parentId: string | null, consumedIds: string[]): void {
    consumeGraphPlaceholderIds(commentsGraph, parentId, consumedIds);
    syncCommentsStateFromGraph(true);
}

function mergeMoreChildrenThings(things: any[], postId: string): CommentsMergeResult {
    const result = mergeMoreChildrenThingsIntoGraph(commentsGraph, things, postId, parseComment);
    syncCommentsStateFromGraph(true);
    return result;
}

async function fetchMoreChildrenThings(postId: string, childrenIds: string[], sort: string): Promise<any[]> {
    const base = new URL('https://www.reddit.com/api/morechildren.json');
    base.searchParams.set('api_type', 'json');
    base.searchParams.set('raw_json', '1');
    base.searchParams.set('link_id', `t3_${postId}`);
    base.searchParams.set('children', childrenIds.join(','));
    base.searchParams.set('sort', sort || 'best');
    base.searchParams.set('limit_children', 'false');

    const response = await fetch(base.toString(), { credentials: 'include' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const things = data?.json?.data?.things;
    return Array.isArray(things) ? things : [];
}

async function loadMoreCommentsForScope(parentId: string | null): Promise<void> {
    const postId = resolveCurrentPostId();
    const statusEl = document.getElementById('comments-status') as HTMLElement | null;
    if (!postId || !statusEl) return;
    if (!commentsVisible) return;

    const seq = ++commentsDeepLoadSeq;
    activeDeepLoadParentId = parentId;
    const limit = getCommentsLimit();
    const sort = getCommentsSort();
    const startedAt = Date.now();
    const progress: LoadProgress = {
        requestsUsed: 0,
        nodesLoaded: 0,
        placeholdersResolved: 0,
        truncated: false,
        errors: [],
    };

    hasActiveSearchStatus = false;
    setCommentsStatus(statusEl, 'loading', parentId ? 'Loading more replies…' : 'Loading more comments…');
    updateCommentsFooter({ hasMore: currentCommentsHasMore, limit, loading: true, permalink: currentPost?.permalink });
    rerenderComments();

    while (seq === commentsDeepLoadSeq) {
        const elapsed = Date.now() - startedAt;
        const budgetHit =
            progress.requestsUsed >= DEFAULT_DEEP_LOAD_BUDGET.maxRequests ||
            progress.nodesLoaded >= DEFAULT_DEEP_LOAD_BUDGET.maxNodes ||
            elapsed >= DEFAULT_DEEP_LOAD_BUDGET.maxMillis;
        if (budgetHit) {
            progress.truncated = true;
            break;
        }

        const queue = collectMorePlaceholdersForScope(parentId)
            .filter(item => item.childrenIds.length > 0)
            .sort((a, b) => {
                if (a.depth !== b.depth) return a.depth - b.depth;
                return a.sourcePath.localeCompare(b.sourcePath);
            });

        if (queue.length === 0) break;
        const next = queue[0]!;
        const batch = next.childrenIds.slice(0, MORECHILDREN_BATCH_SIZE);
        if (batch.length === 0) break;

        progress.requestsUsed += 1;
        let things: any[];
        try {
            things = await fetchMoreChildrenThings(postId, batch, sort);
        } catch (err) {
            progress.errors.push((err as Error)?.message || 'unknown_error');
            break;
        }

        if (seq !== commentsDeepLoadSeq) return;

        consumePlaceholderIdsForParent(next.parentId, batch);
        progress.placeholdersResolved += batch.length;

        const merge = mergeMoreChildrenThings(things, postId);
        progress.nodesLoaded += merge.insertedCount;
    }

    if (seq !== commentsDeepLoadSeq) return;

    activeDeepLoadParentId = null;
    refreshCommentsHasMore();

    if (progress.nodesLoaded > 0) {
        deepLoadState.loaded = true;
        deepLoadState.scope = parentId ? 'branch' : 'root';
    }
    deepLoadState.truncated = deepLoadState.truncated || progress.truncated;

    const totalLoaded = countLoadedComments(currentComments);
    if (progress.nodesLoaded > 0) {
        const suffix = progress.truncated ? ' Reached safe load limit for this pass.' : '';
        setCommentsStatus(statusEl, 'success', `Loaded ${progress.nodesLoaded} more comments. Showing ${totalLoaded} comments.${suffix}`);
    } else if (progress.errors.length > 0) {
        setCommentsStatus(statusEl, 'error', 'Failed to load more comments.', {
            actions: [{ label: 'Retry', onClick: () => void loadMoreCommentsForScope(parentId) }],
        });
    } else {
        const suffix = progress.truncated ? ' Reached safe load limit for this pass.' : '';
        setCommentsStatus(statusEl, 'info', `No additional comments were available.${suffix}`);
    }

    updateCommentsFooter({ hasMore: currentCommentsHasMore, limit, loading: false, permalink: currentPost?.permalink });
    rerenderComments();
    restoreCommentsScrollAnchor();
}

function rerenderComments() {
    const listEl = document.getElementById('comments-list') as HTMLElement | null;
    const statusEl = document.getElementById('comments-status') as HTMLElement | null;
    if (!listEl) return;

    const renderSeq = ++commentsRenderSeq;
    captureCommentFocus();

    const searchQuery = getCommentsSearchQuery();
    const searchActive = searchQuery.length > 0;
    const parsedSearchQuery = searchActive ? parseCommentSearchQuery(searchQuery) : undefined;
    const searchHighlightTerms = getSearchHighlightTerms(parsedSearchQuery);
    const searchHighlightKey = searchHighlightTerms.join('\u001f');
    if (commentsRenderer && searchHighlightKey !== activeSearchHighlightKey) {
        commentsRenderer.invalidate();
    }
    activeSearchHighlightKey = searchHighlightKey;
    const filteredRoots = filterCommentsBySearch(currentComments, searchQuery);
    if (searchQuery && filteredRoots.length === 0) {
        commentsRenderer?.invalidate();
        listEl.replaceChildren();
        const empty = document.createElement('div');
        empty.className = 'comment-collapsed';
        empty.textContent = `No comments match "${searchQuery}".`;
        listEl.appendChild(empty);
        if (statusEl && !commentsAbort && activeDeepLoadParentId === null) {
            setCommentsStatus(statusEl, 'info', `No comments match "${searchQuery}".`);
            hasActiveSearchStatus = true;
        }
        restoreCommentFocus();
        return;
    }

    if (searchActive && statusEl && !commentsAbort && activeDeepLoadParentId === null) {
        const matchCount = countMatchingComments(currentComments, searchQuery);
        const threadCount = filteredRoots.length;
        setCommentsStatus(
            statusEl,
            'info',
            `Found ${matchCount} matching comment${matchCount === 1 ? '' : 's'} in ${threadCount} thread${threadCount === 1 ? '' : 's'}.`,
        );
        hasActiveSearchStatus = true;
    } else if (!searchActive && hasActiveSearchStatus && statusEl && !commentsAbort && activeDeepLoadParentId === null) {
        setCommentsStatus(statusEl, 'success', formatCommentsLoadedMessage(countLoadedComments(currentComments)));
        hasActiveSearchStatus = false;
    }

    const depth = getCommentsDepth();
    const smartMode = getSmartCommentsMode();
    const policy: VisibilityPolicy = {
        depthLimit: searchActive ? Number.MAX_SAFE_INTEGER : depth,
        smartMode: searchActive ? false : smartMode,
        ...DEFAULT_VISIBILITY_POLICY,
    };
    const viewState: VisibilityViewState = {
        expandedMoreIds: expandedMoreById,
        expandedLowScoreIds: expandedLowScoreById,
    };
    const renderItems = filteredRoots.map((top) => {
        const visibilityPlan = buildVisibilityPlan(top, policy, viewState);
        return {
            top,
            settings: {
                depthLimit: depth,
                visibilityPlan,
                searchActive,
                searchQuery: parsedSearchQuery,
                searchHighlightTerms,
            } as RenderTreeSettings,
        };
    });

    const projection = buildCommentProjection(renderItems, {
        collapsedById,
        expandedMoreById,
        expandedLowScoreById,
        autoModeratorExpandedById,
    });

    const rootRenderItems: Array<RootRenderItem<CommentNode, RenderTreeSettings>> = projection.roots
        .map((rootEntry) => {
            const item = renderItems[rootEntry.itemIndex];
            if (!item) return null;
            return {
                key: rootEntry.key,
                signature: rootEntry.signature,
                top: item.top,
                settings: item.settings,
            };
        })
        .filter((item): item is RootRenderItem<CommentNode, RenderTreeSettings> => Boolean(item));

    if (!commentsRenderer) {
        commentsRenderer = createCommentsRenderer<CommentNode, RenderTreeSettings>(
            listEl,
            (top, settings) => renderCommentTree(top, settings, 0, false),
        );
    }

    let changedRoots: HTMLElement[];
    try {
        const result = commentsRenderer.apply(rootRenderItems);
        changedRoots = result.changedRoots;
    } catch (err) {
        console.warn('[Reader Host] Incremental render failed; falling back to reset', err);
        const fallback = commentsRenderer.reset(rootRenderItems);
        changedRoots = fallback.changedRoots;
    }

    const finalize = (targets: HTMLElement[]) => {
        if (renderSeq !== commentsRenderSeq) return;
        restoreCommentFocus();
        if (targets.length === 0) return;
        for (const el of targets) scheduleEnhance(el);
    };
    finalize(changedRoots);
}

function getVisibleChildrenFromPlan(comment: CommentNode, plan: VisibilityPlan): {
    visible: CommentNode[];
    lowScoreCollapsed: CommentNode[];
    hiddenDepthCount: number;
} {
    const byId = new Map(comment.replies.map(reply => [reply.id, reply] as const));
    const visibleIds = plan.visibleChildrenByParentId.get(comment.id) ?? [];
    const collapsedIds = plan.collapsedLowByParentId.get(comment.id) ?? [];
    const hiddenDepthCount = plan.hiddenDepthCountByParentId.get(comment.id) ?? 0;

    const visible = visibleIds
        .map(id => byId.get(id))
        .filter((node): node is CommentNode => Boolean(node));
    const lowScoreCollapsed = collapsedIds
        .map(id => byId.get(id))
        .filter((node): node is CommentNode => Boolean(node));

    return { visible, lowScoreCollapsed, hiddenDepthCount };
}

export function renderCommentTree(
    comment: CommentNode,
    settings: RenderTreeSettings,
    currentDepth: number,
    unlimitedDepth: boolean,
    options?: { forceCollapsed?: boolean; lowScore?: boolean },
): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'comment';
    wrapper.dataset.commentId = comment.id;

    const meta = document.createElement('div');
    meta.className = 'comment-meta';

    const toggle = document.createElement('button');
    toggle.className = 'comment-toggle btn btn--ghost btn--sm';
    toggle.type = 'button';
    const searchActive = Boolean(settings.searchActive);
    const highlightTerms = settings.searchHighlightTerms ?? getSearchHighlightTerms(settings.searchQuery);
    const isAutoModerator = comment.author.trim().toLowerCase() === 'automoderator';
    const autoCollapsed = !searchActive && isAutoModerator && !autoModeratorExpandedById.has(comment.id);
    const isCollapsed = !searchActive && (Boolean(options?.forceCollapsed) || collapsedById.has(comment.id) || autoCollapsed);
    toggle.textContent = isCollapsed ? '▸' : '▾';
    toggle.title = isCollapsed ? 'Expand' : 'Collapse';
    toggle.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
    toggle.setAttribute('aria-label', isCollapsed ? 'Expand comment' : 'Collapse comment');
    const bodyId = `comment-body-${comment.id}`;
    toggle.setAttribute('aria-controls', bodyId);
    toggle.addEventListener('click', (e) => {
        e.preventDefault();
        if (options?.forceCollapsed && options?.lowScore) {
            expandedLowScoreById.add(comment.id);
            rerenderComments();
            return;
        }
        if (isAutoModerator && autoCollapsed) {
            autoModeratorExpandedById.add(comment.id);
            rerenderComments();
            return;
        }
        if (collapsedById.has(comment.id)) collapsedById.delete(comment.id);
        else collapsedById.add(comment.id);
        rerenderComments();
    });

    const metaText = document.createElement('div');
    metaText.className = 'comment-meta-text';
    const scoreText = typeof comment.score === 'number' ? ` • ${comment.score} points` : '';
    const time = formatCommentRelativeTime(comment.createdUtc);
    const timeText = time ? ` • ${time.label}` : '';
    metaText.textContent = `u/${comment.author}${scoreText}${timeText}`;
    if (time) metaText.title = time.title;
    if (searchActive) {
        highlightSearchTerms(metaText, highlightTerms);
    }

    meta.append(toggle, metaText);

    const permalinkUrl = getCommentPermalinkUrl(comment.id);
    if (permalinkUrl) {
        const permalink = document.createElement('a');
        permalink.href = permalinkUrl;
        permalink.className = 'comment-permalink';
        permalink.textContent = 'Permalink';
        permalink.target = '_blank';
        permalink.rel = 'noopener noreferrer';
        permalink.title = 'Open this comment on Reddit';
        meta.appendChild(permalink);
    }

    wrapper.appendChild(meta);

    if (isCollapsed) {
        const collapsed = document.createElement('div');
        collapsed.className = 'comment-collapsed comment-fragment-enter';
        collapsed.textContent = buildCommentSnippet(comment);
        wrapper.appendChild(collapsed);
        if (options?.lowScore) {
            const reason = document.createElement('div');
            reason.className = 'comment-hidden-reason';
            reason.textContent = 'Hidden by smart curation (low score).';
            wrapper.appendChild(reason);
            const reveal = document.createElement('button');
            reveal.className = 'action-btn btn btn--outline btn--sm';
            reveal.type = 'button';
            reveal.textContent = 'Show hidden low-score comment';
            reveal.addEventListener('click', () => {
                expandedLowScoreById.add(comment.id);
                rerenderComments();
            });
            wrapper.appendChild(reveal);
        }
        return wrapper;
    }

    const body = document.createElement('div');
    body.className = 'comment-body comment-fragment-enter';
    body.id = bodyId;
    body.appendChild(sanitizeHtmlToFragment(comment.bodyHtml));
    if (searchActive) {
        highlightSearchTerms(body, highlightTerms);
    }
    wrapper.appendChild(body);

    const unresolvedMoreCount = comment.moreChildrenIds?.length ?? 0;
    if (comment.replies.length === 0 && unresolvedMoreCount === 0) return wrapper;

    const repliesEl = document.createElement('div');
    repliesEl.className = 'comment-replies';

    const thisSubtreeUnlimited = unlimitedDepth || expandedMoreById.has(comment.id);
    let hiddenDepthCount = 0;
    if (comment.replies.length > 0) {
        const { visible, lowScoreCollapsed, hiddenDepthCount: hiddenCount } = getVisibleChildrenFromPlan(
            comment,
            settings.visibilityPlan,
        );
        hiddenDepthCount = hiddenCount;

        for (const child of visible) {
            repliesEl.appendChild(renderCommentTree(child, settings, currentDepth + 1, thisSubtreeUnlimited));
        }
        for (const child of lowScoreCollapsed) {
            repliesEl.appendChild(renderCommentTree(child, settings, currentDepth + 1, thisSubtreeUnlimited, { forceCollapsed: true, lowScore: true }));
        }
    }

    const actions = document.createElement('div');
    actions.className = 'comment-actions';

    if (!thisSubtreeUnlimited && hiddenDepthCount > 0) {
        const btn = document.createElement('button');
        btn.className = 'action-btn btn btn--outline btn--sm';
        btn.type = 'button';
        btn.textContent = `Show ${hiddenDepthCount} hidden repl${hiddenDepthCount === 1 ? 'y' : 'ies'}`;
        btn.addEventListener('click', () => {
            expandedMoreById.add(comment.id);
            rerenderComments();
        });
        actions.appendChild(btn);
    }

    if (unresolvedMoreCount > 0) {
        const loadBtn = document.createElement('button');
        loadBtn.className = 'action-btn btn btn--outline btn--sm';
        loadBtn.type = 'button';
        const isLoading = activeDeepLoadParentId === comment.id;
        loadBtn.disabled = isLoading;
        loadBtn.textContent = isLoading
            ? 'Loading replies…'
            : `Load ${unresolvedMoreCount} more repl${unresolvedMoreCount === 1 ? 'y' : 'ies'} from Reddit`;
        loadBtn.addEventListener('click', () => {
            pendingScrollAnchor = captureCommentsScrollAnchor();
            void loadMoreCommentsForScope(comment.id);
        });
        actions.appendChild(loadBtn);
    }

    if (actions.childNodes.length > 0) wrapper.appendChild(actions);
    if (repliesEl.childNodes.length > 0) wrapper.appendChild(repliesEl);
    return wrapper;
}

export function enhanceInlineMedia(container: HTMLElement, options?: { openUrl?: string }) {
    const anchors = Array.from(container.querySelectorAll('a'));
    for (const a of anchors) {
        if (a.dataset.rvrrEnhanced === '1') continue;

        const href = a.getAttribute('href');
        if (!href) continue;

        // Image links (GIF previews are intentionally not supported)
        if (isProbablyImageUrl(href)) {
            const preview = createImagePreview(href, options?.openUrl);
            a.replaceWith(preview);
            continue;
        }

        // Gifs (e.g. [gif](giphy|...)) are shown as links only.
        if (isGiphyGifPage(href)) {
            a.dataset.rvrrEnhanced = '1';
            if (options?.openUrl) a.setAttribute('href', options.openUrl);
            const text = (a.textContent || '').trim();
            if (!text || text.startsWith('![gif]') || text.startsWith('[gif]')) {
                a.textContent = 'Giphy GIF';
            }

            const note = document.createElement('span');
            note.className = 'inline-gif-note';
            note.textContent = 'GIF preview unsupported';
            a.insertAdjacentElement('afterend', note);
        }
    }
}

function isProbablyImageUrl(url: string): boolean {
    try {
        const parsed = new URL(url);
        const path = parsed.pathname.toLowerCase();
        if (path.endsWith('.png') || path.endsWith('.jpg') || path.endsWith('.jpeg') || path.endsWith('.webp')) {
            return true;
        }
        // Common Reddit image hosts without extensions
        if (parsed.hostname.endsWith('i.redd.it') || parsed.hostname.endsWith('preview.redd.it')) return true;
        return false;
    } catch {
        return false;
    }
}

function isGiphyGifPage(url: string): boolean {
    try {
        const parsed = new URL(url);
        return parsed.hostname.endsWith('giphy.com') && parsed.pathname.startsWith('/gifs/');
    } catch {
        return false;
    }
}

export function enhanceInlineImages(container: HTMLElement, options?: { openUrl?: string }) {
    const imgs = Array.from(container.querySelectorAll('img'));
    for (const img of imgs) {
        if (img.dataset.rvrrEnhanced === '1') continue;
        const src = img.getAttribute('src') || '';
        if (!shouldThumbnailImageUrl(src)) continue;
        img.dataset.rvrrEnhanced = '1';
        img.classList.add('thumb-img');
        (img as HTMLImageElement).loading = 'lazy';
        (img as HTMLImageElement).decoding = 'async';
        img.addEventListener('click', () => {
            const url = options?.openUrl || img.getAttribute('src');
            if (!url) return;
            window.open(url, '_blank', 'noopener,noreferrer');
        });
    }
}

function shouldThumbnailImageUrl(url: string): boolean {
    const parsed = parseHttpUrl(url);
    if (!parsed) return false;
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.toLowerCase();
    if (host.includes('emoji') || path.includes('/emoji/')) return false;
    if (host.endsWith('i.redd.it') || host.endsWith('preview.redd.it')) return true;
    return (
        path.endsWith('.png') ||
        path.endsWith('.jpg') ||
        path.endsWith('.jpeg') ||
        path.endsWith('.webp')
    );
}

function createImagePreview(url: string, openUrl?: string): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'inline-media';
    wrapper.dataset.rvrrEnhanced = '1';

    const img = document.createElement('img');
    img.className = 'inline-media-img';
    img.dataset.rvrrEnhanced = '1';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = url;
    img.alt = '';

    img.addEventListener('click', () => {
        window.open(openUrl || url, '_blank', 'noopener,noreferrer');
    });

    wrapper.appendChild(img);
    return wrapper;
}

function buildCommentSnippet(comment: CommentNode): string {
    let body = (comment.bodyMarkdown || '').trim();
    // Hide noisy "gif" markdown in collapsed snippets.
    body = body.replace(/!\[[^\]]*]\(giphy\|[^)]+\)/gi, '[GIF]');
    body = body.replace(/\[[^\]]*]\(giphy\|[^)]+\)/gi, '[GIF]');
    body = body.replace(/\s+/g, ' ');
    if (!body) return '(collapsed)';
    return body.length > 90 ? `${body.slice(0, 90)}…` : body;
}

export function computePromotedPathIds(root: CommentNode, depthLimit: number, _topScore: number): Set<string> {
    const stats = collectNodeStats(root);
    const policy: VisibilityPolicy = {
        depthLimit,
        smartMode: true,
        ...DEFAULT_VISIBILITY_POLICY,
    };
    const plan = buildVisibilityPlan(root, policy, {
        expandedMoreIds: new Set<string>(),
        expandedLowScoreIds: new Set<string>(),
    });
    const promoted = new Set<string>();
    const walk = (node: CommentNode) => {
        const visibleIds = plan.visibleChildrenByParentId.get(node.id) ?? [];
        for (const childId of visibleIds) {
            const child = node.replies.find(reply => reply.id === childId);
            if (!child) continue;
            const childStats = stats.get(child.id);
            if (childStats && childStats.depth > depthLimit) {
                let cur: string | null = child.id;
                while (cur) {
                    promoted.add(cur);
                    cur = stats.get(cur)?.parentId ?? null;
                }
            }
            walk(child);
        }
    };
    walk(root);
    return promoted;
}

export function collectNodeStats(root: CommentNode): Map<string, NodeStats> {
    const stats = new Map<string, NodeStats>();

    const visit = (node: CommentNode, parentId: string | null, depth: number): NodeStats => {
        const score = typeof node.score === 'number' ? node.score : 0;
        let bestDescendantScore = Number.NEGATIVE_INFINITY;
        let positiveDescendantCount = 0;
        let subtreeSize = 1;

        for (const child of node.replies) {
            const childStats = visit(child, node.id || null, depth + 1);
            subtreeSize += childStats.subtreeSize;
            bestDescendantScore = Math.max(bestDescendantScore, childStats.score, childStats.bestDescendantScore);
            positiveDescendantCount += (childStats.score > 0 ? 1 : 0) + childStats.positiveDescendantCount;
        }

        const nodeStats: NodeStats = {
            id: node.id,
            parentId,
            depth,
            score,
            childCount: node.replies.length,
            bestDescendantScore,
            positiveDescendantCount,
            subtreeSize,
        };
        stats.set(node.id, nodeStats);
        return nodeStats;
    };

    visit(root, null, 0);
    return stats;
}

export function scoreSiblingGroup(
    children: CommentNode[],
    context: { stats: Map<string, NodeStats>; depthLimit: number },
): ScoredChild[] {
    if (children.length === 0) return [];

    const ranked = [...children].sort((a, b) => {
        const aScore = context.stats.get(a.id)?.score ?? 0;
        const bScore = context.stats.get(b.id)?.score ?? 0;
        if (bScore !== aScore) return bScore - aScore;
        return a.id.localeCompare(b.id);
    });

    const percentileById = new Map<string, number>();
    for (let i = 0; i < ranked.length; i += 1) {
        const percentile = ranked.length <= 1 ? 0 : i / (ranked.length - 1);
        percentileById.set(ranked[i]!.id, percentile);
    }

    return children.map((child) => {
        const stat = context.stats.get(child.id);
        const score = stat?.score ?? 0;
        const childDepth = stat?.depth ?? 0;
        const bestDescendantScore = Number.isFinite(stat?.bestDescendantScore)
            ? (stat?.bestDescendantScore ?? Number.NEGATIVE_INFINITY)
            : Number.NEGATIVE_INFINITY;
        const positiveDescendantCount = stat?.positiveDescendantCount ?? 0;
        const siblingPercentile = percentileById.get(child.id) ?? 0;

        const ownScore = Math.log1p(Math.max(score, 0)) * 1.0;
        const negPenalty = score < 0 ? Math.min(2.0, Math.abs(score) / 8) : 0;
        const rankBonus = (1 - siblingPercentile) * 0.8;
        const descendantBoost = Math.log1p(Math.max(bestDescendantScore, 0)) * 0.45 + Math.min(positiveDescendantCount, 8) * 0.08;
        const depthPenalty = Math.max(0, childDepth - context.depthLimit) * 0.55;
        const utility = ownScore + rankBonus + descendantBoost - negPenalty - depthPenalty;

        const isHardLow = score <= -12 && bestDescendantScore < 8;
        const reasonFlags: string[] = [];
        if (score < 0) reasonFlags.push('negative');
        if (isHardLow) reasonFlags.push('hard_low');
        if (bestDescendantScore >= 15 || positiveDescendantCount >= 3) reasonFlags.push('strong_descendant');
        if (childDepth > context.depthLimit) reasonFlags.push('deep');

        return { id: child.id, utility, isHardLow, reasonFlags };
    });
}

export function buildVisibilityPlan(
    root: CommentNode,
    policy: VisibilityPolicy,
    viewState: VisibilityViewState,
): VisibilityPlan {
    const stats = collectNodeStats(root);
    const visibleChildrenByParentId = new Map<string, string[]>();
    const collapsedLowByParentId = new Map<string, string[]>();
    const hiddenDepthCountByParentId = new Map<string, number>();
    let extraDeepVisibleCount = 0;

    const walk = (parent: CommentNode, inheritedUnlimitedDepth: boolean) => {
        if (parent.replies.length === 0) return;

        const thisSubtreeUnlimited = inheritedUnlimitedDepth || viewState.expandedMoreIds.has(parent.id);
        const scoredChildren = scoreSiblingGroup(parent.replies, { stats, depthLimit: policy.depthLimit });
        const scoredById = new Map(scoredChildren.map(entry => [entry.id, entry] as const));

        const visibleIds: string[] = [];
        const collapsedIds: string[] = [];
        const hiddenDepthIds: string[] = [];
        const deepCandidates: ScoredChild[] = [];
        const forcedDeepVisible = new Set<string>();

        for (const child of parent.replies) {
            const stat = stats.get(child.id);
            const score = stat?.score ?? 0;
            const childDepth = stat?.depth ?? 0;
            const bestDescendantScore = Number.isFinite(stat?.bestDescendantScore)
                ? (stat?.bestDescendantScore ?? Number.NEGATIVE_INFINITY)
                : Number.NEGATIVE_INFINITY;
            const positiveDescendantCount = stat?.positiveDescendantCount ?? 0;
            const strongDescendantSignal = bestDescendantScore >= 15 || positiveDescendantCount >= 3;
            const scored = scoredById.get(child.id);
            const isHardLow = policy.smartMode ? (scored?.isHardLow ?? false) : false;

            const withinDepth = thisSubtreeUnlimited || childDepth <= policy.depthLimit;
            if (withinDepth) {
                const userExpandedLow = viewState.expandedLowScoreIds.has(child.id);
                if (policy.smartMode && isHardLow && !strongDescendantSignal && !userExpandedLow) {
                    collapsedIds.push(child.id);
                } else {
                    visibleIds.push(child.id);
                }
                continue;
            }

            if (!policy.smartMode) {
                hiddenDepthIds.push(child.id);
                continue;
            }

            if (score < 0 && strongDescendantSignal) {
                forcedDeepVisible.add(child.id);
                continue;
            }

            if (scored) deepCandidates.push(scored);
            else hiddenDepthIds.push(child.id);
        }

        if (policy.smartMode && !thisSubtreeUnlimited && deepCandidates.length > 0) {
            const sorted = [...deepCandidates].sort((a, b) => {
                if (b.utility !== a.utility) return b.utility - a.utility;
                const scoreA = stats.get(a.id)?.score ?? 0;
                const scoreB = stats.get(b.id)?.score ?? 0;
                if (scoreB !== scoreA) return scoreB - scoreA;
                return a.id.localeCompare(b.id);
            });

            let budget = 1;
            if (sorted.length >= 2) {
                const first = sorted[0]!;
                const second = sorted[1]!;
                const delta = first.utility - second.utility;
                if (
                    delta <= policy.siblingCloseDelta &&
                    first.utility >= policy.utilityThreshold &&
                    second.utility >= policy.utilityThreshold
                ) {
                    budget = 2;
                }
            }

            extraDeepVisibleCount += forcedDeepVisible.size;
            const remainingCap = Math.max(0, policy.maxExtraDeepVisiblePerRoot - extraDeepVisibleCount);
            const take = Math.min(budget, remainingCap);
            const selectedDeep = new Set<string>(sorted.slice(0, take).map(item => item.id));
            extraDeepVisibleCount += selectedDeep.size;

            for (const child of parent.replies) {
                const isDeep = (stats.get(child.id)?.depth ?? 0) > policy.depthLimit;
                if (!isDeep) continue;
                if (forcedDeepVisible.has(child.id) || selectedDeep.has(child.id)) {
                    visibleIds.push(child.id);
                } else if (!hiddenDepthIds.includes(child.id)) {
                    hiddenDepthIds.push(child.id);
                }
            }
        } else {
            for (const child of parent.replies) {
                const isDeep = (stats.get(child.id)?.depth ?? 0) > policy.depthLimit;
                if (!isDeep) continue;
                if (forcedDeepVisible.has(child.id)) {
                    visibleIds.push(child.id);
                } else if (!hiddenDepthIds.includes(child.id)) {
                    hiddenDepthIds.push(child.id);
                }
            }
        }

        visibleChildrenByParentId.set(parent.id, visibleIds);
        collapsedLowByParentId.set(parent.id, collapsedIds);
        hiddenDepthCountByParentId.set(parent.id, hiddenDepthIds.length);

        // Only recurse into currently reachable branches. Hidden or force-collapsed
        // branches should not consume global deep-expansion budget.
        const childById = new Map(parent.replies.map(child => [child.id, child] as const));
        for (const childId of visibleIds) {
            const child = childById.get(childId);
            if (!child) continue;
            walk(child, thisSubtreeUnlimited);
        }
    };

    walk(root, false);
    return {
        visibleChildrenByParentId,
        collapsedLowByParentId,
        hiddenDepthCountByParentId,
    };
}

type CommentExportTreeContext = {
    parentId: string | null;
    path: string;
    isLast: boolean;
    ancestorIsLast: boolean[];
};

function buildCommentTreePrefix(ancestorIsLast: boolean[], isLast: boolean): string {
    const ancestorPrefix = ancestorIsLast.map(last => (last ? '    ' : '|   ')).join('');
    return `${ancestorPrefix}${isLast ? '`-- ' : '|-- '}`;
}

function buildCommentTreeBodyPrefix(ancestorIsLast: boolean[], isLast: boolean): string {
    const ancestorPrefix = ancestorIsLast.map(last => (last ? '    ' : '|   ')).join('');
    return `${ancestorPrefix}${isLast ? '    ' : '|   '}`;
}

export function buildPostMarkdown(post: RedditPostPayload): string {
    const bodyMarkdown = post.bodyMarkdown?.trim() || '';
    const parts: string[] = [];
    parts.push(`# ${post.title}`);
    parts.push('');
    parts.push('## Post Metadata');
    parts.push(`- source_url: ${post.url}`);
    parts.push(`- permalink: ${post.permalink || '(none)'}`);
    parts.push(`- subreddit: ${post.subreddit || 'r/reddit'}`);
    parts.push(`- author: u/${post.author || 'unknown'}`);
    parts.push(`- score: ${typeof post.score === 'number' ? String(post.score) : '(unknown)'}`);
    parts.push(`- nsfw: ${post.nsfw ? 'true' : 'false'}`);
    parts.push(`- spoiler: ${post.spoiler ? 'true' : 'false'}`);
    parts.push(`- fallback_extraction: ${post.isFallback ? 'true' : 'false'}`);
    parts.push('');
    parts.push('## Post Body (Markdown)');
    parts.push('');
    if (bodyMarkdown) {
        parts.push(bodyMarkdown);
    } else if (post.bodyHtml) {
        parts.push('(No Markdown content available)');
    } else {
        parts.push('(No text content found)');
    }
    return parts.join('\n');
}

function buildPostAndCommentsMarkdown(
    post: RedditPostPayload,
    comments: CommentNode[],
    limit: number,
): string {
    const parts: string[] = [];
    parts.push(buildPostMarkdown(post));
    parts.push('');
    const depth = getCommentsDepth();
    const smartMode = getSmartCommentsMode();
    const exportedAtUtc = Math.floor(Date.now() / 1000);

    parts.push('## Comment Export Settings');
    parts.push(`- copy_limit: ${limit}`);
    parts.push(`- exported_at_utc: ${exportedAtUtc}`);
    parts.push('- field_legend: node(id,p,x,d,a,s,t)');
    parts.push(`- depth_setting: ${depth}`);
    parts.push(`- smart_comments: ${smartMode ? 'true' : 'false'}`);
    parts.push(`- deep_loaded: ${deepLoadState.loaded ? 'true' : 'false'}`);
    parts.push(`- deep_load_scope: ${deepLoadState.scope}`);
    parts.push(`- deep_load_truncated: ${deepLoadState.truncated ? 'true' : 'false'}`);
    parts.push(`- auto_depth: ${smartMode ? 'true' : 'false'}`);
    parts.push(`- hide_low_score: ${smartMode ? 'true' : 'false'}`);
    parts.push('');
    parts.push('## Comments');
    parts.push('');

    if (comments.length === 0) {
        parts.push('(No comments loaded)');
        return parts.join('\n');
    }

    parts.push(`- root_comments: ${comments.length}`);
    parts.push('');

    const visibleRoots = comments.filter(comment => !collapsedById.has(comment.id));
    for (let i = 0; i < visibleRoots.length; i += 1) {
        const comment = visibleRoots[i]!;
        const policy: VisibilityPolicy = {
            depthLimit: depth,
            smartMode,
            ...DEFAULT_VISIBILITY_POLICY,
        };
        const visibilityPlan = buildVisibilityPlan(comment, policy, {
            expandedMoreIds: expandedMoreById,
            expandedLowScoreIds: expandedLowScoreById,
        });
        appendVisibleCommentMarkdown(
            parts,
            comment,
            0,
            { depthLimit: depth, visibilityPlan },
            false,
            {
                parentId: null,
                path: String(i + 1),
                isLast: i === visibleRoots.length - 1,
                ancestorIsLast: [],
            },
        );
        if (i < visibleRoots.length - 1) parts.push('');
    }

    return parts.join('\n');
}

function appendVisibleCommentMarkdown(
    out: string[],
    comment: CommentNode,
    depth: number,
    settings: RenderTreeSettings,
    unlimitedDepth: boolean,
    treeContext: CommentExportTreeContext,
) {
    if (collapsedById.has(comment.id)) return;

    const commentId = comment.id || '(unknown)';
    const author = comment.author || 'unknown';
    const scorePart = typeof comment.score === 'number' ? ` s=${comment.score}` : '';
    const createdPart = typeof comment.createdUtc === 'number' ? ` t=${comment.createdUtc}` : '';
    const parentId = treeContext.parentId ?? 'null';

    const header = [
        `id=${commentId}`,
        `p=${parentId}`,
        `x=${treeContext.path}`,
        `d=${depth}`,
        `a=${author}`,
    ];

    const treePrefix = buildCommentTreePrefix(treeContext.ancestorIsLast, treeContext.isLast);
    const bodyPrefix = buildCommentTreeBodyPrefix(treeContext.ancestorIsLast, treeContext.isLast);

    out.push(`${treePrefix}[node ${header.join(' ')}${scorePart}${createdPart}]`);

    const body = comment.bodyMarkdown?.trim() || '';
    out.push(`${bodyPrefix}text: |`);
    if (!body) {
        out.push(`${bodyPrefix}  (empty)`);
    } else {
        const lines = body.split('\n');
        for (const line of lines) {
            out.push(`${bodyPrefix}  ${line}`);
        }
    }

    if (comment.replies.length === 0) return;

    const thisSubtreeUnlimited = unlimitedDepth || expandedMoreById.has(comment.id);
    const { visible } = getVisibleChildrenFromPlan(
        comment,
        settings.visibilityPlan,
    );

    for (let i = 0; i < visible.length; i += 1) {
        const reply = visible[i]!;
        appendVisibleCommentMarkdown(out, reply, depth + 1, settings, thisSubtreeUnlimited, {
            parentId: commentId,
            path: `${treeContext.path}.${i + 1}`,
            isLast: i === visible.length - 1,
            ancestorIsLast: [...treeContext.ancestorIsLast, treeContext.isLast],
        });
    }
}

async function copyToClipboard(text: string) {
    try {
        await navigator.clipboard.writeText(text);
    } catch (err) {
        console.warn('[Reader Host] Clipboard API failed, falling back', err);
        fallbackCopyToClipboard(text);
    }
}

function fallbackCopyToClipboard(text: string) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '0';
    textarea.style.width = '1px';
    textarea.style.height = '1px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
        document.execCommand('copy');
    } finally {
        textarea.remove();
    }
}

export function sanitizeHtmlToFragment(dirtyHtml: string): DocumentFragment {
    const fragment = document.createDocumentFragment();
    if (!dirtyHtml) return fragment;

    const parsed = new DOMParser().parseFromString(dirtyHtml, 'text/html');
    sanitizeNode(parsed.body);

    for (const child of Array.from(parsed.body.childNodes)) {
        fragment.appendChild(document.importNode(child, true));
    }

    return fragment;
}

function sanitizeNode(root: ParentNode) {
    const forbiddenTags = new Set([
        'script',
        'style',
        'iframe',
        'form',
        'object',
        'embed',
        'link',
        'meta',
        'base',
        'noscript',
    ]);

    const allowedTags = new Set([
        'p',
        'div',
        'span',
        'br',
        'hr',
        'a',
        'strong',
        'em',
        'b',
        'i',
        'u',
        's',
        'blockquote',
        'pre',
        'code',
        'ul',
        'ol',
        'li',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'table',
        'thead',
        'tbody',
        'tr',
        'th',
        'td',
        'sup',
        'sub',
        'del',
        'img',
    ]);

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT);

    const nodes: Node[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        nodes.push(node);
    }

    for (const node of nodes) {
        if (node.nodeType === Node.COMMENT_NODE) {
            node.parentNode?.removeChild(node);
            continue;
        }

        if (!(node instanceof Element)) continue;

        const tag = node.tagName.toLowerCase();

        if (forbiddenTags.has(tag)) {
            node.remove();
            continue;
        }

        if (!allowedTags.has(tag)) {
            const parent = node.parentNode;
            if (!parent) continue;
            while (node.firstChild) parent.insertBefore(node.firstChild, node);
            parent.removeChild(node);
            continue;
        }

        sanitizeAttributes(node, tag);
    }
}

function sanitizeAttributes(element: Element, tag: string) {
    const allowedAttrsByTag: Record<string, Set<string>> = {
        a: new Set(['href', 'title']),
        code: new Set(['class']),
        pre: new Set(['class']),
        span: new Set(['class']),
        img: new Set(['src', 'alt', 'title', 'width', 'height', 'loading']),
    };
    const allowedAttrs = allowedAttrsByTag[tag] ?? new Set<string>();

    for (const attr of Array.from(element.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on')) {
            element.removeAttribute(attr.name);
            continue;
        }

        if (!allowedAttrs.has(name)) {
            element.removeAttribute(attr.name);
        }
    }

    if (tag === 'a') {
        const href = element.getAttribute('href');
        if (href) {
            if (href.startsWith('//')) {
                const resolved = `https:${href}`;
                element.setAttribute('href', resolved);
                element.setAttribute('rel', 'noopener noreferrer');
                element.setAttribute('target', '_blank');
                return;
            }
            // Support Reddit-relative links (e.g. /user/... /message/compose/...) by resolving to reddit.com.
            if (href.startsWith('/')) {
                const resolved = new URL(href, 'https://www.reddit.com');
                element.setAttribute('href', resolved.toString());
                element.setAttribute('rel', 'noopener noreferrer');
                element.setAttribute('target', '_blank');
                return;
            }

            const parsed = parseHttpUrl(href);
            if (!parsed) {
                const match = href.match(/^giphy\|([a-zA-Z0-9_-]+)$/i);
                if (match) {
                    const id = match[1];
                    const pageUrl = `https://giphy.com/gifs/${encodeURIComponent(id)}`;
                    element.setAttribute('href', pageUrl);
                    element.setAttribute('rel', 'noopener noreferrer');
                    element.setAttribute('target', '_blank');
                    return;
                }

                element.removeAttribute('href');
            } else {
                element.setAttribute('href', parsed.toString());
                element.setAttribute('rel', 'noopener noreferrer');
                element.setAttribute('target', '_blank');
            }
        }
    }

    if (tag === 'span') {
        const classAttr = element.getAttribute('class') || '';
        if (!classAttr.split(/\s+/).includes('md-spoiler-text')) {
            element.removeAttribute('class');
        } else {
            element.setAttribute('class', 'md-spoiler-text');
        }
    }

    if (tag === 'img') {
        const src = element.getAttribute('src');
        if (!src) return;
        if (src.startsWith('//')) {
            element.setAttribute('src', `https:${src}`);
            return;
        }
        if (src.startsWith('/')) {
            const resolved = new URL(src, 'https://www.reddit.com');
            element.setAttribute('src', resolved.toString());
            return;
        }
        let parsed = parseHttpUrl(src);
        if (!parsed) {
            try {
                parsed = parseHttpUrl(new URL(src, 'https://www.reddit.com').toString());
            } catch {
                parsed = null;
            }
        }
        if (!parsed) element.removeAttribute('src');
        else element.setAttribute('src', parsed.toString());
    }
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function showToast(message: string, tone: 'info' | 'success' | 'error' = 'info') {
    const existing = document.getElementById('__rvrr_toast');
    existing?.remove();

    const toast = document.createElement('div');
    toast.id = '__rvrr_toast';
    toast.className = `rvrr-toast rvrr-toast--${tone}`;
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.setAttribute('aria-atomic', 'true');

    const title = document.createElement('div');
    title.textContent = 'Reader View for Reddit';
    title.className = 'rvrr-toast__title';

    const body = document.createElement('div');
    body.className = 'rvrr-toast__body';
    body.textContent = message;

    toast.append(title, body);
    document.documentElement.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('is-visible'));

    window.setTimeout(() => {
        toast.classList.remove('is-visible');
        window.setTimeout(() => toast.remove(), 220);
    }, 2000);
}

export const __test__ = {
    applyCommentsBulkAction,
    buildCommentSnippet,
    buildMarkdownFilename,
    buildPostAndCommentsMarkdown,
    filterCommentsBySearch,
    countMatchingComments,
    getFooterActionState,
    parseCommentSearchQuery,
    init,
    initTokenProtocol,
    isProbablyImageUrl,
    isGiphyGifPage,
    createImagePreview,
    collapsedById,
    expandedLowScoreById,
    expandedMoreById,
};

document.addEventListener('DOMContentLoaded', init);
