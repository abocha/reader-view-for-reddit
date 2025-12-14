import browser from 'webextension-polyfill';
import { RedditPostPayload } from '../content/reddit-extract';

console.log("[Reader Host] Script loaded");

async function init() {
    const hash = window.location.hash.slice(1); // remove #
    const params = new URLSearchParams(hash);

    // Check for Error Mode
    if (params.get('mode') === 'error' || params.has('error')) {
        const errorMsg = params.get('error') || 'Unknown error';
        const origUrl = params.get('url');
        renderErrorMode(errorMsg, origUrl);
        return;
    }

    const token = params.get('token');
    if (!token) {
        renderErrorMode("No token provided");
        return;
    }

    await initTokenProtocol(token);
}

async function initTokenProtocol(token: string) {
    // 2. Retrieve Payload from Session Storage
    const data = await browser.storage.session.get(token);
    const payload = data[token] as RedditPostPayload | undefined;

    if (!payload) {
        renderErrorMode("Article data expired or not found. Please try extracting again.");
        return;
    }

    // 3. Cleanup Storage immediately
    await browser.storage.session.remove(token);

    // 4. Render Content
    renderArticle(payload);
    initPreferences(); // Initialize Themes & Fonts

    // 5. Signal Ready (Optional, for logging)
    try {
        await browser.runtime.sendMessage({ type: 'READER_CONTENT_READY' });
    } catch (e) { /* ignore */ }
}

function initPreferences() {
    // 1. Restore Saved State
    const savedTheme = localStorage.getItem('reader-theme') || 'light';
    const savedFont = localStorage.getItem('reader-font') || 'serif';
    const savedAlign = localStorage.getItem('reader-align') || 'left';

    // Apply classes
    document.body.classList.add(`theme-${savedTheme}`);
    document.body.classList.add(`font-${savedFont}`);
    document.body.classList.add(`align-${savedAlign}`);

    updateActiveControls(savedTheme, savedFont, savedAlign);

    // 2. Event Delegation
    const toolbar = document.getElementById('reader-toolbar');
    toolbar?.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;

        // Handle Theme Click
        const theme = target.getAttribute('data-theme');
        if (theme) {
            // Remove old theme classes
            document.body.classList.forEach(cls => {
                if (cls.startsWith('theme-')) document.body.classList.remove(cls);
            });

            document.body.classList.add(`theme-${theme}`);
            localStorage.setItem('reader-theme', theme);
            updateActiveControls(theme, null, null);
        }

        // Handle Font Click
        const font = target.getAttribute('data-font');
        if (font) {
            // Remove old font classes
            document.body.classList.forEach(cls => {
                if (cls.startsWith('font-')) document.body.classList.remove(cls);
            });

            document.body.classList.add(`font-${font}`);
            localStorage.setItem('reader-font', font);
            updateActiveControls(null, font, null);
        }

        // Handle Align Click
        const align = target.getAttribute('data-align');
        if (align) {
            document.body.classList.forEach(cls => {
                if (cls.startsWith('align-')) document.body.classList.remove(cls);
            });
            document.body.classList.add(`align-${align}`);
            localStorage.setItem('reader-align', align);
            updateActiveControls(null, null, align);
        }
    });
}

