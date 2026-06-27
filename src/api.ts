import type { AppConfig, Journey, Metrics, Overview, RepoDetail, Session } from "./types.ts";

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

function q(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

export function fetchOverview(cfg: AppConfig): Promise<Overview> {
  return getJSON<Overview>(`/api/overview?${q({ logDir: cfg.logDir, repoRoot: cfg.repoRoot })}`);
}

export function fetchRepo(cfg: AppConfig, repoPath: string, name: string): Promise<RepoDetail> {
  return getJSON<RepoDetail>(
    `/api/repo?${q({ logDir: cfg.logDir, repoRoot: cfg.repoRoot, path: repoPath, name })}`,
  );
}

export function fetchSession(cfg: AppConfig, file: string): Promise<Session> {
  return getJSON<Session>(`/api/session?${q({ logDir: cfg.logDir, file })}`);
}

// The metrics scan reads the whole corpus; memoize per logDir for the page
// lifetime so navigating Repos ⇄ Data Viz doesn't rescan every time.
let metricsCache: { key: string; promise: Promise<Metrics> } | null = null;

export function fetchMetrics(cfg: AppConfig): Promise<Metrics> {
  if (!metricsCache || metricsCache.key !== cfg.logDir) {
    metricsCache = {
      key: cfg.logDir,
      promise: getJSON<Metrics>(`/api/metrics?${q({ logDir: cfg.logDir })}`),
    };
  }
  return metricsCache.promise;
}

export function invalidateMetrics(): void {
  metricsCache = null;
}

// The journey scan reads the whole command history; memoize per logDir+window
// for the page lifetime, same as metrics.
let journeyCache: { key: string; promise: Promise<Journey> } | null = null;

export function fetchJourney(cfg: AppConfig, days = 50): Promise<Journey> {
  const key = `${cfg.logDir}::${days}`;
  if (!journeyCache || journeyCache.key !== key) {
    journeyCache = {
      key,
      promise: getJSON<Journey>(`/api/journey?${q({ logDir: cfg.logDir, days: String(days) })}`),
    };
  }
  return journeyCache.promise;
}

export function invalidateJourney(): void {
  journeyCache = null;
}

/**
 * Subscribe to server-side filesystem change notifications via SSE. `onChange`
 * fires (already debounced server-side) whenever the watched logDir mutates.
 * Returns an unsubscribe function; a no-op where EventSource is unavailable.
 */
export function subscribeToChanges(cfg: AppConfig, onChange: () => void): () => void {
  if (typeof EventSource === "undefined") return () => {};
  const es = new EventSource(`/api/watch?${q({ logDir: cfg.logDir })}`);
  es.addEventListener("change", () => onChange());
  return () => es.close();
}
