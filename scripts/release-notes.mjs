import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

function run(cmd, args = []) {
    return execFileSync(cmd, args, {
        stdio: 'pipe',
        encoding: 'utf8',
    }).trim();
}

function getArg(name, fallback = '') {
    const idx = process.argv.indexOf(name);
    if (idx === -1) return fallback;
    return process.argv[idx + 1] ?? fallback;
}

const tag = getArg('--tag', process.env.GITHUB_REF_NAME || '');
const output = getArg('--output', 'release-notes.md');

if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    console.error(`Expected semver tag like v1.2.3, got: "${tag}"`);
    process.exit(1);
}

const version = tag.slice(1);

function resolveRepoSlug() {
    if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
    try {
        const remote = run('git', ['remote', 'get-url', 'origin']);
        const match = remote.match(/github\.com[/:]([^/]+\/[^/.]+)(?:\.git)?$/);
        return match?.[1] ?? '';
    } catch {
        return '';
    }
}

const repo = resolveRepoSlug();

const allTags = run('git', ['tag', '--list', 'v*.*.*', '--sort=v:refname'])
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .filter(t => /^v\d+\.\d+\.\d+$/.test(t));

const currentIdx = allTags.indexOf(tag);
const previousTag = currentIdx > 0 ? allTags[currentIdx - 1] : '';

const range = previousTag ? `${previousTag}..${tag}` : tag;
const commitsRaw = run('git', ['log', '--oneline', '--no-merges', range]);
const commits = commitsRaw
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean);

const highlights = commits.slice(0, 3).map(line => {
    const firstSpace = line.indexOf(' ');
    return firstSpace === -1 ? line : line.slice(firstSpace + 1);
});

const artifactName = `reader_view_for_reddit-${version}.zip`;
const artifactPath = `web-ext-artifacts/${artifactName}`;
const changelog = previousTag && repo
    ? `https://github.com/${repo}/compare/${previousTag}...${tag}`
    : '';

const notes = [
    '## Highlights',
    '',
    ...(highlights.length > 0 ? highlights.map(item => `- ${item}`) : ['- Maintenance release']),
    '',
    '## Included Commits',
    '',
    ...(commits.length > 0 ? commits.map(item => `- ${item}`) : ['- (No commits found for range)']),
    '',
    '## Verification',
    '',
    '- `pnpm typecheck`',
    '- `pnpm test`',
    '- `pnpm package` (includes build)',
    '',
    '## Artifact',
    '',
    `- ${artifactPath}`,
    '',
    '## Full Changelog',
    '',
    ...(changelog ? [`- ${changelog}`] : ['- (Unavailable: previous semver tag or repository context not found)']),
    '',
].join('\n');

writeFileSync(output, notes, 'utf8');
console.log(`Release notes written to ${output}`);
