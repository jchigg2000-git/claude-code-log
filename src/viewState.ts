/**
 * DOM-only view state that has to survive a page rebuild.
 *
 * A view that rebuilds itself (the 5-minute refresh, or a transcript toggle on
 * the repo page) starts every `<details>` at its default and every filter at
 * "all". The reader who opened a README spec to read it, or picked a Words
 * category, finds the page snapped back — and a collapsed spec shortens the
 * document under them, so the browser clamps their scroll. These two helpers
 * carry that state across; both are pure of any app import so they run under
 * plain node in tests.
 */

interface DetailsLike {
  open: boolean;
  querySelector(selector: string): { textContent: string | null } | null;
}

interface Scope {
  querySelectorAll(selector: string): ArrayLike<DetailsLike>;
}

/**
 * A `<details>`'s identity across rebuilds: its summary text with any trailing
 * count dropped ("Other Claude Code activity (12)" is the same disclosure when
 * the count becomes 13).
 */
function detailsKey(d: DetailsLike): string {
  return (d.querySelector("summary")?.textContent ?? "").replace(/\s*\(\d+\)\s*$/, "").trim();
}

/**
 * Copy each `<details>` open/closed state from the page being replaced (`from`)
 * onto its counterpart in the page replacing it (`to`). Counterparts are matched
 * by summary text, then by order among same-named ones; a disclosure with no
 * counterpart (new data, a removed spec) keeps its built default.
 */
export function carryDetailsState(from: Scope, to: Scope): void {
  const previous = new Map<string, boolean[]>();
  for (const d of Array.from(from.querySelectorAll("details"))) {
    const key = detailsKey(d);
    const states = previous.get(key);
    if (states) states.push(d.open);
    else previous.set(key, [d.open]);
  }
  const seen = new Map<string, number>();
  for (const d of Array.from(to.querySelectorAll("details"))) {
    const key = detailsKey(d);
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    const was = previous.get(key)?.[nth];
    if (was !== undefined) d.open = was;
  }
}

/**
 * The choice a view should start from. A navigation always starts at
 * `fallback`; a refresh keeps the reader's `previous` choice while it is still
 * `valid` against the new data (a category whose last entry vanished falls back
 * rather than leaving an empty list with no chip to explain it).
 */
export function restoreChoice<T>(previous: T, refreshing: boolean, valid: (v: T) => boolean, fallback: T): T {
  return refreshing && valid(previous) ? previous : fallback;
}
