import { defineConfig, type Plugin } from "vite";
import { handleApi } from "./server/api.ts";

/**
 * Keeps everything in one process: the Vite dev server also serves the
 * read-only filesystem API under /api/* via connect middleware.
 */
function filesystemApi(): Plugin {
  return {
    name: "claude-code-log-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        try {
          const handled = await handleApi(req, res);
          if (!handled) next();
        } catch {
          next();
        }
      });
    },
    configurePreviewServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const handled = await handleApi(req, res);
        if (!handled) next();
      });
    },
  };
}

// Loopback only. The /api/* middleware reads the filesystem and has no auth,
// so it must never be reachable off this machine — pinned explicitly rather
// than left to Vite's default, which a stray `--host` or config change flips.
const HOST = "127.0.0.1";
// Port pinned to the local port registry (a port registry: 5189). strictPort
// makes a collision fail loudly instead of silently drifting onto Vite's default
// 5173 (where a stale side-project PWA service worker still squats the origin).
// `preview` reuses 5189 rather than claiming a second registry entry on 4173 —
// dev and preview are never run at the same time.
const PORT = 5189;

export default defineConfig({
  plugins: [filesystemApi()],
  server: { open: true, host: HOST, port: PORT, strictPort: true },
  preview: { host: HOST, port: PORT, strictPort: true },
});
