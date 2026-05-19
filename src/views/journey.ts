import { fetchJourney } from "../api.ts";
import { loadConfig } from "../config.ts";
import { el, clear, relativeTime } from "../dom.ts";
import { forceGraph, sloppyTimeline, compact, type GraphPick } from "../charts.ts";
import type { Journey, JourneyEdge, JourneyNode, JourneyVisit } from "../types.ts";

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

function shortDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** The shared inspector. Starts as a legend; fills in on any pick. */
function legend(): HTMLElement {
  return el(
    "div",
    { class: "jn-legend" },
    el("span", {}, el("i", { class: "jn-key explicit" }), "solid = explicit (a line named the other project)"),
    el("span", {}, el("i", { class: "jn-key inferred" }), "faint dashed = inferred — a leap of faith"),
    el("span", { class: "jn-hint" }, "Click any node, edge, or timeline dot to inspect it."),
  );
}

function renderEdge(panel: HTMLElement, e: JourneyEdge, from?: JourneyNode, to?: JourneyNode): void {
  clear(panel);
  panel.append(
    el(
      "div",
      { class: "jn-d-head" },
      el("span", { class: "jn-d-route" }, `${from?.name ?? "?"} → ${to?.name ?? "?"}`),
      el(
        "span",
        { class: `jn-badge ${e.confidence}` },
        e.confidence === "explicit" ? "explicit" : "inferred · leap of faith",
      ),
    ),
    el(
      "p",
      { class: "jn-d-meta" },
      `${e.count} hop${e.count === 1 ? "" : "s"} · last ${shortDay(e.at)} (${relativeTime(e.at)})`,
    ),
    el("p", { class: "jn-d-label" }, "The line that plausibly led you across:"),
    el("blockquote", { class: "jn-quote" }, e.bridge || "—"),
    e.confidence === "inferred"
      ? el(
          "p",
          { class: "jn-d-foot" },
          "Reconstructed: nothing typed near the switch named the other project, so this is the best-guess bridge — the first real thing you said on arrival.",
        )
      : el("p", { class: "jn-d-foot" }, "High confidence: a line around the switch named the destination."),
  );
}

function renderNode(panel: HTMLElement, n: JourneyNode, j: Journey): void {
  clear(panel);
  const nameOf = (id: string) => j.nodes.find((x) => x.id === id)?.name ?? id;
  const out = j.edges.filter((e) => e.from === n.id).sort((a, b) => b.count - a.count);
  const inc = j.edges.filter((e) => e.to === n.id).sort((a, b) => b.count - a.count);
  const visits = j.visits.filter((v) => v.project === n.id).length;
  const spanDays = Math.max(
    1,
    Math.round((Date.parse(n.last) - Date.parse(n.first)) / 86_400_000) + 1,
  );
  const share = j.totalCommands > 0 ? (n.commands / j.totalCommands) * 100 : 0;
  const shareStr = share >= 1 ? `${Math.round(share)}%` : "<1%";
  const outHops = out.reduce((s, e) => s + e.count, 0);
  const inHops = inc.reduce((s, e) => s + e.count, 0);

  panel.append(
    el("div", { class: "jn-d-head" }, el("span", { class: "jn-d-route" }, n.name)),
    el(
      "p",
      { class: "jn-d-meta" },
      `${compact(n.commands)} lines · ${n.sessions} session${n.sessions === 1 ? "" : "s"} · ` +
        `${visits} visit${visits === 1 ? "" : "s"} · ${shareStr} of all typing`,
    ),
    el(
      "p",
      { class: "jn-d-meta" },
      `${shortDay(n.first)} → ${shortDay(n.last)} · ${spanDays}d span · ` +
        `last active ${relativeTime(n.last)}`,
    ),
    el(
      "p",
      { class: "jn-d-meta" },
      `${out.length} project${out.length === 1 ? "" : "s"} jumped to (${outHops} hop` +
        `${outHops === 1 ? "" : "s"}) · ${inc.length} arrived from (${inHops})`,
    ),
  );

  if (out[0] || inc[0]) {
    panel.append(el("p", { class: "jn-d-label" }, "Strongest connections"));
    if (out[0]) {
      panel.append(
        el("p", { class: "jn-d-meta" }, `→ most often to ${nameOf(out[0].to)} (×${out[0].count})`),
      );
    }
    if (inc[0]) {
      panel.append(
        el(
          "p",
          { class: "jn-d-meta" },
          `← most often from ${nameOf(inc[0].from)} (×${inc[0].count})`,
        ),
      );
    }
  }
}

