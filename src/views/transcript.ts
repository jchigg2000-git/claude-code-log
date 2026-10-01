import { el } from "../dom.ts";
import { renderInSlices, BATCH_SIZE } from "../slices.ts";
import type { Session, TimelineEvent } from "../types.ts";

/**
 * Transcript rendering shared by the inline repo-page transcript
 * (repoDetail.ts) and the standalone session view (session.ts). Kept free of
 * config/API imports so it loads under plain node for tests.
 */

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
 * Fill an attached, non-empty transcript container: truncation notice, kind
 * chips, then the event rows in slices (slices.ts) so a huge session never
 * freezes the tab. The button between batches is the only way to continue —
 * deliberately no IntersectionObserver. `transcript` must already be in the
 * document: the slice loop stops as soon as its row container is detached
 * (a hash change replaced the page), and a detached one reads as already gone.
 * Shared by the inline repo-page transcript and the standalone session view.
 */
export function appendTranscriptBody(transcript: HTMLElement, sess: Session): void {
  const notice = truncationNotice(sess);
  if (notice) transcript.append(notice);
  transcript.append(kindChips(sess.events, transcript));

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
    alive: () => rows.isConnected,
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
