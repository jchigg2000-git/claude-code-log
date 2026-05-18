import { fetchMetrics } from "../api.ts";
import { loadConfig } from "../config.ts";
import { el, clear } from "../dom.ts";
import { areaChart, barList, logBars, compact, money } from "../charts.ts";
import type { Metrics, ProjectMetric } from "../types.ts";

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

function find(list: ProjectMetric[], needle: string): ProjectMetric | undefined {
  return list.find((p) => p.dirName.includes(needle));
}

/** The featured graphic: the req↔harvest loop, drawn from the live numbers. */
function harvestDiagram(m: Metrics): HTMLElement {
  const req = find(m.harvest, "requirements-harvester");
  const dataReq = find(m.harvest, "requirements-harvester-data");
  const reqHarvest = find(m.harvest, "requirements-harvester");
  const self = m.self;
  const trio = (req?.cost ?? 0) + (dataReq?.cost ?? 0) + (reqHarvest?.cost ?? 0);

  const node = (
    x: number,
    y: number,
    w: number,
    title: string,
    line: string,
    tone: "user" | "tool" | "accent",
  ) => `
    <g>
      <rect class="vz-nb vz-stroke-${tone}" x="${x}" y="${y}" width="${w}" height="58" rx="9"/>
      <text x="${x + w / 2}" y="${y + 24}" text-anchor="middle" class="vz-n-title">${title}</text>
      <text x="${x + w / 2}" y="${y + 42}" text-anchor="middle" class="vz-n-sub">${line}</text>
    </g>`;

  const fmt = (p?: ProjectMetric) =>
    p ? `${money(p.cost)} · ${p.sessions} sess · ${p.userPrompts} prompts` : "—";

  const svg = `<svg viewBox="0 0 1000 380" class="vz-svg vz-diagram" role="img"
       aria-label="The requirements-harvester recursion: requirements-harvester seeds requirements-harvester-data; the family harvests the corpus this dashboard also reads.">
    <defs>
      <marker id="vzah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7"
              markerHeight="7" orient="auto-start-reverse">
        <path class="vz-ah" d="M0 0 L10 5 L0 10 z"/>
      </marker>
      <marker id="vzahA" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7"
              markerHeight="7" orient="auto-start-reverse">
        <path class="vz-ah accent" d="M0 0 L10 5 L0 10 z"/>
      </marker>
    </defs>

    ${node(40, 30, 230, "requirements-harvester", fmt(req), "user")}
    ${node(40, 150, 230, "requirements-harvester", fmt(reqHarvest), "tool")}
    ${node(385, 90, 240, "requirements-harvester-data", fmt(dataReq), "accent")}

    <!-- requirements-harvester's direct output seeds requirements-harvester-data -->
    <path class="vz-ln accent" d="M270 59 C 330 59 330 110 385 116" stroke-width="2"
          marker-end="url(#vzahA)"/>
    <text x="332" y="78" text-anchor="middle" class="vz-edge accent">output seeds →</text>

    <!-- both harvest the same corpus -->
    <path class="vz-ln" d="M270 179 C 330 179 340 140 385 134" stroke-width="1.5"
          stroke-dasharray="4 3" marker-end="url(#vzah)"/>

    <!-- the corpus -->
    <g>
      <ellipse class="vz-cyl" cx="780" cy="120" rx="70" ry="16"/>
      <path class="vz-cyl" d="M710 120 V 188 A 70 16 0 0 0 850 188 V 120"/>
      <ellipse class="vz-cyl-rim" cx="780" cy="120" rx="70" ry="16"/>
      <text x="780" y="150" text-anchor="middle" class="vz-n-title">the corpus</text>
      <text x="780" y="170" text-anchor="middle" class="vz-n-sub">${
        m.totals.sessions
      } sessions</text>
    </g>
    <path class="vz-ln" d="M625 150 C 670 160 690 158 712 156" stroke-width="2"
          marker-end="url(#vzah)"/>
    <text x="668" y="140" text-anchor="middle" class="vz-edge">harvests →</text>

    <!-- this app reads the same corpus -->
    ${node(660, 280, 240, "claude-code-log", self ? fmt(self) : "this dashboard", "user")}
    <path class="vz-ln user" d="M780 204 C 780 240 780 250 780 280" stroke-width="2"
          marker-end="url(#vzah)"/>
    <text x="800" y="246" class="vz-edge">reads ↓</text>

    <!-- ouroboros: this very page becomes the next scan -->
    <path class="vz-ln accent" d="M660 309 C 360 360 120 320 120 230 L 120 212"
          stroke-width="2" stroke-dasharray="2 4" marker-end="url(#vzahA)"/>
    <text x="400" y="352" text-anchor="middle" class="vz-edge accent">
      …this very page becomes the next row in the scan</text>
  </svg>`;

  const box = el("div", { class: "vz-diagram-wrap" });
  box.innerHTML = svg;

  const caption = el(
    "p",
    { class: "vz-lede" },
    `Three projects whose names are the same two words shuffled — `,
    el("code", {}, "requirements-harvester"),
    `, `,
    el("code", {}, "requirements-harvester-data"),
    `, `,
    el("code", {}, "requirements-harvester"),
    ` — together ${money(trio)} of estimated spend. ` +
      `requirements-harvester-data was seeded with the direct output of requirements-harvester: a project ` +
      `that builds the data to spec the project that specs it. And the whole family ` +
      `harvests this Claude-Code corpus — the same corpus this dashboard reads. ` +
      `The session writing this page lands in the next scan. The corpus contains itself.`,
  );

  return el("div", {}, box, caption);
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

  host.append(
    el("a", { class: "back", href: "#/" }, "← All repos"),
    el(
      "div",
      { class: "page-head" },
      el("h1", {}, "By the Numbers"),
      el(
        "p",
        { class: "sub" },
        `Everything built in ~${m.span.days} days, read straight from ${t.sessions} ` +
          `session transcripts. Live scan; cost is estimated at public list prices.`,
      ),
    ),
  );

  // ── Headline strip ───────────────────────────────────────────────
  host.append(
    statStrip([
      [`${m.span.activeDays}/${m.span.days}`, "active days"],
      [compact(t.sessions), "sessions"],
      [compact(t.userPrompts), "human prompts"],
      [compact(t.assistant), "assistant turns"],
      [compact(t.toolCalls), "tool calls"],
      [`≈ ${money(t.cost)}`, "est. spend"],
      [compact(t.tokCacheRead), "cache-read tokens"],
      [`${t.humanProjects}`, "real projects"],
    ]),
  );

  // ── The headline graphic: the recursion ──────────────────────────
  host.append(
    section(
      "The req⇄harvest recursion",
      "The bit you asked me to look hard at — and it is genuinely a loop.",
      harvestDiagram(m),
    ),
  );

  // ── Pace ─────────────────────────────────────────────────────────
  const busiest = [...m.byDay].sort((a, b) => b.events - a.events)[0];
  host.append(
    section(
      "Pace",
      `Near-daily for six weeks: activity on ${m.span.activeDays} of ${m.span.days} ` +
        `calendar days. Biggest single day — ${
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
            ` — all of it today. It is already row in its own dataset.`,
          )
        : el("p", {}, "And this dashboard is now part of the corpus it measures."),
      el("p", { class: "vz-foot" }, `Snapshot is live; ${m.totals.scaffoldProjects} throwaway scaffold/temp dirs excluded, as on the Profile page.`),
    ),
  );

  window.scrollTo(0, 0);
}
