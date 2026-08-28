import { fetchMetrics } from "../api.ts";
import { loadConfig } from "../config.ts";
import { el, clear, renderMarkdown, errorBox, statStrip } from "../dom.ts";
import { compact, money } from "../charts.ts";
import type { Metrics } from "../types.ts";

/**
 * A written read of whoever's corpus this app is pointed at, computed live from
 * /api/metrics on every load. Nothing here is hardcoded: the stat strip, the
 * prose, and every figure inside it are derived from the transcripts under the
 * configured log dir.
 *
 * The rule this view is built to: state what the numbers say, and nothing more.
 * A corpus can support "Bash is 43% of your tool calls" — it cannot support a
 * verdict on the person who typed them. Sections drop out entirely when the
 * signal that would justify them is absent, so a thin corpus renders a short
 * honest page rather than a padded one. Cost is an estimate at list rates (see
 * the pricing note the narrative closes on); agent counts and durations are
 * measured.
 */

/** Long-form date from an ISO date or datetime, e.g. "June 28, 2026". */
function longDate(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function num(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** Seconds → "255 h" / "42 min", for on-the-clock figures. */
function hrs(sec: number): string {
  return sec >= 3600 ? `${num(sec / 3600)} h` : `${Math.round(sec / 60)} min`;
}

function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 100) : 0;
}

/** Multipliers read wrong when rounded to whole numbers: 1.5x must not print as "1x". */
function ratioStr(r: number): string {
  return r >= 10 ? num(r) : r.toFixed(1).replace(/\.0$/, "");
}

/** Count for a tool by exact name, 0 if it never appears. */
function toolCount(m: Metrics, name: string): number {
  return m.tools.find((x) => x.name === name)?.count ?? 0;
}

function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * The live stat strip. Mirrors the figures the narrative leans on hardest, so
 * the two can never disagree — both read the same Metrics object.
 */
function strip(m: Metrics): HTMLElement {
  const t = m.totals;
  const items: [string, string][] = [
    [`${num(m.span.days)} days`, "day 1 → now"],
    [num(t.sessions), t.sessions === 1 ? "session" : "sessions"],
    [num(t.userPrompts), "human prompts"],
  ];
  if (m.agents.total > 0) items.push([num(m.agents.total), "agents dispatched"]);
  if (m.engagement.workingSeconds > 0) {
    items.push([`~${hrs(m.engagement.workingSeconds)}`, "on the clock"]);
  }
  items.push([`≈ ${money(t.cost)}`, "est. spend"]);

  const row = statStrip(items);
  if (m.span.last) {
    row.append(el("div", { class: "stat-asof" }, `through ${longDate(m.span.last)}`));
  }
  return row;
}

/** The corpus, stated plainly. Always present — it is the one section that needs no threshold. */
function sectionCorpus(m: Metrics): string {
  const t = m.totals;
  const span =
    m.span.first && m.span.last
      ? `from **${longDate(m.span.first)}** to **${longDate(m.span.last)}**`
      : "across the configured log directory";
  const active =
    m.span.days > 0 && m.span.activeDays > 0
      ? ` — the prompt active on **${num(m.span.activeDays)} of ${num(m.span.days)} days**`
      : "";
  const projects =
    t.humanProjects > 0
      ? ` The work is spread across **${num(t.humanProjects)} projects**` +
        (t.scaffoldProjects > 0 ? `, plus ${num(t.scaffoldProjects)} throwaway scaffold dirs held out of these figures.` : ".")
      : "";
  return `## The corpus

This is read from the logs, not written about you. Your Claude Code history runs
${span}${active}. It holds **${num(t.sessions)} sessions**, **${num(t.userPrompts)} typed prompts**,
**${num(t.assistant)} model turns**, and **${num(t.toolCalls)} tool calls**. About
**${compact(t.tokOut)} tokens of output** rode on **${compact(t.tokCacheRead)}** cache-read tokens, an
estimated **${money(t.cost)}** of model time at public list rates.${projects}`;
}

