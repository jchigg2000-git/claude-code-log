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
// Pinned to an uncommon port with strictPort, so a collision fails loudly at
// startup instead of silently drifting onto Vite's default 5173 — an origin
// other local dev servers reuse, where a stale service worker from a different
// app can end up serving this one. `preview` deliberately reuses the same port;
// dev and preview are never run at the same time.
const PORT = 5189;

// Vite's dev/preview servers default to reflecting any localhost/127.0.0.1
// Origin back as `Access-Control-Allow-Origin`. That default is fine for a
// normal app; it is not fine here, because /api/* hands out the full text of
// every transcript on the machine. With it on, any page served from any other
// local dev server can read the whole corpus cross-origin. Off means the
// browser blocks the read, which is the posture the README describes.
const CORS = false;

export default defineConfig({
  plugins: [filesystemApi()],
  server: { open: true, host: HOST, port: PORT, strictPort: true, cors: CORS },
  preview: { host: HOST, port: PORT, strictPort: true, cors: CORS },
});
