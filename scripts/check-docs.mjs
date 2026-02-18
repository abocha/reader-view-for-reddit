#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();

const requiredDocs = [
    {
        path: 'README.md',
        headings: ['Documentation Map'],
    },
    {
        path: 'DESIGN.md',
        headings: ['Purpose', 'Module Map', 'Invariants'],
    },
    {
        path: 'RELIABILITY.md',
        headings: ['Reliability Goals', 'Failure Modes and Handling', 'Regression Checklist'],
    },
    {
        path: 'SECURITY.md',
        headings: ['Trust Boundaries', 'Security Controls', 'Required Review Checklist for Changes'],
    },
    {
        path: 'PLANS.md',
        headings: ['Plan Types', 'Directory Layout', 'Status Conventions'],
    },
];

const requiredPlanTemplates = [
    'plans/templates/lightweight-plan.md',
    'plans/templates/execution-plan.md',
];

let warnings = 0;

function emitWarning(file, message) {
    warnings += 1;
    const prefix = file ? `${file}: ` : '';
    console.warn(`WARN ${prefix}${message}`);
    if (process.env.GITHUB_ACTIONS === 'true') {
        const filePart = file ? `file=${file},` : '';
        console.log(`::warning ${filePart}title=Docs Check::${message}`);
    }
}

function readFile(filePath) {
    const abs = path.join(root, filePath);
    if (!fs.existsSync(abs)) return null;
    return fs.readFileSync(abs, 'utf8');
}

function getHeadings(markdown) {
    const headings = [];
    const lines = markdown.split(/\r?\n/);
    for (const line of lines) {
        const m = line.match(/^#{1,6}\s+(.+?)\s*$/);
        if (m) headings.push(m[1].trim().toLowerCase());
    }
    return headings;
}

function collectLinks(markdown) {
    const links = [];
    const re = /\[[^\]]+\]\(([^)]+)\)/g;
    let m;
    while ((m = re.exec(markdown)) !== null) {
        links.push(m[1].trim());
    }
    return links;
}

function isExternalLink(link) {
    return (
        link.startsWith('http://') ||
        link.startsWith('https://') ||
        link.startsWith('mailto:') ||
        link.startsWith('tel:')
    );
}

function checkRequiredDocs() {
    for (const doc of requiredDocs) {
        const body = readFile(doc.path);
        if (body === null) {
            emitWarning(doc.path, 'missing required documentation file');
            continue;
        }
        const headings = getHeadings(body);
        for (const requiredHeading of doc.headings) {
            if (!headings.includes(requiredHeading.toLowerCase())) {
                emitWarning(doc.path, `missing required heading "${requiredHeading}"`);
            }
        }
    }
}

function checkTemplatePresence() {
    for (const filePath of requiredPlanTemplates) {
        if (!fs.existsSync(path.join(root, filePath))) {
            emitWarning(filePath, 'missing required plan template');
        }
    }
}

function checkLocalLinks() {
    const markdownFiles = fs
        .readdirSync(root, { withFileTypes: true });

    const queue = markdownFiles
        .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.md'))
        .map((d) => d.name);

    const plansDir = path.join(root, 'plans');
    if (fs.existsSync(plansDir)) {
        const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
                    queue.push(path.relative(root, full));
                }
            }
        };
        walk(plansDir);
    }

    for (const mdFile of [...new Set(queue)]) {
        const body = readFile(mdFile);
        if (body === null) continue;
        const links = collectLinks(body);
        for (const link of links) {
            if (!link || isExternalLink(link) || link.startsWith('#')) continue;
            const [filePart] = link.split('#');
            if (!filePart) continue;
            const target = path.normalize(path.join(path.dirname(mdFile), filePart));
            const abs = path.join(root, target);
            if (!fs.existsSync(abs)) {
                emitWarning(mdFile, `broken local link target "${link}"`);
            }
        }
    }
}

checkRequiredDocs();
checkTemplatePresence();
checkLocalLinks();

if (warnings === 0) {
    console.log('Docs check passed with no warnings.');
} else {
    console.log(`Docs check completed with ${warnings} warning(s). Non-blocking by design.`);
}

process.exit(0);