function renderVisit(panel: HTMLElement, v: JourneyVisit): void {
  clear(panel);
  panel.append(
    el("div", { class: "jn-d-head" }, el("span", { class: "jn-d-route" }, v.name)),
    el(
      "p",
      { class: "jn-d-meta" },
      `${shortDay(v.ts)} (${relativeTime(v.ts)}) · ${v.commands} line${v.commands === 1 ? "" : "s"} this visit`,
    ),
    el("p", { class: "jn-d-label" }, "Opened with:"),
    el("blockquote", { class: "jn-quote" }, v.opening || "—"),
  );
}

export async function renderJourney(host: HTMLElement): Promise<void> {
  clear(host);
  host.append(
    el("a", { class: "back", href: "#/" }, "← All repos"),
    el("p", { class: "loading" }, "Tracing the path from project to project across the command history…"),
  );

  let j: Journey;
  try {
    j = await fetchJourney(loadConfig(), 50);
  } catch (err) {
    clear(host);
    host.append(
      el("a", { class: "back", href: "#/" }, "← All repos"),
      el(
        "div",
        { class: "error" },
        el("strong", {}, "Could not reconstruct the journey. "),
        err instanceof Error ? err.message : "Unknown error",
        el("p", { class: "hint" }, "Needs ~/.claude/history.jsonl next to the log dir. Check Settings (⚙)."),
      ),
    );
    return;
  }

  clear(host);

  const spanDays =
    j.first && j.last
      ? Math.max(1, Math.round((Date.parse(j.last) - Date.parse(j.first)) / 86_400_000) + 1)
      : 0;
  const busiest = j.nodes[0];
  const inferredPct =
    j.edges.length > 0
      ? Math.round((j.edges.filter((e) => e.confidence === "inferred").length / j.edges.length) * 100)
      : 0;

  host.append(
    el("a", { class: "back", href: "#/" }, "← All repos"),
    el(
      "div",
      { class: "page-head" },
      el("h1", {}, "The Journey"),
      el(
        "p",
        { class: "sub" },
        `How the work actually moved, project to project, over ${spanDays} days — ` +
          `rebuilt from every line you typed at the prompt. The connective threads are ` +
          `recovered where you said them and inferred where you didn't.`,
      ),
    ),
  );

  host.append(
    statStrip([
      [`${j.windowDays}`, "day window"],
      [`${j.nodes.length}`, "projects touched"],
      [compact(j.totalSwitches), "project switches"],
      [compact(j.totalCommands), "lines typed"],
      [busiest ? busiest.name : "—", "most-worked"],
      [`${inferredPct}%`, "edges inferred"],
    ]),
  );

  // Shared inspector panel, reused by the graph and the timeline.
  const panel = el("div", { class: "jn-detail" });
  panel.append(legend());
  const resetPanel = () => {
    clear(panel);
    panel.append(legend());
  };

  const onGraphPick = (p: GraphPick) => {
    if (p.type === "node") renderNode(panel, p.node, j);
    else renderEdge(panel, p.edge, p.from, p.to);
  };

  const graphWrap = el(
    "div",
    { class: "jn-graph-wrap" },
    forceGraph(j.nodes, j.edges, { onPick: onGraphPick }),
    panel,
  );

  host.append(
    section(
      "The mental graph",
      `${j.nodes.length} projects, ${j.edges.length} distinct hops between them. Bigger node = ` +
        `more lines typed there; warmer = more recently touched; thicker edge = a path you ` +
        `walked more often.`,
      graphWrap,
    ),
  );

  host.append(
    section(
      "Fifty-ish sloppy days",
      `Every project visit, in order, threaded chronologically. The crossing lines are the ` +
        `point — the jumping around is the shape of the work, not noise to flatten out.`,
      sloppyTimeline(j.visits, {
        first: j.first,
        last: j.last,
        onPick: (v) => renderVisit(panel, v),
      }),
    ),
  );

  host.append(
    el(
      "div",
      { class: "vz-closer" },
      el("h2", {}, "On the leaps of faith"),
      el(
        "p",
        {},
        `Roughly `,
        el("strong", {}, `${inferredPct}% of the edges are inferred`),
        `. Claude Code logs every typed line with its project and time, so the *path* is ` +
          `near-exact — but you rarely announced “now I’ll go do X”. When the switch was ` +
          `silent, the bridge shown is the first real thing you typed on arrival: the best ` +
          `guess at what was on your mind, flagged as a guess rather than hidden.`,
      ),
      el(
        "p",
        { class: "vz-foot" },
        `Window fixed at ${j.windowDays} days; worktrees collapsed onto their parent project. ` +
          `Click around — nothing here is destructive.`,
      ),
      el("button", { class: "btn ghost", onclick: resetPanel }, "Reset inspector"),
    ),
  );

  window.scrollTo(0, 0);
}
