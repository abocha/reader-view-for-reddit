import browser, { Tabs } from 'webextension-polyfill';
import { extractRedditPost, ExtractionResult, RedditPostPayload } from '../content/reddit-extract';
import { fetchRedditPostPayloadFromJson } from './reddit-json';
import { perf, PerfReport, summarize } from '../perf/trace';
import { recordSessionToken } from '../shared/session-token-cache';
import { normalizeRedditPostCacheKey } from './cache-keys';
import { getCachedPayload, setCachedPayload } from './payload-cache';
import { getCachedComments, setCachedComments } from './comments-cache';
import { cleanupPendingTokens, PendingTokenEntry } from './pending-token-cleanup';
import { installRuntimeMessageListener } from './runtime-messages';

// --- Core Logic ---

type OpenMode = 'same-tab' | 'new-tab';

const SHOULD_RECORD_PERF = typeof __DEV__ !== 'undefined' && __DEV__;

export async function getOpenMode(): Promise<OpenMode> {
    const data = await browser.storage.sync.get('openMode');
    return data.openMode === 'new-tab' ? 'new-tab' : 'same-tab';
}

async function storePayloadForTrace(
    traceId: string,
    payload: RedditPostPayload,
    sourceUrl: string,
    events: ReturnType<typeof perf.event>[],
): Promise<string> {
    const token = crypto.randomUUID();
    const pendingKey = `pending_token:${traceId}`;
    const pendingEntry: PendingTokenEntry = { token, createdAt: Date.now() };
    const storeSpan = perf.span('session_set');
    events.push(storeSpan.startEvent);
    await browser.storage.session.set({ [token]: payload, [pendingKey]: pendingEntry });
    events.push(storeSpan.end());
    await recordSessionToken(token, sourceUrl);
    void cleanupPendingTokens();
    return token;
}

