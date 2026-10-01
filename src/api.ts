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

/**
 * Staleness key for one transcript file, from the repo scan's own metadata.
 * Transcripts are append-only, so mtime + size change exactly when the file
 * gained events — the same signal the server's line-count memo trusts
 * (fsScan.ts). Baked into {@link fetchSession}'s cache key, it makes the memo
 * self-invalidating: the 5-minute refresh re-scans the repo, a grown file
 * yields a new key, and the transcript refetches with no manual invalidate.
 */
export function sessionStaleKey(meta: { mtime: string; sizeBytes: number }): string {
  return `${meta.mtime}::${meta.sizeBytes}`;
}

// Same one-entry, evict-on-rejection discipline as fetchRepo: only one
// transcript is ever open on the repo page, and its data is immutable for as
// long as the staleKey holds.
let sessionCache: { key: string; promise: Promise<Session> } | null = null;

/**
 * `staleKey` (see {@link sessionStaleKey}) opts into the memo: the repo page
 * passes it so toggling a transcript closed and open again — or re-rendering
 * on refresh — reuses the already-fetched payload until the file grows. The
 * standalone #/session view has no scan metadata to key on and stays uncached.
 */
export function fetchSession(cfg: AppConfig, file: string, staleKey?: string): Promise<Session> {
  const url = `/api/session?${q({ logDir: cfg.logDir, file })}`;
  if (staleKey === undefined) return getJSON<Session>(url);
  const key = `${cfg.logDir}::${file}::${staleKey}`;
  if (!sessionCache || sessionCache.key !== key) {
    const promise = getJSON<Session>(url);
    promise.catch(() => {
      if (sessionCache?.promise === promise) sessionCache = null;
    });
    sessionCache = { key, promise };
  }
  return sessionCache.promise;
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
 *
 * `invalidate()` is the periodic refresh's lever, and it also marks the NEXT
 * request `fresh=1`. Dropping only this memo is not enough: the server keeps a
 * 5-minute memo of its own, and the refresh fires on a 5-minute timer, so
 * without the flag the refetch landed inside that window and got the old scan
 * back — a refresh that re-rendered identical data every other tick.
 */
function cachedEndpoint<A extends unknown[], T>(
  keyOf: (...args: A) => string,
  urlOf: (...args: A) => string,
): { fetch: (...args: A) => Promise<T>; invalidate: () => void } {
  let cache: { key: string; promise: Promise<T> } | null = null;
  let bust = false;
  return {
    fetch(...args: A): Promise<T> {
      const key = keyOf(...args);
      if (!cache || cache.key !== key) {
        const promise = getJSON<T>(freshUrl(urlOf(...args), bust));
        bust = false;
        promise.catch(() => {
          if (cache?.promise === promise) cache = null;
        });
        cache = { key, promise };
      }
      return cache.promise;
    },
    invalidate(): void {
      cache = null;
      bust = true;
    },
  };
}

/** `url` with the server-memo bypass appended when `bust` is set. */
export function freshUrl(url: string, bust: boolean): string {
  if (!bust) return url;
  return url + (url.includes("?") ? "&" : "?") + "fresh=1";
}

// repoRoot is part of the metrics/words keys because it decides how projects
// are NAMED — the same corpus under a different root yields the same numbers
// with different labels, and a logDir-only key would serve the stale ones.
const metrics = cachedEndpoint<[AppConfig], Metrics>(
  (cfg: AppConfig) => `${cfg.logDir}::${cfg.repoRoot}`,
  (cfg) => `/api/metrics?${q({ logDir: cfg.logDir, repoRoot: cfg.repoRoot })}`,
);
export const fetchMetrics = metrics.fetch;
export const invalidateMetrics = metrics.invalidate;

const journey = cachedEndpoint<[AppConfig, number?], Journey>(
  (cfg: AppConfig, days = 50) => `${cfg.logDir}::${days}`,
  (cfg, days = 50) => `/api/journey?${q({ logDir: cfg.logDir, days: String(days) })}`,
);
export const fetchJourney = journey.fetch;
export const invalidateJourney = journey.invalidate;

const words = cachedEndpoint<[AppConfig], WordsResults>(
  (cfg: AppConfig) => `${cfg.logDir}::${cfg.repoRoot}`,
  (cfg) => `/api/words?${q({ logDir: cfg.logDir, repoRoot: cfg.repoRoot })}`,
);
export const fetchWords = words.fetch;
export const invalidateWords = words.invalidate;
