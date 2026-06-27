import "./style.css";
import { renderOverview } from "./views/overview.ts";
import { renderRepoDetail } from "./views/repoDetail.ts";
import { renderProfile } from "./views/profile.ts";
import { renderDataViz } from "./views/dataViz.ts";
import { renderJourney } from "./views/journey.ts";
import { openSettings } from "./views/settings.ts";
import { invalidateMetrics, invalidateJourney, subscribeToChanges } from "./api.ts";
import { loadConfig } from "./config.ts";

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

// ── Live refresh ──────────────────────────────────────────────────────────
// An SSE stream notifies us whenever the log directory changes on disk; we drop
// the cached scans and re-render the current view in place (scroll preserved).
let unsubscribeLive: () => void = () => {};
let refreshing = false;
let refreshPending = false;

async function onLogsChanged(): Promise<void> {
  if (refreshing) {
    refreshPending = true;
    return;
  }
  refreshing = true;
  invalidateMetrics();
  invalidateJourney();
  try {
    await route({ preserveScroll: true });
    flashUpdated();
  } finally {
    refreshing = false;
    if (refreshPending) {
      refreshPending = false;
      void onLogsChanged();
    }
  }
}

function startLive(): void {
  unsubscribeLive();
  unsubscribeLive = subscribeToChanges(loadConfig(), () => void onLogsChanged());
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function flashUpdated(): void {
  let toast = document.getElementById("live-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "live-toast";
    toast.textContent = "Updated with new activity";
    document.body.append(toast);
  }
  toast.classList.add("show");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast!.classList.remove("show"), 2200);
}

document.getElementById("settings-btn")!.addEventListener("click", () => {
  openSettings(() => {
    if (location.hash.replace(/^#/, "").startsWith("/repo")) location.hash = "#/";
    else route();
    // logDir may have changed — re-point the watch stream at it.
    startLive();
  });
});

window.addEventListener("hashchange", () => route());
route();
startLive();
