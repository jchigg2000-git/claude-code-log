import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { repoKeysFor } from "./fsScan.ts";
import { resolveProjectName } from "./projectNames.ts";
import { family, loadPricing } from "./pricing.ts";
import { ttlMemo } from "./memo.ts";

/**
 * Corpus-wide metrics derived from the raw `.jsonl` transcripts: volume, pace,
 * token usage, and an estimated spend. Read-only, like the rest of the API.
 *
 * Cost is an ESTIMATE: per-message token usage from the transcripts priced at
 * public list rates (from {@link loadPricing}, see server/pricing.ts). Prompt-
 * cache reads are priced at the cached rate, so this tracks real billing far
 * better than naive input pricing — but it is still indicative, not an
 * invoice. Rates are overridable (env var or a repo-root `pricing.json`) so
 * the estimate doesn't silently decay as list prices change — see
 * `Metrics.pricing` for which table produced a given result.
 */

export interface ProjectMetric {
  name: string;
  dirName: string;
  sessions: number;
  userPrompts: number;
  assistant: number;
  tokensTotal: number;
  cacheRead: number;
  cost: number;
  first: string | null;
  last: string | null;
}

export interface DayMetric {
  date: string;
  events: number;
  cost: number;
}

/** One subagent type, rolled up across the corpus. */
export interface AgentTypeStat {
  type: string;
  count: number;
  seconds: number; // cumulative on-the-clock time for matched runs
  maxSeconds: number;
}

/** A single notably long subagent run, for the "longest missions" list. */
export interface AgentMission {
  type: string;
  description: string;
  seconds: number;
  at: string;
}

/**
 * Subagent (the `Agent`/`Task` tool) analysis. Counts are MEASURED — every
 * `tool_use` with name Agent/Task is one dispatch. Durations are MEASURED too:
 * the wall-clock gap between the dispatch and its matching `tool_result` (paired
 * by `tool_use_id`). A few unmatched dispatches (agent never returned a result
 * in-transcript) contribute to `total` but not to `totalSeconds`.
 */
export interface AgentSummary {
  total: number;
  withDuration: number;
  totalSeconds: number;
  byType: AgentTypeStat[];
  byDay: { date: string; count: number }[];
  longest: AgentMission[];
}

/**
 * One long MAIN-THREAD work turn — a "mission" the human kicked off and Claude
 * then worked for a stretch. Duration is the turn's working time (the same
 * gap-sum as {@link Metrics.engagement}, scoped to one turn). This is the honest
 * "longest single thing that happened" — sub-agent runs (`AgentMission`) cap out
 * at ~25 min, but a main-thread turn can run over an hour.
 */
export interface MissionStat {
  seconds: number;
  opening: string;
  project: string;
}

export interface Metrics {
  span: { first: string | null; last: string | null; days: number; activeDays: number };
  totals: {
    sessions: number;
    lines: number;
    userPrompts: number;
    assistant: number;
    toolCalls: number;
    humanProjects: number;
    scaffoldProjects: number;
    tokIn: number;
    tokOut: number;
    tokCacheWrite: number;
    tokCacheRead: number;
    cost: number;
    promptChars: number;
    maxPrompt: number;
  };
  byDay: DayMetric[];
  models: { model: string; tokens: number }[];
  tools: { name: string; count: number }[];
  topByCost: ProjectMetric[];
  self: ProjectMetric | null;
  agents: AgentSummary;
  /**
   * Measured "on the clock" working time — the time Claude was actually doing
   * work, INCLUDING the main thread (not just sub-agents). Computed on the main
   * thread (sidechain rows excluded) as the sum of gaps between consecutive
   * messages, counting model-generation gaps AND tool/sub-agent execution gaps
   * but EXCLUDING the gap before a real human prompt (that's the human thinking,
   * not Claude working). Each gap is clamped at {@link WORK_CAP_SEC} to drop
   * idle/anomalous spans. `workingSeconds` ≫ `agents.totalSeconds`: the fleet is
   * only the delegated slice of the whole.
   */
  engagement: { workingSeconds: number; gapCapSeconds: number };
  /** Longest main-thread work turns, human-initiated, by working time. */
  topMissions: MissionStat[];
  /** Which pricing table priced this scan's cost figures, and as-of when. See server/pricing.ts. */
  pricing: { source: string; effective: string };
}

