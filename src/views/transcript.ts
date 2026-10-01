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
 * Counts describe the fetched events, not just the rendered slice; `update`
 * recounts when a live transcript gains events.
 */
export function kindChips(
  events: TimelineEvent[],
  container: HTMLElement,
): { el: HTMLElement; update(events: TimelineEvent[]): void } {
  const labels = (evs: TimelineEvent[]): Array<[string, string]> => {
    let user = 0;
    let tools = 0;
    for (const ev of evs) {
      if (ev.kind === "user") user++;
      else if (ev.kind === "tool_use" || ev.kind === "tool_result") tools++;
    }
    return [
      ["", `All (${evs.length})`],
      ["filter-prompts", `Prompts only (${user})`],
      ["filter-no-tools", `Hide tools (${evs.length - tools})`],
    ];
  };

  const FILTERS = ["filter-prompts", "filter-no-tools"];
  const chips = el("div", { class: "ev-chips" });
  const buttons = new Map<string, HTMLElement>();
  for (const [filter, label] of labels(events)) {
    const btn = el(
      "button",
      {
        class: filter === "" ? "ev-chip active" : "ev-chip",
        "data-filter": filter,
        onclick: () => {
          for (const f of FILTERS) container.classList.toggle(f, f === filter);
          for (const [f, b] of buttons) b.classList.toggle("active", f === filter);
        },
      },
      label,
    );
    buttons.set(filter, btn);
    chips.append(btn);
  }
  return {
    el: chips,
    update(next) {
      for (const [filter, label] of labels(next)) {
        const btn = buttons.get(filter);
        if (btn) btn.textContent = label;
      }
    },
  };
}

/** Label for a "show more" pause with `remaining` rows unrendered. */
export function moreLabel(remaining: number): string {
  const nextN = Math.min(BATCH_SIZE, remaining);
  return `Show ${nextN} more events${remaining > nextN ? ` (${remaining} not yet rendered)` : ""}`;
}

/** Handle on a filled transcript, for folding a re-fetched payload into it. */
export interface TranscriptHandle {
  /**
   * `next` is a re-fetch of the same transcript after its file grew. When it
   * extends what is on screen (see {@link extendsTranscript}) the new events
   * are folded in at the tail — rows already rendered, the chosen filter and
   * the reader's scroll are untouched — and this returns true. Otherwise
   * nothing changes and it returns false: the caller must rebuild.
   */
  grow(next: Session): boolean;
}

type EventSummary = Pick<TimelineEvent, "kind" | "ts" | "text">;

/**
 * Whether `next` is `prev` plus events at the end. Transcripts are append-only,
 * so the first and last events the reader already has must reappear unchanged
 * at the same positions; anything else (a rewritten or replaced file, a shrink)
 * is not an extension and has to be rebuilt. An empty `prev` never extends:
 * what is on screen is a hint, not rows to append to.
 */
export function extendsTranscript(prev: { events: EventSummary[] }, next: { events: EventSummary[] }): boolean {
  const a = prev.events;
  const b = next.events;
  if (a.length === 0 || b.length < a.length) return false;
  const same = (i: number) => a[i].kind === b[i].kind && a[i].ts === b[i].ts && a[i].text === b[i].text;
  return same(0) && same(a.length - 1);
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
export function appendTranscriptBody(transcript: HTMLElement, sess: Session): TranscriptHandle {
  let current = sess;
  let notice = truncationNotice(sess);
  if (notice) transcript.append(notice);
  const chips = kindChips(sess.events, transcript);
  transcript.append(chips.el);

  const rows = el("div", { class: "ev-rows" });
  const more = el("button", { class: "ev-more", hidden: true });
  let resume: (() => void) | null = null;
  more.addEventListener("click", () => {
    more.hidden = true;
    resume?.();
  });
  transcript.append(rows, more);
  const slices = renderInSlices({
    total: sess.events.length,
    alive: () => rows.isConnected,
    renderSlice: (start, end) => {
      for (let i = start; i < end; i++) rows.append(eventRow(current.events[i]));
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

  return {
    grow(next) {
      if (!extendsTranscript(current, next)) return false;
      current = next;
      const fresh = truncationNotice(next);
      if (fresh) {
        // The cap may only have been reached now — state it honestly either way.
        if (notice) {
          notice.textContent = fresh.textContent;
        } else {
          transcript.insertBefore(fresh, transcript.firstChild);
          notice = fresh;
        }
      }
      chips.update(next.events);
      slices.extend(next.events.length);
      return true;
    },
  };
}
