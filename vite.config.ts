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

export default defineConfig({
  plugins: [filesystemApi()],
  // Port pinned to the local port registry (a port registry: 5189).
  // strictPort makes a collision fail loudly instead of silently drifting
  // onto Vite's default 5173 (where a stale side-project PWA service worker
  // still squats the origin).
  server: { open: true, port: 5189, strictPort: true },
});
