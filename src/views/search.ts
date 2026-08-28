import { fetchSearch } from "../api.ts";
import { loadConfig } from "../config.ts";
import { el, clear, relativeTime, errorBox } from "../dom.ts";
import type { SearchMatch } from "../types.ts";

const MIN_QUERY = 2;

/** Split `text` on case-insensitive matches of `needle`, wrapping each in <mark>. */
function highlight(text: string, needle: string): HTMLElement {
  const span = el("span", { class: "snippet" });
  if (!needle) {
    span.append(text);
    return span;
  }
  const lower = text.toLowerCase();
  const nl = needle.toLowerCase();
  let i = 0;
  while (i <= text.length) {
    const idx = lower.indexOf(nl, i);
    if (idx < 0) {
      span.append(text.slice(i));
      break;
    }
    if (idx > i) span.append(text.slice(i, idx));
    span.append(el("mark", {}, text.slice(idx, idx + needle.length)));
    i = idx + needle.length;
  }
  return span;
}

function resultRow(m: SearchMatch, query: string): HTMLElement {
  const label = m.tool ? `${m.kind} · ${m.tool}` : m.kind;
  const href = `#/session?${new URLSearchParams({
    file: m.file,
    q: query,
    label: m.approxPath,
  }).toString()}`;
  const matches = `${m.matchCount} match${m.matchCount === 1 ? "" : "es"}`;
  return el(
    "a",
    { class: "result", href },
    el(
      "div",
      { class: "result-head" },
      el("code", { class: "result-repo" }, m.approxPath),
      el("span", { class: "result-meta" }, `${matches} · ${relativeTime(m.mtime)}`),
    ),
    el("div", { class: "result-kind" }, `${label} · ${m.sessionId}`),
    highlight(m.snippet, query),
  );
}

export async function renderSearch(host: HTMLElement, query: string): Promise<void> {
  const q = query.trim();
  clear(host);
  host.append(
    el(
      "div",
      { class: "page-head" },
      el("h1", {}, "Search"),
      el("p", { class: "sub" }, q ? `Results for “${q}”` : "Full-text search across every transcript"),
    ),
  );

  if (q.length < MIN_QUERY) {
    host.append(
      el("p", { class: "hint" }, "Type at least 2 characters in the search box to grep your Claude Code history."),
    );
    return;
  }

  const status = el("p", { class: "loading" }, `Searching transcripts for “${q}”…`);
  host.append(status);

  try {
    const data = await fetchSearch(loadConfig(), q);
    status.remove();

    if (data.results.length === 0) {
      host.append(
        el(
          "div",
          { class: "empty" },
          `No transcripts mention “${q}”. Searched ${data.sessionsSearched} session${
            data.sessionsSearched === 1 ? "" : "s"
          }.`,
        ),
      );
      return;
    }

    const shown = data.results.length;
    const summary = data.truncated
      ? `Showing ${shown} of ${data.matchedSessions} matching sessions (${data.sessionsSearched} searched).`
      : `${data.matchedSessions} matching session${data.matchedSessions === 1 ? "" : "s"} (${data.sessionsSearched} searched).`;
    host.append(el("p", { class: "sub search-summary" }, summary));

    const list = el("div", { class: "results" });
    for (const m of data.results) list.append(resultRow(m, q));
    host.append(list);
  } catch (err) {
    status.remove();
    host.append(errorBox("Search failed. ", err, "Check the log path in Settings (⚙)."));
  }
}