export async function processTab(tab: Tabs.Tab) {
    if (!tab.id || !tab.url) {
        console.warn('[Reader Helper] processTab: invalid tab', tab);
        return;
    }

    const traceId = crypto.randomUUID();
    const events = [perf.event('processTab:start', { tabId: tab.id, url: tab.url })];
    console.log('[Reader Helper] Processing tab:', tab.id, tab.url, `(trace ${traceId})`);

    try {
        // 1) Extract payload (prefer background JSON fetch; fall back to executeScript).
        let payload: any | null = null;
        let extractMethod: 'cache' | 'json' | 'executeScript' = 'json';

        const extractOverall = perf.span('extract');
        events.push(extractOverall.startEvent);

        const cacheKey = normalizeRedditPostCacheKey(tab.url);
        if (cacheKey) {
            const cacheSpan = perf.span('extract_cache');
            events.push(cacheSpan.startEvent);
            const cached = getCachedPayload(cacheKey);
            events.push(cacheSpan.end({ hit: Boolean(cached) }));
            if (cached) {
                payload = cached;
                extractMethod = 'cache';
            }
        }

        if (!payload) {
            try {
                const jsonSpan = perf.span('extract_json');
                events.push(jsonSpan.startEvent);
                const fetched = await fetchRedditPostPayloadFromJson(tab.url);
                payload = fetched.payload;
                events.push(jsonSpan.end({ ok: true, ...fetched.meta }));
                extractMethod = 'json';
                if (cacheKey) setCachedPayload(cacheKey, payload);
            } catch (err: any) {
                events.push(perf.event('extract_json:error', { error: err?.message || String(err) }));
                try {
                    console.log('[Reader Helper] JSON fetch failed; falling back to executeScript extraction...');
                    const execSpan = perf.span('extract_executeScript');
                    events.push(execSpan.startEvent);
                    const results = await browser.scripting.executeScript({
                        target: { tabId: tab.id },
                        func: extractRedditPost
                    });
                    events.push(execSpan.end());

                    const result = results[0]?.result as ExtractionResult;
                    if (!result || !result.ok) {
                        console.error('[Reader Helper] Extraction failed:', result?.error);
                        events.push(perf.event('processTab:error', { stage: 'extract', error: result?.error || 'unknown' }));
                        events.push(extractOverall.end({ ok: false, method: 'executeScript' }));
                        void recordPerf({ traceId, scope: 'background', events, meta: { ok: false } });
                        await openErrorHost(tab, result?.error || 'Unknown extraction error');
                        return;
                    }
                    payload = result.payload;
                    extractMethod = 'executeScript';
                    if (cacheKey) setCachedPayload(cacheKey, payload);
                } catch (fallbackErr: any) {
                    events.push(perf.event('processTab:error', { stage: 'extract', error: fallbackErr?.message || String(fallbackErr) }));
                    events.push(extractOverall.end({ ok: false, method: 'executeScript' }));
                    void recordPerf({ traceId, scope: 'background', events, meta: { ok: false } });
                    await openErrorHost(tab, fallbackErr?.message || String(fallbackErr));
                    return;
                }
            }
        }

        events.push(extractOverall.end({ ok: true, method: extractMethod }));
        console.log('[Reader Helper] Extraction success:', payload?.title);

        const openMode = await getOpenMode();

        // For new-tab mode, open the host immediately so the user sees instant feedback,
        // then hydrate it when payload is ready.
        let pendingTraceId: string | null = null;
        if (openMode === 'new-tab') {
            pendingTraceId = traceId;
            const navSpan = perf.span('open_host_page', { openMode: 'new-tab', pending: true });
            events.push(navSpan.startEvent);
            await openHostPagePending(pendingTraceId, tab.url);
            events.push(navSpan.end());
        }

        // 2. Generate token and persist payload + pending marker.
        const token = await storePayloadForTrace(traceId, payload, tab.url, events);

        // 3. Open Host Page (or hydrate the already-opened pending host).
        if (openMode === 'new-tab' && pendingTraceId) {
            try {
                await browser.runtime.sendMessage({ type: 'HOST_PAYLOAD_READY', traceId: pendingTraceId, token });
            } catch {
                // ignore messaging failures
            }
        } else {
            const navSpan = perf.span('open_host_page', { openMode });
            events.push(navSpan.startEvent);
            await openHostPage(tab.id, token, openMode, traceId, tab.url);
            events.push(navSpan.end());
        }

        events.push(perf.event('processTab:end'));
        void recordPerf({ traceId, scope: 'background', events, meta: { ok: true, openMode, extractMethod } });

    } catch (err: any) {
        console.error('[Reader Helper] Error during process sequence:', err);
        events.push(perf.event('processTab:error', { stage: 'exception', error: err?.message || String(err) }));
        void recordPerf({ traceId, scope: 'background', events, meta: { ok: false } });
        await openErrorHost(tab, err.message || String(err));
    }
}

export async function openHostPage(sourceTabId: number, token: string, openMode: OpenMode, traceId?: string, sourceUrl?: string) {
    const hostUrl =
        browser.runtime.getURL('pages/reader-host.html') +
        `#token=${token}` +
        `${traceId ? `&trace=${encodeURIComponent(traceId)}` : ''}` +
        `${sourceUrl ? `&sourceUrl=${encodeURIComponent(sourceUrl)}` : ''}`;
    if (openMode === 'new-tab') {
        await browser.tabs.create({ url: hostUrl, active: true });
        return;
    }
    await browser.tabs.update(sourceTabId, { url: hostUrl, active: true });
}

export async function openHostPagePending(traceId: string, sourceUrl?: string) {
    const hostUrl =
        browser.runtime.getURL('pages/reader-host.html') +
        `#pending=1&trace=${encodeURIComponent(traceId)}${sourceUrl ? `&sourceUrl=${encodeURIComponent(sourceUrl)}` : ''}`;
    await browser.tabs.create({ url: hostUrl, active: true });
}

