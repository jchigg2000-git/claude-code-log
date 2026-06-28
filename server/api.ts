import type { IncomingMessage, ServerResponse } from "node:http";
import { buildOverview, buildRepoDetail } from "./fsScan.ts";
import { buildMetrics } from "./metrics.ts";
import { buildJourney } from "./journey.ts";
import { parseTranscript } from "./jsonl.ts";
import { expandHome, safeResolve } from "./paths.ts";

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(json);
}

/**
 * Dispatch `/api/*` routes. Returns true if the request was handled (so the
 * caller can fall through to the static/dev server otherwise). All filesystem
 * access is read-only and confined to the configured roots.
 */
export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/api/")) return false;

  try {
    if (url.pathname === "/api/health") {
      send(res, 200, { ok: true });
      return true;
    }

    if (url.pathname === "/api/overview") {
      const logDir = expandHome(url.searchParams.get("logDir") ?? "");
      const repoRoot = expandHome(url.searchParams.get("repoRoot") ?? "");
      send(res, 200, await buildOverview(logDir, repoRoot));
      return true;
    }

    if (url.pathname === "/api/repo") {
      const logDir = expandHome(url.searchParams.get("logDir") ?? "");
      const repoRoot = expandHome(url.searchParams.get("repoRoot") ?? "");
      const rawPath = url.searchParams.get("path") ?? "";
      const name = url.searchParams.get("name") ?? rawPath;
      const repoPath = safeResolve(repoRoot, rawPath);
      if (!repoPath) {
        send(res, 400, { error: "repo path is outside the configured base root" });
        return true;
      }
      send(res, 200, await buildRepoDetail(repoPath, name, logDir));
      return true;
    }

    if (url.pathname === "/api/metrics") {
      const logDir = expandHome(url.searchParams.get("logDir") ?? "");
      send(res, 200, await buildMetrics(logDir));
      return true;
    }

    if (url.pathname === "/api/journey") {
      const logDir = expandHome(url.searchParams.get("logDir") ?? "");
      const daysRaw = Number(url.searchParams.get("days"));
      const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(365, daysRaw) : 50;
      send(res, 200, await buildJourney(logDir, days));
      return true;
    }

    if (url.pathname === "/api/session") {
      const logDir = expandHome(url.searchParams.get("logDir") ?? "");
      const rawFile = url.searchParams.get("file") ?? "";
      const file = safeResolve(logDir, rawFile);
      if (!file || !file.endsWith(".jsonl")) {
        send(res, 400, { error: "session file is outside the configured log location" });
        return true;
      }
      send(res, 200, { file, events: await parseTranscript(file) });
      return true;
    }

    send(res, 404, { error: "unknown endpoint" });
    return true;
  } catch (err) {
    send(res, 500, { error: err instanceof Error ? err.message : "internal error" });
    return true;
  }
}
