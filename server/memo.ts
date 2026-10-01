/**
 * The single-entry TTL memo every corpus-scanning endpoint used to hand-roll.
 *
 * `compute` returns its value together with a `healthy` flag because whether a
 * scan is safe to memoize is not always derivable from the value alone
 * (metrics' readdir can fail while yielding a structurally valid empty
 * rollup): a degraded scan — missing log dir, FS race, absent history file —
 * must never be cached for the full TTL, or the operator fixing their
 * Settings would stare at a memoized empty state. Each endpoint states what
 * "healthy" means for it at the call site.
 */
export interface TtlMemo<T> {
  get(key: string, compute: () => Promise<{ value: T; healthy: boolean }>): Promise<T>;
  /** Drop the memo AND detach anything still computing: a scan that was already
   *  running will not repopulate it, and the next `get` starts its own. */
  clear(): void;
}

/**
 * Concurrent `get`s for one key share a single `compute`. A cold whole-corpus
 * scan takes seconds, and an overlapping request (a second tab, or the
 * periodic refresh landing mid-scan) used to start its own full scan in
 * parallel — two multi-GB parses at once, the loser's work thrown away.
 *
 * `clear()` is the `fresh=1` path, which must reflect the disk as of NOW, so
 * it does not let the next caller join a scan that began before it. The
 * generation counter is the other half: a scan that started before a `clear()`
 * and finishes after it must not write its older result over the memo (it
 * could otherwise land after the fresh scan did and win).
 */
export function ttlMemo<T>(ttlMs: number): TtlMemo<T> {
  let cache: { key: string; at: number; value: T } | null = null;
  let generation = 0;
  const inflight = new Map<string, Promise<T>>();
  return {
    get(key, compute) {
      if (cache && cache.key === key && Date.now() - cache.at < ttlMs) return Promise.resolve(cache.value);
      const running = inflight.get(key);
      if (running) return running;
      const started = generation;
      const run = (async () => {
        const { value, healthy } = await compute();
        if (healthy && started === generation) cache = { key, at: Date.now(), value };
        return value;
      })();
      inflight.set(key, run);
      // A settled scan (either way) stops being joinable; a rejection is never
      // memoized, so the next caller retries. Guarded so a scan detached by
      // clear() can't evict the newer one that replaced it.
      const settle = () => {
        if (inflight.get(key) === run) inflight.delete(key);
      };
      run.then(settle, settle);
      return run;
    },
    clear() {
      cache = null;
      generation++;
      inflight.clear();
    },
  };
}
