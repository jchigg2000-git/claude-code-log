import "./style.css";
import { renderOverview } from "./views/overview.ts";
import { renderRepoDetail } from "./views/repoDetail.ts";
import { renderProfile } from "./views/profile.ts";
import { renderDataViz } from "./views/dataViz.ts";
import { renderJourney } from "./views/journey.ts";
import { renderSearch } from "./views/search.ts";
import { renderSession } from "./views/session.ts";
import { openSettings } from "./views/settings.ts";
import { invalidateMetrics, invalidateJourney } from "./api.ts";

const app = document.getElementById("app")!;
const searchBox = document.getElementById("search-box") as HTMLInputElement;

async function route(opts: { preserveScroll?: boolean } = {}): Promise<void> {
  const hash = location.hash.replace(/^#/, "") || "/";
  const [pathPart, queryPart] = hash.split("?");
  const params = new URLSearchParams(queryPart ?? "");

  if (pathPart === "/repo") {
    const repoPath = params.get("path") ?? "";
    const name = params.get("name") ?? repoPath;
    await renderRepoDetail(app, repoPath, name);
  } else if (pathPart === "/search") {
    const q = params.get("q") ?? "";
    if (document.activeElement !== searchBox) searchBox.value = q;
    await renderSearch(app, q);
  } else if (pathPart === "/session") {
    const file = params.get("file") ?? "";
    const label = params.get("label") ?? "";
    const q = params.get("q") ?? "";
    const backHref = q ? `#/search?q=${encodeURIComponent(q)}` : "#/search";
    await renderSession(app, file, label, backHref);
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
        pathPart !== "/journey" &&
        pathPart !== "/search" &&
        pathPart !== "/session");
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

// ── Top-bar search ──────────────────────────────────────────────────────────
// Debounced live search. While already on the results page we replaceState +
// re-render so keystrokes don't stack history entries; entering search from
// another view pushes a single entry so Back returns where the user came from.
let searchDebounce: ReturnType<typeof setTimeout> | undefined;

function goSearch(value: string, replace: boolean): void {
  const target = value ? `#/search?q=${encodeURIComponent(value)}` : "#/search";
  if (replace && location.hash.startsWith("#/search")) {
    history.replaceState(null, "", target);
    void route({ preserveScroll: true });
  } else if (location.hash === target) {
    void route({ preserveScroll: true });
  } else {
    location.hash = target;
  }
}

searchBox.addEventListener("input", () => {
  clearTimeout(searchDebounce);
  const value = searchBox.value.trim();
  searchDebounce = setTimeout(() => goSearch(value, true), 300);
});

searchBox.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    clearTimeout(searchDebounce);
    goSearch(searchBox.value.trim(), false);
  } else if (e.key === "Escape") {
    searchBox.blur();
  }
});

document.getElementById("settings-btn")!.addEventListener("click", () => {
  openSettings(() => {
    if (location.hash.replace(/^#/, "").startsWith("/repo")) location.hash = "#/";
    else route();
  });
});

window.addEventListener("hashchange", () => route());
route();
