/**
 * Pure hash-URL builders shared by the router and the views that link into
 * it. Kept DOM-free so node's test runner can exercise them directly.
 */

/**
 * Hash for a repo page. `sessionId` opens that transcript inline — the hash
 * is the single source of truth for which session is open, so opening and
 * closing are navigation: Back closes the transcript, and the URL is
 * shareable. (navIntent.ts decides which toggles push vs rewrite the current
 * entry, so browsing many sessions costs one history entry, not two each.)
 */
export function repoHash(repoPath: string, name: string, sessionId?: string): string {
  const params = new URLSearchParams({ path: repoPath, name });
  if (sessionId) params.set("session", sessionId);
  return `#/repo?${params.toString()}`;
}

/**
 * Hash for the standalone #/session transcript view. `label` is the display
 * path the header shows, `back` names the origin view (see
 * {@link sessionBackLink}), and `q` carries the search query so results can be
 * restored. Params are emitted in the order the views' hand-built links always
 * used — file, q, label, back — so retrofitting them onto this helper changes
 * no byte of any href. An absent or empty option is omitted outright rather
 * than serialized as an empty param.
 */
export function sessionHash(
  file: string,
  opts: { label?: string; back?: string; q?: string } = {},
): string {
  const params = new URLSearchParams({ file });
  if (opts.q) params.set("q", opts.q);
  if (opts.label) params.set("label", opts.label);
  if (opts.back) params.set("back", opts.back);
  return `#/session?${params.toString()}`;
}

/**
 * Where a #/session view's back link points, and what it says. `back` names
 * the origin view (words.ts, search.ts and dataViz.ts tag their links);
 * absent/unknown falls back to search — with `q` restored when the link
 * carries one — so pre-`back` deep links keep working. The label states the
 * true destination: "results" only when there is a query to return to.
 */
export function sessionBackLink(back: string | null, q: string | null): { href: string; label: string } {
  if (back === "words") return { href: "#/words", label: "← Back to Words" };
  if (back === "viz") return { href: "#/viz", label: "← Back to Data Viz" };
  if (q) return { href: `#/search?q=${encodeURIComponent(q)}`, label: "← Back to results" };
  return { href: "#/search", label: "← Back to search" };
}

/**
 * True when two full URLs are hashes of the same repo page (only the open
 * session differs, or one has none). The hashchange handler uses this to keep
 * scroll position across a transcript toggle instead of jumping to page top.
 */
export function sameRepoPage(oldURL: string, newURL: string): boolean {
  const repoKey = (u: string): string | null => {
    const params = repoParams(u);
    return params && `${params.get("path")}::${params.get("name")}`;
  };
  const a = repoKey(oldURL);
  return a !== null && a === repoKey(newURL);
}

/** Parse a full URL's hash as a repo-page hash → its params, or null. */
function repoParams(u: string): URLSearchParams | null {
  const hash = u.split("#")[1] ?? "";
  const [pathPart, queryPart] = hash.split("?");
  if (pathPart !== "/repo") return null;
  return new URLSearchParams(queryPart ?? "");
}

/**
 * True when a hash navigation just landed on the repo page's PUSHED session
 * entry: a same-repo transition from the plain page to an open transcript.
 * That is the only transition after which the history entry directly beneath
 * the current one is provably this repo's plain page — the precondition for
 * closing via `history.back()` (see {@link sessionToggleNav}). The page's own
 * open-push and a Forward re-open both qualify; Back to the plain page,
 * arrivals from other views, and deep links all clear it.
 */
export function sessionEntryAfterNav(oldURL: string, newURL: string): boolean {
  return (
    sameRepoPage(oldURL, newURL) &&
    repoParams(oldURL)?.get("session") == null &&
    repoParams(newURL)?.get("session") != null
  );
}

export type SessionToggleNav = "push" | "replace" | "back";

/**
 * How a session-toggle click navigates, given whether it opens (vs closes) a
 * transcript and whether the top history entry is the session entry this page
 * pushed for a previous open (`sessionEntryLive` — the view maintains it from
 * {@link sessionEntryAfterNav}). The resulting stack discipline is at most ONE
 * session entry per repo visit:
 *
 * - open from the plain page → "push": Back closes the transcript.
 * - open while the session entry is live (switching) → "replace": browsing N
 *   sessions costs one entry, not N; Back still closes, and a second Back
 *   leaves the repo.
 * - close while the entry is live → "back": pop the entry the open pushed, so
 *   the stack never accumulates duplicate plain-repo entries, no Back press is
 *   left visually dead, and Forward genuinely re-opens the transcript.
 * - close otherwise (deep-link arrival, cross-page return) → "replace":
 *   nothing beneath is provably ours, so mutate the entry in place rather than
 *   stepping `history.back()` toward an unknown one.
 */
export function sessionToggleNav(opening: boolean, sessionEntryLive: boolean): SessionToggleNav {
  if (opening) return sessionEntryLive ? "replace" : "push";
  return sessionEntryLive ? "back" : "replace";
}
