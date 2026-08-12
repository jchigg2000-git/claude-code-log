import { readFile } from "node:fs/promises";
import { parseTranscriptText, type TimelineEvent } from "./jsonl.ts";
import { enumerateSessions, type SearchSession } from "./search.ts";

/**
 * "Words That Mattered" — mine every transcript for moments where the user's
 * own phrasing changed the outcome: an instruction taken literally in a way
 * they didn't intend, a typo/wrong word that sent the session sideways, or an
 * offhand word that got overweighted into unrequested work.
 *
 * Detection is signal-based, not semantic: a later USER message carrying a
 * correction marker ("that's not what I meant", "typo, I meant…", "I never
 * asked for…") is paired with the nearest earlier substantive user message —
 * the phrase that got taken the wrong way. Everything the assistant did in
 * between is summarized so the entry reads original → what happened → the
 * correction.
 *
 * Confidence follows the journey graph's convention ("explicit" | "inferred",
 * never hidden): explicit when the correction names the miscommunication
 * outright, inferred when only a weak reversal pattern ("no, …", "wait —",
 * bare "I meant") fired and the pairing is a best guess.
 */

export type WordCategory = "literal" | "missaid" | "pivot";
export type WordConfidence = "explicit" | "inferred";

export interface WordEntry {
  file: string;
  sessionId: string;
  dirName: string;
  approxPath: string;
  /** Timestamp of the correcting message. */
  ts: string | null;
  category: WordCategory;
  confidence: WordConfidence;
  /** Short human label for the marker that fired. */
  label: string;
  /** The exact substring the marker matched, for client-side highlighting. */
  matched: string;
  /** Verbatim earlier user message that got taken the wrong way (flattened, capped). */
  original: string;
  /** Verbatim correcting message (flattened, capped). */
  correction: string;
  /** Assistant-authored events between the two messages. */
  assistantTurns: number;
  /** Individual tool invocations between the two messages. */
  toolCalls: number;
  /** First assistant output after the original — what acting on it looked like. */
  firstAction: string;
}

export interface WordsResults {
  sessionsScanned: number;
  matchedSessions: number;
  /** Every marker hit found, including ones dropped by the caps below. */
  totalMatches: number;
  truncated: boolean;
  entries: WordEntry[];
}

/** Cap returned entries so one grep-happy corpus can't build a huge DOM. */
const RESULT_CAP = 200;
/** Cap per session so one gnarly argument doesn't flood the page. */
const SESSION_CAP = 4;
/** Ignore user messages shorter than this — bare approvals aren't phrasing. */
const MIN_SUBSTANTIVE = 8;
const QUOTE_CAP = 400;
const ACTION_CAP = 160;

interface Marker {
  re: RegExp;
  category: WordCategory;
  confidence: WordConfidence;
  label: string;
}

/**
 * Ordered by priority — the first marker to match wins. Self-referential
 * mis-said markers outrank the generic "i meant" clarifier, and explicit
 * markers outrank the weak reversal patterns at the bottom.
 */
