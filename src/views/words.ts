import { fetchWords } from "../api.ts";
import { loadConfig } from "../config.ts";
import { el, clear, relativeTime, errorBox } from "../dom.ts";
import type { WordCategory, WordEntry } from "../types.ts";

const CATEGORY_LABEL: Record<WordCategory, string> = {
  literal: "Taken literally",
  missaid: "Mis-said",
  pivot: "Overweighted",
};

type Filter = WordCategory | "all";

/** Wrap the first case-insensitive occurrence of `needle` in <mark>. */
function markFirst(text: string, needle: string): HTMLElement {
  const span = el("span", {});
  const idx = needle ? text.toLowerCase().indexOf(needle.toLowerCase()) : -1;
  if (idx < 0) {
    span.append(text);
    return span;
  }
  if (idx > 0) span.append(text.slice(0, idx));
  span.append(el("mark", {}, text.slice(idx, idx + needle.length)));
  span.append(text.slice(idx + needle.length));
  return span;
}

function quoteBlock(cls: string, label: string, body: HTMLElement | string): HTMLElement {
  return el("blockquote", { class: `wm-quote ${cls}` }, el("span", { class: "wm-quote-label" }, label), body);
}

function betweenLine(e: WordEntry): string {
  if (e.assistantTurns === 0) return "Caught before anything ran on it.";
  const turns = `${e.assistantTurns} assistant turn${e.assistantTurns === 1 ? "" : "s"}`;
  const tools = e.toolCalls > 0 ? ` · ${e.toolCalls} tool call${e.toolCalls === 1 ? "" : "s"}` : "";
  return `${turns}${tools} before the correction landed.`;
}

function entryCard(e: WordEntry): HTMLElement {
  // `back=words` tells the session view's back link to return here, not to a blank search page.
  const href = `#/session?${new URLSearchParams({ file: e.file, label: e.approxPath, back: "words" }).toString()}`;
  const card = el(
    "div",
    { class: "wm-card" },
    el(
      "div",
      { class: "wm-head" },
      el("span", { class: `wm-badge ${e.category}` }, CATEGORY_LABEL[e.category]),
      el("span", { class: `wm-conf ${e.confidence}`, title: e.confidence === "explicit" ? "The correction names the miscommunication outright." : "Pattern-guessed pairing — a leap of faith." }, e.confidence),
      el("code", { class: "result-repo" }, e.approxPath),
      el("span", { class: "wm-meta" }, e.ts ? relativeTime(e.ts) : "undated"),
    ),
    quoteBlock("wm-original", "What I said", e.original),
  );
  if (e.assistantTurns > 0 && e.firstAction) {
    card.append(el("p", { class: "wm-between" }, `${betweenLine(e)} First move: ${e.firstAction}`));
  } else {
    card.append(el("p", { class: "wm-between" }, betweenLine(e)));
  }
  card.append(
    quoteBlock("wm-correction", "The correction", markFirst(e.correction, e.matched)),
    el("div", { class: "wm-foot" }, el("a", { href }, "open the session →")),
  );
  return card;
}

export async function renderWords(host: HTMLElement): Promise<void> {
  clear(host);
  host.append(
    el(
      "div",
      { class: "page-head" },
      el("h1", {}, "Words That Mattered"),
      el(
        "p",
        { class: "sub" },
        "Moments where a phrase of yours changed the outcome — taken literally, mis-said, or a word that got overweighted. Mined from your own corrections.",
      ),
    ),
  );

  const status = el("p", { class: "loading" }, "Mining transcripts for corrections…");
  host.append(status);

  try {
    const data = await fetchWords(loadConfig());
    status.remove();

    if (data.entries.length === 0) {
      host.append(
        el(
          "div",
          { class: "empty" },
          `No phrasing incidents found across ${data.sessionsScanned} session${data.sessionsScanned === 1 ? "" : "s"}. Either the corrections corpus is clean, or the log path in Settings (⚙) is off.`,
        ),
      );
      return;
    }

    const shown = data.entries.length;
    const summary = data.truncated
      ? `Showing ${shown} of ${data.totalMatches} incidents across ${data.matchedSessions} sessions (${data.sessionsScanned} scanned).`
      : `${data.totalMatches} incident${data.totalMatches === 1 ? "" : "s"} across ${data.matchedSessions} session${data.matchedSessions === 1 ? "" : "s"} (${data.sessionsScanned} scanned).`;
    host.append(el("p", { class: "sub wm-summary" }, summary));

    const counts = new Map<WordCategory, number>();
    for (const e of data.entries) counts.set(e.category, (counts.get(e.category) ?? 0) + 1);

    const list = el("div", { class: "wm-list" });
    const chips = el("div", { class: "wm-chips" });
    let active: Filter = "all";

    const renderList = () => {
      clear(list);
      for (const e of data.entries) {
        if (active === "all" || e.category === active) list.append(entryCard(e));
      }
      for (const b of chips.querySelectorAll("button")) {
        b.classList.toggle("active", b.dataset.filter === active);
      }
    };

    const chip = (filter: Filter, label: string) =>
      el(
        "button",
        {
          class: "wm-chip",
          "data-filter": filter,
          onclick: () => {
            active = filter;
            renderList();
          },
        },
        label,
      );

    chips.append(chip("all", `All (${shown})`));
    for (const cat of ["literal", "missaid", "pivot"] as const) {
      const n = counts.get(cat) ?? 0;
      if (n > 0) chips.append(chip(cat, `${CATEGORY_LABEL[cat]} (${n})`));
    }

    host.append(chips, list);
    renderList();
  } catch (err) {
    status.remove();
    host.append(errorBox("Mining failed. ", err, "Check the log path in Settings (⚙)."));
  }
}
