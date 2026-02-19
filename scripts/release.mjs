import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const bumpType = process.argv[2];
const ALLOWED_BUMPS = new Set(['patch', 'minor', 'major']);

if (!ALLOWED_BUMPS.has(bumpType)) {
    console.error('Usage: node scripts/release.mjs <patch|minor|major>');
    process.exit(1);
}

function run(cmd, args = [], options = {}) {
    return execFileSync(cmd, args, {
        stdio: 'pipe',
        encoding: 'utf8',
        ...options,
    }).trim();
}

function runStreaming(cmd, args = []) {
    execFileSync(cmd, args, { stdio: 'inherit' });
}

function bumpSemver(version, type) {
    const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!match) {
        throw new Error(`Unsupported version format: ${version}`);
    }

    let major = Number.parseInt(match[1], 10);
    let minor = Number.parseInt(match[2], 10);
    let patch = Number.parseInt(match[3], 10);

    if (type === 'major') {
        major += 1;
        minor = 0;
        patch = 0;
    } else if (type === 'minor') {
        minor += 1;
        patch = 0;
    } else {
        patch += 1;
    }

    return `${major}.${minor}.${patch}`;
}

function assertCleanWorkingTree() {
    const status = run('git', ['status', '--porcelain']);
    if (status.length > 0) {
        throw new Error('Working tree is not clean. Commit or stash changes before releasing.');
    }
}

function assertMainBranch() {
    const branch = run('git', ['branch', '--show-current']);
    if (branch !== 'main') {
        throw new Error(`Release must run from main. Current branch: ${branch}`);
    }
}

function loadJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

function saveJson(path, value) {
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function main() {
    assertCleanWorkingTree();
    assertMainBranch();

    runStreaming('pnpm', ['run', 'release:preflight']);

    const pkg = loadJson('package.json');
    const manifest = loadJson('manifest.json');

    if (pkg.version !== manifest.version) {
        throw new Error(`Version mismatch before bump: package.json=${pkg.version}, manifest.json=${manifest.version}`);
    }

    const nextVersion = bumpSemver(pkg.version, bumpType);
    pkg.version = nextVersion;
    manifest.version = nextVersion;

    saveJson('package.json', pkg);
    saveJson('manifest.json', manifest);

    runStreaming('git', ['add', 'package.json', 'manifest.json']);
    runStreaming('git', ['commit', '-m', `release ${nextVersion}`]);
    runStreaming('git', ['tag', '-a', `v${nextVersion}`, '-m', `v${nextVersion}`]);
    runStreaming('git', ['push']);
    runStreaming('git', ['push', 'origin', `v${nextVersion}`]);

    console.log('');
    console.log(`Released v${nextVersion}.`);
    console.log('GitHub Actions will build/package and publish the release artifact from tag CI.');
}

main();
