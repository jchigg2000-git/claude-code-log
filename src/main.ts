import "./style.css";
import { renderOverview } from "./views/overview.ts";
import { renderRepoDetail } from "./views/repoDetail.ts";
import { renderProfile } from "./views/profile.ts";
import { renderDataViz } from "./views/dataViz.ts";
import { renderJourney } from "./views/journey.ts";
import { openSettings } from "./views/settings.ts";
import { invalidateMetrics, invalidateJourney } from "./api.ts";

const app = document.getElementById("app")!;

async function route(opts: { preserveScroll?: boolean } = {}): Promise<void> {
  const hash = location.hash.replace(/^#/, "") || "/";
  const [pathPart, queryPart] = hash.split("?");
  const params = new URLSearchParams(queryPart ?? "");

  if (pathPart === "/repo") {
    const repoPath = params.get("path") ?? "";
    const name = params.get("name") ?? repoPath;
    await renderRepoDetail(app, repoPath, name);
  } else if (pathPart === "/profile") {
    await renderProfile(app);
  } else if (pathPart === "/viz") {
    await renderDataViz(app);
  } else if (pathPart === "/journey") {
    await renderJourney(app);
  } else {
    await renderOverview(app);
  }
  syncNav(pathPart);
  if (!opts.preserveScroll) window.scrollTo(0, 0);
}

function syncNav(pathPart: string): void {
  for (const a of document.querySelectorAll<HTMLAnchorElement>(".nav a")) {
    const active =
      (a.dataset.route === "profile" && pathPart === "/profile") ||
      (a.dataset.route === "viz" && pathPart === "/viz") ||
      (a.dataset.route === "journey" && pathPart === "/journey") ||
      (a.dataset.route === "repos" &&
        pathPart !== "/profile" &&
        pathPart !== "/viz" &&
        pathPart !== "/journey");
    a.classList.toggle("active", active);
  }
}

// ── Periodic refresh ────────────────────────────────────────────────────────
// Re-scan the logs every few minutes so a long-lived tab picks up new activity
// without manual reload. Drops the cached scans and re-renders the current view
// in place (scroll preserved); no push/watch, just a quiet interval.
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
let refreshing = false;

async function refreshInPlace(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  invalidateMetrics();
  invalidateJourney();
  try {
    await route({ preserveScroll: true });
  } finally {
    refreshing = false;
  }
}

setInterval(() => void refreshInPlace(), REFRESH_INTERVAL_MS);

document.getElementById("settings-btn")!.addEventListener("click", () => {
  openSettings(() => {
    if (location.hash.replace(/^#/, "").startsWith("/repo")) location.hash = "#/";
    else route();
  });
});

window.addEventListener("hashchange", () => route());
route();
