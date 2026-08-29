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
  clear(): void;
}

export function ttlMemo<T>(ttlMs: number): TtlMemo<T> {
  let cache: { key: string; at: number; value: T } | null = null;
  return {
    async get(key, compute) {
      if (cache && cache.key === key && Date.now() - cache.at < ttlMs) return cache.value;
      const { value, healthy } = await compute();
      if (healthy) cache = { key, at: Date.now(), value };
      return value;
    },
    clear() {
      cache = null;
    },
  };
}
