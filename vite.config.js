import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    assetsInlineLimit: 100 * 1024 * 1024,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        manualChunks: undefined,
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
  base: './',
  plugins: [inlineAssetsPlugin()],
});

/**
 * Post-build plugin: inlines the single JS chunk and CSS file into index.html
 * so the output is a fully self-contained single file.
 */
function inlineAssetsPlugin() {
  return {
    name: 'inline-assets',
    enforce: /** @type {'post'} */ ('post'),
    generateBundle(_options, bundle) {
      const htmlChunk = /** @type {any} */ (bundle['index.html']);
      if (!htmlChunk) return;

      let html = /** @type {string} */ (htmlChunk.source);

      for (const [, chunk] of Object.entries(bundle)) {
        const c = /** @type {any} */ (chunk);
        if (c.type === 'chunk') {
          html = html.replace(
            new RegExp(
              `<script[^>]+src=["'][^"']*${escRe(c.fileName.split('/').pop())}[^"']*["'][^>]*></script>`,
              'g',
            ),
            `<script type="module">${c.code}</script>`,
          );
        } else if (c.type === 'asset' && c.fileName.endsWith('.css')) {
          html = html.replace(
            new RegExp(
              `<link[^>]+href=["'][^"']*${escRe(c.fileName.split('/').pop())}[^"']*["'][^>]*>`,
              'g',
            ),
            `<style>${c.source}</style>`,
          );
        }
      }

      htmlChunk.source = html;

      // Remove now-inlined assets from the bundle
      for (const key of Object.keys(bundle)) {
        if (key === 'index.html') continue;
        const c = /** @type {any} */ (bundle[key]);
        if (c.type === 'chunk' || (c.type === 'asset' && key.endsWith('.css'))) {
          delete bundle[key];
        }
      }
    },
  };
}

function escRe(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
