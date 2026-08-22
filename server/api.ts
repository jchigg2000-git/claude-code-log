import type { IncomingMessage, ServerResponse } from "node:http";
import { buildOverview, buildRepoDetail } from "./fsScan.ts";
import { buildMetrics } from "./metrics.ts";
import { buildJourney } from "./journey.ts";
import { buildSearch } from "./search.ts";
import { buildWords } from "./words.ts";
import { parseTranscript } from "./jsonl.ts";
import { resolveRoot, safeResolveReal } from "./paths.ts";

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(json);
}

/**
 * Resolve a caller-supplied root query param, answering 400 if it escapes the
 * allowed roots. Returns null once the error response has been sent, so callers
 * read as `const dir = root(...); if (dir === null) return true;`.
 *
 * Every route takes its roots from the client, so this is the containment for
 * the whole surface — not just the two routes that take a file path.
 */
function root(res: ServerResponse, url: URL, param: "logDir" | "repoRoot"): string | null {
  const resolved = resolveRoot(url.searchParams.get(param) ?? "");
  if (!resolved) {
    send(res, 400, {
      error: `${param} must be a directory inside your home directory (or a path listed in CLAUDE_CODE_LOG_ROOTS)`,
    });
    return null;
  }
  return resolved;
}

/**
 * Same containment as {@link root}, for a param a route can work without.
 *
 * Returns `undefined` when the caller omitted it — that is not an error, it
 * just costs precision (see {@link resolveProjectName}'s lower rungs). Returns
 * `null`, having already sent a 400, when the caller supplied one that fails
 * containment: a bad root is still a bad root, and silently ignoring it would
 * be a worse surprise than rejecting it.
 *
 * Callers read as `const r = optionalRoot(...); if (r === null) return true;`.
 */
function optionalRoot(
  res: ServerResponse,
  url: URL,
  param: "logDir" | "repoRoot",
): string | undefined | null {
  const raw = url.searchParams.get(param);
  if (raw === null || !raw.trim()) return undefined;
  return root(res, url, param);
}

/**
 * Dispatch `/api/*` routes. Returns true if the request was handled (so the
 * caller can fall through to the static/dev server otherwise).
 *
 * All filesystem access is read-only. Containment is two-layered: the
 * caller-supplied `logDir`/`repoRoot` must land inside an allowed root (see
 * {@link resolveRoot}), and the two routes that additionally take a file path
 * must land inside the root they were given (see {@link safeResolveReal}).
 * The server binds to loopback only — it has no auth and never should be
 * reachable off the machine.
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
      const logDir = root(res, url, "logDir");
      if (logDir === null) return true;
      const repoRoot = root(res, url, "repoRoot");
      if (repoRoot === null) return true;
      send(res, 200, await buildOverview(logDir, repoRoot));
      return true;
    }

    if (url.pathname === "/api/repo") {
      const logDir = root(res, url, "logDir");
      if (logDir === null) return true;
      const repoRoot = root(res, url, "repoRoot");
      if (repoRoot === null) return true;
      const rawPath = url.searchParams.get("path") ?? "";
      const name = url.searchParams.get("name") ?? rawPath;
      const repoPath = await safeResolveReal(repoRoot, rawPath);
      if (!repoPath) {
        send(res, 400, { error: "repo path is outside the configured base root" });
        return true;
      }
      send(res, 200, await buildRepoDetail(repoPath, name, logDir));
      return true;
    }

    if (url.pathname === "/api/metrics") {
      const logDir = root(res, url, "logDir");
      if (logDir === null) return true;
      const repoRoot = optionalRoot(res, url, "repoRoot");
      if (repoRoot === null) return true;
      send(res, 200, await buildMetrics(logDir, repoRoot));
      return true;
    }

    if (url.pathname === "/api/journey") {
      const logDir = root(res, url, "logDir");
      if (logDir === null) return true;
      const daysRaw = Number(url.searchParams.get("days"));
      const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(365, daysRaw) : 50;
      send(res, 200, await buildJourney(logDir, days));
      return true;
    }

    if (url.pathname === "/api/search") {
      const logDir = root(res, url, "logDir");
      if (logDir === null) return true;
      const repoRoot = optionalRoot(res, url, "repoRoot");
      if (repoRoot === null) return true;
      const query = url.searchParams.get("q") ?? "";
      send(res, 200, await buildSearch(logDir, query, repoRoot));
      return true;
    }

    if (url.pathname === "/api/words") {
      const logDir = root(res, url, "logDir");
      if (logDir === null) return true;
      const repoRoot = optionalRoot(res, url, "repoRoot");
      if (repoRoot === null) return true;
      send(res, 200, await buildWords(logDir, repoRoot));
      return true;
    }

    if (url.pathname === "/api/session") {
      const logDir = root(res, url, "logDir");
      if (logDir === null) return true;
      const rawFile = url.searchParams.get("file") ?? "";
      const file = await safeResolveReal(logDir, rawFile);
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
