import { fetchSession } from "../api.ts";
import { loadConfig } from "../config.ts";
import { el, clear } from "../dom.ts";
import { eventRow } from "./repoDetail.ts";

/**
 * Standalone transcript view for a single session, reachable by deep link
 * (`#/session?file=…`). Search results click through to here so a matching
 * session opens directly, regardless of whether it maps to a crawled repo.
 */
export async function renderSession(
  host: HTMLElement,
  file: string,
  label: string,
  backHref: string,
): Promise<void> {
  clear(host);
  host.append(el("a", { class: "back", href: backHref }, "← Back to results"));
  host.append(el("p", { class: "loading" }, "Loading transcript…"));

  let events;
  try {
    events = (await fetchSession(loadConfig(), file)).events;
  } catch (err) {
    clear(host);
    host.append(
      el("a", { class: "back", href: backHref }, "← Back to results"),
      el(
        "div",
        { class: "error" },
        el("strong", {}, "Could not load transcript. "),
        err instanceof Error ? err.message : "Unknown error",
      ),
    );
    return;
  }

  const id = file.replace(/\.jsonl$/, "").split("/").pop() ?? file;
  clear(host);
  host.append(
    el("a", { class: "back", href: backHref }, "← Back to results"),
    el(
      "div",
      { class: "page-head" },
      el("h1", {}, "Session transcript"),
      el("code", { class: "path" }, label || file),
      el("p", { class: "sub" }, `${id} · ${events.length} events`),
    ),
  );

  const transcript = el("div", { class: "transcript" });
  if (events.length === 0) {
    transcript.append(el("p", { class: "hint" }, "No readable events in this transcript."));
  } else {
    for (const ev of events) transcript.append(eventRow(ev));
  }
  host.append(transcript);
}
