import { fetchMetrics } from "../api.ts";
import { loadConfig } from "../config.ts";
import { el, clear } from "../dom.ts";
import { areaChart, barList, logBars, compact, money } from "../charts.ts";
import type { Metrics, AgentSummary, MissionStat } from "../types.ts";

function statStrip(items: [string, string][]): HTMLElement {
  const strip = el("div", { class: "stats snapshot" });
  for (const [v, l] of items) {
    strip.append(
      el("div", { class: "stat" }, el("span", { class: "stat-v" }, v), el("span", { class: "stat-l" }, l)),
    );
  }
  return strip;
}

function section(title: string, lede: string, body: HTMLElement): HTMLElement {
  return el(
    "section",
    { class: "vz-section" },
    el("h2", {}, title),
    el("p", { class: "vz-lede" }, lede),
    body,
  );
}

/** Seconds → a terse human duration: "20.7 h", "5 min", "82 s". */
function dur(sec: number): string {
  if (sec >= 3600) return (sec / 3600).toFixed(1).replace(/\.0$/, "") + " h";
  if (sec >= 60) return Math.round(sec / 60) + " min";
  return Math.round(sec) + " s";
}

/** Minutes/hours for a long work turn: "57 min", "1h 9m". */
function durMission(sec: number): string {
  const m = Math.round(sec / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} min`;
}

/** Distinct, stable colors for the agent-type fleet bar + legend. */
const FLEET_COLORS = [
  "#c98a3c", // accent
  "#5aa9e6", // user-blue
  "#b072d6", // tool-purple
  "#4fc24f", // green
  "#f2d035", // yellow
  "#22b5c4", // cyan
  "#e5362c", // red
  "#8b93a3", // gray
];

/**
 * The headline graphic: time on the clock, and the subagent fleet. The hero
 * "on the clock" figure is the WHOLE of Claude's working time — the main thread
 * plus tools and sub-agents — not just the fleet. Working time is measured from
 * message gaps (human think-time excluded); agent counts and durations are
 * measured (each dispatch is an `Agent`/`Task` tool call paired to its result).
 */
function agentSection(a: AgentSummary, workingHours: number, topMissions: MissionStat[]): HTMLElement {
  const onClockH = a.totalSeconds / 3600;
  const avgSec = a.withDuration ? a.totalSeconds / a.withDuration : 0;

  // Hero numbers — lead with the whole working time, then the fleet's slice.
  const hero = el(
    "div",
    { class: "vz-hero" },
    el(
      "div",
      { class: "vz-hero-fig accent" },
      el("span", { class: "vz-hero-v" }, Math.round(workingHours) + " h"),
      el("span", { class: "vz-hero-l" }, "on the clock"),
    ),
    el(
      "div",
      { class: "vz-hero-fig" },
      el("span", { class: "vz-hero-v" }, compact(a.total)),
      el("span", { class: "vz-hero-l" }, "agents dispatched"),
    ),
    el(
      "div",
      { class: "vz-hero-fig" },
      el("span", { class: "vz-hero-v" }, onClockH.toFixed(1) + " h"),
      el("span", { class: "vz-hero-l" }, "delegated to agents"),
    ),
    el(
      "div",
      { class: "vz-hero-fig" },
      el("span", { class: "vz-hero-v" }, a.byType.length.toString()),
      el("span", { class: "vz-hero-l" }, "agent types"),
    ),
  );

  // Segmented "fleet" bar — proportion of the fleet by type, one strip.
  const fleetBar = el("div", { class: "vz-fleet" });
  const legend = el("div", { class: "vz-legend" });
  a.byType.forEach((t, i) => {
    const color = FLEET_COLORS[i % FLEET_COLORS.length];
    const pct = (t.count / a.total) * 100;
    if (pct >= 0.6) {
      fleetBar.append(
        el("div", {
          class: "vz-fleet-seg",
          style: `width:${pct.toFixed(2)}%;background:${color}`,
          title: `${t.type}: ${t.count} agents · ${dur(t.seconds)}`,
        }),
      );
    }
    legend.append(
      el(
        "span",
        { class: "vz-legend-item" },
        el("span", { class: "vz-legend-dot", style: `background:${color}` }),
        `${t.type} `,
        el("span", { class: "vz-legend-n" }, String(t.count)),
      ),
    );
  });

  // By-type ranked bars — value is count, but each row carries its on-clock time.
  const typeBars = barList(
    a.byType.map((t, i) => ({
      label: t.type,
      value: t.count,
      display: t.count.toLocaleString("en-US"),
      sub: `${dur(t.seconds)} on the clock · avg ${dur(t.seconds / Math.max(1, t.count))}`,
      tone: i === 0 ? "accent" : i === 1 ? "user" : "tool",
    })),
  );

  // Who did the most actual work — ranked by cumulative on-clock time.
  const byTime = [...a.byType].sort((x, y) => y.seconds - x.seconds);
  const workBars = barList(
    byTime.map((t, i) => ({
      label: t.type,
      value: t.seconds,
      display: dur(t.seconds),
      sub: `${t.count} dispatches`,
      tone: i === 0 ? "accent" : "tool",
    })),
  );

  // Longest missions — the heaviest single MAIN-THREAD turns (one prompt, then
  // Claude running for a stretch). These dwarf any single sub-agent, which cap
  // out around 25 min.
  const missions = el("div", { class: "vz-missions" });
  topMissions.forEach((m, i) => {
    missions.append(
      el(
        "div",
        { class: "vz-mission" },
        el("span", { class: "vz-mission-rank" }, `#${i + 1}`),
        el(
          "div",
          { class: "vz-mission-body" },
          el(
            "div",
            { class: "vz-mission-head" },
            el("span", { class: "vz-mission-type" }, m.project),
            el("span", { class: "vz-mission-dur" }, durMission(m.seconds)),
          ),
          el("div", { class: "vz-mission-desc" }, m.opening || "—"),
        ),
      ),
    );
  });

  // Dispatch cadence over time.
  const cadence = areaChart(
    a.byDay.map((d) => ({ date: d.date, value: d.count })),
    { height: 180, peaks: 3, first: a.byDay[0]?.date, last: a.byDay.at(-1)?.date },
  );

  // What that time means — measured, with the main thread included.
  const manHours = el(
    "div",
    { class: "vz-manhours" },
    el("h3", {}, "How much work is that?"),
    el(
      "p",
      {},
      `Measured: Claude was on the clock for `,
      el("strong", {}, `${Math.round(workingHours)} hours`),
      ` of real work — model generating, plus tools and agents executing, with human ` +
        `think-time excluded. That is the whole of it, main thread included. Of that total, the `,
      el("strong", {}, `${a.total} subagents`),
      ` handled `,
      el("strong", {}, `${onClockH.toFixed(1)} hours`),
      ` in parallel — the part that was fanned out rather than done in line.`,
    ),
    el(
      "p",
      { class: "vz-foot" },
      `Working time is measured from message timestamps (each gap capped at ten minutes, ` +
        `human idle excluded); agent counts and durations are exact. Hand-building the same ` +
        `output would take some multiple of ${Math.round(workingHours)} hours — that part isn't measured.`,
    ),
  );

  return el(
    "section",
    { class: "vz-section vz-agentry" },
    el("h2", {}, "The agent fleet"),
    el(
      "p",
      { class: "vz-lede" },
      `Most of this wasn't typed by one model in a chat box — it ran across the main thread and ` +
        `a fleet of subagents working in parallel. Every number is read straight from the ` +
        `transcripts: time on the clock from message gaps (human idle excluded), a dispatch from ` +
        `each Agent/Task call, a duration from the gap to its result.`,
    ),
    hero,
    el("div", { class: "vz-fleet-wrap" }, fleetBar, legend),
    el(
      "div",
      { class: "vz-split" },
      el(
        "div",
        { class: "vz-split-col" },
        el("h3", {}, "By type — who gets called"),
        typeBars,
      ),
      el(
        "div",
        { class: "vz-split-col" },
        el("h3", {}, "By time — who does the work"),
        workBars,
      ),
    ),
    el("h3", { class: "vz-sub-h" }, `Dispatch cadence — ${avgSec.toFixed(0)}s average per run`),
    cadence,
    el("h3", { class: "vz-sub-h" }, "Longest missions — single turns of work"),
    el(
      "p",
      { class: "vz-lede" },
      `One human prompt, then Claude working straight through. These are main-thread turns — ` +
        `they run far longer than any single sub-agent, which top out near 25 minutes.`,
    ),
    missions,
    manHours,
  );
}

