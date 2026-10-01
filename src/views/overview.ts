import { fetchOverview, fetchMetrics } from "../api.ts";
import { loadConfig } from "../config.ts";
import { el, clear, relativeTime, errorBox, stat } from "../dom.ts";
import { areaChart, compact, money } from "../charts.ts";
import { fitChart } from "../fitChart.ts";
import type { RenderCtx } from "../mount.ts";
import { repoHash } from "../routes.ts";
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
    fitChart(el("div"), (w) =>
      areaChart(
        m.byDay.map((d) => ({ date: d.date, value: d.events })),
        { bare: true, height: 96, peaks: 2, width: w },
      ),
    ),
  );
}

function repoCard(r: RepoSummary): HTMLElement {
  const href = repoHash(r.path, r.name);
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

export async function renderOverview(host: HTMLElement, ctx: RenderCtx): Promise<void> {
  clear(host);
  host.append(el("p", { class: "loading" }, "Scanning repos and Claude Code logs…"));

  try {
    const data = await fetchOverview(loadConfig());
    if (!ctx.isCurrent()) return;
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
          `${data.repos.length} repo${data.repos.length === 1 ? "" : "s"} · ${active} with Claude activity · ` +
            `${data.orphanLogs.length} unmatched log project${data.orphanLogs.length === 1 ? "" : "s"}`,
        ),
      ),
    );

    // Full-width hero strip directly under the subtext, linking to the Data
    // Viz page. The corpus scan is heavy, so a navigation renders a placeholder
    // and fills it in once the (cached) metrics resolve — the repo grid never
    // waits on it. A refresh is different: the old page (hero included) stays up
    // while this one builds, so waiting here is invisible, and a placeholder
    // would swap in shorter than the page it replaces and clamp the scroll.
    const hero = el("a", { class: "hero", href: "#/viz", title: "Open the full Data Viz page" });
    const metrics = fetchMetrics(loadConfig());
    const early = ctx.refreshing ? await metrics.catch(() => null) : null;
    if (!ctx.isCurrent()) return;
    if (early) {
      populateHero(hero, early);
    } else {
      hero.append(el("p", { class: "loading", style: "margin:6px 0 14px" }, "Summarizing the whole corpus…"));
      // Guarded on the route, not on `hero.isConnected`: a refresh builds in a
      // detached stage, and the metrics can land before it is swapped in.
      // Filling a detached hero is harmless; skipping it would strand the
      // placeholder on screen.
      metrics
        .then((m) => {
          if (ctx.isCurrent()) populateHero(hero, m);
        })
        .catch(() => {
          if (ctx.isCurrent()) hero.remove();
        });
    }
    host.append(hero);

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
    if (!ctx.isCurrent()) return;
    clear(host);
    host.append(errorBox("Could not load data. ", err, "Check the paths in Settings (⚙)."));
  }
}
