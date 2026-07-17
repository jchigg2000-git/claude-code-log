import { scanLogProjects, type LogProject, type SessionMeta } from "./fsScan.ts";
import { parseTranscript, type TimelineEvent } from "./jsonl.ts";

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
 * Reuses {@link scanLogProjects} to enumerate every project/session and
 * {@link parseTranscript} to normalize each transcript into searchable text,
 * so this stays a thin read-only layer over the existing primitives. Sessions
 * are scanned newest-first and the returned rows are capped, so a broad query
 * keeps the freshest work and can't blow up the payload.
 */
export async function buildSearch(logDir: string, rawQuery: string): Promise<SearchResults> {
  const query = rawQuery.trim();
  if (query.length < MIN_QUERY) {
    return { query, sessionsSearched: 0, matchedSessions: 0, truncated: false, results: [] };
  }
  const needle = query.toLowerCase();
  const projects = await scanLogProjects(logDir);

  // Flatten to (project, session) pairs, newest-first, so the result cap keeps
  // the most recent activity rather than whatever happened to sort first.
  const items: { project: LogProject; session: SessionMeta }[] = [];
  for (const p of projects) for (const s of p.sessions) items.push({ project: p, session: s });
  items.sort((a, b) => b.session.mtime.localeCompare(a.session.mtime));

  const results: SearchMatch[] = [];
  let sessionsSearched = 0;
  let matchedSessions = 0;

  for (const { project, session } of items) {
    sessionsSearched++;
    const events = await parseTranscript(session.file);
    let matchCount = 0;
    let first: TimelineEvent | null = null;
    for (const ev of events) {
      if (ev.text.toLowerCase().includes(needle)) {
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
        dirName: project.dirName,
        approxPath: project.approxPath,
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
