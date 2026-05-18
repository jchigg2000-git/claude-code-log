import { el } from "./dom.ts";

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
