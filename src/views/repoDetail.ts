import { fetchRepo, fetchSession } from "../api.ts";
import { loadConfig } from "../config.ts";
import { el, clear, relativeTime, renderMarkdown, errorBox } from "../dom.ts";
import { repoHash } from "../routes.ts";
import { renderInSlices, BATCH_SIZE } from "../slices.ts";
import type { RepoDetail, Session, SpecDoc, SessionMeta, TimelineEvent } from "../types.ts";

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

const MB = 1024 * 1024;

/**
 * Explicit truncation banner for a capped `/api/session` payload — repo
 * convention: honest degraded states, never silently dropped events. Returns
 * null when the payload is complete. When the byte cap bit, the file's true
 * event total is unknown, so the count is stated as a lower bound (`N+`).
 */
export function truncationNotice(sess: Session): HTMLElement | null {
  if (!sess.truncated) return null;
  const byteCapped = sess.readBytes < sess.sizeBytes;
  const mb = (sess.sizeBytes / MB).toFixed(1);
  const head = `Transcript truncated: showing ${sess.events.length} of ${sess.totalEvents}${byteCapped ? "+" : ""} events`;
  const tail = byteCapped
    ? ` — only the first ${Math.round(sess.readBytes / MB)} MB of this ${mb} MB file were read.`
    : ` — file is ${mb} MB.`;
  return el("p", { class: "truncation-note" }, head + tail);
}

/**
 * Event-kind filter chips for a transcript container — the words.ts chip
 * idiom, but CSS-state-based: each chip toggles a `filter-*` class on
 * `container` and rules in style.css hide non-matching `.ev-*` rows, so
 * already-rendered DOM is never rebuilt on a filter change (words re-renders
 * its short list; a transcript holds thousands of rows). Hidden rows still
 * cost DOM nodes — the progressive renderer is what keeps that affordable.
 * Counts describe the fetched events, not just the rendered slice.
 */
export function kindChips(events: TimelineEvent[], container: HTMLElement): HTMLElement {
  let user = 0;
  let tools = 0;
  for (const ev of events) {
    if (ev.kind === "user") user++;
    else if (ev.kind === "tool_use" || ev.kind === "tool_result") tools++;
  }

  const FILTERS = ["filter-prompts", "filter-no-tools"];
  const chips = el("div", { class: "ev-chips" });
  const chip = (filter: string, label: string) =>
    el(
      "button",
      {
        class: filter === "" ? "ev-chip active" : "ev-chip",
        "data-filter": filter,
        onclick: () => {
          for (const f of FILTERS) container.classList.toggle(f, f === filter);
          for (const b of chips.querySelectorAll("button")) {
            b.classList.toggle("active", b.dataset.filter === filter);
          }
        },
      },
      label,
    );

  chips.append(
    chip("", `All (${events.length})`),
    chip("filter-prompts", `Prompts only (${user})`),
    chip("filter-no-tools", `Hide tools (${events.length - tools})`),
  );
  return chips;
}

/** Label for a "show more" pause with `remaining` rows unrendered. */
export function moreLabel(remaining: number): string {
  const nextN = Math.min(BATCH_SIZE, remaining);
  return `Show ${nextN} more events${remaining > nextN ? ` (${remaining} not yet rendered)` : ""}`;
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
    } else {
      const notice = truncationNotice(sess);
      if (notice) transcript.append(notice);
      transcript.append(kindChips(sess.events, transcript));

      // Progressive body: rows land in slices (slices.ts) so a huge session
      // never freezes the tab; the button between batches is the only way to
      // continue — deliberately no IntersectionObserver.
      const rows = el("div", { class: "ev-rows" });
      const more = el("button", { class: "ev-more", hidden: true });
      let resume: (() => void) | null = null;
      more.addEventListener("click", () => {
        more.hidden = true;
        resume?.();
      });
      transcript.append(rows, more);
      renderInSlices({
        total: sess.events.length,
        alive: () => rows.isConnected, // stop appending into a container a hash change detached
        renderSlice: (start, end) => {
          for (let i = start; i < end; i++) rows.append(eventRow(sess.events[i]));
        },
        onPause: (remaining, r) => {
          resume = r;
          more.textContent = moreLabel(remaining);
          more.hidden = false;
        },
        onDone: () => {
          more.hidden = true;
        },
      });
    }
  } catch (err) {
    clear(transcript);
    transcript.append(el("p", { class: "error" }, err instanceof Error ? err.message : "Failed to load transcript"));
  }
  // A hash change may have replaced the page while the fetch was in flight;
  // never scroll a detached row. (Rows fill in below on later frames — the
  // row's top edge doesn't depend on them.)
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
