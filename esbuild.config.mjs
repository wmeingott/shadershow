import * as esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const watch = process.argv.includes('--watch');

// Resolve @alias/foo.js → src/alias/foo.ts (TypeScript convention: import with .js, resolve to .ts)
function resolveAlias(prefix, dir) {
  return {
    filter: new RegExp(`^${prefix}/`),
    fn: (args) => {
      let rel = args.path.replace(`${prefix}/`, '');
      // .js → .ts for TypeScript source files
      if (rel.endsWith('.js')) rel = rel.slice(0, -3) + '.ts';
      return { path: path.resolve(__dirname, dir, rel) };
    },
  };
}

const aliases = [
  resolveAlias('@shared', 'src/shared'),
  resolveAlias('@main', 'src/main'),
  resolveAlias('@renderer', 'src/renderer'),
  resolveAlias('@fullscreen', 'src/fullscreen'),
];

const aliasPlugin = {
  name: 'path-aliases',
  setup(build) {
    for (const { filter, fn } of aliases) {
      build.onResolve({ filter }, fn);
    }
  },
};

// Main process (CJS for Electron main)
const mainConfig = {
  entryPoints: ['src/main/app.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outdir: 'dist/main',
  sourcemap: true,
  external: [
    'electron',
    'grandiose',
    'grandiose-mac',
    'node-syphon',
    'ffmpeg-static',
    'three',
    '@babel/standalone',
  ],
  plugins: [aliasPlugin],
  logLevel: 'info',
};

// Renderer process (ESM bundle for browser)
const rendererConfig = {
  entryPoints: ['src/renderer/app.ts'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  outdir: 'dist/renderer',
  sourcemap: true,
  external: [
    // These are loaded via <script> tags or lazy import
    'ace-builds',
    'three',
    '@babel/standalone',
  ],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  plugins: [aliasPlugin],
  logLevel: 'info',
};

// Fullscreen renderer process (ESM bundle for browser)
const fullscreenConfig = {
  entryPoints: ['src/fullscreen/app.ts'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  outdir: 'dist/fullscreen',
  sourcemap: true,
  external: [
    'three',
    '@babel/standalone',
  ],
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  plugins: [aliasPlugin],
  logLevel: 'info',
};

// Preload scripts (CJS for Electron preload)
const preloadConfig = {
  entryPoints: [
    'src/preload/preload.ts',
    'src/preload/preload-dialog.ts',
    'src/preload/preload-texture-dialog.ts',
  ],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outdir: 'dist/preload',
  sourcemap: true,
  external: ['electron'],
  plugins: [aliasPlugin],
  logLevel: 'info',
};

async function build() {
  if (watch) {
    const contexts = await Promise.all([
      esbuild.context(mainConfig),
      esbuild.context(rendererConfig),
      esbuild.context(fullscreenConfig),
      esbuild.context(preloadConfig),
    ]);
    await Promise.all(contexts.map(ctx => ctx.watch()));
    console.log('Watching for changes...');
  } else {
    const start = Date.now();
    await Promise.all([
      esbuild.build(mainConfig),
      esbuild.build(rendererConfig),
      esbuild.build(fullscreenConfig),
      esbuild.build(preloadConfig),
    ]);
    console.log(`Build completed in ${Date.now() - start}ms`);
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
