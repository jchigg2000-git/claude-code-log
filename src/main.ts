import "./style.css";
import { renderOverview } from "./views/overview.ts";
import { renderRepoDetail, noteHashNav } from "./views/repoDetail.ts";
import { renderProfile } from "./views/profile.ts";
import { renderDataViz } from "./views/dataViz.ts";
import { renderJourney } from "./views/journey.ts";
import { renderSearch } from "./views/search.ts";
import { renderSession } from "./views/session.ts";
import { renderWords } from "./views/words.ts";
import { openSettings } from "./views/settings.ts";
import { invalidateMetrics, invalidateJourney, invalidateWords, invalidateRepo } from "./api.ts";
import { sessionBackLink, sameRepoPage } from "./routes.ts";

const app = document.getElementById("app")!;
const searchBox = document.getElementById("search-box") as HTMLInputElement;

async function route(opts: { preserveScroll?: boolean } = {}): Promise<void> {
  const hash = location.hash.replace(/^#/, "") || "/";
  const [pathPart, queryPart] = hash.split("?");
  const params = new URLSearchParams(queryPart ?? "");

  if (pathPart === "/repo") {
    const repoPath = params.get("path") ?? "";
    const name = params.get("name") ?? repoPath;
    // `session` is the open-transcript state: present ⇒ that session renders
    // inline on the repo page, absent ⇒ plain session list. Living in the
    // hash makes open/close real navigation (Back closes) and shareable.
    await renderRepoDetail(app, repoPath, name, params.get("session") ?? "");
  } else if (pathPart === "/search") {
    const q = params.get("q") ?? "";
    if (document.activeElement !== searchBox) searchBox.value = q;
    await renderSearch(app, q);
  } else if (pathPart === "/session") {
    const file = params.get("file") ?? "";
    const label = params.get("label") ?? "";
    const back = sessionBackLink(params.get("back"), params.get("q"));
    await renderSession(app, file, label, back.href, back.label);
  } else if (pathPart === "/profile") {
    await renderProfile(app);
  } else if (pathPart === "/viz") {
    await renderDataViz(app);
  } else if (pathPart === "/journey") {
    await renderJourney(app);
  } else if (pathPart === "/words") {
    await renderWords(app);
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
      (a.dataset.route === "words" && pathPart === "/words") ||
      (a.dataset.route === "repos" &&
        pathPart !== "/profile" &&
        pathPart !== "/viz" &&
        pathPart !== "/journey" &&
        pathPart !== "/words" &&
        pathPart !== "/search" &&
        pathPart !== "/session");
    a.classList.toggle("active", active);
  }
  // Below the 700px breakpoint the nav is a horizontal scroll strip — slide
  // the active pill into view on navigation. Guarded on real overflow so the
  // desktop layout (where the nav never scrolls) is untouched; block:nearest
  // keeps this from ever scrolling the page itself.
  const nav = document.querySelector<HTMLElement>(".topbar .nav");
  if (nav && nav.scrollWidth > nav.clientWidth) {
    nav
      .querySelector<HTMLElement>("a.active")
      ?.scrollIntoView({ inline: "nearest", block: "nearest" });
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
  invalidateWords();
  invalidateRepo();
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

window.addEventListener("hashchange", (e) => {
  // Let the repo page re-evaluate whether the entry beneath the reader is its
  // own pushed session entry, which decides how the next close navigates
  // (routes.ts sessionToggleNav states the policy). The periodic refresh
  // re-renders without navigating, so it never lands here.
  noteHashNav(e.oldURL, e.newURL);
  // Toggling a transcript open/closed navigates between two hashes of the
  // same repo page; keep the scroll position so closing a session doesn't
  // jump back to the top of the list. (Opening still lands on the transcript
  // — the loaded row scrolls itself into view.)
  void route({ preserveScroll: sameRepoPage(e.oldURL, e.newURL) });
});
route();
