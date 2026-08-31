import { readFile } from "node:fs/promises";
import path from "node:path";
import { ttlMemo } from "./memo.ts";
import { allowedRoots, safeResolve } from "./paths.ts";

/**
 * Reconstruct the project→project journey from `~/.claude/history.jsonl` — the
 * one place Claude Code records every line you typed at the prompt, with a
 * timestamp and the project (cwd) it was typed in.
 *
 * The graph is honest where it can be and flags its guesses where it can't:
 * a hop is "explicit" only when a line typed right around the switch actually
 * names the other project. Everything else is an "inferred" leap of faith —
 * shown, not hidden, with the best-guess bridging line attached. Read-only.
 */

export interface JourneyNode {
  id: string;
  name: string;
  commands: number;
  sessions: number;
  first: string;
  last: string;
}

export interface JourneyEdge {
  from: string;
  to: string;
  count: number;
  confidence: "explicit" | "inferred";
  bridge: string;
  at: string;
}

export interface JourneyVisit {
  ts: string;
  project: string;
  name: string;
  opening: string;
  commands: number;
}

export interface Journey {
  windowDays: number;
  first: string | null;
  last: string | null;
  totalCommands: number;
  totalSwitches: number;
  nodes: JourneyNode[];
  edges: JourneyEdge[];
  visits: JourneyVisit[];
  /** Where we looked for `history.jsonl`, and whether it was readable. A missing
   *  file is not an error — it yields an empty journey — so the client needs
   *  this to tell "nothing recorded yet" apart from "that file isn't there". */
  historyPath: string;
  historyFound: boolean;
}

interface HistEntry {
  display: string;
  timestamp: number;
  project: string;
  sessionId: string;
}

/** Pure flow words — they advance work but never say *where* you went. */
const NOISE = new Set([
  "approve", "approved", "yes", "y", "yep", "yeah", "ok", "okay", "k", "sure",
  "continue", "go", "next", "do it", "ship it", "good", "great", "thanks",
  "thank you", "stop", "no", "n", "nope", "wait", "undo", "fix it", "retry",
  // Session control — advances/ends a session but carries no intent.
  "exit", "quit", "clear", "resume", "/exit", "/quit", "/clear", "/compact",
  "/resume", "/cost", "/status", "/help", "bye",
]);

function isNoise(raw: string): boolean {
  const s = raw.trim().toLowerCase();
  if (s.length < 4) return true;
  if (/^\d+$/.test(s)) return true;
  if (NOISE.has(s)) return true;
  return false;
}

/** Collapse worktrees onto their parent and give a friendly tail name. */
function normalizeProject(p: string): { id: string; name: string } {
  let id = p;
  const wt = id.search(/\/(\.?claude-worktrees|worktrees)\//);
  if (wt >= 0) id = id.slice(0, wt);
  id = id.replace(/\/+$/, "");
  const home = process.env.HOME ?? "";
  let name: string;
  if (home && id === home) name = "~";
  else if (/\/Projects$/.test(id)) name = "Projects/";
  else name = path.basename(id) || id;
  return { id, name };
}

/** Distinctive tokens of a project name, for detecting explicit mentions. */
function nameTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 5 || (t.length >= 4 && !/^\d+$/.test(t)));
}

function mentions(text: string, tokens: string[], whole: string): boolean {
  const t = text.toLowerCase();
  if (whole.length >= 4 && t.includes(whole.toLowerCase())) return true;
  return tokens.some((tok) => t.includes(tok));
}

function clean(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 160);
}

const memo = ttlMemo<Journey>(5 * 60 * 1000);

/**
 * Build the journey for the last `windowDays`. `logDir` is the resolved
 * Claude projects dir (e.g. ~/.claude/projects); history sits next to it.
 * Memoized per (logDir, windowDays); a scan with no history file is not.
 */
export function buildJourney(logDir: string, windowDays = 50): Promise<Journey> {
  return memo.get(`${logDir}::${windowDays}`, () => computeJourney(logDir, windowDays));
}

