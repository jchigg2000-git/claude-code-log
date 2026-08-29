/**
 * One teardown slot for whichever view is currently mounted.
 *
 * Most views are pure DOM: the next render clears the container and the old
 * subtree is garbage. Journey is not. It owns window-level `scroll`/`resize`
 * listeners and a `requestAnimationFrame` loop that re-arms unconditionally
 * (see `createJourneyField` in views/journey-canvas.ts), so disposing it means
 * *calling* something, not just dropping nodes. Without that call, leaving the
 * tab leaves the particle field painting into a detached canvas for the life of
 * the tab, and every scroll on every other page still measures detached scene
 * sections — while the whole detached Journey DOM stays reachable.
 *
 * The router runs {@link runViewTeardown} before dispatching the next view, so
 * a view that needs disposal registers it here and otherwise ignores routing.
 * Teardown is one-shot: running it clears the slot, so a double route (a
 * refresh landing on the same view) can't run the same teardown twice.
 */
let dispose: (() => void) | null = null;

/** Register the teardown for the view being mounted. Replaces any previous one. */
export function setViewTeardown(fn: () => void): void {
  dispose = fn;
}

/** Run and clear the pending teardown, if any. Safe to call when none is set. */
export function runViewTeardown(): void {
  const fn = dispose;
  dispose = null;
  fn?.();
}
