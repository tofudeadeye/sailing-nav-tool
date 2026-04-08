import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
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
 *
 * Uses generateBundle so we have direct access to chunk code/source rather
 * than relying on fragile regex against the emitted script/link tag attributes.
 */
function inlineAssetsPlugin() {
  return {
    name: 'inline-assets',
    enforce: /** @type {'post'} */ ('post'),
    generateBundle(_options, bundle) {
      const htmlChunk = /** @type {any} */ (bundle['index.html']);
      if (!htmlChunk) return;

      let html = /** @type {string} */ (htmlChunk.source);

      // Collect JS chunks and CSS assets, keyed by filename (no path)
      const jsChunks = /** @type {Map<string, string>} */ (new Map());
      const cssAssets = /** @type {Map<string, string>} */ (new Map());

      for (const [key, chunk] of Object.entries(bundle)) {
        if (key === 'index.html') continue;
        const c = /** @type {any} */ (chunk);
        const basename = key.split('/').pop();
        if (c.type === 'chunk') {
          jsChunks.set(basename, c.code);
        } else if (c.type === 'asset' && key.endsWith('.css')) {
          cssAssets.set(basename, String(c.source));
        }
      }

      // Replace <script ... src="...filename..."> tags (any attributes, self-closing or not)
      html = html.replace(
        /<script([^>]*)\ssrc=["']([^"']+)["']([^>]*)>\s*<\/script>/g,
        (_match, _pre, src, _post) => {
          const basename = src.split('/').pop().split('?')[0];
          const code = jsChunks.get(basename);
          return code != null ? `<script type="module">${code}</script>` : _match;
        },
      );

      // Replace <link rel="stylesheet" href="...filename..."> tags
      html = html.replace(
        /<link([^>]*)\shref=["']([^"']+)["']([^>]*)>/g,
        (_match, pre, href, post) => {
          const basename = href.split('/').pop().split('?')[0];
          const css = cssAssets.get(basename);
          if (css == null) return _match;
          // Only replace stylesheet links, not preload/modulepreload
          const combined = pre + post;
          if (/rel=["'][^"']*stylesheet[^"']*["']/.test(combined) || /rel=["'][^"']*stylesheet[^"']*["']/.test(_match)) {
            return `<style>${css}</style>`;
          }
          return _match;
        },
      );

      htmlChunk.source = html;

      // Remove inlined assets from the bundle so they aren't written to disk
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
