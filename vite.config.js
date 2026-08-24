import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// Sub-paths under /world/ (e.g. /world/palo-alto) are a real, bookmarkable
// URL for a specific location — main.js reads the path on load and jumps
// straight there (see syncToPath) — but there's no actual file at that
// path, only /world/index.html itself. Without this, Vite's dev server (no
// file match) falls through to its SPA default, which is the *root*
// index.html — a plain redirect stub (see its own comment) — landing every
// deep link back at the plain /world/ overview instead of the location it
// named. This middleware serves world/index.html's actual content for any
// /world/* request that isn't a real file, so the client-side router in
// main.js gets a chance to read the path at all. GitHub Pages needs the
// equivalent as a static 404.html fallback, since it can't run middleware —
// see world/404.html.
function worldSubpathFallback() {
  return {
    name: 'world-subpath-fallback',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url && /^\/world\/[^/]+\/?($|\?)/.test(req.url)) {
          req.url = '/world/';
        }
        next();
      });
    },
  };
}

export default defineConfig({
  base: '/',
  plugins: [worldSubpathFallback()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      // Multi-page build: the 3D experience lives at /world (a real static
      // file, not a client-side route — GitHub Pages has no server to run
      // a history-API router, so a plain HTML entry per path is what
      // actually makes /world a working, bookmarkable, deep-linkable URL).
      // Root index.html is just a redirect into it.
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        world: fileURLToPath(new URL('./world/index.html', import.meta.url)),
      },
    },
  },
});