async function waitForTabLoad(tabId: number, timeoutMs = 10000): Promise<void> {
    const onUpdated = browser.tabs?.onUpdated;
    if (!onUpdated?.addListener) return;

    await new Promise<void>((resolve) => {
        const listener = (updatedId: number, changeInfo: { status?: string }) => {
            if (updatedId !== tabId) return;
            if (changeInfo.status !== 'complete') return;
            onUpdated.removeListener(listener);
            globalThis.clearTimeout(timer);
            resolve();
        };

        const timer = globalThis.setTimeout(() => {
            onUpdated.removeListener(listener);
            resolve();
        }, timeoutMs);

        onUpdated.addListener(listener);
    });
}

async function extractPayloadViaTempTab(url: string): Promise<RedditPostPayload> {
    const tempTab = await browser.tabs.create({ url, active: false });
    if (!tempTab?.id) throw new Error('Failed to create temp tab');

    try {
        await waitForTabLoad(tempTab.id);
        const results = await browser.scripting.executeScript({
            target: { tabId: tempTab.id },
            func: extractRedditPost
        });

        const result = results[0]?.result as ExtractionResult;
        if (!result || !result.ok) {
            throw new Error(result?.error || 'Unknown extraction error');
        }
        return result.payload;
    } finally {
        try {
            await browser.tabs.remove(tempTab.id);
        } catch {
            // ignore cleanup failures
        }
    }
}

async function extractPayloadWithFallback(
    url: string,
    events: ReturnType<typeof perf.event>[]
): Promise<{ payload: RedditPostPayload; method: 'json' | 'executeScript' }> {
    try {
        const jsonSpan = perf.span('extract_json');
        events.push(jsonSpan.startEvent);
        const fetched = await fetchRedditPostPayloadFromJson(url);
        events.push(jsonSpan.end({ ok: true, ...fetched.meta }));
        return { payload: fetched.payload, method: 'json' };
    } catch (err: any) {
        events.push(perf.event('extract_json:error', { error: err?.message || String(err) }));
        const execSpan = perf.span('extract_executeScript');
        events.push(execSpan.startEvent);
        const payload = await extractPayloadViaTempTab(url);
        events.push(execSpan.end({ ok: true }));
        return { payload, method: 'executeScript' };
    }
}

export async function openReaderViewForUrl(url: string) {
    const traceId = crypto.randomUUID();
    const events = [perf.event('openUrl:start', { url })];

    try {
        // Always open pending host (new-tab UX).
        const navSpan = perf.span('open_host_page', { openMode: 'new-tab', pending: true, source: 'link' });
        events.push(navSpan.startEvent);
        await openHostPagePending(traceId, url);
        events.push(navSpan.end());

        const extractOverall = perf.span('extract');
        events.push(extractOverall.startEvent);
        const { payload, method: extractMethod } = await extractPayloadWithFallback(url, events);
        events.push(extractOverall.end({ ok: true, method: extractMethod }));

        const token = await storePayloadForTrace(traceId, payload, url, events);

        try {
            await browser.runtime.sendMessage({ type: 'HOST_PAYLOAD_READY', traceId, token });
        } catch {
            // ignore
        }

        events.push(perf.event('openUrl:end'));
        void recordPerf({ traceId, scope: 'background', events, meta: { ok: true, openMode: 'new-tab', extractMethod } });
    } catch (err: any) {
        events.push(perf.event('openUrl:error', { error: err?.message || String(err) }));
        void recordPerf({ traceId, scope: 'background', events, meta: { ok: false, openMode: 'new-tab' } });
        await browser.runtime.sendMessage({ type: 'HOST_PAYLOAD_ERROR', traceId, error: err?.message || String(err) }).catch(() => undefined);
    }
}

async function openErrorHost(sourceTab: Tabs.Tab, errorMsg: string) {
    // Cap error length to avoid massive URLs
    const safeError = encodeURIComponent(errorMsg.slice(0, 500));
    const safeUrl = encodeURIComponent(sourceTab.url || 'unknown');

    const hostUrl = browser.runtime.getURL('pages/reader-host.html') +
        `#mode=error&error=${safeError}&url=${safeUrl}`;

    const openMode = await getOpenMode();
    if (openMode === 'new-tab' || !sourceTab.id) {
        await browser.tabs.create({ url: hostUrl, active: true });
        return;
    }
    await browser.tabs.update(sourceTab.id, { url: hostUrl, active: true });
}