const MARKERS: Marker[] = [
  // Mis-said — the user names their own slip.
  { re: /\b(i (made|had) a typo|my typo|i mistyped|i misspoke|i misspelled|autocorrect(ed)?)\b/i, category: "missaid", confidence: "explicit", label: "own slip" },
  { re: /\bmeant to (say|type|write)\b/i, category: "missaid", confidence: "explicit", label: "own slip" },
  { re: /\btypo\b.{0,20}\bi meant\b/i, category: "missaid", confidence: "explicit", label: "own slip" },
  // Taken literally — the instruction was read in a way the user didn't intend.
  { re: /\b(that'?s|thats) not what i (mean|meant|asked|wanted)\b/i, category: "literal", confidence: "explicit", label: "not what I meant" },
  { re: /\bnot what i (mean|meant|asked( for)?|wanted)\b/i, category: "literal", confidence: "explicit", label: "not what I meant" },
  // First/second-person only — bare "misread" fires on prose about files being misread.
  { re: /\b(you('| a)?ve? (completely |totally )?(misunderstood|misread)|misunderstood (me|my|what i))\b/i, category: "literal", confidence: "explicit", label: "misunderstood" },
  { re: /\bi didn'?t mean\b/i, category: "literal", confidence: "explicit", label: "didn't mean" },
  { re: /\btoo literal(ly)?\b/i, category: "literal", confidence: "explicit", label: "too literal" },
  // Overweighted — a word the user never (or barely) said became load-bearing.
  { re: /\bi never (asked|said|wanted|cared|told)\b/i, category: "pivot", confidence: "explicit", label: "never asked" },
  { re: /\bi didn'?t (ask|say|request)\b/i, category: "pivot", confidence: "explicit", label: "didn't ask" },
  { re: /\b(that'?s|thats) not what i said\b/i, category: "pivot", confidence: "explicit", label: "not what I said" },
  { re: /\bi told you (to|not)\b/i, category: "pivot", confidence: "explicit", label: "I told you" },
  // Weak signals — pattern-guessed pairings, surfaced as inferred, never hidden.
  { re: /\bi meant\b/i, category: "literal", confidence: "inferred", label: "clarification" },
  { re: /\b(undo|revert) (that|this)\b/i, category: "literal", confidence: "inferred", label: "reversal" },
  // "stop" is deliberately absent — "stop the server" is an instruction, not a correction.
  { re: /^(no|nope|wait|whoa|hold on|hang on)[,.! ]/i, category: "literal", confidence: "inferred", label: "reversal" },
];

/**
 * Raw-text pre-filter, same trick as search: skip `JSON.parse` for transcripts
 * that can't contain any marker. Substring-safe variants only — the anchored
 * reversal markers are approximated by their in-JSON shape (`"no, …`), which
 * can only over-match, never under-match, so no entry is lost to this filter.
 */
const PREFILTER = new RegExp(
  [
    "not what i",
    "misunderstood",
    "misread",
    "didn'?t mean",
    "i meant",
    "typo",
    "mistyped",
    "misspoke",
    "misspelled",
    "autocorrect",
    "i never (asked|said|wanted|cared|told)",
    "didn'?t (ask|say|request)",
    "i told you",
    "(undo|revert) (that|this)",
    '"(no|nope|wait|whoa|hold on|hang on)[,.! ]',
  ].join("|"),
  "i",
);

/**
 * A typed correction is short. Anything this long in a user row is a paste,
 * a skill-body expansion, or injected context — never "that's not what I
 * meant". Long rows can still serve as the ORIGINAL (pastes get quoted
 * verbatim-but-capped); they just can't fire markers themselves.
 */
const MAX_CORRECTION_LEN = 800;

/** Strip injected harness blocks, then flatten whitespace for matching/display. */
function cleanUserText(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Harness-injected user rows that were never typed by a human. */
function isHarnessNoise(flat: string): boolean {
  return (
    flat.startsWith("Caveat:") ||
    flat.startsWith("[Request interrupted") ||
    flat.startsWith("(Re-invocation of") ||
    flat.includes("<command-name>") ||
    flat.includes("<command-message>") ||
    flat.includes("<local-command") ||
    flat.includes("<task-notification>") ||
    flat.includes("Base directory for this skill:")
  );
}

function snip(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap - 1)}…`;
}

function matchMarker(flat: string): { marker: Marker; matched: string } | null {
  for (const marker of MARKERS) {
    const m = marker.re.exec(flat);
    if (m) return { marker, matched: m[0] };
  }
  return null;
}

function mineSession(session: SearchSession, events: TimelineEvent[]): { entries: WordEntry[]; matches: number } {
  const entries: WordEntry[] = [];
  let matches = 0;

  let original: { text: string; ts: string | null } | null = null;
  let assistantTurns = 0;
  let toolCalls = 0;
  let firstAction = "";

  for (const ev of events) {
    if (ev.kind === "assistant" || ev.kind === "tool_use") {
      assistantTurns++;
      if (ev.kind === "tool_use") toolCalls += (ev.text.match(/(^|\n)→ /g) ?? []).length;
      if (!firstAction) {
        const flat = ev.text.replace(/\s+/g, " ").trim();
        if (flat) firstAction = snip(flat, ACTION_CAP);
      }
      continue;
    }
    if (ev.kind !== "user") continue; // tool_result/summary/other: neither prose nor a reset

    const flat = cleanUserText(ev.text);
    if (!flat || isHarnessNoise(flat)) continue;

    const hit =
      flat.length >= MIN_SUBSTANTIVE && flat.length <= MAX_CORRECTION_LEN ? matchMarker(flat) : null;
    // Transcripts occasionally log the same user message twice (resends /
    // partial rewrites) — a message must not be paired with itself.
    const selfPair = original !== null && original.text.slice(0, 80) === flat.slice(0, 80);
    if (hit && original && !selfPair) {
      matches++;
      if (entries.length < SESSION_CAP) {
        // A correction fired before the assistant did anything is the user
        // fixing their own words — a mis-said, whatever marker caught it.
        const selfCorrection = assistantTurns === 0;
        entries.push({
          file: session.file,
          sessionId: session.id,
          dirName: session.dirName,
          approxPath: session.approxPath,
          ts: ev.ts,
          category: selfCorrection ? "missaid" : hit.marker.category,
          confidence: hit.marker.confidence,
          label: hit.marker.label,
          matched: hit.matched,
          original: snip(original.text, QUOTE_CAP),
          correction: snip(flat, QUOTE_CAP),
          assistantTurns,
          toolCalls,
          firstAction,
        });
      }
    }

    if (flat.length >= MIN_SUBSTANTIVE) {
      original = { text: flat, ts: ev.ts };
      assistantTurns = 0;
      toolCalls = 0;
      firstAction = "";
    }
  }

  return { entries, matches };
}

/**
 * Memoized per logDir for 5 minutes (same TTL as the metrics scan) — this
 * walks the whole corpus, and correction history changes on the order of
 * sessions, not keystrokes. Deliberately does NOT feed `transcriptCache.ts`:
 * a corpus-wide sweep would evict search's working set of matching files.
 */
let cache: { key: string; at: number; data: WordsResults } | null = null;
const TTL_MS = 5 * 60 * 1000;

/** Drop the memo. Exposed for tooling/tests. */
export function clearWordsCache(): void {
  cache = null;
}

export async function buildWords(logDir: string): Promise<WordsResults> {
  if (cache && cache.key === logDir && Date.now() - cache.at < TTL_MS) return cache.data;

  const sessions = [...(await enumerateSessions(logDir))].sort((a, b) => b.mtime.localeCompare(a.mtime));

  const entries: WordEntry[] = [];
  let matchedSessions = 0;
  let totalMatches = 0;

  for (const session of sessions) {
    let raw: string;
    try {
      raw = await readFile(session.file, "utf8");
    } catch {
      continue; // deleted mid-scan / unreadable — skip
    }
    if (!PREFILTER.test(raw)) continue;

    const mined = mineSession(session, parseTranscriptText(raw));
    if (mined.matches === 0) continue;
    matchedSessions++;
    totalMatches += mined.matches;
    for (const e of mined.entries) {
      if (entries.length < RESULT_CAP) entries.push(e);
    }
  }

  entries.sort((a, b) => (b.ts ?? "").localeCompare(a.ts ?? ""));

  const data: WordsResults = {
    sessionsScanned: sessions.length,
    matchedSessions,
    totalMatches,
    truncated: totalMatches > entries.length,
    entries,
  };
  // Never memoize an empty/unreadable corpus — same caution as search's memo.
  if (data.sessionsScanned > 0) cache = { key: logDir, at: Date.now(), data };
  return data;
}