const SIZE_CAP = 60 * 1024 * 1024;

/** Openings that aren't a meaningful human "mission" label: harness injections,
 *  bare approvals, system tags. Turns opening with these are dropped from the list. */
function isMissionNoise(s: string): boolean {
  const t = s.trim();
  if (!t) return true;
  if (t.startsWith("<")) return true; // task-notification / command tags
  if (t.startsWith("Caveat:") || t.startsWith("[Request interrupted")) return true;
  if (t.startsWith("Base directory for this skill")) return true;
  if (t.length < 16 && /^(y|yes|ok|okay|k|continue|go|go on|proceed|sure|do it|done|next|yep|approved?|resume)\b/i.test(t)) return true;
  return false;
}
/** A single gap between consecutive messages longer than this is treated as a
 *  pause/anomaly and clamped, so working time tracks active work, not wall-clock. */
const WORK_CAP_SEC = 600;

/** Throwaway dirs the profile snapshot also excludes: tmp, test scaffolds, worktrees. */
function isScaffold(dirName: string): boolean {
  return (
    dirName.startsWith("-private-") ||
    dirName.includes("-T-Example") ||
    dirName.includes("-T-example-project") ||
    dirName.includes("claude-worktrees")
  );
}

/**
 * Classify one `user` line: is it a real human prompt (vs a tool_result
 * carrier), and if so, its raw text blocks. Engagement tracking and prompt
 * accounting both need this test; the blocks come back unjoined because the
 * two consumers deliberately join differently (" " for turn-opening text,
 * "" for character counts) and that difference must stay call-site-explicit.
 * A line with no content at all still counts as human — only a tool_result
 * demotes it — which preserves the turn/gap semantics exactly.
 */
function humanPrompt(msg: Record<string, unknown> | null): { isHuman: boolean; parts: string[] } {
  const c = msg?.content;
  if (typeof c === "string") return { isHuman: true, parts: [c] };
  if (Array.isArray(c)) {
    const isToolRes = c.some((b) => b && typeof b === "object" && (b as { type?: string }).type === "tool_result");
    if (isToolRes) return { isHuman: false, parts: [] };
    return {
      isHuman: true,
      parts: c
        .filter(
          (b): b is { type: string; text: string } =>
            !!b && typeof b === "object" && (b as { type?: string }).type === "text",
        )
        .map((b) => b.text),
    };
  }
  return { isHuman: true, parts: [] };
}

interface Acc {
  dirName: string;
  name: string;
  sessions: number;
  lines: number;
  userPrompts: number;
  assistant: number;
  tokIn: number;
  tokOut: number;
  tokCW: number;
  tokCR: number;
  cost: number;
  first: string | null;
  last: string | null;
}

function toProjectMetric(a: Acc): ProjectMetric {
  return {
    name: a.name,
    dirName: a.dirName,
    sessions: a.sessions,
    userPrompts: a.userPrompts,
    assistant: a.assistant,
    tokensTotal: a.tokIn + a.tokOut + a.tokCW + a.tokCR,
    cacheRead: a.tokCR,
    cost: Math.round(a.cost * 100) / 100,
    first: a.first,
    last: a.last,
  };
}

const memo = ttlMemo<Metrics>(5 * 60 * 1000);

/**
 * Scan every transcript and roll it up. Memoized per (logDir, repoRoot) for
 * the memo's 5-minute TTL; a scan whose readdir failed is never memoized.
 *
 * `repoRoot` is optional and only ever improves display names: with it, every
 * project is named by matching crawled repo paths against the encoded log
 * directory (lossless); without it, names fall back to the coarser rungs of
 * {@link resolveProjectName}. It is part of the cache key because two roots
 * over the same logDir produce different names for identical numbers.
 */
export function buildMetrics(logDir: string, repoRoot?: string): Promise<Metrics> {
  return memo.get(`${logDir}::${repoRoot ?? ""}`, () => computeMetrics(logDir, repoRoot));
}

