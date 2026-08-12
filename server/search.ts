import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { TimelineEvent } from "./jsonl.ts";
import { decodeProjectDirApprox } from "./paths.ts";
import { peekSearchable, putSearchable, type SearchableEvent } from "./transcriptCache.ts";

export interface SearchMatch {
  file: string;
  sessionId: string;
  dirName: string;
  approxPath: string;
  mtime: string;
  kind: TimelineEvent["kind"];
  tool?: string;
  /** Context window around the first match, whitespace-collapsed for display. */
  snippet: string;
  /** How many events in this session matched the query. */
  matchCount: number;
}

export interface SearchResults {
  query: string;
  sessionsSearched: number;
  matchedSessions: number;
  /** True when more sessions matched than the returned result cap. */
  truncated: boolean;
  results: SearchMatch[];
}

/** Ignore queries shorter than this — a naive full-corpus grep on 1 char is noise. */
const MIN_QUERY = 2;
/** Cap returned rows so a broad query can't build a multi-thousand-item DOM. */
const RESULT_CAP = 100;
/** Characters of context to keep on each side of the first match in a snippet. */
const SNIPPET_RADIUS = 90;

/** One transcript, with just the metadata a search row needs. */
export interface SearchSession {
  file: string;
  id: string;
  mtime: string;
  mtimeMs: number;
  size: number;
  dirName: string;
  approxPath: string;
}

/**
 * Enumerate every transcript under `logDir` using `readdir` + `stat` only.
 *
 * Search deliberately does NOT reuse {@link import("./fsScan.ts").scanLogProjects}:
 * that function READS every transcript in full just to count its lines, which
 * costs seconds on a real corpus and produces a `messageCount` search never
 * looks at. Enumerating without reading measures at ~40ms against ~2.7s for
 * the line-counting scan. Other callers still want the counts, so that
 * function is left alone.
 */
