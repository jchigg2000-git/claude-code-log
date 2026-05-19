import { el, relativeTime } from "./dom.ts";
import type { JourneyEdge, JourneyNode, JourneyVisit } from "./types.ts";

/** Bespoke, theme-matched visualizations. No chart library: the app is
 * zero-framework vanilla DOM with a hand-built palette, and purpose-built
 * SVG/flex sits in that aesthetic far better than a generic charting dep. */

let gradSeq = 0;

export function compact(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, "") + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (a >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(Math.round(n));
}

export function money(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function shortDate(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${mon[(m || 1) - 1]} ${d}`;
}

/** Continuous cold→hot recency ramp: 0 = long untouched (neutral gray) then
 * up through the full spectrum to 1 = freshly worked (hot red). */
const HEAT_RAMP: [number, number, number][] = [
  [0x80, 0x86, 0x92], // cold — neutral gray (stale)
  [0x3c, 0x6f, 0xd6], // blue
  [0x22, 0xb5, 0xc4], // cyan
  [0x4f, 0xc2, 0x4f], // green
  [0xf2, 0xd0, 0x35], // yellow
  [0xf0, 0x8a, 0x24], // orange
  [0xe5, 0x36, 0x2c], // hot — red (fresh)
];
function warmth(f: number): string {
  const t = Math.max(0, Math.min(1, f));
  const segs = HEAT_RAMP.length - 1;
  const x = t * segs;
  const i = Math.min(segs - 1, Math.floor(x));
  const lt = x - i;
  const a = HEAT_RAMP[i];
  const b = HEAT_RAMP[i + 1];
  const hex = (k: number) =>
    Math.round(a[k] + (b[k] - a[k]) * lt)
      .toString(16)
      .padStart(2, "0");
  return `#${hex(0)}${hex(1)}${hex(2)}`;
}

interface AreaOpts {
  height?: number;
  /** Annotate the N tallest points with date + value. */
  peaks?: number;
  /** Value formatter for peak labels. */
  fmt?: (n: number) => string;
  /** Compact variant for the front-page strip: thinner, no labels. */
  bare?: boolean;
  /** Optional start/end captions drawn on the baseline. */
  first?: string;
  last?: string;
}

/** Daily activity as a filled area + line, peaks annotated. */
export function areaChart(
  series: { date: string; value: number }[],
  opts: AreaOpts = {},
): HTMLElement {
  const W = 1000;
  const H = opts.height ?? 220;
  const padX = 8;
  const padTop = opts.bare ? 6 : 26;
  const padBottom = opts.bare ? 6 : 22;
  const max = Math.max(1, ...series.map((s) => s.value));
  const n = series.length;
  const x = (i: number) => padX + (i / Math.max(1, n - 1)) * (W - 2 * padX);
  const y = (v: number) => padTop + (1 - v / max) * (H - padTop - padBottom);

  const pts = series.map((s, i) => `${x(i).toFixed(1)},${y(s.value).toFixed(1)}`);
  const line = `M${pts.join(" L")}`;
  const area = `${line} L${x(n - 1).toFixed(1)},${(H - padBottom).toFixed(1)} L${x(0).toFixed(
    1,
  )},${(H - padBottom).toFixed(1)} Z`;

  const peakIdx = opts.peaks
    ? [...series.keys()].sort((a, b) => series[b].value - series[a].value).slice(0, opts.peaks)
    : [];
  const fmt = opts.fmt ?? compact;

  const dots = peakIdx
    .map((i) => {
      const cx = x(i);
      const cy = y(series[i].value);
      const label = `${shortDate(series[i].date)} · ${fmt(series[i].value)}`;
      const anchor = cx > W - 160 ? "end" : cx < 160 ? "start" : "middle";
      const lx = anchor === "end" ? cx - 6 : anchor === "start" ? cx + 6 : cx;
      const text = opts.bare
        ? ""
        : `<text x="${lx.toFixed(1)}" y="${(cy - 9).toFixed(
            1,
          )}" text-anchor="${anchor}" class="vz-peak">${esc(label)}</text>`;
      return `<circle class="vz-dot" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3.5"/>${text}`;
    })
    .join("");

  const baseline =
    opts.first || opts.last
      ? `<text x="${padX}" y="${H - 6}" class="vz-axis">${esc(opts.first ?? "")}</text>
         <text x="${W - padX}" y="${H - 6}" text-anchor="end" class="vz-axis">${esc(
           opts.last ?? "",
         )}</text>`
      : "";

  // Unique gradient id: multiple area charts coexist on the Data Viz page and
  // duplicate ids would all resolve to the first gradient.
  const gid = `vzfill-${++gradSeq}`;
  const svg = `<svg viewBox="0 0 ${W} ${H}" class="vz-svg" role="img" aria-hidden="true">
    <defs><linearGradient id="${gid}" x1="0" x2="0" y1="0" y2="1">
      <stop class="vz-stop-0" offset="0%"/>
      <stop class="vz-stop-1" offset="100%"/>
    </linearGradient></defs>
    <path class="vz-fill" d="${area}" fill="url(#${gid})"/>
    <path class="vz-line${opts.bare ? " bare" : ""}" d="${line}"/>
    ${dots}${baseline}
  </svg>`;

  const box = el("div", { class: `vz-area${opts.bare ? " vz-area-bare" : ""}` });
  box.innerHTML = svg;
  return box;
}

export interface BarRow {
  label: string;
  value: number;
  display: string;
  /** Optional secondary line under the label. */
  sub?: string;
  /** Accent | user | tool — picks the bar color. */
  tone?: "accent" | "user" | "tool" | "muted";
  href?: string;
  /** Visually group adjacent rows (e.g. the job-search-engine double-spelling). */
  grouped?: boolean;
}

/** Horizontal labelled bars, scaled linearly to the largest value. */
export function barList(rows: BarRow[]): HTMLElement {
  const max = Math.max(1, ...rows.map((r) => r.value));
  const wrap = el("div", { class: "vz-bars" });
  for (const r of rows) {
    const pct = Math.max(1.5, (r.value / max) * 100);
    const tone = r.tone ?? "accent";
    const meta = el(
      "div",
      { class: "vz-bar-meta" },
      el("span", { class: "vz-bar-label" }, r.label),
      el("span", { class: "vz-bar-val" }, r.display),
    );
    if (r.sub) meta.append(el("span", { class: "vz-bar-sub" }, r.sub));
    const track = el(
      "div",
      { class: "vz-bar-track" },
      el("div", { class: `vz-bar-fill tone-${tone}`, style: `width:${pct.toFixed(1)}%` }),
    );
    const row = el(
      r.href ? "a" : "div",
      r.href
        ? { class: `vz-bar-row${r.grouped ? " grouped" : ""}`, href: r.href }
        : { class: `vz-bar-row${r.grouped ? " grouped" : ""}` },
      meta,
      track,
    );
    wrap.append(row);
  }
  return wrap;
}

/** Log-scaled bars — for spans where one value dwarfs the rest by orders of
 * magnitude (the prompt-cache story). Each bar carries its own raw label. */
export function logBars(
  items: { label: string; value: number; display: string; note?: string; tone?: BarRow["tone"] }[],
): HTMLElement {
  const logs = items.map((i) => Math.log10(Math.max(1, i.value)));
  const max = Math.max(...logs);
  const wrap = el("div", { class: "vz-bars vz-logbars" });
  items.forEach((it, k) => {
    const pct = Math.max(4, (logs[k] / max) * 100);
    const meta = el(
      "div",
      { class: "vz-bar-meta" },
      el("span", { class: "vz-bar-label" }, it.label),
      el("span", { class: "vz-bar-val" }, it.display),
    );
    if (it.note) meta.append(el("span", { class: "vz-bar-sub" }, it.note));
    wrap.append(
      el(
        "div",
        { class: "vz-bar-row" },
        meta,
        el(
          "div",
          { class: "vz-bar-track" },
          el("div", {
            class: `vz-bar-fill tone-${it.tone ?? "accent"}`,
            style: `width:${pct.toFixed(1)}%`,
          }),
        ),
      ),
    );
  });
  return wrap;
}

const clampN = (lo: number, hi: number, v: number) => Math.max(lo, Math.min(hi, v));

export type GraphPick =
  | { type: "node"; node: JourneyNode }
  | { type: "edge"; edge: JourneyEdge; from: JourneyNode | undefined; to: JourneyNode | undefined };

interface GraphOpts {
  onPick?: (p: GraphPick) => void;
  height?: number;
}

/**
 * The "mental graph": projects as a force-directed neural-net. Layout is a
 * deterministic spring/repulsion relaxation (no RNG → stable across renders,
 * no animation needed). Solid accent edge = an explicit hop (a typed line
 * named the other project); faint dashed edge = an inferred leap of faith.
 * Edge weight ∝ how often that hop happened; node size ∝ activity; node tone
 * ∝ recency. Click a node or edge to inspect it.
 */
export function forceGraph(
  nodes: JourneyNode[],
  edges: JourneyEdge[],
  opts: GraphOpts = {},
): HTMLElement {
  const W = 1200;
  const H = opts.height ?? 720;
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  const N = nodes.length;

  const box = el("div", { class: "jn-graph" });
  if (N === 0) {
    box.append(el("p", { class: "vz-lede" }, "No project activity in this window."));
    return box;
  }

  // Deterministic seed: a golden-angle spiral around the centre.
  const cx = W / 2;
  const cy = H / 2;
  const pos = nodes.map((_, i) => {
    const a = i * 2.399963;
    const r = 40 + i * (Math.min(W, H) * 0.36 / Math.max(1, N));
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
  });

  const links = edges
    .map((e) => ({ s: idx.get(e.from), t: idx.get(e.to), w: e.count }))
    .filter((l): l is { s: number; t: number; w: number } => l.s !== undefined && l.t !== undefined);

  // Spring/repulsion relaxation establishes topology (connected projects sit
  // near each other) and strong gravity keeps it one cohesive mass so stray
  // nodes don't strand in empty canvas. The collision pass below then expands
  // that compact mass to fill the space with zero overlap.
  const REST = 130;
  const K_REP = 92_000;
  const K_SPR = 0.016;
  const K_GRAV = 0.07;
  const ITERS = 520;
  for (let it = 0; it < ITERS; it++) {
    const cool = 1 - it / ITERS;
    const dx = new Array(N).fill(0);
    const dy = new Array(N).fill(0);
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        let vx = pos[i].x - pos[j].x;
        let vy = pos[i].y - pos[j].y;
        let d2 = vx * vx + vy * vy;
        if (d2 < 1) {
          d2 = 1;
          vx = (i - j) || 1;
          vy = 1;
        }
        const f = K_REP / d2;
        const d = Math.sqrt(d2);
        const ux = (vx / d) * f;
        const uy = (vy / d) * f;
        dx[i] += ux;
        dy[i] += uy;
        dx[j] -= ux;
        dy[j] -= uy;
      }
    }
    for (const l of links) {
      const vx = pos[l.t].x - pos[l.s].x;
      const vy = pos[l.t].y - pos[l.s].y;
      const d = Math.sqrt(vx * vx + vy * vy) || 1;
      const f = (d - REST) * K_SPR * Math.min(3, 1 + Math.log2(l.w + 1));
      const ux = (vx / d) * f;
      const uy = (vy / d) * f;
      dx[l.s] += ux;
      dy[l.s] += uy;
      dx[l.t] -= ux;
      dy[l.t] -= uy;
    }
    for (let i = 0; i < N; i++) {
      dx[i] += (cx - pos[i].x) * K_GRAV;
      dy[i] += (cy - pos[i].y) * K_GRAV;
      const step = 14 * cool;
      pos[i].x += clampN(-step, step, dx[i]);
      pos[i].y += clampN(-step, step, dy[i]);
    }
  }

  // Fit to the viewBox, then centre the cluster so the freed space is shared
  // evenly on both axes instead of pooling against the top-left padding.
  const pad = 56;
  const xs = pos.map((p) => p.x);
  const ys = pos.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const sc = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
  const offX = (W - spanX * sc) / 2;
  const offY = (H - spanY * sc) / 2;
  for (const p of pos) {
    p.x = offX + (p.x - minX) * sc;
    p.y = offY + (p.y - minY) * sc;
  }

  const maxCmd = Math.max(1, ...nodes.map((n) => n.commands));
  const radius = (n: JourneyNode) => clampN(7, 26, 6 + Math.sqrt(n.commands / maxCmd) * 22);

  // Overlap resolution in final pixel space: the force pass settles topology,
  // this guarantees no two circles touch — which also expands the dense core
  // to actually fill the canvas instead of clumping. Radii + a label-aware
  // gap; clamp inside the frame each pass.
  const rad = nodes.map((n) => radius(n));
  const COLL_ITERS = 28;
  for (let it = 0; it < COLL_ITERS; it++) {
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        let vx = pos[j].x - pos[i].x;
        let vy = pos[j].y - pos[i].y;
        let d = Math.hypot(vx, vy);
        const gap = rad[i] + rad[j] + 44;
        if (d < 0.01) {
          vx = (i % 2 ? 1 : -1);
          vy = i % 3 ? 1 : -1;
          d = 1;
        }
        if (d < gap) {
          const push = (gap - d) / 2;
          const ux = vx / d;
          const uy = vy / d;
          pos[i].x -= ux * push;
          pos[i].y -= uy * push;
          pos[j].x += ux * push;
          pos[j].y += uy * push;
        }
      }
    }
    for (let i = 0; i < N; i++) {
      pos[i].x = clampN(pad + rad[i], W - pad - rad[i], pos[i].x);
      pos[i].y = clampN(pad + rad[i], H - pad - rad[i], pos[i].y);
    }
  }

  // Stretch the overlap-free layout to fill the whole frame. Both axes scale
  // by ≥1 so separations only grow (overlap can't return); anisotropy is
  // capped so a thin cluster fills the width without smearing into spaghetti.
  {
    const inset = pad + 22;
    const bx0 = Math.min(...pos.map((p) => p.x));
    const bx1 = Math.max(...pos.map((p) => p.x));
    const by0 = Math.min(...pos.map((p) => p.y));
    const by1 = Math.max(...pos.map((p) => p.y));
    let fx = Math.max(1, (W - 2 * inset) / Math.max(1, bx1 - bx0));
    let fy = Math.max(1, (H - 2 * inset) / Math.max(1, by1 - by0));
    const lo = Math.min(fx, fy);
    fx = Math.min(fx, lo * 2.4);
    fy = Math.min(fy, lo * 2.4);
    const offX = inset + (W - 2 * inset - (bx1 - bx0) * fx) / 2;
    const offY = inset + (H - 2 * inset - (by1 - by0) * fy) / 2;
    for (const p of pos) {
      p.x = offX + (p.x - bx0) * fx;
      p.y = offY + (p.y - by0) * fy;
    }
  }

  // Recency colour by *rank*, not raw time: almost everything was touched
  // near the end of the window, so a linear time map pins ~everyone at the
  // hot end. Percentile rank exercises the whole ramp — a true heatmap of
  // coldest → hottest project, evenly spread.
  const rankFrac = new Map<string, number>();
  [...nodes]
    .map((n) => ({ id: n.id, t: Date.parse(n.last) }))
    .sort((a, b) => a.t - b.t)
    .forEach((o, k, arr) => rankFrac.set(o.id, arr.length > 1 ? k / (arr.length - 1) : 1));
  const recencyFill = (n: JourneyNode) => warmth(rankFrac.get(n.id) ?? 1);

  const edgePath = (sI: number, tI: number, dir: number) => {
    const a = pos[sI];
    const b = pos[tI];
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const nx = -(b.y - a.y);
    const ny = b.x - a.x;
    const len = Math.hypot(nx, ny) || 1;
    const bow = 26 * dir;
    return `M${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${(mx + (nx / len) * bow).toFixed(1)} ${(
      my +
      (ny / len) * bow
    ).toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
  };

  const edgeSvg = edges
    .map((e, i) => {
      const s = idx.get(e.from);
      const t = idx.get(e.to);
      if (s === undefined || t === undefined) return "";
      const dir = e.from < e.to ? 1 : -1;
      const sw = clampN(0.7, 6, Math.log2(e.count + 1) * 1.1).toFixed(2);
      const cls = e.confidence === "explicit" ? "jn-edge explicit" : "jn-edge inferred";
      const mk = e.confidence === "explicit" ? "jnA" : "jnI";
      return `<path class="${cls}" data-edge="${i}" d="${edgePath(s, t, dir)}"
        stroke-width="${sw}" marker-end="url(#${mk})"/>`;
    })
    .join("");

  const nodeSvg = nodes
    .map((n, i) => {
      const r = radius(n);
      const p = pos[i];
      const showLabel = r >= 12 || N <= 18;
      const label = showLabel
        ? `<text class="jn-nlabel" x="${p.x.toFixed(1)}" y="${(p.y + r + 13).toFixed(
            1,
          )}" text-anchor="middle">${esc(n.name)}</text>`
        : "";
      return `<g class="jn-node" data-node="${i}">
        <title>${esc(n.name)} · ${n.commands} lines · ${n.sessions} sessions</title>
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(1)}" fill="${recencyFill(
          n,
        )}"/>
        ${label}</g>`;
    })
    .join("");

  const svg = `<svg viewBox="0 0 ${W} ${H}" class="vz-svg jn-svg" role="img"
      aria-label="Force-directed graph of projects worked on and the hops between them.">
    <defs>
      <marker id="jnA" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6"
              orient="auto-start-reverse"><path class="jn-ah accent" d="M0 0 L10 5 L0 10 z"/></marker>
      <marker id="jnI" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6"
              orient="auto-start-reverse"><path class="jn-ah" d="M0 0 L10 5 L0 10 z"/></marker>
    </defs>
    <g class="jn-edges">${edgeSvg}</g>
    <g class="jn-nodes">${nodeSvg}</g>
  </svg>`;

  box.innerHTML = svg;

  if (opts.onPick) {
    const pick = opts.onPick;
    box.querySelectorAll<SVGElement>("[data-edge]").forEach((p) => {
      p.addEventListener("click", () => {
        const e = edges[Number(p.dataset.edge)];
        pick({
          type: "edge",
          edge: e,
          from: nodes[idx.get(e.from) ?? -1],
          to: nodes[idx.get(e.to) ?? -1],
        });
      });
    });
    box.querySelectorAll<SVGElement>("[data-node]").forEach((g) => {
      g.addEventListener("click", () => pick({ type: "node", node: nodes[Number(g.dataset.node)] }));
    });
  }
  return box;
}

