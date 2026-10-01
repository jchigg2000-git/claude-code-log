import { test } from "node:test";
import assert from "node:assert/strict";

import { MIN_CHART_W, fitChart, fitWidth, refitAction } from "../src/fitChart.ts";

// The DOM half of fitChart (ResizeObserver wiring) runs in a browser (one
// stubbed test below pins its first-delivery handshake);
// the policy it applies — width floor + when to re-render — is pure and
// pinned here.

test("fitWidth floors detached or collapsed hosts at MIN_CHART_W", () => {
  assert.equal(fitWidth(0), MIN_CHART_W);
  assert.equal(fitWidth(150), MIN_CHART_W);
  assert.equal(fitWidth(MIN_CHART_W), MIN_CHART_W);
});

test("fitWidth rounds real measurements to whole viewBox units", () => {
  assert.equal(fitWidth(641.6), 642);
  assert.equal(fitWidth(1132), 1132);
});

test("fitWidth honours a caller-supplied floor", () => {
  assert.equal(fitWidth(100, 200), 200);
  assert.equal(fitWidth(500, 200), 500);
});

test("refitAction ignores reports that fit to the already-rendered width", () => {
  assert.equal(refitAction(800, 800, false), "none");
  assert.equal(refitAction(800.4, 800, true), "none"); // rounds to the same
  assert.equal(refitAction(100, MIN_CHART_W, false), "none"); // floors to the same
});

test("refitAction renders immediately on the observer's initial delivery", () => {
  // Mount measures a detached host (→ floor); the first delivery is layout
  // discovery and must correct the chart before paint, not 150ms later.
  assert.equal(refitAction(1132, MIN_CHART_W, true), "render");
});

test("refitAction debounces real resizes after the first delivery", () => {
  assert.equal(refitAction(700, 1132, false), "debounce");
});

test("fitChart's first-delivery render unobserves until the next frame (no RO loop warning)", () => {
  // Minimal DOM stand-ins: a host, a ResizeObserver that records calls, and a
  // manually-flushed requestAnimationFrame.
  const calls: string[] = [];
  let deliver: () => void = () => {};
  const frames: Array<() => void> = [];
  const g = globalThis as Record<string, unknown>;
  const saved = { RO: g.ResizeObserver, raf: g.requestAnimationFrame };
  g.ResizeObserver = class {
    constructor(cb: () => void) {
      deliver = cb;
    }
    observe() { calls.push("observe"); }
    unobserve() { calls.push("unobserve"); }
    disconnect() { calls.push("disconnect"); }
  };
  g.requestAnimationFrame = (fn: () => void) => frames.push(fn);
  try {
    const host = { clientWidth: 0, isConnected: true, replaceChildren() {} };
    const widths: number[] = [];
    fitChart(host as unknown as HTMLElement, (w) => {
      widths.push(w);
      return {} as HTMLElement;
    });
    host.clientWidth = 1132;
    deliver(); // initial delivery: layout discovery → immediate render
    assert.deepEqual(widths, [MIN_CHART_W, 1132]);
    assert.deepEqual(calls, ["observe", "unobserve"]);
    frames.shift()!();
    assert.deepEqual(calls, ["observe", "unobserve", "observe"]);
  } finally {
    g.ResizeObserver = saved.RO;
    g.requestAnimationFrame = saved.raf;
  }
});
