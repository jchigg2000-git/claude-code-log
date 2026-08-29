/**
 * Width-fitting for the hand-built SVG charts. The charts draw into a fixed
 * viewBox and `.vz-svg` renders at `width:100%`, so SVG text scales with the
 * container: a 13px label inside a 1000-unit viewBox renders ~4px on a phone.
 * The fix is to rebuild the chart at the container's real CSS width, so one
 * viewBox unit ≈ one CSS pixel and text stays legible at every viewport.
 *
 * One debounced ResizeObserver per mounted chart. The app fully re-renders on
 * navigation, so every callback re-checks `host.isConnected` and disconnects
 * the moment the host has left the DOM — observers never leak or fire into
 * detached nodes.
 */

/** Charts are never rebuilt narrower than this: below it the axis/peak text
 * wouldn't fit anyway, and the SVG scales down gracefully from here. */
export const MIN_CHART_W = 320;

/** Trailing debounce for resize-driven rebuilds (window drags fire storms). */
export const REFIT_DEBOUNCE_MS = 150;

/** Snap a measured container width to a chart width: floored at MIN_CHART_W
 * (a detached or collapsed host measures 0) and rounded to whole units. */
export function fitWidth(measured: number, floor = MIN_CHART_W): number {
  return measured > floor ? Math.round(measured) : floor;
}

/**
 * What a width report means for a mounted chart — pure, so the policy is
 * testable without a DOM. `first` is the observer's initial delivery: that is
 * layout discovery (the host was measured detached at mount), and it renders
 * immediately — ResizeObserver runs after layout but before paint, so the
 * corrected chart is what actually appears. Later deliveries are real
 * resizes and debounce.
 */
export function refitAction(
  reported: number,
  renderedW: number,
  first: boolean,
  floor = MIN_CHART_W,
): "render" | "debounce" | "none" {
  if (fitWidth(reported, floor) === renderedW) return "none";
  return first ? "render" : "debounce";
}

interface FitOpts {
  floor?: number;
  debounceMs?: number;
}

/**
 * Mount a chart into `host`, rebuilt to fit the host's width. Renders
 * immediately at the current `clientWidth` (floored — hosts are usually still
 * detached when views assemble their tree), then re-renders on container
 * resize. Returns `host` so views can mount inline:
 *
 *   fitChart(el("div"), (w) => areaChart(series, { width: w }))
 */
export function fitChart(
  host: HTMLElement,
  render: (width: number) => HTMLElement,
  opts: FitOpts = {},
): HTMLElement {
  const floor = opts.floor ?? MIN_CHART_W;
  const wait = opts.debounceMs ?? REFIT_DEBOUNCE_MS;
  let renderedW = fitWidth(host.clientWidth, floor);
  host.replaceChildren(render(renderedW));

  if (typeof ResizeObserver === "undefined") return host;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let first = true;
  const refit = () => {
    if (!host.isConnected) {
      ro.disconnect();
      return;
    }
    const w = fitWidth(host.clientWidth, floor);
    if (w === renderedW) return;
    renderedW = w;
    host.replaceChildren(render(w));
  };
  const ro = new ResizeObserver(() => {
    if (!host.isConnected) {
      // Removal also delivers a (zero-size) observation — use it to tear down.
      ro.disconnect();
      return;
    }
    const action = refitAction(host.clientWidth, renderedW, first, floor);
    first = false;
    if (action === "render") refit();
    else if (action === "debounce") {
      clearTimeout(timer);
      timer = setTimeout(refit, wait);
    }
  });
  ro.observe(host);
  return host;
}