/**
 * A deliberately dense, non-linear timeline of the window. One marker per
 * project "visit" (a contiguous run of work): x = time, y = which project
 * (each project owns a horizontal lane, ordered top→bottom by first-seen).
 * The thin connector threads visits in chronological order so the
 * jumping-around is the visible signal, not noise smoothed away. Hovering a
 * dot lights up that project's whole lane and opens a detail tooltip; click
 * still drives the shared inspector.
 */
export function sloppyTimeline(
  visits: JourneyVisit[],
  opts: { first: string | null; last: string | null; onPick?: (v: JourneyVisit) => void } = {
    first: null,
    last: null,
  },
): HTMLElement {
  const W = 1000;
  const H = 380;
  const padL = 128; // left gutter holds the project (y-axis) labels
  const padR = 18;
  const padTop = 26;
  const padBot = 34;
  const box = el("div", { class: "jn-timeline" });
  if (visits.length === 0) {
    box.append(el("p", { class: "vz-lede" }, "No visits in this window."));
    return box;
  }

  const t0 = Date.parse(opts.first ?? visits[0].ts);
  const t1 = Date.parse(opts.last ?? visits[visits.length - 1].ts);
  const span = Math.max(1, t1 - t0);
  const x = (iso: string) => padL + ((Date.parse(iso) - t0) / span) * (W - padL - padR);

  // Stable colour + lane per project, in first-seen order. The display name
  // is stable per project id, so capture the first one we see.
  const order: string[] = [];
  const nameOf = new Map<string, string>();
  for (const v of visits) {
    if (!order.includes(v.project)) order.push(v.project);
    if (!nameOf.has(v.project)) nameOf.set(v.project, v.name);
  }
  const projIdx = (p: string) => order.indexOf(p);
  const colorOf = (p: string) => `jn-c${projIdx(p) % 10}`;
  const bandOf = (p: string) => {
    const k = order.length > 1 ? projIdx(p) / (order.length - 1) : 0.5;
    return padTop + k * (H - padTop - padBot);
  };
  // Deterministic jitter so overlapping visits stay legible and look hand-drawn.
  const jitter = (ts: string) => ((Date.parse(ts) / 1000) % 47) - 23;

  const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

  const pt = visits.map((v) => ({ vx: x(v.ts), vy: bandOf(v.project) + jitter(v.ts), v }));

  const thread = `M${pt.map((p) => `${p.vx.toFixed(1)} ${p.vy.toFixed(1)}`).join(" L")}`;

  // Y axis: one guide line + gutter label per project lane. Thin the labels
  // out when lanes get tight so they never collide.
  const bandGap = order.length > 1 ? (H - padTop - padBot) / (order.length - 1) : H;
  const labelEvery = Math.max(1, Math.ceil(12 / Math.max(1, bandGap)));
  const lanes = order
    .map((p, j) => {
      const by = bandOf(p);
      const line = `<line class="jn-band" data-proj-band="${j}" x1="${padL}" y1="${by.toFixed(
        1,
      )}" x2="${W - padR}" y2="${by.toFixed(1)}"/>`;
      const show = j % labelEvery === 0 || j === 0 || j === order.length - 1;
      const label = show
        ? `<text class="jn-ylabel" data-proj-band="${j}" x="${padL - 10}" y="${(by + 3.5).toFixed(
            1,
          )}" text-anchor="end">${esc(trunc(nameOf.get(p) ?? p, 17))}</text>`
        : "";
      return line + label;
    })
    .join("");
  const yTitle = `<text class="jn-ytitle" transform="rotate(-90 13 ${(H / 2).toFixed(
    1,
  )})" x="13" y="${(H / 2).toFixed(1)}" text-anchor="middle">projects · top = first seen</text>`;

  const maxCmd = Math.max(1, ...visits.map((v) => v.commands));
  const dots = pt
    .map((p, i) => {
      const r = clampN(2.5, 9, 2.5 + Math.sqrt(p.v.commands / maxCmd) * 8);
      return `<circle class="jn-dot ${colorOf(p.v.project)}" data-visit="${i}" data-proj="${projIdx(
        p.v.project,
      )}" cx="${p.vx.toFixed(1)}" cy="${p.vy.toFixed(1)}" r="${r.toFixed(1)}"/>`;
    })
    .join("");

  // Label only the heftiest visits to keep it dense-but-readable.
  const labelIdx = [...visits.keys()]
    .sort((a, b) => visits[b].commands - visits[a].commands)
    .slice(0, 9);
  const labels = labelIdx
    .map((i) => {
      const p = pt[i];
      const anchor = p.vx > W - 170 ? "end" : p.vx < padL + 100 ? "start" : "middle";
      return `<text class="jn-tlabel" x="${p.vx.toFixed(1)}" y="${(p.vy - 11).toFixed(
        1,
      )}" text-anchor="${anchor}">${esc(p.v.name)}</text>`;
    })
    .join("");

  // Sparse date axis.
  const ticks = 6;
  const axis = Array.from({ length: ticks }, (_, k) => {
    const tx = padL + (k / (ticks - 1)) * (W - padL - padR);
    const iso = new Date(t0 + (k / (ticks - 1)) * span).toISOString().slice(0, 10);
    const anchor = k === 0 ? "start" : k === ticks - 1 ? "end" : "middle";
    return `<line class="jn-axisln" x1="${tx.toFixed(1)}" y1="${padTop - 8}" x2="${tx.toFixed(
      1,
    )}" y2="${H - padBot + 6}"/>
      <text class="vz-axis" x="${tx.toFixed(1)}" y="${H - 10}" text-anchor="${anchor}">${esc(
        shortDate(iso),
      )}</text>`;
  }).join("");

  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="vz-svg jn-tl-svg" role="img"
      aria-label="Non-linear timeline of project visits: x is time, y is which project (lanes ordered top to bottom by first seen).">
    ${axis}
    ${lanes}${yTitle}
    <path class="jn-thread" d="${thread}"/>
    ${dots}${labels}
  </svg>`;

  // --- Interactivity: hover a dot → light its whole project lane + tooltip.
  const tip = el("div", { class: "jn-tip" });
  tip.hidden = true;
  box.append(tip);

  const svg = box.querySelector<SVGSVGElement>("svg");
  const dotEls = [...box.querySelectorAll<SVGCircleElement>("[data-visit]")];
  const bandEls = [...box.querySelectorAll<SVGElement>("[data-proj-band]")];

  const focus = (c: SVGCircleElement) => {
    const pj = c.dataset.proj;
    box.classList.add("jn-focusing");
    for (const d of dotEls) d.classList.toggle("jn-lit", d.dataset.proj === pj);
    c.classList.add("jn-hot");
    for (const b of bandEls) b.classList.toggle("jn-lit", b.dataset.projBand === pj);
  };
  const blur = () => {
    box.classList.remove("jn-focusing");
    for (const d of dotEls) d.classList.remove("jn-lit", "jn-hot");
    for (const b of bandEls) b.classList.remove("jn-lit");
    tip.hidden = true;
  };

  const placeTip = (ev: MouseEvent) => {
    const r = box.getBoundingClientRect();
    let tx = ev.clientX - r.left + 16;
    let ty = ev.clientY - r.top + 16;
    if (tx + tip.offsetWidth > r.width - 6) tx = ev.clientX - r.left - tip.offsetWidth - 14;
    if (ty + tip.offsetHeight > r.height - 6) ty = r.height - tip.offsetHeight - 6;
    tip.style.left = `${Math.max(6, tx)}px`;
    tip.style.top = `${Math.max(6, ty)}px`;
  };
  const showTip = (v: JourneyVisit, ev: MouseEvent) => {
    tip.innerHTML =
      `<div class="jn-tip-h">${esc(v.name)}</div>` +
      `<div class="jn-tip-m">${esc(shortDate(v.ts.slice(0, 10)))} · ${esc(
        relativeTime(v.ts),
      )} · ${v.commands} line${v.commands === 1 ? "" : "s"}</div>` +
      `<div class="jn-tip-q">${esc(trunc(v.opening || "—", 160))}</div>`;
    tip.hidden = false;
    placeTip(ev);
  };

  for (const c of dotEls) {
    const v = visits[Number(c.dataset.visit)];
    c.addEventListener("mouseenter", (ev) => {
      focus(c);
      showTip(v, ev);
    });
    c.addEventListener("mousemove", (ev) => {
      if (!tip.hidden) placeTip(ev);
    });
    if (opts.onPick) {
      const pick = opts.onPick;
      c.addEventListener("click", () => pick(v));
    }
  }
  svg?.addEventListener("mouseleave", blur);

  return box;
}
