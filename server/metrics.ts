import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { decodeProjectDirApprox } from "./paths.ts";

/**
 * Corpus-wide metrics derived from the raw `.jsonl` transcripts: volume, pace,
 * token usage, and an estimated spend. Read-only, like the rest of the API.
 *
 * Cost is an ESTIMATE: per-message token usage from the transcripts priced at
 * public list rates (below). Prompt-cache reads are priced at the cached rate,
 * so this tracks real billing far better than naive input pricing — but it is
 * still indicative, not an invoice.
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
  harvest: ProjectMetric[];
  self: ProjectMetric | null;
}

const SIZE_CAP = 60 * 1024 * 1024;

/** Public list pricing, USD per 1M tokens: [input, output, cacheWrite, cacheRead]. */
const PRICING: Record<"opus" | "sonnet" | "haiku", [number, number, number, number]> = {
  opus: [15, 75, 18.75, 1.5],
  sonnet: [3, 15, 3.75, 0.3],
  haiku: [1, 5, 1.25, 0.1],
};

function family(model: unknown): keyof typeof PRICING | null {
  const m = typeof model === "string" ? model.toLowerCase() : "";
  if (m.includes("opus")) return "opus";
  if (m.includes("sonnet")) return "sonnet";
  if (m.includes("haiku")) return "haiku";
  return null;
}

/** Throwaway dirs the profile snapshot also excludes: tmp, test scaffolds, worktrees. */
function isScaffold(dirName: string): boolean {
  return (
    dirName.startsWith("-private-") ||
    dirName.includes("-T-Example") ||
    dirName.includes("-T-example-project") ||
    dirName.includes("claude-worktrees")
  );
}

/** Best-effort display name: the path tail at/after the last `Projects` segment. */
function friendlyName(dirName: string): string {
  const parts = dirName.split("-").filter(Boolean);
  const idx = parts.lastIndexOf("Projects");
  if (idx >= 0) {
    const tail = parts.slice(idx + 1);
    return tail.length ? tail.join("-") : "Projects (root)";
  }
  const approx = decodeProjectDirApprox(dirName);
  return path.basename(approx) || dirName;
}

interface Acc {
  dirName: string;
  name: string;
  scaffold: boolean;
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

let cache: { key: string; at: number; data: Metrics } | null = null;
const TTL_MS = 5 * 60 * 1000;

/** Scan every transcript and roll it up. Memoized per logDir for {@link TTL_MS}. */
export async function buildMetrics(logDir: string): Promise<Metrics> {
  if (cache && cache.key === logDir && Date.now() - cache.at < TTL_MS) return cache.data;

  let dirNames: string[];
  try {
    dirNames = (await readdir(logDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    dirNames = [];
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
      name: friendlyName(dirName),
      scaffold,
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

        if (type === "user" && msg) {
          const content = msg.content;
          let txt = "";
          if (typeof content === "string") {
            txt = content;
          } else if (Array.isArray(content)) {
            const isToolResult = content.some(
              (b) => b && typeof b === "object" && (b as { type?: string }).type === "tool_result",
            );
            if (!isToolResult) {
              txt = content
                .filter(
                  (b): b is { type: string; text: string } =>
                    !!b && typeof b === "object" && (b as { type?: string }).type === "text",
                )
                .map((b) => b.text)
                .join("");
            }
          }
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
            const [pi, po, pcw, pcr] = PRICING[fam];
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
    harvest: sortedByCost
      .filter((p) => p.dirName.toLowerCase().includes("harvest"))
      .sort((x, y) => (x.first ?? "").localeCompare(y.first ?? "")),
    self: sortedByCost.find((p) => p.dirName.includes("claude-code-log")) ?? null,
  };

  cache = { key: logDir, at: Date.now(), data };
  return data;
}