export async function renderDataViz(host: HTMLElement): Promise<void> {
  clear(host);
  host.append(
    el("a", { class: "back", href: "#/" }, "← All repos"),
    el("p", { class: "loading" }, "Crunching the whole transcript corpus… (first load reads every session)"),
  );

  let m: Metrics;
  try {
    m = await fetchMetrics(loadConfig());
  } catch (err) {
    clear(host);
    host.append(
      el("a", { class: "back", href: "#/" }, "← All repos"),
      el(
        "div",
        { class: "error" },
        el("strong", {}, "Could not compute metrics. "),
        err instanceof Error ? err.message : "Unknown error",
        el("p", { class: "hint" }, "Check the log path in Settings (⚙)."),
      ),
    );
    return;
  }

  clear(host);
  const t = m.totals;
  const cacheRatio = t.tokIn > 0 ? Math.round(t.tokCacheRead / t.tokIn) : 0;
  const perDay = m.span.activeDays > 0 ? t.cost / m.span.activeDays : 0;
  const workingHours = m.engagement.workingSeconds / 3600;

  host.append(
    el("a", { class: "back", href: "#/" }, "← All repos"),
    el(
      "div",
      { class: "page-head" },
      el("h1", {}, "By the Numbers"),
      el(
        "p",
        { class: "sub" },
        `Everything built in ~${m.span.days} days, read straight from ${compact(t.sessions)} ` +
          `session transcripts. Live scan; cost is estimated at public list prices, ` +
          `agent counts and durations are measured.`,
      ),
    ),
  );

  // ── Headline strip ───────────────────────────────────────────────
  host.append(
    statStrip([
      [`${m.span.activeDays}/${m.span.days}`, "active days"],
      [compact(t.sessions), "sessions"],
      [compact(t.userPrompts), "human prompts"],
      [compact(m.agents.total), "agents dispatched"],
      [`${Math.round(workingHours)} h`, "on the clock"],
      [compact(t.toolCalls), "tool calls"],
      [`≈ ${money(t.cost)}`, "est. spend"],
      [`${t.humanProjects}`, "real projects"],
    ]),
  );

  // ── The headline graphic: the agent fleet ────────────────────────
  host.append(agentSection(m.agents, workingHours, m.topMissions));

  // ── Pace ─────────────────────────────────────────────────────────
  const busiest = [...m.byDay].sort((a, b) => b.events - a.events)[0];
  host.append(
    section(
      "Pace",
      `Activity on ${m.span.activeDays} of ${m.span.days} calendar days. Biggest single day — ${
        busiest ? `${busiest.date}, ${compact(busiest.events)} transcript events` : "—"
      }.`,
      areaChart(
        m.byDay.map((d) => ({ date: d.date, value: d.events })),
        {
          height: 240,
          peaks: 3,
          first: m.span.first?.slice(0, 10),
          last: m.span.last?.slice(0, 10),
        },
      ),
    ),
  );

  // ── Spend over time ──────────────────────────────────────────────
  host.append(
    section(
      "Spend, by day",
      `≈ ${money(t.cost)} estimated total — about ${money(perDay)} per active day. ` +
        `Token usage from the transcripts priced at public list rates.`,
      areaChart(
        m.byDay.map((d) => ({ date: d.date, value: d.cost })),
        { height: 200, peaks: 3, fmt: money, first: m.span.first?.slice(0, 10), last: m.span.last?.slice(0, 10) },
      ),
    ),
  );

  // ── The cache iceberg ────────────────────────────────────────────
  host.append(
    section(
      "The prompt-cache iceberg",
      `The single most lopsided number in the corpus: ${compact(
        t.tokCacheRead,
      )} cache-read tokens against just ${compact(
        t.tokIn,
      )} of fresh input — a ${cacheRatio.toLocaleString("en-US")}× ratio. ` +
        `Almost nothing is paid for at the full input rate; prompt caching is doing the work. (Log scale.)`,
      logBars([
        {
          label: "Cache-read tokens",
          value: t.tokCacheRead,
          display: compact(t.tokCacheRead),
          note: "billed at the cached rate (~10× cheaper than input)",
          tone: "accent",
        },
        {
          label: "Cache-creation tokens",
          value: t.tokCacheWrite,
          display: compact(t.tokCacheWrite),
          tone: "tool",
        },
        { label: "Output tokens", value: t.tokOut, display: compact(t.tokOut), tone: "user" },
        {
          label: "Fresh input tokens",
          value: t.tokIn,
          display: compact(t.tokIn),
          note: "the only part priced at full input rate",
          tone: "muted",
        },
      ]),
    ),
  );

  // ── Where the money went ─────────────────────────────────────────
  const top = m.topByCost.slice(0, 10);
  const topShare = top.slice(0, 5).reduce((s, p) => s + p.cost, 0);
  host.append(
    section(
      "Where the spend went",
      `Heavily concentrated: the top 5 projects are ${Math.round(
        (topShare / t.cost) * 100,
      )}% of all estimated spend. ` +
        `job-search-engine and job-search-engine are the same project under two directory spellings — ` +
        `the flagship investment, split in two by a typo.`,
      barList(
        top.map((p) => ({
          label: p.name,
          value: p.cost,
          display: money(p.cost),
          sub: `${p.sessions} sessions · ${p.userPrompts} prompts · ${compact(
            p.tokensTotal,
          )} tokens`,
          tone: p.name.startsWith("job-search-engine") ? "user" : "accent",
          grouped: p.name.startsWith("job-search-engine"),
        })),
      ),
    ),
  );

  // ── Tool fingerprint ─────────────────────────────────────────────
  host.append(
    section(
      "Tool fingerprint",
      `${compact(t.toolCalls)} tool calls. The shape of someone who lives at the ` +
        `command line and runs the model as an orchestrated system, not a chat box.`,
      barList(
        m.tools.map((tool, i) => ({
          label: tool.name,
          value: tool.count,
          display: tool.count.toLocaleString("en-US"),
          tone: i === 0 ? "accent" : "tool",
        })),
      ),
    ),
  );

  // ── Closer ───────────────────────────────────────────────────────
  const big = compact(t.maxPrompt);
  host.append(
    el(
      "div",
      { class: "vz-closer" },
      el("h2", {}, "Two more, for the road"),
      el(
        "p",
        {},
        `The largest single prompt in the corpus was `,
        el("strong", {}, `${t.maxPrompt.toLocaleString("en-US")} characters`),
        ` (~${big}) — an entire corpus pasted into one message. Across everything, ` +
          `roughly ${compact(t.promptChars)} characters were typed by hand.`,
      ),
      m.self
        ? el(
            "p",
            {},
            `And this dashboard, observing everything above, is itself only `,
            el(
              "strong",
              {},
              `${m.self.sessions} sessions and ≈ ${money(m.self.cost)} old`,
            ),
            ` — it is already a row in its own dataset.`,
          )
        : el("p", {}, "And this dashboard is now part of the corpus it measures."),
      el("p", { class: "vz-foot" }, `Snapshot is live; ${m.totals.scaffoldProjects} throwaway scaffold/temp dirs excluded, as on the Profile page.`),
    ),
  );

  window.scrollTo(0, 0);
}
