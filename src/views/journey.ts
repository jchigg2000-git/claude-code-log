import { fetchJourney, fetchMetrics } from "../api.ts";
import { loadConfig } from "../config.ts";
import { el, clear, relativeTime, errorBox } from "../dom.ts";
import { forceGraph, sloppyTimeline, compact, money, type GraphPick } from "../charts.ts";
import { fitChart } from "../fitChart.ts";
import { createJourneyField, type FleetBucket, type SceneId, type VisitSeed } from "./journey-canvas.ts";
import type { Journey, JourneyEdge, JourneyNode, JourneyVisit, Metrics } from "../types.ts";

const WINDOW_DAYS = 100; // wide enough to cover day one → now

function shortDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function fullDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

// ── The interactive inspector (preserved from the original Journey) ──────────
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
  const spanDays = Math.max(1, Math.round((Date.parse(n.last) - Date.parse(n.first)) / 86_400_000) + 1);
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
      `${shortDay(n.first)} → ${shortDay(n.last)} · ${spanDays}d span · last active ${relativeTime(n.last)}`,
    ),
    el(
      "p",
      { class: "jn-d-meta" },
      `${out.length} project${out.length === 1 ? "" : "s"} jumped to (${outHops} hop${outHops === 1 ? "" : "s"}) · ` +
        `${inc.length} arrived from (${inHops})`,
    ),
  );
  if (out[0] || inc[0]) {
    panel.append(el("p", { class: "jn-d-label" }, "Strongest connections"));
    if (out[0]) panel.append(el("p", { class: "jn-d-meta" }, `→ most often to ${nameOf(out[0].to)} (×${out[0].count})`));
    if (inc[0]) panel.append(el("p", { class: "jn-d-meta" }, `← most often from ${nameOf(inc[0].from)} (×${inc[0].count})`));
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

// ── Scrolly-telling primitives ───────────────────────────────────────────────
interface CountSpec {
  span: HTMLElement;
  to: number;
  fmt: (n: number) => string;
}

const intFmt = (n: number) => Math.round(n).toLocaleString("en-US");
const oneDp = (n: number) => n.toFixed(1);

/** A row of big animated figures. Returns the node and the count specs to run
 *  when its scene becomes active. */
function figures(items: { to: number; fmt: (n: number) => string; label: string; accent?: boolean }[]): {
  node: HTMLElement;
  counts: CountSpec[];
} {
  const node = el("div", { class: "jny-figs" });
  const counts: CountSpec[] = [];
  for (const it of items) {
    const span = el("span", { class: `jny-fig-v${it.accent ? " accent" : ""}` }, it.fmt(0));
    counts.push({ span, to: it.to, fmt: it.fmt });
    node.append(el("div", { class: "jny-fig" }, span, el("span", { class: "jny-fig-l" }, it.label)));
  }
  return { node, counts };
}

function runCounts(counts: CountSpec[]): void {
  for (const c of counts) {
    const start = performance.now();
    const dur = 1100;
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      c.span.textContent = c.fmt(c.to * e);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

interface Scene {
  id: SceneId;
  anchor: string;
  chapter: string;
  el: HTMLElement;
  counts: CountSpec[];
}

function scene(
  id: SceneId,
  anchor: string,
  chapter: string,
  kicker: string,
  title: string,
  body: HTMLElement[],
): Scene {
  const counts: CountSpec[] = [];
  const panel = el(
    "div",
    { class: "jny-panel" },
    el("p", { class: "jny-kicker" }, kicker),
    el("h2", { class: "jny-title" }, title),
    ...body,
  );
  const sec = el("section", { class: "jny-scene", id: anchor }, panel);
  return { id, anchor, chapter, el: sec, counts };
}

// Distinct colors for the subagent fleet swarm centers.
const FLEET_HEX: [number, number, number][] = [
  [0xc9, 0x8a, 0x3c],
  [0x5a, 0xa9, 0xe6],
  [0xb0, 0x72, 0xd6],
  [0x4f, 0xc2, 0x4f],
  [0x22, 0xb5, 0xc4],
  [0xf2, 0xd0, 0x35],
  [0x5b, 0x64, 0x72],
];

let teardown: (() => void) | null = null;

export async function renderJourney(host: HTMLElement): Promise<void> {
  if (teardown) {
    teardown();
    teardown = null;
  }
  clear(host);
  host.append(el("p", { class: "loading" }, "Reconstructing the journey from day one…"));

  let j: Journey;
  let m: Metrics;
  try {
    const cfg = loadConfig();
    [j, m] = await Promise.all([fetchJourney(cfg, WINDOW_DAYS), fetchMetrics(cfg)]);
  } catch (err) {
    clear(host);
    host.append(
      el("a", { class: "back", href: "#/" }, "← All repos"),
      errorBox("Could not reconstruct the journey. ", err, "Needs ~/.claude/history.jsonl next to the log dir. Check Settings (⚙)."),
    );
    return;
  }

  // A missing/empty history file is NOT a fetch failure — the server reports it
  // as an empty journey — so it lands here, not in the catch above. Without this
  // the whole scrollytelling renders against zeros: a "day one" scene with no
  // date, empty counters, and a graph with no nodes.
  if (j.visits.length === 0 || j.nodes.length === 0) {
    clear(host);
    host.append(
      el("a", { class: "back", href: "#/" }, "← All repos"),
      el(
        "div",
        { class: "page-head" },
        el("h1", {}, "Journey"),
        el("p", { class: "sub" }, "Nothing to retell yet."),
      ),
      el(
        "div",
        { class: "empty" },
        el(
          "p",
          {},
          j.historyFound
            ? "Your command history was read, but it holds no project activity in the last " +
                `${j.windowDays} days.`
            : "This view is reconstructed from Claude Code's command history, and that file wasn't found.",
        ),
        el("code", { class: "path" }, j.historyPath),
        el(
          "p",
          { class: "hint" },
          j.historyFound
            ? "Use Claude Code for a bit and it will fill in — the other tabs read the session transcripts and work without this file."
            : "Claude Code writes history.jsonl next to its projects directory. If your log location is set to a copy or a sample corpus, that file won't be beside it — the other three tabs read the transcripts directly and work regardless.",
        ),
        el(
          "p",
          {},
          el("a", { class: "btn ghost", href: "#/viz" }, "Go to Data Viz"),
          " ",
          el("a", { class: "btn ghost", href: "#/" }, "Browse repos"),
        ),
      ),
    );
    return;
  }

  clear(host);

  // ── Build particle seeds from real visits ──────────────────────────────────
  const firstMs = j.first ? Date.parse(j.first) : Date.now();
  const lastMs = j.last ? Date.parse(j.last) : Date.now();
  const span = Math.max(1, lastMs - firstMs);
  const rankOf = new Map<string, number>();
  j.nodes.forEach((n, i) => rankOf.set(n.id, i));
  const maxCmd = Math.max(1, ...j.visits.map((v) => v.commands));
  const seeds: VisitSeed[] = j.visits.map((v) => ({
    t: Math.max(0, Math.min(1, (Date.parse(v.ts) - firstMs) / span)),
    projectRank: rankOf.get(v.project) ?? 99,
    weight: Math.min(1, Math.sqrt(v.commands) / Math.sqrt(maxCmd)),
  }));

  // ── Fleet buckets from measured agent types ────────────────────────────────
  const A = m.agents;
  const topTypes = A.byType.slice(0, 6);
  const otherCount = A.byType.slice(6).reduce((s, t) => s + t.count, 0);
  const fleetForCanvas: FleetBucket[] = [
    ...topTypes.map((t, i) => ({ color: FLEET_HEX[i] ?? FLEET_HEX[6], share: t.count / Math.max(1, A.total) })),
    ...(otherCount > 0 ? [{ color: FLEET_HEX[6], share: otherCount / Math.max(1, A.total) }] : []),
  ];

  // Derived narrative numbers.
  const days = m.span.days;
  const t = m.totals;
  const agentHours = A.totalSeconds / 3600;
  const workingHours = m.engagement.workingSeconds / 3600;
  const topProjects = j.nodes.slice(0, 4).map((n) => n.name);

  // ── Layout shell ───────────────────────────────────────────────────────────
  const canvas = el("canvas", { class: "jny-canvas" }) as HTMLCanvasElement;
  const railBar = el("div", { class: "jny-railbar-fill" });
  const dots = el("div", { class: "jny-dots" });
  const rail = el("div", { class: "jny-rail" }, el("div", { class: "jny-railbar" }, railBar), dots);

  const back = el("a", { class: "back jny-back", href: "#/" }, "← All repos");

  // ── Scenes ─────────────────────────────────────────────────────────────────
  const scenes: Scene[] = [];

  // S0 — Day one.
  {
    const s = scene(
      "seed",
      "jny-s0",
      "Day one",
      j.first ? fullDay(j.first) : "The beginning",
      "One prompt into the dark.",
      [
        el(
          "p",
          { class: "jny-lede" },
          `It starts with a single session and a command that doesn't exist yet — `,
          el("code", {}, j.visits[0]?.opening || "/example-command"),
          `. No skills, no pipelines, no fleet. Just one person, a blank prompt, and ${days} days ahead.`,
        ),
        el("p", { class: "jny-scroll-hint" }, "scroll ↓"),
      ],
    );
    scenes.push(s);
  }

  // S1 — Accumulation over time.
  {
    const f = figures([
      { to: days, fmt: intFmt, label: "days" },
      { to: t.sessions, fmt: intFmt, label: "sessions", accent: true },
      { to: j.visits.length, fmt: intFmt, label: "project visits" },
      { to: m.span.activeDays, fmt: intFmt, label: "active days" },
    ]);
    const s = scene("accumulate", "jny-s1", "The build-up", "Day 1 → today", "Then it didn't stop.", [
      el(
        "p",
        { class: "jny-lede" },
        `Every dot is one real visit to a project, dropped onto the timeline at the moment it happened. ` +
          `Watch ${days} days fill in — near-daily, rarely quiet.`,
      ),
      f.node,
    ]);
    s.counts.push(...f.counts);
    scenes.push(s);
  }

  // S2 — The scale.
  {
    const f = figures([
      { to: t.userPrompts, fmt: intFmt, label: "prompts typed" },
      { to: t.assistant, fmt: intFmt, label: "assistant turns", accent: true },
      { to: t.tokOut, fmt: compact, label: "output tokens" },
      { to: t.tokCacheRead, fmt: compact, label: "cache reads" },
    ]);
    const s = scene("cloud", "jny-s2", "The scale", "What that adds up to", "A staggering amount of thinking.", [
      el(
        "p",
        { class: "jny-lede" },
        `${intFmt(t.userPrompts)} prompts pulled ${intFmt(t.assistant)} model turns out of the dark — ` +
          `${compact(t.tokOut)} tokens of output, riding ${compact(t.tokCacheRead)} cache-read tokens. ` +
          `An estimated ${money(t.cost)} of model time at list rates.`,
      ),
      f.node,
    ]);
    s.counts.push(...f.counts);
    scenes.push(s);
  }

  // S3 — Across the work.
  {
    const f = figures([
      { to: t.humanProjects, fmt: intFmt, label: "real projects" },
      { to: t.toolCalls, fmt: intFmt, label: "tool calls", accent: true },
      { to: j.totalSwitches, fmt: intFmt, label: "project switches" },
    ]);
    const s = scene(
      "constellation",
      "jny-s3",
      "The spread",
      "Not one project — dozens",
      "Work pulled into constellations.",
      [
        el(
          "p",
          { class: "jny-lede" },
          `${t.humanProjects} real projects, and the dots gather into the heaviest of them — ` +
            `${topProjects.join(", ")}. The work jumps between them ${intFmt(j.totalSwitches)} times; ` +
            `that restlessness is the shape of it.`,
        ),
        f.node,
      ],
    );
    s.counts.push(...f.counts);
    scenes.push(s);
  }

  // S4 — The fleet (climax).
  {
    const f = figures([
      { to: workingHours, fmt: (n) => Math.round(n).toLocaleString("en-US"), label: "hrs on the clock", accent: true },
      { to: A.total, fmt: intFmt, label: "agents dispatched" },
      { to: agentHours, fmt: oneDp, label: "hrs via sub-agents" },
      { to: A.byType.length, fmt: intFmt, label: "agent roles" },
    ]);
    const s = scene("fleet", "jny-s4", "The fleet", "The work stopped being solo", "An army, working in parallel.", [
      el(
        "p",
        { class: "jny-lede" },
        `Claude was on the clock for ${Math.round(workingHours)} measured hours — model generating, ` +
          `tools and agents executing, human think-time stripped out. The main thread did the bulk; ` +
          `around it, ${intFmt(A.total)} subagents handled ${oneDp(agentHours)} hours in parallel. ` +
          `That is the man-hours story: not one operator typing, but a fleet on the clock.`,
      ),
      f.node,
      el("p", { class: "jny-foot" }, "All figures measured from message timestamps; working time excludes human idle (gaps capped at 10 min)."),
    ]);
    s.counts.push(...f.counts);
    scenes.push(s);
  }

  // ── Interactive map scene (preserved force graph + timeline) ────────────────
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
  const inferredPct =
    j.edges.length > 0
      ? Math.round((j.edges.filter((e) => e.confidence === "inferred").length / j.edges.length) * 100)
      : 0;

  const explore = el(
    "section",
    { class: "jny-explore", id: "jny-map" },
    el("div", { class: "jny-explore-head" }, el("p", { class: "jny-kicker" }, "The map"), el("h2", {}, "Now walk it yourself.")),
    el(
      "p",
      { class: "jny-lede" },
      `${j.nodes.length} projects, ${j.edges.length} distinct hops. Bigger node = more lines typed there; ` +
        `warmer = more recently touched; thicker edge = a path walked more often. ` +
        `Solid edges are explicit; faint dashed ones are inferred leaps. Click anything.`,
    ),
    el(
      "div",
      { class: "jn-graph-wrap" },
      fitChart(el("div"), (w) => forceGraph(j.nodes, j.edges, { onPick: onGraphPick, width: w })),
      panel,
    ),
    el("h3", { class: "jny-tl-head" }, "Every visit, threaded in time"),
    el(
      "p",
      { class: "jny-lede" },
      `The crossing lines are the point — the jumping around is the work, not noise to flatten out.`,
    ),
    fitChart(el("div"), (w) =>
      sloppyTimeline(j.visits, { first: j.first, last: j.last, onPick: (v) => renderVisit(panel, v), width: w }),
    ),
  );

  // ── Today / closer ──────────────────────────────────────────────────────────
  const closer = el(
    "section",
    { class: "jny-closer", id: "jny-today" },
    el("p", { class: "jny-kicker" }, j.last ? fullDay(j.last) : "Today"),
    el("h2", {}, "And it loops back on itself."),
    el(
      "p",
      {},
      `From `,
      el("code", {}, j.visits[0]?.opening || "/example-command"),
      ` on day one to ${intFmt(A.total)} agents and ${money(t.cost)} of estimated model time. ` +
        `The latest thing built is this very view — a tool that reads the journey and renders it back. ` +
        `The corpus now contains the map of itself.`,
    ),
    el(
      "p",
      { class: "jny-foot" },
      `Window ${j.windowDays} days; worktrees collapsed onto their parent. ${inferredPct}% of edges inferred. Nothing here is destructive — click around.`,
    ),
    el("button", { class: "btn ghost", onclick: resetPanel }, "Reset inspector"),
    el("a", { class: "btn", href: "#jny-s0" }, "Back to day one ↑"),
  );

  // ── Assemble ────────────────────────────────────────────────────────────────
  const stage = el("div", { class: "jny-stage" }, canvas);
  const root = el("div", { class: "jny-root" }, stage, rail, back, ...scenes.map((s) => s.el), explore, closer);
  host.append(root);

  // Chapter dots.
  const chapters = [...scenes.map((s) => ({ anchor: s.anchor, label: s.chapter })), { anchor: "jny-map", label: "The map" }, { anchor: "jny-today", label: "Today" }];
  const dotEls = chapters.map((c, i) => {
    const d = el(
      "button",
      { class: "jny-dot", title: c.label, onclick: () => document.getElementById(c.anchor)?.scrollIntoView({ behavior: "smooth" }) },
      el("span", { class: "jny-dot-label" }, `${i + 1}. ${c.label}`),
    );
    dots.append(d);
    return d;
  });

  // ── Canvas + scroll wiring ──────────────────────────────────────────────────
  const field = createJourneyField(canvas, seeds, fleetForCanvas);
  const triggered = new Set<number>();
  let lastActive = -1;
  let ticking = false;

  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      ticking = false;
      const vh = window.innerHeight;
      let active = 0;
      let prog = 0;
      for (let i = 0; i < scenes.length; i++) {
        const r = scenes[i].el.getBoundingClientRect();
        if (r.top <= vh * 0.45) {
          active = i;
          prog = Math.max(0, Math.min(1, (vh * 0.45 - r.top) / (r.height * 0.78)));
        }
      }
      const er = explore.getBoundingClientRect();
      const inExplore = er.top <= vh * 0.55;

      if (inExplore) {
        field.setVisible(false);
        field.setScene("starfield", 1);
        railBar.style.height = "100%";
      } else {
        field.setVisible(true);
        field.setScene(scenes[active].id, prog);
        railBar.style.height = `${(((active + prog) / chapters.length) * 100).toFixed(1)}%`;
        if (active !== lastActive) {
          lastActive = active;
          if (!triggered.has(active)) {
            triggered.add(active);
            runCounts(scenes[active].counts);
          }
        }
      }

      // Active chapter dot.
      const cr = closer.getBoundingClientRect();
      let chap = active;
      if (cr.top <= vh * 0.55) chap = chapters.length - 1;
      else if (inExplore) chap = scenes.length;
      dotEls.forEach((d, i) => d.classList.toggle("active", i === chap));
    });
  };
  const onResize = () => {
    field.resize();
    onScroll();
  };

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onResize);
  teardown = () => {
    field.destroy();
    window.removeEventListener("scroll", onScroll);
    window.removeEventListener("resize", onResize);
  };

  // Kick off scene 0.
  triggered.add(0);
  onScroll();
}