async function computeJourney(
  logDir: string,
  windowDays: number,
): Promise<{ value: Journey; healthy: boolean }> {

  // `logDir` arrives validated, but its PARENT is not covered by that check —
  // when logDir is itself an allowed root (e.g. $HOME), dirname() climbs out of
  // it, and this read would inherit clearance it was never granted. Re-validate
  // the derived path on its own merits.
  const historyPath = path.join(path.dirname(logDir), "history.jsonl");
  const historyAllowed = allowedRoots().some((r) => safeResolve(r, historyPath));
  let raw = "";
  let historyFound = true;
  try {
    if (!historyAllowed) throw new Error("history.jsonl resolves outside the allowed roots");
    raw = await readFile(historyPath, "utf8");
  } catch {
    // Not an error: plenty of machines have no history file. Report it as a
    // degraded state instead of throwing, and let the client say so plainly.
    raw = "";
    historyFound = false;
  }

  const cutoff = Date.now() - windowDays * 86_400_000;
  const entries: (HistEntry & { id: string; name: string })[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let o: HistEntry;
    try {
      o = JSON.parse(s) as HistEntry;
    } catch {
      continue;
    }
    if (!o || typeof o !== "object") continue;
    if (typeof o.timestamp !== "number" || o.timestamp < cutoff) continue;
    if (typeof o.project !== "string" || !o.project) continue;
    const { id, name } = normalizeProject(o.project);
    entries.push({ ...o, display: typeof o.display === "string" ? o.display : "", id, name });
  }
  entries.sort((a, b) => a.timestamp - b.timestamp);

  // Per-project rollup.
  const nodeMap = new Map<string, JourneyNode & { _sessions: Set<string> }>();
  for (const e of entries) {
    let n = nodeMap.get(e.id);
    if (!n) {
      n = {
        id: e.id,
        name: e.name,
        commands: 0,
        sessions: 0,
        first: new Date(e.timestamp).toISOString(),
        last: new Date(e.timestamp).toISOString(),
        _sessions: new Set(),
      };
      nodeMap.set(e.id, n);
    }
    n.commands++;
    if (e.sessionId) n._sessions.add(e.sessionId);
    const iso = new Date(e.timestamp).toISOString();
    if (iso < n.first) n.first = iso;
    if (iso > n.last) n.last = iso;
  }
  const nodes: JourneyNode[] = [...nodeMap.values()]
    .map(({ _sessions, ...n }) => ({ ...n, sessions: _sessions.size }))
    .sort((a, b) => b.commands - a.commands);

  // Walk the timeline: visits (contiguous same-project runs) + hops.
  const visits: JourneyVisit[] = [];
  type Agg = { from: string; to: string; count: number; explicit: boolean; bridge: string; at: number };
  const edgeMap = new Map<string, Agg>();
  let totalSwitches = 0;

  let curId: string | null = null;
  let visitStart = 0;
  let visitCount = 0;
  let visitOpening = "";
  let prevId: string | null = null;
  let prevLastSubstantive = "";

  const flushVisit = () => {
    if (curId === null) return;
    const nm = nodeMap.get(curId);
    visits.push({
      ts: new Date(visitStart).toISOString(),
      project: curId,
      name: nm ? nm.name : path.basename(curId),
      opening: clean(visitOpening || "—"),
      commands: visitCount,
    });
  };

  for (const e of entries) {
    if (e.id !== curId) {
      flushVisit();
      if (prevId && prevId !== e.id) {
        // Hop from prevId → e.id. The line that "led here" is the first
        // substantive thing typed on arrival; fall back to the last
        // substantive line typed before leaving.
        totalSwitches++;
        const arrival = !isNoise(e.display) ? e.display : "";
        const bridge = arrival || prevLastSubstantive || e.display;
        const fromN = nodeMap.get(prevId);
        const toN = nodeMap.get(e.id);
        const fromName = fromN ? fromN.name : "";
        const toName = toN ? toN.name : "";
        const explicit =
          mentions(bridge, nameTokens(toName), toName) ||
          mentions(bridge, nameTokens(fromName), fromName) ||
          mentions(prevLastSubstantive, nameTokens(toName), toName);
        const k = `${prevId}\0${e.id}`;
        const agg = edgeMap.get(k);
        if (!agg) {
          edgeMap.set(k, {
            from: prevId,
            to: e.id,
            count: 1,
            explicit,
            bridge: clean(bridge),
            at: e.timestamp,
          });
        } else {
          agg.count++;
          agg.explicit = agg.explicit || explicit;
          if (e.timestamp >= agg.at) {
            agg.at = e.timestamp;
            agg.bridge = clean(bridge);
          }
        }
      }
      curId = e.id;
      prevId = e.id;
      visitStart = e.timestamp;
      visitCount = 0;
      visitOpening = !isNoise(e.display) ? e.display : "";
    }
    visitCount++;
    if (!visitOpening && !isNoise(e.display)) visitOpening = e.display;
    if (!isNoise(e.display)) prevLastSubstantive = e.display;
  }
  flushVisit();

  const edges: JourneyEdge[] = [...edgeMap.values()]
    .map((a) => ({
      from: a.from,
      to: a.to,
      count: a.count,
      confidence: (a.explicit ? "explicit" : "inferred") as JourneyEdge["confidence"],
      bridge: a.bridge,
      at: new Date(a.at).toISOString(),
    }))
    .sort((x, y) => y.count - x.count);

  const data: Journey = {
    windowDays,
    first: entries.length ? new Date(entries[0].timestamp).toISOString() : null,
    last: entries.length ? new Date(entries[entries.length - 1].timestamp).toISOString() : null,
    totalCommands: entries.length,
    totalSwitches,
    nodes,
    edges,
    visits,
    historyPath,
    historyFound,
  };

  // A missing history file is unhealthy for caching — it may be an FS race,
  // or the operator may be about to point Settings at the right log location.
  return { value: data, healthy: historyFound };
}
