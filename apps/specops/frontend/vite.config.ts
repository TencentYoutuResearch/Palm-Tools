import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// SpecOps server embeds static assets at COMPILE TIME via
// `import X from './public/<file>' with { type: 'text' }`
// (see apps/specops/src/server/index.ts). The sidecar is produced by
// `bun build --compile`, so every produced filename MUST be known ahead of
// time and match the server's asset whitelist (index.html / app.js / styles.css).
//
// Therefore: fixed output names, NO hashing, single bundle, single CSS file,
// and NO inline module-preload (the server CSP is `script-src 'self'` with no
// `unsafe-inline`).
export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: '../src/server/public',
    emptyOutDir: false, // keep hand-authored assets until migration removes them
    cssCodeSplit: false,
    modulePreload: false, // avoid inline preload <script> that CSP would block
    assetsInlineLimit: 100_000_000, // inline small assets so no extra files leak out
    target: 'es2022',
    rollupOptions: {
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: 'app.js',
        assetFileNames: 'styles.css',
        manualChunks: undefined, // single bundle, no code splitting
        inlineDynamicImports: true,
      },
    },
  },
  server: {
    port: 5199,
    proxy: {
      '/api': {
        target: process.env.SPECOPS_ORIGIN || 'http://127.0.0.1:47900',
        changeOrigin: true,
        // SSE (/api/events) must stream — disable buffering.
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-store';
            }
          });
        },
      },
    },
  },
});
