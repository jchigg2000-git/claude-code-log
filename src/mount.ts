/**
 * How a full-page view gets onto the screen without clobbering a page the
 * reader is in the middle of.
 *
 * Two problems, one seam:
 *
 * 1. **Refresh collapse.** The 5-minute refresh re-routes to the current view.
 *    A view that clears its host to show "Loading…" collapses the document, and
 *    the browser clamps scroll to the top — the reader loses their place every
 *    five minutes. On a refresh the view is instead built into a detached stage
 *    while the old render stays up, and the stage replaces it in one
 *    `replaceChildren`, so document height never dips.
 *
 * 2. **Stale writers.** Every view awaits a fetch, then writes into the shared
 *    host. A slow first-load scan that resolves after the reader has moved on
 *    (another tab, or one more keystroke in the search box) used to append its
 *    whole page into whatever was on screen by then. {@link RenderCtx.isCurrent}
 *    is the check a view makes after each await; a newer route flips it.
 *
 * Views that opt in take a `RenderCtx` and otherwise render exactly as before:
 * `host` is just the element they write into.
 */

import { runViewTeardown } from "./viewLifecycle.ts";

export interface RenderCtx {
  /**
   * True on the periodic refresh: the old page is still on screen, so the view
   * may wait on slow secondary data to build a complete page rather than show a
   * placeholder — a placeholder would shorten the swapped-in page and clamp the
   * reader's scroll.
   */
  refreshing: boolean;
  /** False once a newer route has started — the render must not touch the page. */
  isCurrent(): boolean;
  /**
   * Run `fn` once the rendered tree is part of the page. Needed by anything that
   * measures layout or installs window listeners (Journey). Immediate when the
   * view is rendering straight into the live host; deferred past the swap when
   * it is rendering into a stage; dropped if the stage is discarded.
   */
  afterAttach(fn: () => void): void;
}

let generation = 0;

/** Begin a route; supersedes every render started before it. Returns its token. */
export function startRoute(): number {
  return ++generation;
}

/** Whether `token` still names the newest route. */
export function isCurrentRoute(token: number): boolean {
  return token === generation;
}

/**
 * True when `node` holds a finished page: no direct-child loading line and no
 * direct-child error box. Every view puts those placeholders at the top level
 * of its host (the shared `errorBox` builds `div.error`), so this one test
 * tells "a page worth keeping" from "a spinner" or "a failure" without each
 * view having to report which one it ended on.
 */
export function isSettled(node: { children: ArrayLike<{ classList: { contains(c: string): boolean } }> }): boolean {
  return !Array.from(node.children).some((c) => c.classList.contains("loading") || c.classList.contains("error"));
}

/**
 * Render a view into `host`.
 *
 * `refresh: false` — a navigation. The view renders straight into the host,
 * showing its own loading state, exactly as it always has.
 *
 * `refresh: true` — the periodic refresh. The view renders into a detached
 * stage; the stage replaces the old page only when it settled into a real page.
 * A failed refetch keeps the old page up (stale content beats an error box
 * mid-read, and the next refresh retries). The exception is a host that is not
 * itself a finished page — still a loading line, or already an error — which
 * takes whatever the stage ended on, so a refresh can't leave it stuck.
 */
export async function mountView(
  host: HTMLElement,
  token: number,
  refresh: boolean,
  render: (target: HTMLElement, ctx: RenderCtx) => Promise<void>,
): Promise<void> {
  const isCurrent = () => isCurrentRoute(token);

  if (!refresh) {
    await render(host, { refreshing: false, isCurrent, afterAttach: (fn) => fn() });
    return;
  }

  const stage = document.createElement("div");
  const pending: Array<() => void> = [];
  await render(stage, { refreshing: true, isCurrent, afterAttach: (fn) => void pending.push(fn) });

  if (!isCurrent()) return;
  if (!isSettled(stage) && host.children.length > 0 && isSettled(host)) return;
  // The replaced page's window listeners / animation loops die with it — and
  // only now, so a refetch that fails (page kept) leaves the old one live.
  runViewTeardown();
  host.replaceChildren(...Array.from(stage.childNodes));
  for (const fn of pending) fn();
}
