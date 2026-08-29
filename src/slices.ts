/**
 * Incremental renderer for long flat lists (the transcript surfaces).
 *
 * Rows are appended in slices of `sliceSize` — one scheduled tick (a
 * requestAnimationFrame frame) each — so no single tick blocks the main
 * thread, and after `batchSize` rows the loop parks behind an explicit
 * "show more" resume (`onPause`). Deliberately no IntersectionObserver:
 * a button is predictable, and there is no observer lifecycle to manage
 * across the app's full-page hash re-renders.
 *
 * The helper owns only the loop; each surface wires its own DOM through the
 * callbacks. `schedule` and `alive` are injectable so the loop is testable
 * without a DOM and stops touching containers a route change has detached.
 */

/** Rows appended per scheduled tick — small enough to never blow a frame. */
export const SLICE_SIZE = 250;
/** Rows rendered per resume before parking again behind the button. */
export const BATCH_SIZE = 1000;

export interface SliceOptions {
  /** Total rows available. */
  total: number;
  /** Append rows [start, end) to the surface's own container. */
  renderSlice: (start: number, end: number) => void;
  /** A batch finished with rows left; show the control, call `resume` on click. */
  onPause: (remaining: number, resume: () => void) => void;
  /** Every row is rendered; hide the control. */
  onDone: () => void;
  sliceSize?: number;
  batchSize?: number;
  /** Return false to abandon the loop (container detached by a re-render). */
  alive?: () => boolean;
  /** Tick scheduler; defaults to requestAnimationFrame. */
  schedule?: (fn: () => void) => void;
}

export function renderInSlices(opts: SliceOptions): void {
  const sliceSize = Math.max(1, opts.sliceSize ?? SLICE_SIZE);
  const batchSize = Math.max(sliceSize, opts.batchSize ?? BATCH_SIZE);
  const alive = opts.alive ?? (() => true);
  const schedule = opts.schedule ?? ((fn) => requestAnimationFrame(() => fn()));

  let next = 0;
  const step = (batchEnd: number): void => {
    if (!alive()) return;
    const end = Math.min(next + sliceSize, batchEnd, opts.total);
    if (end > next) {
      opts.renderSlice(next, end);
      next = end;
    }
    if (next >= opts.total) {
      opts.onDone();
      return;
    }
    if (next < batchEnd) {
      schedule(() => step(batchEnd));
      return;
    }
    opts.onPause(opts.total - next, () => schedule(() => step(next + batchSize)));
  };

  schedule(() => step(batchSize));
}
