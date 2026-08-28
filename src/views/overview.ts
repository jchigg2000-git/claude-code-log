import { fetchOverview, fetchMetrics } from "../api.ts";
import { loadConfig } from "../config.ts";
import { el, clear, relativeTime, errorBox, stat } from "../dom.ts";
import { areaChart, compact, money } from "../charts.ts";
import type { RepoSummary, OrphanLog, Metrics } from "../types.ts";

function heroStat(value: string, label: string): HTMLElement {
  return el("div", { class: "hero-stat" }, el("b", {}, value), el("span", {}, label));
}

/** Fill the front-page hero once the (cached) corpus scan resolves. */
function populateHero(hero: HTMLElement, m: Metrics): void {
  const t = m.totals;
  clear(hero);
  hero.append(
    el(
      "div",
      { class: "hero-top" },
      el(
        "div",
        { class: "hero-stats" },
        heroStat(compact(t.sessions), "sessions"),
        heroStat(compact(t.userPrompts), "prompts"),
        heroStat(`≈ ${money(t.cost)}`, "est. spend"),
        heroStat(compact(t.tokCacheRead), "cache-read tok"),
        heroStat(`${m.span.activeDays}/${m.span.days}`, "active days"),
      ),
      el("span", { class: "hero-cta" }, "Full data viz →"),
    ),
    areaChart(
      m.byDay.map((d) => ({ date: d.date, value: d.events })),
      { bare: true, height: 96, peaks: 2 },
    ),
  );
}

function repoCard(r: RepoSummary): HTMLElement {
  const href = `#/repo?path=${encodeURIComponent(r.path)}&name=${encodeURIComponent(r.name)}`;
  const inactive = r.sessionCount === 0;
  return el(
    "a",
    { class: `card${inactive ? " inactive" : ""}`, href },
    el(
      "div",
      { class: "card-head" },
      el("h3", {}, r.name),
      el("span", { class: `badge${r.hasGit ? "" : " muted"}` }, r.hasGit ? "git" : "no git"),
    ),
    el("code", { class: "path" }, r.path),
    el(
      "div",
      { class: "stats" },
      stat(r.sessionCount, "sessions"),
      stat(r.messageCount || "—", "messages"),
      stat(relativeTime(r.lastActivity), "last"),
    ),
  );
}

function orphanRow(o: OrphanLog): HTMLElement {
  return el(
    "div",
    { class: "orphan" },
    el("code", { class: "path" }, o.approxPath),
    el(
      "span",
      { class: "orphan-meta" },
      `${o.sessionCount} session${o.sessionCount === 1 ? "" : "s"} · ${relativeTime(o.lastActivity)}`,
    ),
  );
}

export async function renderOverview(host: HTMLElement): Promise<void> {
  clear(host);
  host.append(el("p", { class: "loading" }, "Scanning repos and Claude Code logs…"));

  try {
    const data = await fetchOverview(loadConfig());
    clear(host);

    const active = data.repos.filter((r) => r.sessionCount > 0).length;
    host.append(
      el(
        "div",
        { class: "page-head" },
        el("h1", {}, "Claude Code History"),
        el(
          "p",
          { class: "sub" },
          `${data.repos.length} repos · ${active} with Claude activity · ${data.orphanLogs.length} unmatched log projects`,
        ),
      ),
    );

    // Full-width hero strip directly under the subtext, linking to the Data
    // Viz page. The corpus scan is heavy, so render a placeholder and fill it
    // in once the (cached) metrics resolve — the repo grid never waits on it.
    const hero = el(
      "a",
      { class: "hero", href: "#/viz", title: "Open the full Data Viz page" },
      el("p", { class: "loading", style: "margin:6px 0 14px" }, "Summarizing the whole corpus…"),
    );
    host.append(hero);
    fetchMetrics(loadConfig())
      .then((m) => {
        if (hero.isConnected) populateHero(hero, m);
      })
      .catch(() => {
        if (hero.isConnected) hero.remove();
      });

    if (data.repos.length === 0) {
      host.append(
        el(
          "div",
          { class: "empty" },
          "No repositories found under the configured base root. Open Settings (⚙) to adjust the path.",
        ),
      );
    } else {
      const grid = el("div", { class: "grid" });
      for (const r of data.repos) grid.append(repoCard(r));
      host.append(grid);
    }

    if (data.orphanLogs.length > 0) {
      const box = el("details", { class: "orphans" }, el("summary", {}, `Other Claude Code activity (${data.orphanLogs.length})`));
      for (const o of data.orphanLogs) box.append(orphanRow(o));
      host.append(box);
    }
  } catch (err) {
    clear(host);
    host.append(errorBox("Could not load data. ", err, "Check the paths in Settings (⚙)."));
  }
}
