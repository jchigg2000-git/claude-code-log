import { fetchRepo, fetchSession, sessionStaleKey } from "../api.ts";
import { loadConfig } from "../config.ts";
import { el, clear, relativeTime, renderMarkdown, errorBox } from "../dom.ts";
import { classifySessionRender, consumeSessionNav, recordSessionNav } from "../navIntent.ts";
import { repoHash, sessionEntryAfterNav, sessionToggleNav } from "../routes.ts";
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
 * Whether the top history entry is the session entry THIS page pushed for a
 * previous open — the precondition for closing via `history.back()`. Kept in
 * step with real navigation by {@link noteHashNav}; `sessionEntryAfterNav`
 * in routes.ts states exactly which transitions set it.
 */
let sessionEntryLive = false;

/** Router hook: every hashchange re-evaluates whether the entry beneath us is
 *  provably this page's own pushed session entry. */
export function noteHashNav(oldURL: string, newURL: string): void {
  sessionEntryLive = sessionEntryAfterNav(oldURL, newURL);
}

/**
 * Navigate a session toggle — the repo hash with `session=<id>` toggled on
 * (or off, for a close). The scroll intent is recorded first so the resulting
 * render can tell this click from the periodic refresh (navIntent.ts); the
 * history primitive comes from `sessionToggleNav` (routes.ts), which keeps the
 * stack at one session entry per repo visit.
 *
 * "push" and "back" are real navigation — the browser fires hashchange and the
 * router re-renders. "replace" fires no event, so it renders directly; that is
 * the same shape as `goSearch` in main.ts, without fabricating a HashChangeEvent
 * to fake a navigation that did not happen.
 */
function navigateSession(host: HTMLElement, repoPath: string, name: string, targetId: string): void {
  recordSessionNav(targetId);
  const href = repoHash(repoPath, name, targetId || undefined);
  const nav = sessionToggleNav(targetId !== "", sessionEntryLive);
  if (nav === "push") {
    location.hash = href;
  } else if (nav === "back") {
    history.back(); // pop the entry the open pushed — no duplicate plain entry, Forward reopens
  } else {
    history.replaceState(null, "", href);
    void renderRepoDetail(host, repoPath, name, targetId);
  }
}

/**
 * One session row. Clicking calls `navigate` — a session toggle through
 * {@link navigateSession} — and the route re-render does the actual opening:
 * the hash is the single source of truth for which transcript is open, so
 * Back closes it and the URL is shareable.
 */
