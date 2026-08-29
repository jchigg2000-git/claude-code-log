import { fetchSession } from "../api.ts";
import { loadConfig } from "../config.ts";
import { el, clear, errorBox } from "../dom.ts";
import { renderInSlices } from "../slices.ts";
import { eventRow, kindChips, moreLabel, truncationNotice } from "./repoDetail.ts";
import type { Session } from "../types.ts";

/**
 * Standalone transcript view for a single session, reachable by deep link
 * (`#/session?file=…`). Search results, Words cards and Data Viz mission cards
 * click through to here so a matching session opens directly, regardless of
 * whether it maps to a crawled repo. `backHref`/`backLabel` come pre-resolved
 * from the router (sessionBackLink), so the link always states its true
 * destination.
 */
export async function renderSession(
  host: HTMLElement,
  file: string,
  label: string,
  backHref: string,
  backLabel: string,
): Promise<void> {
  clear(host);
  host.append(el("a", { class: "back", href: backHref }, backLabel));
  host.append(el("p", { class: "loading" }, "Loading transcript…"));

  let sess: Session;
  try {
    sess = await fetchSession(loadConfig(), file);
  } catch (err) {
    clear(host);
    host.append(
      el("a", { class: "back", href: backHref }, backLabel),
      errorBox("Could not load transcript. ", err),
    );
    return;
  }

  const events = sess.events;
  const id = file.replace(/\.jsonl$/, "").split("/").pop() ?? file;
  const countLabel = sess.truncated
    ? `${events.length} of ${sess.totalEvents}${sess.readBytes < sess.sizeBytes ? "+" : ""} events`
    : `${events.length} events`;
  clear(host);
  host.append(
    el("a", { class: "back", href: backHref }, backLabel),
    el(
      "div",
      { class: "page-head" },
      el("h1", {}, "Session transcript"),
      el("code", { class: "path" }, label || file),
      el("p", { class: "sub" }, `${id} · ${countLabel}`),
    ),
  );

  const transcript = el("div", { class: "transcript" });
  if (events.length === 0) {
    transcript.append(el("p", { class: "hint" }, "No readable events in this transcript."));
    host.append(transcript);
    return;
  }

  const notice = truncationNotice(sess);
  if (notice) transcript.append(notice);
  transcript.append(kindChips(events, transcript));

  // Progressive body: rows land in slices (slices.ts) so a huge session never
  // freezes the tab; the button between batches is the only way to continue —
  // deliberately no IntersectionObserver.
  const rows = el("div", { class: "ev-rows" });
  const more = el("button", { class: "ev-more", hidden: true });
  let resume: (() => void) | null = null;
  more.addEventListener("click", () => {
    more.hidden = true;
    resume?.();
  });
  transcript.append(rows, more);
  host.append(transcript);

  renderInSlices({
    total: events.length,
    alive: () => rows.isConnected, // stop appending into a container a hash change detached
    renderSlice: (start, end) => {
      for (let i = start; i < end; i++) rows.append(eventRow(events[i]));
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