// --- Listeners ---

// 1. Action Click
browser.action.onClicked.addListener((tab) => {
    processTab(tab);
});

// 2. Commands (Keyboard Shortcuts)
browser.commands.onCommand.addListener(async (command) => {
    if (command === 'open-reader-view') {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        if (tabs.length > 0) {
            processTab(tabs[0]);
        }
        return;
    }
});

// 3. Context Menus
browser.runtime.onInstalled.addListener(async () => {
    // Reset menus to avoid duplicates
    await browser.menus.removeAll();

    browser.menus.create({
        id: "open-reddit-reader",
        title: "Read in Reader View",
        contexts: ["page"],
        documentUrlPatterns: ["*://*.reddit.com/r/*/comments/*"]
    });

    browser.menus.create({
        id: "open-reddit-reader-link",
        title: "Open link in Reader View",
        contexts: ["link"],
        targetUrlPatterns: [
            "*://reddit.com/r/*/comments/*",
            "*://*.reddit.com/r/*/comments/*"
        ],
    } as any);
});

browser.menus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "open-reddit-reader" && tab) {
        processTab(tab);
        return;
    }
    if (info.menuItemId === "open-reddit-reader-link") {
        const linkUrl = (info as any).linkUrl as string | undefined;
        if (typeof linkUrl === 'string' && linkUrl) {
            void openReaderViewForUrl(linkUrl);
        }
    }
});

type StoredTrace = PerfReport & { createdAt: number };

async function recordPerf(report: PerfReport) {
    if (!SHOULD_RECORD_PERF) return;
    const entry: StoredTrace = { ...report, createdAt: Date.now() };
    try {
        const existing = await browser.storage.local.get('perf_traces');
        const traces = Array.isArray(existing.perf_traces) ? (existing.perf_traces as StoredTrace[]) : [];
        traces.push(entry);
        // Keep last 50
        const next = traces.slice(-50);
        await browser.storage.local.set({ perf_traces: next });
    } catch {
        // ignore storage failures
    }

    // Log a small summary for quick inspection.
    try {
        const summary = summarize(report.events);
        console.log('[Perf]', report.scope, report.traceId, summary);
    } catch {
        // ignore
    }
}

async function handleHostPayloadRequest(traceId: string, url: string): Promise<void> {
    const events = [perf.event('host_request:start', { traceId, url })];
    try {
        const extractOverall = perf.span('extract');
        events.push(extractOverall.startEvent);
        const { payload, method: extractMethod } = await extractPayloadWithFallback(url, events);
        events.push(extractOverall.end({ ok: true, method: extractMethod }));

        const token = await storePayloadForTrace(traceId, payload, url, events);

        try {
            await browser.runtime.sendMessage({ type: 'HOST_PAYLOAD_READY', traceId, token });
        } catch {
            // ignore
        }

        events.push(perf.event('host_request:end'));
        void recordPerf({ traceId, scope: 'background', events, meta: { ok: true, source: 'host_request', extractMethod } });
    } catch (err: any) {
        events.push(perf.event('host_request:error', { error: err?.message || String(err) }));
        void recordPerf({ traceId, scope: 'background', events, meta: { ok: false, source: 'host_request' } });
        await browser.runtime.sendMessage({ type: 'HOST_PAYLOAD_ERROR', traceId, error: err?.message || String(err) }).catch(() => undefined);
    }
}

installRuntimeMessageListener({
    onPerfReport: (report) => {
        void recordPerf(report);
    },
    onHostPayloadRequest: handleHostPayloadRequest,
    onCommentsCacheGet: getCachedComments,
    onCommentsCacheSet: setCachedComments,
});