function sessionRow(s: SessionMeta, active: boolean, navigate: () => void): HTMLElement {
  const wrap = el("div", { class: active ? "session active" : "session" });
  const header = el(
    "button",
    {
      class: "session-head",
      onclick: navigate,
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
 * Fetch + render one transcript into its container. `scroll` is navIntent's
 * classification of this render: a row click or a first mount (deep link,
 * reload, Forward) brings the open row into view — the router has already
 * scrolled to page top by the time the fetch lands — while a refresh
 * re-render passes false and leaves the reader exactly where they were. The
 * fetch is keyed by the scan's mtime+size (sessionStaleKey), so re-opening an
 * unchanged transcript replays the memoized payload and a grown file
 * refetches with no manual invalidation.
 */
async function loadTranscript(transcript: HTMLElement, row: HTMLElement, s: SessionMeta, scroll: boolean): Promise<void> {
  transcript.append(el("p", { class: "loading" }, "Loading transcript…"));
  try {
    const sess = await fetchSession(loadConfig(), s.file, sessionStaleKey(s));
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
    // Never let a FAILED transcript be adopted. The mount record is written
    // synchronously by the render that started this fetch, so by the time we
    // land here it points at this error box; leaving it would make every
    // later refresh re-attach the failure forever (the staleKey of an idle
    // file never changes, so nothing else would ever invalidate it). Dropping
    // it makes the next render rebuild — and fetchSession evicts a rejected
    // promise, so that rebuild is a real refetch and the error self-heals.
    if (mounted?.transcript?.el === transcript) mounted.transcript = null;
  }
  // A hash change may have replaced the page while the fetch was in flight;
  // never scroll a detached row. (Rows fill in below on later frames — the
  // row's top edge doesn't depend on them.)
  if (scroll && row.isConnected) row.scrollIntoView({ block: "start" });
}

/**
 * What the last successful render left on screen, so the next one can tell a
 * refresh from an arrival and salvage the live transcript element. `root`
 * anchors the record to the DOM — if it is no longer inside the host, another
 * view has been here since and the record is dead. One slot, module-level:
 * only one repo page is ever on screen (same shape as api.ts's repoCache).
 */
interface MountedTranscript {
  id: string;
  staleKey: string;
  el: HTMLElement;
}
let mounted: {
  repoKey: string;
  root: HTMLElement;
  transcript: MountedTranscript | null;
} | null = null;

export async function renderRepoDetail(host: HTMLElement, repoPath: string, name: string, sessionId = ""): Promise<void> {
  // Consume the one-shot intent before any await: if a click races the
  // periodic refresh, both renders run, and the click's — which started after
  // the intent was recorded — must be the one that claims it.
  const intent = consumeSessionNav();
  const repoKey = `${repoPath}::${name}`;
  const prior = mounted && mounted.repoKey === repoKey && host.contains(mounted.root) ? mounted : null;
  mounted = null;

  // Scroll decision from pre-fetch facts: what the URL asks for, why we're
  // here, and what is already on screen (navIntent.ts states the policy).
  const { scroll } = classifySessionRender({
    sessionId,
    intent,
    shownSessionId: prior?.transcript?.id ?? null,
    now: Date.now(),
  });

  // Arriving from elsewhere shows the loading state; when this repo page is
  // already up (a toggle, the periodic refresh) the old render stays visible
  // and interactive while the fetch runs — stale content beats blanking the
  // page mid-read — and the rebuild below is synchronous, so a salvaged
  // transcript is reattached before the next frame can see it detached.
  if (!prior) {
    clear(host);
    host.append(el("p", { class: "loading" }, `Loading ${name}…`));
  }

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

  let transcriptRef: MountedTranscript | null = null;
  if (data.sessions.length === 0) {
    sessCol.append(el("p", { class: "hint" }, "No Claude Code sessions recorded for this repo."));
  } else {
    let found = false;
    for (const s of data.sessions) {
      const active = s.id === sessionId;
      // Toggle target: an inactive row opens it; the active row's target is
      // the plain repo URL, so clicking again closes the transcript.
      const row = sessionRow(s, active, () => navigateSession(host, repoPath, name, active ? "" : s.id));
      sessCol.append(row);
      if (active) {
        found = true;
        const staleKey = sessionStaleKey(s);
        const keep = prior?.transcript;
        if (keep && keep.id === s.id && keep.staleKey === staleKey) {
          // Same session, file unchanged: adopt the live element wholesale.
          // Slice progress, filter state and listeners carry over, so the
          // refresh re-render never blows away what the reader is midway
          // through. (classify already ruled this render a refresh — the
          // adopted row is never scrolled to.)
          row.append(keep.el);
          transcriptRef = keep;
        } else {
          // The transcript lives inside the active row, so it opens in place
          // — right under the session that was clicked, not below the list.
          // A changed staleKey lands here too: the rebuild refetches and
          // picks up the events the file gained.
          const transcript = el("div", { class: "transcript" });
          row.append(transcript);
          transcriptRef = { id: s.id, staleKey, el: transcript };
          void loadTranscript(transcript, row, s, scroll);
        }
      }
    }
    if (sessionId && !found) {
      sessCol.append(el("p", { class: "hint" }, `No session ${sessionId} in this repo's logs — it may have been pruned.`));
    }
  }

  cols.append(specCol, sessCol);
  host.append(cols);
  mounted = { repoKey, root: cols, transcript: transcriptRef };
}
