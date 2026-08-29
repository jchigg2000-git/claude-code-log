import { fetchRepo, fetchSession } from "../api.ts";
import { loadConfig } from "../config.ts";
import { el, clear, relativeTime, renderMarkdown, errorBox } from "../dom.ts";
import { repoHash } from "../routes.ts";
import type { RepoDetail, SpecDoc, SessionMeta, TimelineEvent } from "../types.ts";

function specBlock(s: SpecDoc): HTMLElement {
  const body =
    s.kind === "markdown"
      ? renderMarkdown(s.content)
      : el("pre", { class: "code" }, el("code", {}, s.content));
  return el(
    "details",
    { class: "spec", open: s.name === "CLAUDE.md" },
    el("summary", {}, s.name),
    body,
  );
}

export function eventRow(ev: TimelineEvent): HTMLElement {
  const label = ev.tool ? `${ev.kind} · ${ev.tool}` : ev.kind;
  const text = ev.text.length > 4000 ? ev.text.slice(0, 4000) + "\n…(truncated)" : ev.text;
  return el(
    "div",
    { class: `ev ev-${ev.kind}` },
    el(
      "div",
      { class: "ev-head" },
      el("span", { class: "ev-kind" }, label),
      el("span", { class: "ev-ts" }, ev.ts ? new Date(ev.ts).toLocaleString() : ""),
    ),
    el("pre", { class: "ev-body" }, text),
  );
}

/**
 * One session row. Clicking navigates to `href` — the repo hash with
 * `session=<id>` toggled on (or, for the active row, off) — and the route
 * re-render does the actual opening: the hash is the single source of truth
 * for which transcript is open, so Back closes it and the URL is shareable.
 */
function sessionRow(s: SessionMeta, active: boolean, href: string): HTMLElement {
  const wrap = el("div", { class: active ? "session active" : "session" });
  const header = el(
    "button",
    {
      class: "session-head",
      onclick: () => {
        location.hash = href;
      },
    },
    el(
      "span",
      { class: "session-line" },
      el("span", { class: "session-id" }, s.id),
      el(
        "span",
        { class: "session-meta" },
        `${s.messageCount >= 0 ? s.messageCount + " msgs · " : ""}${relativeTime(s.mtime)}`,
      ),
    ),
  );
  if (s.preview) header.append(el("span", { class: "session-preview" }, s.preview));
  wrap.append(header);
  return wrap;
}

/**
 * Fetch + render one transcript into its container, then bring the open row
 * into view: the router has already scrolled to page top by the time the
 * fetch lands, and both a deep link and an in-page click should land the
 * reader on the transcript, not wherever the page happens to sit.
 */
async function loadTranscript(transcript: HTMLElement, row: HTMLElement, s: SessionMeta): Promise<void> {
  transcript.append(el("p", { class: "loading" }, "Loading transcript…"));
  try {
    const sess = await fetchSession(loadConfig(), s.file);
    clear(transcript);
    if (sess.events.length === 0) {
      transcript.append(el("p", { class: "hint" }, "No readable events in this transcript."));
    }
    for (const ev of sess.events) transcript.append(eventRow(ev));
  } catch (err) {
    clear(transcript);
    transcript.append(el("p", { class: "error" }, err instanceof Error ? err.message : "Failed to load transcript"));
  }
  // A hash change may have replaced the page while the fetch was in flight;
  // never scroll a detached row.
  if (row.isConnected) row.scrollIntoView({ block: "start" });
}

export async function renderRepoDetail(host: HTMLElement, repoPath: string, name: string, sessionId = ""): Promise<void> {
  clear(host);
  host.append(el("p", { class: "loading" }, `Loading ${name}…`));

  let data: RepoDetail;
  try {
    data = await fetchRepo(loadConfig(), repoPath, name);
  } catch (err) {
    clear(host);
    host.append(errorBox("Could not load repo. ", err, el("p", {}, el("a", { href: "#/" }, "← Back to overview"))));
    return;
  }

  clear(host);
  host.append(
    el("a", { class: "back", href: "#/" }, "← All repos"),
    el(
      "div",
      { class: "page-head" },
      el("h1", {}, data.name),
      el("code", { class: "path" }, data.path),
      el(
        "div",
        { class: "chips" },
        ...(data.stack.length ? data.stack.map((s) => el("span", { class: "chip" }, s)) : [el("span", { class: "chip muted" }, "stack unknown")]),
      ),
      el(
        "p",
        { class: "sub" },
        `${data.sessionCount} sessions · ${data.messageCount || "—"} messages · last activity ${relativeTime(data.lastActivity)}`,
      ),
    ),
  );

  const cols = el("div", { class: "detail-cols" });

  const specCol = el("section", { class: "spec-col" }, el("h2", {}, "Project specs"));
  if (data.specs.length === 0) {
    specCol.append(el("p", { class: "hint" }, "No CLAUDE.md, README, or package manifest found."));
  } else {
    for (const s of data.specs) specCol.append(specBlock(s));
  }

  const sessCol = el("section", { class: "sess-col" }, el("h2", {}, `Sessions (${data.sessions.length})`));

  if (data.sessions.length === 0) {
    sessCol.append(el("p", { class: "hint" }, "No Claude Code sessions recorded for this repo."));
  } else {
    let found = false;
    for (const s of data.sessions) {
      const active = s.id === sessionId;
      // Toggle target: an inactive row's link opens it; the active row's link
      // is the plain repo URL, so clicking again closes the transcript.
      const row = sessionRow(s, active, repoHash(repoPath, name, active ? undefined : s.id));
      sessCol.append(row);
      if (active) {
        found = true;
        // The transcript lives inside the active row, so it opens in place —
        // right under the session that was clicked, not below the whole list.
        const transcript = el("div", { class: "transcript" });
        row.append(transcript);
        void loadTranscript(transcript, row, s);
      }
    }
    if (sessionId && !found) {
      sessCol.append(el("p", { class: "hint" }, `No session ${sessionId} in this repo's logs — it may have been pruned.`));
    }
  }

  cols.append(specCol, sessCol);
  host.append(cols);
}
