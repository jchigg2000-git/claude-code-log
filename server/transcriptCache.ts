import { parseTranscriptText, type TimelineEvent } from "./jsonl.ts";

/**
 * Parsed-transcript cache for search. `buildSearch` runs on every debounced
 * keystroke, and `JSON.parse`-ing every `.jsonl` in the corpus per query is by
 * far the dominant cost (measured at ~6s on a 2.3 GB corpus, against ~1.4s to
 * read the same bytes). This cache keeps the parsed, search-ready form of each
 * transcript in memory, keyed by absolute file path.
 *
 * It is deliberately NOT sized to hold a whole corpus — it can't be, and it
 * doesn't need to be. Search pre-filters on raw text and only ever parses the
 * handful of transcripts that actually contain the query, so what lands here
 * is the working set of *matching* files, which stays small and makes a
 * refined query over the same term nearly free.
 *
 * Transcripts are append-only session logs (Claude Code never rewrites a past
 * line in place), so `mtimeMs` + `size` together are a sound staleness check:
 * if either changed, treat the entry as invalid and reparse. There is no
 * scenario in this corpus where a file's content changes while both stay
 * fixed.
 */

/** The subset of a parsed event search actually needs, pre-lowercased once. */
export interface SearchableEvent {
  /** Original text, kept for snippet extraction (case must be preserved there). */
  text: string;
  /** `text.toLowerCase()`, computed once at parse time instead of per query. */
  textLower: string;
  kind: TimelineEvent["kind"];
  tool?: string;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  events: SearchableEvent[];
  /** `text.length + textLower.length` summed across `events`, for the memory cap below. */
  chars: number;
}

/**
 * Cap on total cached characters (across `text` + `textLower` of every cached
 * event), not entry count — a corpus can contain arbitrarily large or
 * numerous transcripts, and this is a long-lived dev server process, so an
 * unbounded cache is a leak. ~256M chars is a defensible ceiling for a dev
 * tool (JS strings are UTF-16, so this is roughly ~512MB of resident string
 * data at the cap, not 256MB — chosen with headroom rather than shaved thin).
 */
const MAX_CACHE_CHARS = 256 * 1024 * 1024;

// `Map` iteration order is insertion order, and every hit re-inserts its key
// at the end (see `touch` below), so the first entry in iteration order is
// always the least-recently-used one — a cheap LRU without a separate list.
const cache = new Map<string, CacheEntry>();
let totalChars = 0;

function touch(file: string, entry: CacheEntry): void {
  cache.delete(file);
  cache.set(file, entry);
}

function evictUntilWithinBudget(): void {
  for (const [file, entry] of cache) {
    if (totalChars <= MAX_CACHE_CHARS) return;
    cache.delete(file);
    totalChars -= entry.chars;
  }
}

/** Look up a still-valid cache entry, or null. Touches it on a hit (LRU). */
export function peekSearchable(file: string, mtimeMs: number, size: number): SearchableEvent[] | null {
  const cached = cache.get(file);
  if (!cached) return null;
  if (cached.mtimeMs !== mtimeMs || cached.size !== size) {
    // Stale — mtime/size moved, so the transcript grew (or was replaced).
    cache.delete(file);
    totalChars -= cached.chars;
    return null;
  }
  touch(file, cached);
  return cached.events;
}

/**
 * Parse `raw` into searchable form and cache it under `file`.
 *
 * The caller supplies the already-read text rather than a path: search reads
 * each transcript once to pre-filter it, and re-reading the same 4.5 GB corpus
 * a second time just to parse the few files that matched would give most of
 * the win back. Never throws.
 */
export function putSearchable(
  file: string,
  mtimeMs: number,
  size: number,
  raw: string,
): SearchableEvent[] {
  const events: SearchableEvent[] = parseTranscriptText(raw).map((ev) => ({
    text: ev.text,
    textLower: ev.text.toLowerCase(),
    kind: ev.kind,
    tool: ev.tool,
  }));
  const chars = events.reduce((n, e) => n + e.text.length + e.textLower.length, 0);

  const prev = cache.get(file);
  if (prev) totalChars -= prev.chars;
  cache.set(file, { mtimeMs, size, events, chars });
  totalChars += chars;
  evictUntilWithinBudget();

  return events;
}

/** Drop every cached transcript. Exposed for completeness (e.g. tooling/tests). */
export function clearTranscriptCache(): void {
  cache.clear();
  totalChars = 0;
}
