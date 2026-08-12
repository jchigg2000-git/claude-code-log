import type { AppConfig, Journey, Metrics, Overview, RepoDetail, SearchResults, Session, WordsResults } from "./types.ts";

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

export function fetchSearch(cfg: AppConfig, query: string): Promise<SearchResults> {
  return getJSON<SearchResults>(`/api/search?${q({ logDir: cfg.logDir, q: query })}`);
}

// The metrics scan reads the whole corpus; memoize per logDir for the page
// lifetime so navigating Repos ⇄ Data Viz doesn't rescan every time.
let metricsCache: { key: string; promise: Promise<Metrics> } | null = null;

export function fetchMetrics(cfg: AppConfig): Promise<Metrics> {
  if (!metricsCache || metricsCache.key !== cfg.logDir) {
    const promise = getJSON<Metrics>(`/api/metrics?${q({ logDir: cfg.logDir })}`);
    // Don't let a transient failure become permanent: a rejected promise cached here would be
    // replayed on every re-navigation (callers show an error but never invalidate). Evict on
    // rejection — guarded so a newer in-flight fetch isn't clobbered — so the next call retries.
    promise.catch(() => {
      if (metricsCache?.promise === promise) metricsCache = null;
    });
    metricsCache = { key: cfg.logDir, promise };
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
    const promise = getJSON<Journey>(`/api/journey?${q({ logDir: cfg.logDir, days: String(days) })}`);
    // Same as fetchMetrics: evict on rejection so a transient failure isn't cached permanently.
    promise.catch(() => {
      if (journeyCache?.promise === promise) journeyCache = null;
    });
    journeyCache = { key, promise };
  }
  return journeyCache.promise;
}

export function invalidateJourney(): void {
  journeyCache = null;
}

// The words scan reads the whole corpus; memoize per logDir for the page
// lifetime, same as metrics.
let wordsCache: { key: string; promise: Promise<WordsResults> } | null = null;

export function fetchWords(cfg: AppConfig): Promise<WordsResults> {
  if (!wordsCache || wordsCache.key !== cfg.logDir) {
    const promise = getJSON<WordsResults>(`/api/words?${q({ logDir: cfg.logDir })}`);
    // Same as fetchMetrics: evict on rejection so a transient failure isn't cached permanently.
    promise.catch(() => {
      if (wordsCache?.promise === promise) wordsCache = null;
    });
    wordsCache = { key: cfg.logDir, promise };
  }
  return wordsCache.promise;
}

export function invalidateWords(): void {
  wordsCache = null;
}
