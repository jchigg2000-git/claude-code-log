/**
 * Pure hash-URL builders shared by the router and the views that link into
 * it. Kept DOM-free so node's test runner can exercise them directly.
 */

/**
 * Hash for a repo page. `sessionId` opens that transcript inline — the hash
 * is the single source of truth for which session is open, so opening and
 * closing are navigation: Back closes the transcript, and the URL is
 * shareable.
 */
export function repoHash(repoPath: string, name: string, sessionId?: string): string {
  const params = new URLSearchParams({ path: repoPath, name });
  if (sessionId) params.set("session", sessionId);
  return `#/repo?${params.toString()}`;
}

/**
 * Where a #/session view's back link points, and what it says. `back` names
 * the origin view (words.ts and search.ts tag their links); absent/unknown
 * falls back to search — with `q` restored when the link carries one — so
 * pre-`back` deep links keep working. The label states the true destination:
 * "results" only when there is a query to return to.
 */
export function sessionBackLink(back: string | null, q: string | null): { href: string; label: string } {
  if (back === "words") return { href: "#/words", label: "← Back to Words" };
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
    const hash = u.split("#")[1] ?? "";
    const [pathPart, queryPart] = hash.split("?");
    if (pathPart !== "/repo") return null;
    const params = new URLSearchParams(queryPart ?? "");
    return `${params.get("path")}::${params.get("name")}`;
  };
  const a = repoKey(oldURL);
  return a !== null && a === repoKey(newURL);
}
