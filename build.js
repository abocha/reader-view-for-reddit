import { context as _context } from 'esbuild';
import { emptyDir, copy } from 'fs-extra';
import path from 'path';

const isDev = process.argv.includes('--dev');

async function build() {
    // Clean dist
    await emptyDir('dist');

    // Copy static assets
    await copy('manifest.json', 'dist/manifest.json');
    await copy('src/pages', 'dist/pages', {
        filter: (src) => !src.endsWith('.ts') // Don't copy usage sources
    });

    // Bundle TS
    const context = await _context({
        entryPoints: {
            'background': 'src/background/index.ts',
            'pages/reader-host': 'src/pages/reader-host.ts'
        },
        bundle: true,
        outdir: 'dist',
        platform: 'browser',
        target: ['firefox142'], // MV3 Firefox target
        sourcemap: isDev ? 'inline' : false,
        minify: !isDev,
        logLevel: 'info',
    });

    if (isDev) {
        await context.watch();
        console.log('Watching for changes...');
    } else {
        await context.rebuild();
        await context.dispose();
        console.log('Build complete.');
    }
}

build().catch(err => {
    console.error(err);
    process.exit(1);
});
