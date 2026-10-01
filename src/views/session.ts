import { fetchSession } from "../api.ts";
import { loadConfig } from "../config.ts";
import { el, clear, errorBox } from "../dom.ts";
import { appendTranscriptBody, type TranscriptHandle } from "./transcript.ts";
import type { RenderCtx } from "../mount.ts";
import type { Session } from "../types.ts";

/**
 * The page currently on screen, or null when none is known to be. Set only once
 * a render is truly attached (see `afterAttach` below) and cleared at the start
 * of every navigation, so a superseded or failed render can never leave it
 * vouching for a page that isn't there.
 */
interface ShownSession {
  /** Which transcript and back link this page is for. */
  identity: string;
  /** Which version of that file it was built from (changes when the file grows). */
  version: string;
  handle: TranscriptHandle | null;
  /** The "id · N events" line, rewritten when events are folded in. */
  sub: HTMLElement;
  id: string;
}
let shown: ShownSession | null = null;

function subline(id: string, sess: Session): string {
  const count = sess.truncated
    ? `${sess.events.length} of ${sess.totalEvents}${sess.readBytes < sess.sizeBytes ? "+" : ""} events`
    : `${sess.events.length} events`;
  return `${id} · ${count}`;
}

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
  ctx: RenderCtx,
): Promise<void> {
  if (!ctx.refreshing) shown = null;
  clear(host);
  host.append(el("a", { class: "back", href: backHref }, backLabel));
  host.append(el("p", { class: "loading" }, "Loading transcript…"));

  let sess: Session;
  try {
    sess = await fetchSession(loadConfig(), file);
  } catch (err) {
    if (!ctx.isCurrent()) return;
    clear(host);
    host.append(
      el("a", { class: "back", href: backHref }, backLabel),
      errorBox("Could not load transcript. ", err),
    );
    return;
  }

  if (!ctx.isCurrent()) return;

  // A transcript is append-only. Unchanged size and event count mean the page
  // on screen — slices expanded, filter chosen, scroll depth — is already right;
  // rebuilding it would reset all of that (and shorten the document under a
  // reader who had paged deep into a long session). A file that merely GREW has
  // its new events folded in at the tail, so a live session can be read while
  // it is written. Only a file that was rewritten falls through to a rebuild.
  const identity = [file, label, backHref, backLabel].join("\0");
  const version = [sess.sizeBytes, sess.readBytes, sess.totalEvents].join("\0");
  if (ctx.refreshing && shown && shown.identity === identity) {
    if (shown.version === version) {
      ctx.keepPage();
      return;
    }
    if (shown.handle?.grow(sess)) {
      shown.version = version;
      shown.sub.textContent = subline(shown.id, sess);
      ctx.keepPage();
      return;
    }
  }

  const events = sess.events;
  const id = file.replace(/\.jsonl$/, "").split("/").pop() ?? file;
  const sub = el("p", { class: "sub" }, subline(id, sess));
  clear(host);
  host.append(
    el("a", { class: "back", href: backHref }, backLabel),
    el(
      "div",
      { class: "page-head" },
      el("h1", {}, "Session transcript"),
      el("code", { class: "path" }, label || file),
      sub,
    ),
  );

  const transcript = el("div", { class: "transcript" });
  host.append(transcript);
  // The slice loop stops the moment its rows are detached, so the body has to
  // be filled once `transcript` is in the page — not while a refresh still holds
  // it in a detached stage.
  ctx.afterAttach(() => {
    let handle: TranscriptHandle | null = null;
    if (events.length === 0) {
      transcript.append(el("p", { class: "hint" }, "No readable events in this transcript."));
    } else {
      handle = appendTranscriptBody(transcript, sess);
    }
    shown = { identity, version, handle, sub, id };
  });
}
