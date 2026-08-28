import { fetchRepo, fetchSession } from "../api.ts";
import { loadConfig } from "../config.ts";
import { el, clear, relativeTime, renderMarkdown, errorBox } from "../dom.ts";
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

function sessionRow(s: SessionMeta, onOpen: (s: SessionMeta) => void): HTMLElement {
  const wrap = el("div", { class: "session" });
  const header = el(
    "button",
    {
      class: "session-head",
      onclick: () => onOpen(s),
    },
    el("span", { class: "session-id" }, s.id),
    el(
      "span",
      { class: "session-meta" },
      `${s.messageCount >= 0 ? s.messageCount + " msgs · " : ""}${relativeTime(s.mtime)}`,
    ),
  );
  wrap.append(header);
  return wrap;
}

export async function renderRepoDetail(host: HTMLElement, repoPath: string, name: string): Promise<void> {
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
  const transcript = el("div", { class: "transcript" });

  const openSession = async (s: SessionMeta) => {
    clear(transcript);
    transcript.append(el("p", { class: "loading" }, "Loading transcript…"));
    try {
      const sess = await fetchSession(loadConfig(), s.file);
      clear(transcript);
      transcript.append(el("h3", {}, `Session ${s.id}`));
      if (sess.events.length === 0) {
        transcript.append(el("p", { class: "hint" }, "No readable events in this transcript."));
      }
      for (const ev of sess.events) transcript.append(eventRow(ev));
    } catch (err) {
      clear(transcript);
      transcript.append(el("p", { class: "error" }, err instanceof Error ? err.message : "Failed to load transcript"));
    }
  };

  if (data.sessions.length === 0) {
    sessCol.append(el("p", { class: "hint" }, "No Claude Code sessions recorded for this repo."));
  } else {
    for (const s of data.sessions) sessCol.append(sessionRow(s, openSession));
  }
  sessCol.append(transcript);

  cols.append(specCol, sessCol);
  host.append(cols);
}
