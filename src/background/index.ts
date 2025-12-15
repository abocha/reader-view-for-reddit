import browser, { Tabs } from 'webextension-polyfill';
import { extractRedditPost, ExtractionResult } from '../content/reddit-extract';

// --- Core Logic ---

async function processTab(tab: Tabs.Tab) {
    if (!tab.id || !tab.url) {
        console.warn('[Reader Helper] processTab: invalid tab', tab);
        return;
    }

    console.log('[Reader Helper] Processing tab:', tab.id, tab.url);

    try {
        // 1. Inject Extraction Logic
        console.log('[Reader Helper] Injecting script...');
        const results = await browser.scripting.executeScript({
            target: { tabId: tab.id },
            func: extractRedditPost
        });

        // scripting.executeScript returns array of results (one per frame)
        const result = results[0]?.result as ExtractionResult;

        if (!result || !result.ok) {
            console.error('[Reader Helper] Extraction failed:', result?.error);
            await openErrorHost(tab, result?.error || 'Unknown extraction error');
            return;
        }

        console.log('[Reader Helper] Extraction success:', result.payload.title);

        // 2. Generate Token & Store Payload
        const token = crypto.randomUUID();
        await browser.storage.session.set({
            [token]: result.payload
        });

        // 3. Open Host Page
        await openHostPage(token);

    } catch (err: any) {
        console.error('[Reader Helper] Error during process sequence:', err);
        await openErrorHost(tab, err.message || String(err));
    }
}

async function openHostPage(token: string) {
    const hostUrl = browser.runtime.getURL('pages/reader-host.html') + `#token=${token}`;
    await browser.tabs.create({
        url: hostUrl,
        active: true
    });
}

async function openErrorHost(sourceTab: Tabs.Tab, errorMsg: string) {
    // Cap error length to avoid massive URLs
    const safeError = encodeURIComponent(errorMsg.slice(0, 500));
    const safeUrl = encodeURIComponent(sourceTab.url || 'unknown');

    const hostUrl = browser.runtime.getURL('pages/reader-host.html') +
        `#mode=error&error=${safeError}&url=${safeUrl}`;

    await browser.tabs.create({
        url: hostUrl,
        active: true
    });
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
});

browser.menus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "open-reddit-reader" && tab) {
        processTab(tab);
    }
});
