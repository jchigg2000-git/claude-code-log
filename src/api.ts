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

// Opening/closing a transcript navigates through #/repo (the hash carries the
// open session), so the route re-render calls fetchRepo on every toggle.
// Memoize the last repo — same shape and keying discipline as fetchMetrics —
// so a toggle re-renders from the already-resolved promise instead of
// rescanning the project dir. One entry is enough: only one repo page is ever
// on screen, and the periodic refresh invalidates it like the other caches.
let repoCache: { key: string; promise: Promise<RepoDetail> } | null = null;

export function fetchRepo(cfg: AppConfig, repoPath: string, name: string): Promise<RepoDetail> {
  const key = `${cfg.logDir}::${cfg.repoRoot}::${repoPath}::${name}`;
  if (!repoCache || repoCache.key !== key) {
    const promise = getJSON<RepoDetail>(
      `/api/repo?${q({ logDir: cfg.logDir, repoRoot: cfg.repoRoot, path: repoPath, name })}`,
    );
    // Same as fetchMetrics: evict on rejection so a transient failure isn't cached permanently.
    promise.catch(() => {
      if (repoCache?.promise === promise) repoCache = null;
    });
    repoCache = { key, promise };
  }
  return repoCache.promise;
}

export function invalidateRepo(): void {
  repoCache = null;
}

export function fetchSession(cfg: AppConfig, file: string): Promise<Session> {
  return getJSON<Session>(`/api/session?${q({ logDir: cfg.logDir, file })}`);
}

export function fetchSearch(cfg: AppConfig, query: string): Promise<SearchResults> {
  return getJSON<SearchResults>(
    `/api/search?${q({ logDir: cfg.logDir, repoRoot: cfg.repoRoot, q: query })}`,
  );
}

/**
 * Page-lifetime promise memo for the corpus-scanning endpoints, so navigating
 * between tabs doesn't rescan every time. A rejected promise is evicted
 * (guarded so a newer in-flight fetch isn't clobbered) — a transient failure
 * cached here would otherwise be replayed on every re-navigation, since
 * callers show an error but never invalidate.
 */
function cachedEndpoint<A extends unknown[], T>(
  keyOf: (...args: A) => string,
  fetchOf: (...args: A) => Promise<T>,
): { fetch: (...args: A) => Promise<T>; invalidate: () => void } {
  let cache: { key: string; promise: Promise<T> } | null = null;
  return {
    fetch(...args: A): Promise<T> {
      const key = keyOf(...args);
      if (!cache || cache.key !== key) {
        const promise = fetchOf(...args);
        promise.catch(() => {
          if (cache?.promise === promise) cache = null;
        });
        cache = { key, promise };
      }
      return cache.promise;
    },
    invalidate(): void {
      cache = null;
    },
  };
}

// repoRoot is part of the metrics/words keys because it decides how projects
// are NAMED — the same corpus under a different root yields the same numbers
// with different labels, and a logDir-only key would serve the stale ones.
const metrics = cachedEndpoint(
  (cfg: AppConfig) => `${cfg.logDir}::${cfg.repoRoot}`,
  (cfg) => getJSON<Metrics>(`/api/metrics?${q({ logDir: cfg.logDir, repoRoot: cfg.repoRoot })}`),
);
export const fetchMetrics = metrics.fetch;
export const invalidateMetrics = metrics.invalidate;

const journey = cachedEndpoint(
  (cfg: AppConfig, days = 50) => `${cfg.logDir}::${days}`,
  (cfg, days = 50) => getJSON<Journey>(`/api/journey?${q({ logDir: cfg.logDir, days: String(days) })}`),
);
export const fetchJourney = journey.fetch;
export const invalidateJourney = journey.invalidate;

const words = cachedEndpoint(
  (cfg: AppConfig) => `${cfg.logDir}::${cfg.repoRoot}`,
  (cfg) => getJSON<WordsResults>(`/api/words?${q({ logDir: cfg.logDir, repoRoot: cfg.repoRoot })}`),
);
export const fetchWords = words.fetch;
export const invalidateWords = words.invalidate;