export async function enumerateSessions(logDir: string): Promise<SearchSession[]> {
  let dirNames: string[];
  try {
    dirNames = (await readdir(logDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const out: SearchSession[] = [];
  for (const dirName of dirNames) {
    const projDir = path.join(logDir, dirName);
    let files: string[];
    try {
      files = (await readdir(projDir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    const approxPath = decodeProjectDirApprox(dirName);
    for (const f of files) {
      const full = path.join(projDir, f);
      try {
        const st = await stat(full);
        out.push({
          file: full,
          id: f.replace(/\.jsonl$/, ""),
          mtime: st.mtime.toISOString(),
          mtimeMs: st.mtimeMs,
          size: st.size,
          dirName,
          approxPath,
        });
      } catch {
        continue;
      }
    }
  }
  return out;
}

/**
 * Short-TTL memo of the enumeration. The UI debounces at 300ms but still fires
 * a request per keystroke burst. A 10s TTL is short enough that a new session
 * is picked up almost immediately, long enough to absorb a whole burst of
 * keystrokes as one scan.
 */
let sessionsCache: { key: string; at: number; data: SearchSession[] } | null = null;
const SESSIONS_TTL_MS = 10_000;

async function getSessionsCached(logDir: string): Promise<SearchSession[]> {
  if (sessionsCache && sessionsCache.key === logDir && Date.now() - sessionsCache.at < SESSIONS_TTL_MS) {
    return sessionsCache.data;
  }
  const data = await enumerateSessions(logDir);
  // An empty result means an unreadable/missing logDir — never memoize that,
  // or a transient FS error papers over the corpus for the full TTL.
  if (data.length > 0) sessionsCache = { key: logDir, at: Date.now(), data };
  return data;
}

/** Drop the enumeration memo. Exposed for tooling/tests. */
export function clearSearchCaches(): void {
  sessionsCache = null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether `query` can be safely pre-filtered against the RAW JSONL text before
 * paying for `JSON.parse`.
 *
 * A transcript's parsed event text comes out of JSON string literals, so any
 * character JSON escapes (`"`, `\`, control characters) appears differently in
 * the raw bytes than in the parsed text — a needle containing one could match
 * the parsed form while being absent from the raw form, i.e. a false negative.
 * `→` is excluded for the same reason: {@link import("./jsonl.ts").parseTranscriptText}
 * SYNTHESIZES `→ <toolName>` for tool_use blocks, so that arrow exists only
 * after parsing.
 *
 * Everything else is safe: for a needle free of those characters, any
 * occurrence in the parsed text is a verbatim contiguous run in the raw text
 * too (multi-block text is joined with `\n`, which such a needle cannot span).
 * Excluded queries simply skip the fast path and parse everything, as before.
 */
function canPrefilter(query: string): boolean {
  return !/["\\\u0000-\u001f\u2192]/.test(query);
}

/** Build a single-line snippet centered on the first occurrence of `needle`. */
function makeSnippet(text: string, needle: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const idx = flat.toLowerCase().indexOf(needle);
  if (idx < 0) return flat.slice(0, SNIPPET_RADIUS * 2);
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(flat.length, idx + needle.length + SNIPPET_RADIUS);
  return (start > 0 ? "…" : "") + flat.slice(start, end) + (end < flat.length ? "…" : "");
}

/**
 * Full-text search across every Claude Code transcript under `logDir`.
 *
 * Three layers keep a debounced keystroke from costing a full corpus walk:
 *
 * 1. Enumeration is `readdir`+`stat` only (see {@link enumerateSessions}) and
 *    memoized for {@link SESSIONS_TTL_MS}.
 * 2. Each transcript is read once and pre-filtered with a case-insensitive
 *    regex over its RAW text. `JSON.parse` is the dominant cost by a wide
 *    margin (~6s vs ~1.4s to read the same bytes on a 2.3 GB corpus), and the
 *    overwhelming majority of transcripts don't contain the query at all, so
 *    skipping the parse for those is where the time goes. See
 *    {@link canPrefilter} for when this is provably safe; when it isn't, the
 *    query falls back to parsing everything and behaviour is unchanged.
 * 3. Transcripts that DO match are parsed and cached by mtime+size
 *    (`transcriptCache.ts`), so refining a query over the same term is nearly
 *    free.
 *
 * Sessions are scanned newest-first and the returned rows are capped, so a
 * broad query keeps the freshest work and can't blow up the payload.
 *
 * There is deliberately no on-disk index: this app's read-only filesystem
 * posture is load-bearing, and it never writes outside its own repo.
 */
export async function buildSearch(logDir: string, rawQuery: string): Promise<SearchResults> {
  const query = rawQuery.trim();
  if (query.length < MIN_QUERY) {
    return { query, sessionsSearched: 0, matchedSessions: 0, truncated: false, results: [] };
  }
  const needle = query.toLowerCase();
  const probe = canPrefilter(query) ? new RegExp(escapeRegExp(query), "i") : null;

  // Newest-first, so the result cap keeps the most recent activity rather than
  // whatever happened to sort first.
  const items = await getSessionsCached(logDir);
  const ordered = [...items].sort((a, b) => b.mtime.localeCompare(a.mtime));

  const results: SearchMatch[] = [];
  let sessionsSearched = 0;
  let matchedSessions = 0;

  for (const session of ordered) {
    sessionsSearched++;

    let events = peekSearchable(session.file, session.mtimeMs, session.size);
    if (!events) {
      let raw: string;
      try {
        raw = await readFile(session.file, "utf8");
      } catch {
        continue; // deleted mid-scan / unreadable — skip, same as before
      }
      // Cheap reject before the expensive parse. A raw hit can still be a false
      // positive (it may live in a JSON key or a field we don't surface), which
      // the real match loop below then discards — that stays correct.
      if (probe && !probe.test(raw)) continue;
      events = putSearchable(session.file, session.mtimeMs, session.size, raw);
    }

    let matchCount = 0;
    let first: SearchableEvent | null = null;
    for (const ev of events) {
      if (ev.textLower.includes(needle)) {
        matchCount++;
        if (!first) first = ev;
      }
    }
    if (matchCount === 0 || !first) continue;
    matchedSessions++;
    if (results.length < RESULT_CAP) {
      results.push({
        file: session.file,
        sessionId: session.id,
        dirName: session.dirName,
        approxPath: session.approxPath,
        mtime: session.mtime,
        kind: first.kind,
        tool: first.tool,
        snippet: makeSnippet(first.text, needle),
        matchCount,
      });
    }
  }

  return {
    query,
    sessionsSearched,
    matchedSessions,
    truncated: matchedSessions > results.length,
    results,
  };
}
