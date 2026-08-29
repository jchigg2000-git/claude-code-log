import { fetchMetrics } from "../api.ts";
import { loadConfig } from "../config.ts";
import { el, clear, errorBox, statStrip } from "../dom.ts";
import { areaChart, barList, logBars, compact, money } from "../charts.ts";
import { fitChart } from "../fitChart.ts";
import { repoHash, sessionHash } from "../routes.ts";
import type { Metrics, AgentSummary, MissionStat } from "../types.ts";

/**
 * Fold rows that are the same project under more than one directory spelling.
 * A project that has genuinely lived at both `foo.io` and `foo-io` is two real
 * directories, so it arrives as two rows whose cost is really one investment.
 * Key on the name with punctuation removed, and keep siblings adjacent — the
 * grouped styling only ties *neighbouring* rows.
 *
 * Names now arrive resolved against the real repo paths (server/projectNames.ts),
 * so this only ever folds genuine duplicates. It used to also absorb names the
 * server had truncated — two unrelated repos could both arrive as `demo` and be
 * folded into one row — which was papering over that bug rather than this case.
 * `/` is deliberately NOT stripped, so a repo (`acme/web-app`) never folds into
 * a subdirectory row (`acme/web-app` under some other repo).
 */
function groupNearDuplicates<T extends { name: string }>(
  rows: T[],
): { row: T; grouped: boolean }[] {
  const key = (n: string) => n.toLowerCase().replace(/[.\-_\s]/g, "");
  const byKey = new Map<string, T[]>();
  for (const r of rows) {
    const bucket = byKey.get(key(r.name));
    if (bucket) bucket.push(r);
    else byKey.set(key(r.name), [r]);
  }
  const out: { row: T; grouped: boolean }[] = [];
  const emitted = new Set<string>();
  for (const r of rows) {
    const k = key(r.name);
    if (emitted.has(k)) continue;
    emitted.add(k);
    const bucket = byKey.get(k)!;
    for (const member of bucket) out.push({ row: member, grouped: bucket.length > 1 });
  }
  return out;
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

  // A corpus can be entirely main-thread. Everything below that describes a
  // FLEET drops out in that case; the main-thread material (longest missions,
  // what the hours amount to) is still true and still renders.
  const hasFleet = a.total > 0;

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
    ...(hasFleet
      ? [
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
        ]
      : []),
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
  // Claude running for a stretch). Each card links into its transcript; `back=viz` routes
  // the session view's back link here (sessionBackLink). Same never-a-dead-link
  // rule as barList: no file, no anchor — the card just stays inert.
  // Compare against the real longest dispatch rather than asserting a ceiling.
  // Only claim main-thread turns run longer when this corpus actually shows
  // that; on one where a parallel dispatch outlasts them, the clause drops out
  // instead of printing a second unsupported number.
  const longestAgent = a.longest[0]?.seconds ?? 0;
  const topMission = topMissions[0]?.seconds ?? 0;
  const vsAgents =
    longestAgent > 0 && topMission > longestAgent
      ? ` They run longer than any single sub-agent — the longest of those ran ${dur(longestAgent)}.`
      : "";

  const missions = el("div", { class: "vz-missions" });
  topMissions.forEach((m, i) => {
    missions.append(
      el(
        m.file ? "a" : "div",
        m.file
          ? { class: "vz-mission", href: sessionHash(m.file, { label: m.project, back: "viz" }) }
          : { class: "vz-mission" },
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
  const cadence = fitChart(el("div"), (w) =>
    areaChart(
      a.byDay.map((d) => ({ date: d.date, value: d.count })),
      { height: 180, peaks: 3, first: a.byDay[0]?.date, last: a.byDay.at(-1)?.date, width: w },
    ),
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
    el("h2", {}, hasFleet ? "The agent fleet" : "Time on the clock"),
    el(
      "p",
      { class: "vz-lede" },
      hasFleet
        ? `Most of this wasn't typed by one model in a chat box — it ran across the main thread and ` +
          `a fleet of subagents working in parallel. Every number is read straight from the ` +
          `transcripts: time on the clock from message gaps (human idle excluded), a dispatch from ` +
          `each Agent/Task call, a duration from the gap to its result.`
        : `This corpus ran entirely on the main thread — no subagents were dispatched. Time on the ` +
          `clock is read straight from the transcripts: message gaps, with human idle excluded.`,
    ),
    hero,
    ...(hasFleet
      ? [
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
        ]
      : []),
    el("h3", { class: "vz-sub-h" }, "Longest missions — single turns of work"),
    el(
      "p",
      { class: "vz-lede" },
      `One human prompt, then Claude working straight through. These are main-thread turns.${vsAgents}`,
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
      errorBox("Could not compute metrics. ", err, "Check the log path in Settings (⚙)."),
    );
    return;
  }

  clear(host);
  const t = m.totals;
  // Round for DISPLAY only. Deciding on the rounded value made this page and
  // Profile disagree about the same corpus: a true 1.6 rounds to 2 here and
  // printed "caching is doing the work" while Profile, using the unrounded
  // value, printed "close to parity".
  const cacheRatioExact = t.tokIn > 0 ? t.tokCacheRead / t.tokIn : 0;
  const cacheRatio = Math.round(cacheRatioExact);
  const perDay = m.span.activeDays > 0 ? t.cost / m.span.activeDays : 0;
  const workingHours = m.engagement.workingSeconds / 3600;
  // Names which pricing table produced the cost figures below, so a stale
  // built-in table (or a stale pricing.json) is visible rather than silently
  // decaying the spend estimate. See server/pricing.ts.
  const pricingLabel =
    m.pricing.source === "pricing.json"
      ? "pricing.json"
      : m.pricing.source === "env"
        ? "env override"
        : "built-in";

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
          `session transcripts. Live scan; cost is estimated at list prices effective ` +
          `${m.pricing.effective} (${pricingLabel}), agent counts and durations are measured.`,
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
  // agentSection drops its own fleet-specific parts when nothing was dispatched
  // and keeps the main-thread material, which is true either way.
  host.append(agentSection(m.agents, workingHours, m.topMissions));

  // ── Pace ─────────────────────────────────────────────────────────
  const busiest = [...m.byDay].sort((a, b) => b.events - a.events)[0];
  host.append(
    section(
      "Pace",
      `Activity on ${m.span.activeDays} of ${m.span.days} calendar days. Biggest single day — ${
        busiest ? `${busiest.date}, ${compact(busiest.events)} transcript events` : "—"
      }.`,
      fitChart(el("div"), (w) =>
        areaChart(
          m.byDay.map((d) => ({ date: d.date, value: d.events })),
          {
            height: 240,
            peaks: 3,
            first: m.span.first?.slice(0, 10),
            last: m.span.last?.slice(0, 10),
            width: w,
          },
        ),
      ),
    ),
  );

  // ── Spend over time ──────────────────────────────────────────────
  host.append(
    section(
      "Spend, by day",
      `≈ ${money(t.cost)} estimated total — about ${money(perDay)} per active day. ` +
        `Token usage from the transcripts priced at public list rates.`,
      fitChart(el("div"), (w) =>
        areaChart(
          m.byDay.map((d) => ({ date: d.date, value: d.cost })),
          { height: 200, peaks: 3, fmt: money, first: m.span.first?.slice(0, 10), last: m.span.last?.slice(0, 10), width: w },
        ),
      ),
    ),
  );

  // ── The cache iceberg ────────────────────────────────────────────
  host.append(
    section(
      "The prompt-cache iceberg",
      `${compact(t.tokCacheRead)} cache-read tokens against ${compact(t.tokIn)} of fresh input — ` +
        `a ${cacheRatio.toLocaleString("en-US")}× ratio. ` +
        (cacheRatioExact >= 2
          ? `Almost nothing is paid for at the full input rate; prompt caching is doing the work.`
          : `Cache reads and fresh input are close to parity here, so little of the input cost is absorbed by the cache.`) +
        ` (Log scale.)`,
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
  const sharePct = t.cost > 0 ? Math.round((topShare / t.cost) * 100) : 0;
  const ranked = groupNearDuplicates(top);
  const foldedRows = ranked.filter((r) => r.grouped).length;
  host.append(
    section(
      "Where the spend went",
      `${sharePct >= 60 ? "Heavily concentrated: the" : "The"} top 5 projects are ` +
        `${sharePct}% of all estimated spend.` +
        (foldedRows > 0
          ? ` ${foldedRows} of the rows below are the same project under more than one ` +
            `directory spelling, tied together here — the encoded directory name differs, ` +
            `the work doesn't.`
          : ""),
      barList(
        ranked.map(({ row: p, grouped }) => ({
          label: p.name,
          value: p.cost,
          display: money(p.cost),
          sub: `${p.sessions} sessions · ${p.userPrompts} prompts · ${compact(
            p.tokensTotal,
          )} tokens`,
          tone: grouped ? "user" : "accent",
          grouped,
          // The headline figure as an entry point: each row opens its repo's
          // session list. Orphan logs (repoPath null) have no repo page, so
          // they stay plain rows rather than dead links.
          href: p.repoPath ? repoHash(p.repoPath, p.name) : undefined,
        })),
      ),
    ),
  );

  // ── Tool fingerprint ─────────────────────────────────────────────
  host.append(
    section(
      "Tool fingerprint",
      `${compact(t.toolCalls)} tool calls` +
        (m.tools.length
          ? `, led by ${m.tools[0].name} at ${m.tools[0].count.toLocaleString("en-US")}.`
          : ".") +
        ` The mix is the clearest signal of how the model is actually being used — ` +
        `read-and-edit, shell-driven, or search-heavy.`,
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
        ` (~${big}). Across everything, ` +
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
}
