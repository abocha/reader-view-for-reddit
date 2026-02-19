import { execFileSync } from 'node:child_process';
import { accessSync, readFileSync } from 'node:fs';

function run(cmd, args = []) {
    return execFileSync(cmd, args, {
        stdio: 'pipe',
        encoding: 'utf8',
    }).trim();
}

function runStreaming(cmd, args = []) {
    execFileSync(cmd, args, { stdio: 'inherit' });
}

function getArg(name, fallback = '') {
    const idx = process.argv.indexOf(name);
    if (idx === -1) return fallback;
    return process.argv[idx + 1] ?? fallback;
}

const explicitTag = getArg('--tag', '');
const explicitVersion = getArg('--version', '');
const repo = getArg('--repo', 'abocha/reader-view-for-reddit');

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const version = explicitVersion || manifest.version;
const tag = explicitTag || `v${version}`;

if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    console.error(`Invalid tag: ${tag}`);
    process.exit(1);
}
if (!/^\d+\.\d+\.\d+$/.test(version)) {
    console.error(`Invalid version: ${version}`);
    process.exit(1);
}

runStreaming('pnpm', ['run', 'package']);

const artifact = `web-ext-artifacts/reader_view_for_reddit-${version}.zip`;
accessSync(artifact);

runStreaming('gh', ['release', 'upload', tag, artifact, '--repo', repo, '--clobber']);

const url = run('gh', ['release', 'view', tag, '--repo', repo, '--json', 'url', '--jq', '.url']);
console.log('');
console.log(`Asset uploaded: ${artifact}`);
console.log(`Release URL: ${url}`);