/** Where the money concentrated. Needs at least two projects to say anything worth reading. */
function sectionConcentration(m: Metrics): string {
  const top = m.topByCost.filter((p) => p.cost > 0);
  if (top.length < 2) return "";
  const t = m.totals;
  const lead = top[0];
  const topFive = top.slice(0, 5).reduce((s, p) => s + p.cost, 0);
  const share = pct(topFive, t.cost);
  const leadShare = pct(lead.cost, t.cost);
  const named = top.slice(0, 3).map((p) => `\`${p.name}\` (${money(p.cost)})`);
  const verdict =
    share >= 70
      ? "That is a corpus with a centre of gravity, not an even spread"
      : share >= 40
        ? "Concentrated, but with real work happening outside the top of the list"
        : "Unusually flat — effort is spread wide rather than pooled in a few projects";
  return `### Where the effort concentrated

The top ${Math.min(5, top.length)} projects account for **${share}%** of estimated spend, with
${list(named)} at the head. The single largest, \`${lead.name}\`, is **${leadShare}%** of the total on its
own across ${num(lead.sessions)} session${lead.sessions === 1 ? "" : "s"}. ${verdict}.`;
}

/** The tool histogram, and whether it looks orchestrated or hands-on. */
function sectionHow(m: Metrics): string {
  if (m.tools.length === 0 || m.totals.toolCalls === 0) return "";
  const t = m.totals;
  const top = m.tools.slice(0, 4).map((x) => `**${x.name}** (${num(x.count)})`);
  const leadShare = pct(m.tools[0].count, t.toolCalls);

  const orchestration = ["Agent", "Task", "TaskCreate", "TaskUpdate", "Skill", "ToolSearch", "AskUserQuestion"]
    .map((n) => ({ n, c: toolCount(m, n) }))
    .filter((x) => x.c > 0);
  const orchTotal = orchestration.reduce((s, x) => s + x.c, 0);
  const orchShare = pct(orchTotal, t.toolCalls);

  const orchLine = orchTotal
    ? ` Below the top of the list sit ${list(orchestration.map((x) => `${num(x.c)} ${x.n}`))} calls — ` +
      `**${orchShare}%** of all tool use is orchestration rather than direct edits, which is the ` +
      `difference between running the model as a system and chatting at it.`
    : "";

  return `### How the work gets done

The tool histogram leads with ${list(top)}. \`${m.tools[0].name}\` alone is **${leadShare}%** of every
tool call in the corpus.${orchLine}`;
}

/** Delegation. Only rendered when subagents were actually dispatched. */
function sectionFleet(m: Metrics): string {
  const a = m.agents;
  if (a.total === 0) return "";
  const byType = a.byType.slice(0, 4).map((x) => `**${x.type}** (${num(x.count)})`);
  const measured =
    a.withDuration > 0 && a.totalSeconds > 0
      ? ` Of those, ${num(a.withDuration)} ran to a paired result, accounting for a measured ` +
        `**${hrs(a.totalSeconds)}**` +
        (m.engagement.workingSeconds > 0
          ? ` — **${pct(a.totalSeconds, m.engagement.workingSeconds)}%** of total time on the clock, ` +
            `run in parallel rather than in line.`
          : ".")
      : "";
  const longest =
    a.longest.length > 0 && a.longest[0].seconds > 0
      ? ` The longest single dispatch ran ${hrs(a.longest[0].seconds)}.`
      : "";
  return `### The fleet

**${num(a.total)} subagents** were dispatched across the corpus${
    byType.length ? `, most often ${list(byType)}` : ""
  }.${measured}${longest}`;
}

/** Prompt length distribution — only interesting when the spread is genuinely wide. */
function sectionPrompts(m: Metrics): string {
  const t = m.totals;
  if (t.userPrompts === 0 || t.promptChars === 0) return "";
  const mean = t.promptChars / t.userPrompts;
  const ratio = mean > 0 ? t.maxPrompt / mean : 0;
  if (t.maxPrompt === 0) return "";
  const verdict =
    ratio >= 100
      ? `That is a **bimodal** style: most prompts are a sentence, and then without transition ` +
        `an enormous spec. Little in between.`
      : ratio >= 20
        ? `A wide spread — short by default, with occasional long-form specs.`
        : `A fairly even spread; prompts cluster near the average rather than swinging between extremes.`;
  return `### Prompt style

The average typed prompt is **${num(mean)} characters**. The largest single prompt in the corpus is
**${num(t.maxPrompt)}** — ${ratioStr(ratio)}× the mean. ${verdict}`;
}

