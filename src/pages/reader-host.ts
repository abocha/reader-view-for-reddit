import browser from 'webextension-polyfill';
import { RedditPostPayload } from '../content/reddit-extract';
import { perf, PerfReport } from '../perf/trace';

console.log("[Reader Host] Script loaded");

type CommentNode = {
    id: string;
    author: string;
    bodyMarkdown: string;
    bodyHtml: string;
    score?: number;
    createdUtc?: number;
    replies: CommentNode[];
};

let currentPost: RedditPostPayload | null = null;
let currentComments: CommentNode[] = [];
let commentsVisible = true;
const expandedMoreById = new Set<string>();
const expandedLowScoreById = new Set<string>();
const collapsedById = new Set<string>();
let traceId: string | null = null;
let commentsAbort: AbortController | null = null;
let commentsLoadSeq = 0;
let isBenchmark = false;
let benchmarkLimitOverride: number | null = null;
let benchmarkSortOverride: string | null = null;
let benchmarkAutoComments = false;
let pendingScrollAnchor: { commentId: string; top: number } | null = null;
let keepCommentsListDuringNextLoad = false;

const COMMENTS_LIMIT_OPTIONS = [50, 100, 200, 300, 400, 500] as const;

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

    const shouldShow = options.hasMore && options.limit < 500;
    const loading = Boolean(options.loading);
    const showRedditLink = !loading && options.hasMore && options.limit >= 500;
    footer.classList.toggle('is-hidden', !shouldShow && !loading && !showRedditLink);

    let btn = footer.querySelector<HTMLButtonElement>('button[data-role="load-more-comments"]');
    if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn--outline btn--sm';
        btn.dataset.role = 'load-more-comments';
        footer.appendChild(btn);
    }

    btn.onclick = null;
    btn.disabled = loading || (!shouldShow && !showRedditLink);
    if (loading) {
        btn.classList.add('is-busy');
        btn.setAttribute('aria-busy', 'true');
        btn.textContent = 'Loading more…';
    } else {
        btn.classList.remove('is-busy');
        btn.removeAttribute('aria-busy');
        btn.textContent = showRedditLink ? 'See more comments on Reddit' : 'Load more comments';
    }

    if (showRedditLink) {
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

    if (shouldShow && !loading) {
        btn.onclick = () => {
            const currentLimit = getCommentsLimit();
            pendingScrollAnchor = captureCommentsScrollAnchor();
            keepCommentsListDuringNextLoad = true;
            const limitEl = document.getElementById('comments-limit') as HTMLSelectElement | null;
            const idx = COMMENTS_LIMIT_OPTIONS.indexOf(currentLimit as any);
            const next = COMMENTS_LIMIT_OPTIONS[Math.min(COMMENTS_LIMIT_OPTIONS.length - 1, Math.max(0, idx) + 1)] ?? 500;
            if (limitEl) limitEl.value = String(next);
            void loadComments();
        };
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
    metaText.textContent = sourceUrl ? new URL(sourceUrl).hostname.replace(/^www\./, '') : 'Fetching post';
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

    const tryStorage = async () => {
        try {
            const data = await browser.storage.session.get(pendingKey);
            const token = data?.[pendingKey] as string | undefined;
            if (!token || typeof token !== 'string') return;
            if (resolved) return;
            resolved = true;
            window.clearTimeout(timeout);
            window.clearInterval(interval);
            hostEvents.push(waitSpan.end({ ok: true, via: 'storage' }));
            persistTokenInUrl(token, expectedTraceId);
            try { await browser.storage.session.remove(pendingKey); } catch { /* ignore */ }
            void initTokenProtocol(token, hostEvents);
        } catch {
            // ignore
        }
    };
    const timeout = window.setTimeout(() => {
        if (resolved) return;
        resolved = true;
        hostEvents.push(waitSpan.end({ ok: false, reason: 'timeout' }));
        renderErrorMode('Timed out waiting for article data. Please try again.');
    }, 12000);

    // Poll storage to avoid missing a one-shot runtime message.
    const interval = window.setInterval(() => void tryStorage(), 200);
    void tryStorage();

    const onMsg = (msg: unknown) => {
        if (!msg || typeof msg !== 'object') return;
        const type = (msg as any).type;
        if (type === 'HOST_PAYLOAD_READY' && (msg as any).traceId === expectedTraceId) {
            const token = (msg as any).token as string | undefined;
            if (!token) return;
            if (resolved) return;
            resolved = true;
            window.clearTimeout(timeout);
            window.clearInterval(interval);
            hostEvents.push(waitSpan.end({ ok: true, via: 'message' }));
            browser.runtime.onMessage.removeListener(onMsg as any);
            persistTokenInUrl(token, expectedTraceId);
            try { void browser.storage.session.remove(pendingKey); } catch { /* ignore */ }
            void initTokenProtocol(token, hostEvents);
            return;
        }
        if (type === 'HOST_PAYLOAD_ERROR' && (msg as any).traceId === expectedTraceId) {
            if (resolved) return;
            resolved = true;
            window.clearTimeout(timeout);
            window.clearInterval(interval);
            hostEvents.push(waitSpan.end({ ok: false, reason: 'error' }));
            browser.runtime.onMessage.removeListener(onMsg as any);
            renderErrorMode((msg as any).error || 'Failed to load article.');
        }
    };

    browser.runtime.onMessage.addListener(onMsg as any);
}

function persistTokenInUrl(token: string, trace: string) {
    try {
        const params = new URLSearchParams(window.location.hash.slice(1));
        params.delete('pending');
        params.delete('sourceUrl');
        params.set('token', token);
        params.set('trace', trace);
        history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${params.toString()}`);
    } catch {
        // ignore
    }
}

async function initTokenProtocol(token: string, hostEvents: ReturnType<typeof perf.event>[]) {
    // 2. Retrieve Payload from Session Storage
    const getSpan = perf.span('host:session_get');
    const data = await browser.storage.session.get(token);
    hostEvents.push(getSpan.startEvent, getSpan.end());
    const payload = data[token] as RedditPostPayload | undefined;

    if (!payload) {
        renderErrorMode("Article data expired or not found. Please try extracting again.");
        return;
    }

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
    } catch (e) { /* ignore */ }
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

    // Apply classes
    document.body.classList.add(`theme-${savedTheme}`);
    document.body.classList.add(`font-${savedFont}`);
    document.body.classList.add(`align-${savedAlign}`);

    updateActiveControls(savedTheme, savedFont, savedAlign);

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
}

export function initActions() {
    const copyPostBtn = document.getElementById('copy-post-md') as HTMLButtonElement | null;
    const copyPostCommentsBtn = document.getElementById('copy-post-comments-md') as HTMLButtonElement | null;
    const openModeSelect = document.getElementById('open-mode') as HTMLSelectElement | null;

    // Drawer Logic
    const drawer = document.getElementById('settings-drawer');
    const toggleDrawerBtn = document.getElementById('toggle-drawer');
    const closeDrawerBtn = document.getElementById('close-drawer');
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

    // Depth Slider Live Update & Auto-Disable
    const depthInput = document.getElementById('comments-depth') as HTMLInputElement;
    const depthVal = document.getElementById('depth-val');
    const autoDepthCheckbox = document.getElementById('comments-auto-depth') as HTMLInputElement;

    if (depthInput && depthVal) {
        depthInput.addEventListener('input', () => {
            depthVal.textContent = depthInput.value;
            if (autoDepthCheckbox && autoDepthCheckbox.checked) {
                autoDepthCheckbox.checked = false;
                // Don't need to trigger change immediately as the slider input/change event will likely handle rerender eventually, 
                // or we can manually trigger it if desired. The main point is visually unchecking it.
            }
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

export function initCommentsUI() {
    const toggleSwitch = document.getElementById('toggle-comments-switch') as HTMLInputElement | null;
    // Reload logic merged into config changes
    const depthEl = document.getElementById('comments-depth') as HTMLInputElement | null;
    const autoDepthEl = document.getElementById('comments-auto-depth') as HTMLInputElement | null;
    const hideLowEl = document.getElementById('comments-hide-low') as HTMLInputElement | null;
    const limitEl = document.getElementById('comments-limit') as HTMLSelectElement | null;
    const sortEl = document.getElementById('comments-sort') as HTMLSelectElement | null;

    toggleSwitch?.addEventListener('change', () => {
        commentsVisible = toggleSwitch.checked;
        setCommentsVisibility(commentsVisible);
        if (commentsVisible && currentComments.length === 0) void loadComments();
    });

    const onFetchConfigChange = () => {
        if (!commentsVisible) return;
        void loadComments();
    };

    const onViewConfigChange = () => {
        if (!commentsVisible) return;
        rerenderComments();
    };

    limitEl?.addEventListener('change', onFetchConfigChange);
    sortEl?.addEventListener('change', onFetchConfigChange);
    depthEl?.addEventListener('change', onViewConfigChange);
    autoDepthEl?.addEventListener('change', onViewConfigChange);
    hideLowEl?.addEventListener('change', onViewConfigChange);

    // Initialize state
    if (toggleSwitch) {
        commentsVisible = toggleSwitch.checked;
        setCommentsVisibility(commentsVisible);
        if (commentsVisible) void loadComments();
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
    metaText.textContent = `${post.subreddit} • u/${post.author}`;
    metaRow.appendChild(metaText);

    if (post.isFallback) {
        const fallbackBadge = document.createElement('span');
        fallbackBadge.className = 'meta-pill fallback-badge';
        fallbackBadge.textContent = 'Extracted via Fallback';
        metaRow.appendChild(fallbackBadge);
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

    const bodyFragment = sanitizeHtmlToFragment(post.bodyHtml || '');
    const hasBody = bodyFragment.childNodes.length > 0;

    if (hasBody) {
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

        content.appendChild(body);
        scheduleEnhance(body);
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

function scheduleEnhance(container: HTMLElement) {
    const run = () => {
        try {
            enhanceInlineMedia(container);
            enhanceInlineImages(container);
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
    link.href = parsed.toString();
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
        return wrapper;
    }

    const caption = document.createElement('div');
    caption.className = 'media-caption';
    caption.textContent = 'Open video in a new tab';
    link.textContent = parsed.hostname.replace(/^www\./, '');
    link.classList.add('media-link');
    wrapper.append(link, caption);
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

async function loadComments() {
    const localTrace = traceId ?? crypto.randomUUID();
    const events: ReturnType<typeof perf.event>[] = [perf.event('comments:load_start')];
    const commentsSection = document.getElementById('comments') as HTMLElement | null;
    const statusEl = document.getElementById('comments-status') as HTMLElement | null;
    const listEl = document.getElementById('comments-list') as HTMLElement | null;
    const limitEl = document.getElementById('comments-limit') as HTMLSelectElement | null;
    const sortEl = document.getElementById('comments-sort') as HTMLSelectElement | null;

    if (!commentsSection || !statusEl || !listEl) return;
    if (!currentPost?.permalink) {
        commentsSection.hidden = false;
        setCommentsStatus(statusEl, 'info', currentPost?.isFallback
            ? 'Comments are unavailable (fallback extraction was used).'
            : 'Comments are unavailable for this post.');
        listEl.replaceChildren();
        updateCommentsFooter({ hasMore: false, limit: getCommentsLimit(), loading: false, permalink: currentPost?.permalink });
        currentComments = [];
        return;
    }

    const limit = getCommentsLimit();
    const sort = getCommentsSort();

    const requestSeq = ++commentsLoadSeq;
    commentsAbort?.abort();
    commentsAbort = new AbortController();

    commentsSection.hidden = false;
    setCommentsStatus(statusEl, 'loading', 'Loading comments…');
    if (limitEl) limitEl.disabled = true;
    if (sortEl) sortEl.disabled = true;
    if (!keepCommentsListDuringNextLoad) {
        listEl.replaceChildren();
    }
    updateCommentsFooter({ hasMore: false, limit, loading: keepCommentsListDuringNextLoad, permalink: currentPost?.permalink });

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
                const totalCount = typeof (value as any).totalCount === 'number' ? (value as any).totalCount : undefined;

                if (Array.isArray(cachedComments) && requestSeq === commentsLoadSeq) {
                    currentComments = cachedComments;
                    expandedMoreById.clear();
                    expandedLowScoreById.clear();
                    collapsedById.clear();

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
                    updateCommentsFooter({ hasMore, limit, loading: false, permalink: currentPost?.permalink });
                    return;
                }
            }
        } catch {
            events.push(cacheSpan.end({ hit: false, error: true }));
        }

        const url = buildCommentsJsonUrl(currentPost.permalink, { limit, sort });
        const fetchSpan = perf.span('comments:fetch', { url: url.toString(), limit, sort });
        const response = await fetch(url.toString(), { credentials: 'include', signal: commentsAbort.signal });
        events.push(fetchSpan.startEvent, fetchSpan.end({ ok: response.ok, status: response.status }));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const parseSpan = perf.span('comments:parse');
        const data = await response.json();
        const totalCount = typeof data?.[0]?.data?.children?.[0]?.data?.num_comments === 'number'
            ? (data[0].data.children[0].data.num_comments as number)
            : undefined;
        const commentsListing = data?.[1]?.data?.children;

        const parsed = parseCommentsListing(commentsListing);
        events.push(parseSpan.startEvent, parseSpan.end({ loadedCount: parsed.loadedCount, hasMore: parsed.hasMore, totalCount }));
        if (requestSeq !== commentsLoadSeq) return;
        currentComments = parsed.comments;
        expandedMoreById.clear();
        expandedLowScoreById.clear();
        collapsedById.clear();

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
                value: { comments: parsed.comments, loadedCount: parsed.loadedCount, hasMore: parsed.hasMore, totalCount },
            });
            if (res && typeof res === 'object') {
                events.push(cacheSetSpan.end(res as any));
            } else {
                events.push(cacheSetSpan.end({ ok: false, reason: 'no_response' }));
            }
        } catch {
            events.push(cacheSetSpan.end({ ok: false, reason: 'send_failed' }));
        }
        updateCommentsFooter({ hasMore: parsed.hasMore, limit, loading: false, permalink: currentPost?.permalink });
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
        if (requestSeq !== commentsLoadSeq) return;
        setCommentsStatus(statusEl, 'error', 'Failed to load comments.', {
            actions: [
                {
                    label: 'Retry',
                    onClick: () => void loadComments(),
                }
            ],
        });
        listEl.replaceChildren();
        updateCommentsFooter({ hasMore: keepCommentsListDuringNextLoad, limit, loading: false, permalink: currentPost?.permalink });
        currentComments = [];
    } finally {
        keepCommentsListDuringNextLoad = false;
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
    const depthEl = document.getElementById('comments-depth') as HTMLSelectElement | null;
    const parsed = Number.parseInt(depthEl?.value ?? '1', 10);
    if (!Number.isFinite(parsed)) return 1;
    return Math.min(5, Math.max(0, parsed));
}

export function getAutoDepth(): boolean {
    const el = document.getElementById('comments-auto-depth') as HTMLInputElement | null;
    return el?.checked ?? true;
}

function getHideLowScore(): boolean {
    const el = document.getElementById('comments-hide-low') as HTMLInputElement | null;
    return el?.checked ?? true;
}

function getCommentsLimit(): number {
    const limitEl = document.getElementById('comments-limit') as HTMLSelectElement | null;
    const parsed = Number.parseInt(limitEl?.value ?? '100', 10);
    return coerceCommentsLimit(parsed);
}

function getCommentsSort(): string {
    const sortEl = document.getElementById('comments-sort') as HTMLSelectElement | null;
    return sortEl?.value || 'top';
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

export function parseCommentsListing(children: any[] | undefined): { comments: CommentNode[]; loadedCount: number; hasMore: boolean } {
    if (!Array.isArray(children)) return { comments: [], loadedCount: 0, hasMore: false };

    let loadedCount = 0;
    let hasMore = false;

    const comments: CommentNode[] = [];

    // Helper to recursively count
    const countNodes = (node: CommentNode): number => {
        let n = 1;
        for (const child of node.replies) n += countNodes(child);
        return n;
    };

    for (const child of children) {
        if (!child || typeof child !== 'object') continue;
        if (child.kind === 'more') {
            hasMore = true;
            continue;
        }
        if (child.kind !== 't1') continue;

        const node = parseComment(child, 10);
        if (!node) continue;

        loadedCount += countNodes(node);
        comments.push(node);
    }

    return { comments, loadedCount, hasMore };
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
    if (remainingDepth > 0 && data.replies && typeof data.replies === 'object') {
        const children = data?.replies?.data?.children;
        if (Array.isArray(children)) {
            for (const child of children) {
                if (child?.kind !== 't1') continue;
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
        replies,
    };
}

function rerenderComments() {
    const listEl = document.getElementById('comments-list') as HTMLElement | null;
    if (!listEl) return;

    listEl.replaceChildren();

    const depth = getCommentsDepth();
    const autoDepth = getAutoDepth();
    const hideLow = getHideLowScore();

    for (const top of currentComments) {
        const topScore = typeof top.score === 'number' ? top.score : 0;
        const promoted = autoDepth ? computePromotedPathIds(top, depth, topScore) : new Set<string>();
        listEl.appendChild(renderCommentTree(top, { depthLimit: depth, autoDepth, hideLow, promotedPathIds: promoted }, 0, false));
    }

    scheduleEnhance(listEl);
}

export function renderCommentTree(
    comment: CommentNode,
    settings: { depthLimit: number; autoDepth: boolean; hideLow: boolean; promotedPathIds: Set<string> },
    currentDepth: number,
    unlimitedDepth: boolean,
): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'comment';
    wrapper.dataset.commentId = comment.id;

    const meta = document.createElement('div');
    meta.className = 'comment-meta';

    const toggle = document.createElement('button');
    toggle.className = 'comment-toggle btn btn--ghost btn--sm';
    toggle.type = 'button';
    const isCollapsed = collapsedById.has(comment.id);
    toggle.textContent = isCollapsed ? '▸' : '▾';
    toggle.title = isCollapsed ? 'Expand' : 'Collapse';
    toggle.addEventListener('click', (e) => {
        e.preventDefault();
        if (collapsedById.has(comment.id)) collapsedById.delete(comment.id);
        else collapsedById.add(comment.id);
        rerenderComments();
    });

    const metaText = document.createElement('div');
    metaText.className = 'comment-meta-text';
    const scoreText = typeof comment.score === 'number' ? ` • ${comment.score} points` : '';
    metaText.textContent = `u/${comment.author}${scoreText}`;
    meta.append(toggle, metaText);

    wrapper.appendChild(meta);

    if (isCollapsed) {
        const collapsed = document.createElement('div');
        collapsed.className = 'comment-collapsed';
        collapsed.textContent = buildCommentSnippet(comment);
        wrapper.appendChild(collapsed);
        return wrapper;
    }

    const body = document.createElement('div');
    body.className = 'comment-body';
    body.appendChild(sanitizeHtmlToFragment(comment.bodyHtml));
    wrapper.appendChild(body);

    if (comment.replies.length === 0) return wrapper;

    const repliesEl = document.createElement('div');
    repliesEl.className = 'comment-replies';

    const thisSubtreeUnlimited = unlimitedDepth || expandedMoreById.has(comment.id);
    const { visible, hiddenDepthCount, hiddenLowScoreCount } = selectVisibleChildren(
        comment,
        comment.replies,
        currentDepth + 1,
        settings.depthLimit,
        settings.hideLow,
        settings.promotedPathIds,
        thisSubtreeUnlimited,
    );

    for (const child of visible) {
        repliesEl.appendChild(renderCommentTree(child, settings, currentDepth + 1, thisSubtreeUnlimited));
    }

    const actions = document.createElement('div');
    actions.className = 'comment-actions';

    if (!thisSubtreeUnlimited && hiddenDepthCount > 0) {
        const btn = document.createElement('button');
        btn.className = 'action-btn btn btn--outline btn--sm';
        btn.type = 'button';
        btn.textContent = `Show ${hiddenDepthCount} more replies`;
        btn.addEventListener('click', () => {
            expandedMoreById.add(comment.id);
            rerenderComments();
        });
        actions.appendChild(btn);
    }

    if (hiddenLowScoreCount > 0) {
        const btn = document.createElement('button');
        btn.className = 'action-btn btn btn--outline btn--sm';
        btn.type = 'button';
        btn.textContent = `Show ${hiddenLowScoreCount} low-score replies`;
        btn.addEventListener('click', () => {
            expandedLowScoreById.add(comment.id);
            rerenderComments();
        });
        actions.appendChild(btn);
    }

    if (actions.childNodes.length > 0) wrapper.appendChild(actions);
    wrapper.appendChild(repliesEl);
    return wrapper;
}

export function enhanceInlineMedia(container: HTMLElement) {
    const anchors = Array.from(container.querySelectorAll('a'));
    for (const a of anchors) {
        if (a.dataset.rvrrEnhanced === '1') continue;

        const href = a.getAttribute('href');
        if (!href) continue;

        // Image links (GIF previews are intentionally not supported)
        if (isProbablyImageUrl(href)) {
            const preview = createImagePreview(href);
            a.replaceWith(preview);
            continue;
        }

        // Gifs (e.g. [gif](giphy|...)) are shown as links only.
        if (isGiphyGifPage(href)) {
            a.dataset.rvrrEnhanced = '1';
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

export function enhanceInlineImages(container: HTMLElement) {
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
            const url = img.getAttribute('src');
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

function createImagePreview(url: string): HTMLElement {
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
        window.open(url, '_blank', 'noopener,noreferrer');
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
    const parentById = new Map<string, string | null>();
    const scoreById = new Map<string, number>();
    const depthById = new Map<string, number>();
    const allIds: string[] = [];

    const visit = (node: CommentNode, parentId: string | null, depth: number) => {
        parentById.set(node.id, parentId);
        scoreById.set(node.id, typeof node.score === 'number' ? node.score : 0);
        depthById.set(node.id, depth);
        allIds.push(node.id);
        for (const child of node.replies) visit(child, node.id, depth + 1);
    };

    visit(root, null, 0);

    const candidates: Array<{ id: string; score: number }> = [];
    let maxCandidateScore = 0;

    for (const id of allIds) {
        const depth = depthById.get(id) ?? 0;
        if (depth <= depthLimit) continue;
        const score = scoreById.get(id) ?? 0;
        candidates.push({ id, score });
        if (score > maxCandidateScore) maxCandidateScore = score;
    }

    // If nothing beyond the depth limit is meaningfully upvoted, don't expand.
    if (maxCandidateScore < 5) return new Set<string>();

    const threshold = Math.max(5, maxCandidateScore * 0.25);
    const best = candidates
        .filter(c => c.score >= threshold)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);

    const promoted = new Set<string>();
    for (const { id } of best) {
        let cur: string | null = id;
        while (cur) {
            promoted.add(cur);
            cur = parentById.get(cur) ?? null;
        }
    }

    return promoted;
}

function selectVisibleChildren(
    parent: CommentNode,
    children: CommentNode[],
    depth: number,
    depthLimit: number,
    hideLow: boolean,
    promotedPathIds: Set<string>,
    unlimitedDepth: boolean,
): { visible: CommentNode[]; hiddenDepthCount: number; hiddenLowScoreCount: number } {
    const showLow = expandedLowScoreById.has(parent.id);

    const visible: CommentNode[] = [];
    let hiddenDepthCount = 0;
    let hiddenLowScoreCount = 0;

    for (const child of children) {
        const score = typeof child.score === 'number' ? child.score : 0;
        const isLow = hideLow && score <= -3 && !showLow;

        const withinDepth = depth <= depthLimit;
        const promoted = promotedPathIds.has(child.id);
        const visibleByDepth = unlimitedDepth || withinDepth || promoted;

        if (isLow) {
            hiddenLowScoreCount += 1;
            continue;
        }

        if (!visibleByDepth) {
            hiddenDepthCount += 1;
            continue;
        }

        visible.push(child);
    }

    return { visible, hiddenDepthCount, hiddenLowScoreCount };
}

export function buildPostMarkdown(post: RedditPostPayload): string {
    const parts: string[] = [];
    parts.push(`# ${post.title}`);
    parts.push('');
    parts.push(post.url);
    parts.push('');
    if (post.bodyMarkdown) {
        parts.push(post.bodyMarkdown.trim());
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
    parts.push('---');
    parts.push('');
    const depth = getCommentsDepth();
    const autoDepth = getAutoDepth();
    const hideLow = getHideLowScore();

    parts.push(`## Comments (depth ${depth}, limit ${limit})`);
    parts.push('');

    if (comments.length === 0) {
        parts.push('(No comments loaded)');
        return parts.join('\n');
    }

    for (const comment of comments) {
        const topScore = typeof comment.score === 'number' ? comment.score : 0;
        const promoted = autoDepth ? computePromotedPathIds(comment, depth, topScore) : new Set<string>();
        appendVisibleCommentMarkdown(parts, comment, 0, { depthLimit: depth, autoDepth, hideLow, promotedPathIds: promoted }, false);
    }

    return parts.join('\n');
}

function appendVisibleCommentMarkdown(
    out: string[],
    comment: CommentNode,
    depth: number,
    settings: { depthLimit: number; autoDepth: boolean; hideLow: boolean; promotedPathIds: Set<string> },
    unlimitedDepth: boolean,
) {
    if (collapsedById.has(comment.id)) return;

    const indent = '  '.repeat(depth);
    const header = `${indent}- **u/${comment.author}**`;
    out.push(header);

    const body = comment.bodyMarkdown?.trim() || '';
    if (body) {
        const lines = body.split('\n');
        for (const line of lines) {
            out.push(`${indent}  ${line}`);
        }
    }

    if (comment.replies.length === 0) return;

    const thisSubtreeUnlimited = unlimitedDepth || expandedMoreById.has(comment.id);
    const { visible } = selectVisibleChildren(
        comment,
        comment.replies,
        depth + 1,
        settings.depthLimit,
        settings.hideLow,
        settings.promotedPathIds,
        thisSubtreeUnlimited,
    );

    for (const reply of visible) {
        appendVisibleCommentMarkdown(out, reply, depth + 1, settings, thisSubtreeUnlimited);
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
    buildCommentSnippet,
    init,
    initTokenProtocol,
    isProbablyImageUrl,
    isGiphyGifPage,
    createImagePreview,
    collapsedById,
};

document.addEventListener('DOMContentLoaded', init);