async function computeMetrics(
  logDir: string,
  repoRoot?: string,
): Promise<{ value: Metrics; healthy: boolean }> {

  const pricing = await loadPricing();

  // Cheap next to the transcript scan below: ~30 readdir + ~180 stat for a
  // 94-entry root, and it only reads directory metadata. crawlRepos swallows
  // its own errors, so an unreadable or missing root yields [] and the naming
  // ladder simply drops to its lower rungs.
  const repoKeys = await repoKeysFor(repoRoot);

  let dirNames: string[];
  let scanned = true;
  try {
    dirNames = (await readdir(logDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    // A transient ENOENT/EACCES/FS race must not get cached as an empty result for the whole TTL.
    dirNames = [];
    scanned = false;
  }

  const projects: Acc[] = [];
  const dayEvents = new Map<string, number>();
  const dayCost = new Map<string, number>();
  const modelTokens = new Map<string, number>();
  const toolCounts = new Map<string, number>();
  let scaffoldCount = 0;
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  let totalToolCalls = 0;
  let promptChars = 0;
  let maxPrompt = 0;

  // Subagent dispatch/return pairing. Keyed by tool_use_id (globally unique),
  // so we can pair across messages and across files in a single pass.
  const agentUses = new Map<string, { ts: string | null; type: string; desc: string }>();
  const agentResults = new Map<string, string | null>();
  let workingSec = 0;
  const allMissions: MissionStat[] = []; // longest main-thread work turns

  for (const dirName of dirNames) {
    const scaffold = isScaffold(dirName);
    const projDir = path.join(logDir, dirName);
    let files: string[];
    try {
      files = (await readdir(projDir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    if (files.length === 0) continue;
    if (scaffold) {
      scaffoldCount++;
      continue; // counted, but never read — keeps the scan to the real corpus
    }

    const a: Acc = {
      dirName,
      name: resolveProjectName(dirName, repoKeys, repoRoot),
      sessions: 0,
      lines: 0,
      userPrompts: 0,
      assistant: 0,
      tokIn: 0,
      tokOut: 0,
      tokCW: 0,
      tokCR: 0,
      cost: 0,
      first: null,
      last: null,
    };

    for (const f of files) {
      const full = path.join(projDir, f);
      let raw: string;
      try {
        if ((await stat(full)).size > SIZE_CAP) {
          a.sessions++;
          continue;
        }
        raw = await readFile(full, "utf8");
      } catch {
        continue;
      }
      a.sessions++;

      let prevMainTs: string | null = null; // main-thread working-time gap accumulation
      // Per-turn accumulation, to surface the longest single missions.
      let turnSec = 0;
      let turnOpen = "";
      let turnHas = false;
      const closeTurn = (): void => {
        if (turnHas && turnSec > 0 && !isMissionNoise(turnOpen)) {
          allMissions.push({
            seconds: Math.round(turnSec),
            opening: turnOpen.trim().replace(/\s+/g, " ").slice(0, 90),
            project: a.name,
          });
        }
      };
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        a.lines++;
        let o: Record<string, unknown>;
        try {
          o = JSON.parse(trimmed);
        } catch {
          continue;
        }
        // A line parsing to null/primitive (corrupt/partial JSONL) doesn't throw; skip it before
        // dereferencing o.timestamp, like the other malformed lines.
        if (!o || typeof o !== "object") continue;

        const ts = typeof o.timestamp === "string" ? o.timestamp : null;
        const day = ts && ts.length >= 10 ? ts.slice(0, 10) : null;
        if (ts) {
          if (!firstTs || ts < firstTs) firstTs = ts;
          if (!lastTs || ts > lastTs) lastTs = ts;
          if (!a.first || ts < a.first) a.first = ts;
          if (!a.last || ts > a.last) a.last = ts;
        }

        const type = o.type;
        const msg =
          o.message && typeof o.message === "object"
            ? (o.message as Record<string, unknown>)
            : null;

        // Working time, MAIN THREAD only (sidechain rows are the sub-agents, and
        // their wall-clock already shows up as the tool-result gap on the main
        // thread). Count generation + tool-execution gaps; skip the gap before a
        // real human prompt (that gap is the human thinking, not Claude working).
        // Computed once per line; engagement tracking here and the prompt
        // accounting further down both consume it.
        const prompt = type === "user" ? humanPrompt(msg) : null;

        if (ts && o.isSidechain !== true && (type === "user" || type === "assistant")) {
          const isHumanPrompt = prompt?.isHuman ?? false;
          const promptTxt = prompt?.isHuman ? prompt.parts.join(" ") : "";
          if (prevMainTs) {
            const gap = (Date.parse(ts) - Date.parse(prevMainTs)) / 1000;
            if (gap > 0 && !isHumanPrompt) {
              const capped = Math.min(gap, WORK_CAP_SEC);
              workingSec += capped;
              turnSec += capped; // attribute to the in-flight turn
            }
          }
          if (isHumanPrompt) {
            // A new human prompt closes the previous turn and opens this one.
            closeTurn();
            turnSec = 0;
            turnOpen = promptTxt;
            turnHas = true;
          }
          prevMainTs = ts;
        }

        // Subagent dispatches (tool_use name Agent/Task) and their returns
        // (tool_result) can sit in different messages; record both for pairing.
        if (msg && Array.isArray(msg.content)) {
          for (const b of msg.content) {
            if (!b || typeof b !== "object") continue;
            const blk = b as { type?: string; name?: string; id?: string; tool_use_id?: string; input?: Record<string, unknown> };
            if (blk.type === "tool_use" && (blk.name === "Agent" || blk.name === "Task") && blk.id) {
              const input = blk.input ?? {};
              const subType = typeof input.subagent_type === "string" && input.subagent_type ? input.subagent_type : "unknown";
              const desc = typeof input.description === "string" ? input.description : "";
              agentUses.set(blk.id, { ts, type: subType, desc });
            } else if (blk.type === "tool_result" && blk.tool_use_id && !agentResults.has(blk.tool_use_id)) {
              agentResults.set(blk.tool_use_id, ts);
            }
          }
        }

        if (prompt && msg) {
          const txt = prompt.isHuman ? prompt.parts.join("") : "";
          if (txt.trim()) {
            a.userPrompts++;
            promptChars += txt.length;
            if (txt.length > maxPrompt) maxPrompt = txt.length;
          }
        }

        if (type === "assistant" && msg) {
          a.assistant++;
          const usage = (msg.usage ?? {}) as Record<string, number>;
          const ti = usage.input_tokens || 0;
          const to = usage.output_tokens || 0;
          const tcw = usage.cache_creation_input_tokens || 0;
          const tcr = usage.cache_read_input_tokens || 0;
          a.tokIn += ti;
          a.tokOut += to;
          a.tokCW += tcw;
          a.tokCR += tcr;

          const model = typeof msg.model === "string" ? msg.model : null;
          const fam = family(model);
          let cost = 0;
          if (fam) {
            const [pi, po, pcw, pcr] = pricing.rates[fam];
            cost = (ti * pi + to * po + tcw * pcw + tcr * pcr) / 1_000_000;
          }
          a.cost += cost;
          if (model) modelTokens.set(model, (modelTokens.get(model) ?? 0) + ti + to + tcw + tcr);
          if (day) {
            dayEvents.set(day, (dayEvents.get(day) ?? 0) + 1);
            dayCost.set(day, (dayCost.get(day) ?? 0) + cost);
          }

          if (Array.isArray(msg.content)) {
            for (const b of msg.content) {
              if (b && typeof b === "object" && (b as { type?: string }).type === "tool_use") {
                const nm = (b as { name?: string }).name ?? "tool";
                toolCounts.set(nm, (toolCounts.get(nm) ?? 0) + 1);
                totalToolCalls++;
              }
            }
          }
        }
      }
      closeTurn(); // flush the final turn of the session
    }
    projects.push(a);
  }

  const totals = {
    sessions: 0,
    lines: 0,
    userPrompts: 0,
    assistant: 0,
    toolCalls: totalToolCalls,
    humanProjects: projects.length,
    scaffoldProjects: scaffoldCount,
    tokIn: 0,
    tokOut: 0,
    tokCacheWrite: 0,
    tokCacheRead: 0,
    cost: 0,
    promptChars,
    maxPrompt,
  };
  for (const a of projects) {
    totals.sessions += a.sessions;
    totals.lines += a.lines;
    totals.userPrompts += a.userPrompts;
    totals.assistant += a.assistant;
    totals.tokIn += a.tokIn;
    totals.tokOut += a.tokOut;
    totals.tokCacheWrite += a.tokCW;
    totals.tokCacheRead += a.tokCR;
    totals.cost += a.cost;
  }
  totals.cost = Math.round(totals.cost * 100) / 100;

  const byDay: DayMetric[] = [...dayEvents.keys()]
    .sort()
    .map((date) => ({
      date,
      events: dayEvents.get(date) ?? 0,
      cost: Math.round((dayCost.get(date) ?? 0) * 100) / 100,
    }));

  const spanDays =
    firstTs && lastTs
      ? Math.round((Date.parse(lastTs) - Date.parse(firstTs)) / 86_400_000) + 1
      : 0;

  const sortedByCost = projects
    .map(toProjectMetric)
    .sort((x, y) => y.cost - x.cost);

  // Roll up subagent dispatches: pair each with its result for a duration.
  const typeStats = new Map<string, AgentTypeStat>();
  const agentDay = new Map<string, number>();
  const missions: AgentMission[] = [];
  let withDuration = 0;
  let totalAgentSec = 0;
  for (const [id, use] of agentUses) {
    const st =
      typeStats.get(use.type) ??
      { type: use.type, count: 0, seconds: 0, maxSeconds: 0 };
    st.count++;
    if (use.ts) {
      const d = use.ts.slice(0, 10);
      agentDay.set(d, (agentDay.get(d) ?? 0) + 1);
    }
    const resTs = agentResults.get(id);
    if (resTs && use.ts) {
      const sec = (Date.parse(resTs) - Date.parse(use.ts)) / 1000;
      if (sec >= 0 && Number.isFinite(sec)) {
        withDuration++;
        totalAgentSec += sec;
        st.seconds += sec;
        if (sec > st.maxSeconds) st.maxSeconds = sec;
        missions.push({ type: use.type, description: use.desc, seconds: sec, at: use.ts });
      }
    }
    typeStats.set(use.type, st);
  }
  const agents: AgentSummary = {
    total: agentUses.size,
    withDuration,
    totalSeconds: Math.round(totalAgentSec),
    byType: [...typeStats.values()]
      .map((s) => ({ ...s, seconds: Math.round(s.seconds), maxSeconds: Math.round(s.maxSeconds) }))
      .sort((x, y) => y.count - x.count),
    byDay: [...agentDay.keys()].sort().map((date) => ({ date, count: agentDay.get(date) ?? 0 })),
    longest: missions
      .sort((x, y) => y.seconds - x.seconds)
      .slice(0, 6)
      .map((m) => ({ ...m, seconds: Math.round(m.seconds) })),
  };

  const data: Metrics = {
    span: { first: firstTs, last: lastTs, days: spanDays, activeDays: byDay.length },
    totals,
    byDay,
    models: [...modelTokens.entries()]
      .map(([model, tokens]) => ({ model, tokens }))
      .sort((x, y) => y.tokens - x.tokens),
    tools: [...toolCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((x, y) => y.count - x.count)
      .slice(0, 14),
    topByCost: sortedByCost.slice(0, 12),
    self: sortedByCost.find((p) => p.dirName.includes("claude-code-log")) ?? null,
    agents,
    engagement: { workingSeconds: Math.round(workingSec), gapCapSeconds: WORK_CAP_SEC },
    topMissions: allMissions.sort((x, y) => y.seconds - x.seconds).slice(0, 6),
    pricing: { source: pricing.source, effective: pricing.effective },
  };

  // `scanned` is the health signal: a failed readdir must not be memoized.
  return { value: data, healthy: scanned };
}
