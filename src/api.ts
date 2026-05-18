import type { AppConfig, Metrics, Overview, RepoDetail, Session } from "./types.ts";

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