/** Model routing and cache leverage. */
function sectionModels(m: Metrics): string {
  const t = m.totals;
  if (m.models.length === 0) return "";
  const total = m.models.reduce((s, x) => s + x.tokens, 0);
  const named = m.models
    .slice(0, 3)
    .map((x) => `\`${x.model}\` (${compact(x.tokens)}, ${pct(x.tokens, total)}%)`);
  // Only worth a sentence when the cache actually dominates. At parity the claim
  // would contradict its own figure, which is how the first draft of this read.
  const cacheRatio = t.tokIn > 0 ? t.tokCacheRead / t.tokIn : 0;
  const leverage =
    cacheRatio >= 2
      ? ` Cache-read tokens outnumber fresh input **${ratioStr(cacheRatio)}:1** — most context is ` +
        `re-read from cache rather than paid for at full input rate, which is a large part of why the ` +
        `cost figure sits where it does relative to the token count.`
      : cacheRatio > 0
        ? ` Cache-read and fresh input tokens are close to parity (**${ratioStr(cacheRatio)}:1**), so ` +
          `little of the cost here is being absorbed by the prompt cache.`
        : "";
  const spread =
    m.models.length > 1
      ? `Work is spread across **${m.models.length} models**: ${list(named)}.`
      : `All measured tokens ran on ${named[0]}.`;
  return `### Model mix

${spread}${leverage}`;
}

/** Cadence — how the work is distributed over time. */
function sectionCadence(m: Metrics): string {
  if (m.span.activeDays === 0 || m.engagement.workingSeconds === 0) return "";
  const perDay = m.engagement.workingSeconds / m.span.activeDays;
  const sessionsPerDay = m.totals.sessions / m.span.activeDays;
  const coverage = pct(m.span.activeDays, m.span.days);
  return `### Cadence

Across **${num(m.span.activeDays)} active days** (${coverage}% of the elapsed span) that works out to
about **${hrs(perDay)}** of measured machine time and **${sessionsPerDay.toFixed(1)} sessions** per
active day — model generating plus tools and subagents executing, with human think-time stripped out.`;
}

function buildNarrative(m: Metrics): string {
  const sections = [
    sectionCorpus(m),
    sectionConcentration(m),
    sectionHow(m),
    sectionFleet(m),
    sectionPrompts(m),
    sectionModels(m),
    sectionCadence(m),
  ].filter(Boolean);

  const caveat = `---

Cost is an **estimate**, not an invoice: every figure above is priced per token against the
${m.pricing.source} rate table effective **${longDate(m.pricing.effective)}**. Token counts, tool
calls, sessions and agent durations are measured directly from the transcripts. Everything on this
page is computed from the corpus at the log path in Settings (⚙) — point it somewhere else and this
page describes that corpus instead.`;

  return `${sections.join("\n\n")}\n\n${caveat}\n`;
}

export async function renderProfile(host: HTMLElement): Promise<void> {
  clear(host);

  host.append(
    el("a", { class: "back", href: "#/" }, "← All repos"),
    el(
      "div",
      { class: "page-head" },
      el("h1", {}, "You, Observed"),
      el(
        "p",
        { class: "sub" },
        "A read of your own Claude Code corpus — what you built, how you worked it, and what the numbers actually support.",
      ),
    ),
  );

  const status = el("p", { class: "loading" }, "Reading the corpus…");
  host.append(status);

  let m: Metrics;
  try {
    m = await fetchMetrics(loadConfig());
  } catch (err) {
    status.remove();
    host.append(errorBox("Could not read the corpus. ", err, "Check the log path in Settings (⚙)."));
    return;
  }
  status.remove();

  // A corpus with no sessions is not an error — it is an empty log dir. Render
  // that honestly rather than a profile built on a page of zeros.
  if (m.totals.sessions === 0) {
    host.append(
      el(
        "div",
        { class: "empty" },
        el("p", {}, "No sessions found, so there is nothing to profile yet."),
        el(
          "p",
          {},
          "Point the log path at a directory with Claude Code transcripts in Settings (⚙), or run ",
          el("code", {}, "npm run demo"),
          " to explore against the sample corpus.",
        ),
      ),
    );
    return;
  }

  host.append(strip(m));

  const narrative = renderMarkdown(buildNarrative(m));
  narrative.classList.add("narrative");
  host.append(narrative);
}