function updateActiveControls(activeTheme: string | null, activeFont: string | null, activeAlign: string | null) {
    if (activeTheme) {
        document.querySelectorAll('.theme-btn').forEach(btn => {
            if (btn.getAttribute('data-theme') === activeTheme) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    }

    if (activeFont) {
        document.querySelectorAll('.font-btn').forEach(btn => {
            if (btn.getAttribute('data-font') === activeFont) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    }

    if (activeAlign) {
        document.querySelectorAll('.align-btn').forEach(btn => {
            if (btn.getAttribute('data-align') === activeAlign) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    }
}

function renderErrorMode(msg: string, url?: string | null) {
    const articleEl = document.getElementById('spike-article');
    if (!articleEl) return;

    // Wire up theme even in error mode
    initPreferences();

    articleEl.replaceChildren();

    const header = document.createElement('header');
    header.style.cssText = 'border-bottom: 2px solid #ef4444; padding-bottom: 10px; margin-bottom: 20px;';

    const title = document.createElement('h1');
    title.style.cssText = 'color: #b91c1c;';
    title.textContent = 'Reader View Unavailable';
    header.appendChild(title);

    const section = document.createElement('section');
    section.className = 'content';

    const intro = document.createElement('p');
    intro.style.cssText = 'font-size: 1.1em; color: #374151;';
    intro.textContent = "We couldn't extract the content from this page.";
    section.appendChild(intro);

    const errorBox = document.createElement('div');
    errorBox.style.cssText = 'background: #fee2e2; border-left: 4px solid #ef4444; padding: 15px; margin: 20px 0; font-family: monospace; color: #b91c1c;';
    errorBox.textContent = msg;
    section.appendChild(errorBox);

    const parsedUrl = url ? parseHttpUrl(url) : null;
    if (parsedUrl) {
        const actions = document.createElement('div');
        actions.style.cssText = 'margin-top: 20px;';

        const link = document.createElement('a');
        link.href = parsedUrl.toString();
        link.style.cssText = 'background: #0079D3; color: white; padding: 10px 20px; text-decoration: none; border-radius: 4px; font-weight: bold;';
        link.textContent = 'Open Original Post';

        actions.appendChild(link);
        section.appendChild(actions);
    }

    articleEl.append(header, section);

    document.title = "Error - Reader Helper";
}


function renderArticle(post: RedditPostPayload) {
    const articleEl = document.getElementById('spike-article');
    if (!articleEl) return;

    articleEl.replaceChildren();

    const header = document.createElement('header');

    const title = document.createElement('h1');
    title.textContent = post.title;
    header.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.style.cssText = 'color:var(--meta-color); font-size:0.9em; margin-bottom:2em; border-bottom: 1px solid rgba(125,125,125,0.2); padding-bottom: 20px;';
    meta.append(document.createTextNode(`${post.subreddit} • u/${post.author} `));

    if (post.isFallback) {
        const fallbackBadge = document.createElement('span');
        fallbackBadge.style.cssText = 'background:#fef3c7; color:#92400e; padding:2px 6px; border-radius:4px; font-size:0.8em; margin-left:8px;';
        fallbackBadge.textContent = 'Extracted via Fallback';
        meta.appendChild(fallbackBadge);
    }

    meta.appendChild(document.createElement('br'));

    const parsedOriginalUrl = parseHttpUrl(post.url);
    if (parsedOriginalUrl) {
        const originalLink = document.createElement('a');
        originalLink.href = parsedOriginalUrl.toString();
        originalLink.target = '_blank';
        originalLink.rel = 'noopener noreferrer';
        originalLink.style.cssText = 'color:var(--meta-color); opacity: 0.8;';
        originalLink.textContent = 'View Original Discussion on Reddit';
        meta.appendChild(originalLink);
    }

    header.appendChild(meta);

    const content = document.createElement('section');
    content.className = 'content';

    const bodyFragment = sanitizeHtmlToFragment(post.bodyHtml || '');
    const hasBody = bodyFragment.childNodes.length > 0;

    if (hasBody) {
        content.appendChild(bodyFragment);
    } else if (post.linkUrl) {
        const parsedLinkUrl = parseHttpUrl(post.linkUrl);
        const domain = parsedLinkUrl?.hostname.replace(/^www\./, '') || null;

        const metaSummary = document.createElement('div');
        metaSummary.style.cssText = 'background: rgba(125,125,125,0.05); padding: 15px; border-radius: 8px; margin-bottom: 20px;';

        const summaryP = document.createElement('p');
        summaryP.style.cssText = 'margin: 0;';

        const label = document.createElement('strong');
        label.textContent = 'Link Post Context:';
        summaryP.append(label, document.createTextNode(' This submission links directly to '));

        if (parsedLinkUrl && domain) {
            summaryP.appendChild(document.createTextNode('external content on '));
            const externalLink = document.createElement('a');
            externalLink.href = parsedLinkUrl.toString();
            externalLink.rel = 'noopener noreferrer';
            const strongDomain = document.createElement('strong');
            strongDomain.textContent = domain;
            externalLink.appendChild(strongDomain);
            summaryP.append(externalLink, document.createTextNode('. '));
        } else {
            summaryP.appendChild(document.createTextNode("an external link, but the URL couldn't be parsed: "));
            const code = document.createElement('code');
            code.textContent = post.linkUrl;
            summaryP.append(code, document.createTextNode('. '));
        }

        summaryP.appendChild(document.createTextNode('There is no text body in the original post.'));
        metaSummary.appendChild(summaryP);
        content.appendChild(metaSummary);

        const linkCard = document.createElement('div');
        linkCard.className = 'link-card';
        linkCard.style.cssText = 'border: 1px solid var(--meta-color); padding: 20px; border-radius: 8px; background: rgba(125,125,125,0.05); margin-bottom: 30px; overflow: hidden; display: flex; align-items: center;';

        const parsedThumbUrl = post.thumbnail ? parseHttpUrl(post.thumbnail) : null;
        if (parsedThumbUrl) {
            const img = document.createElement('img');
            img.src = parsedThumbUrl.toString();
            img.alt = '';
            img.style.cssText = 'float:left; margin-right:15px; border-radius:4px; max-width:100px;';
            linkCard.appendChild(img);
        }

        const linkCardBody = document.createElement('div');
        linkCardBody.style.cssText = 'flex:1;';

        const h3 = document.createElement('h3');
        h3.style.cssText = 'margin-top:0; margin-bottom: 10px;';
        if (parsedLinkUrl) {
            const titleLink = document.createElement('a');
            titleLink.href = parsedLinkUrl.toString();
            titleLink.style.cssText = 'text-decoration:none; color:var(--link-color);';
            titleLink.rel = 'noopener noreferrer';
            titleLink.textContent = post.title;
            h3.appendChild(titleLink);
        } else {
            h3.textContent = post.title;
        }

        const p = document.createElement('p');
        p.style.cssText = 'color:var(--meta-color); margin:0;';
        p.textContent = domain || 'External link';

        linkCardBody.append(h3, p);
        linkCard.appendChild(linkCardBody);
        content.appendChild(linkCard);
    } else {
        const p = document.createElement('p');
        const em = document.createElement('em');
        em.textContent = '(No text content found in this post)';
        p.appendChild(em);
        content.appendChild(p);
    }

    articleEl.append(header, content);

    // Update document title for history/tab
    document.title = post.title;
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

function sanitizeHtmlToFragment(dirtyHtml: string): DocumentFragment {
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
            const parsed = parseHttpUrl(href);
            if (!parsed) {
                element.removeAttribute('href');
            } else {
                element.setAttribute('href', parsed.toString());
                element.setAttribute('rel', 'noopener noreferrer');
                element.setAttribute('target', '_blank');
            }
        }
    }
}

document.addEventListener('DOMContentLoaded', init);
