import { test } from "node:test";
import assert from "node:assert/strict";

import { MIN_CHART_W, fitWidth, refitAction } from "../src/fitChart.ts";

// The DOM half of fitChart (ResizeObserver wiring) only runs in a browser;
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
