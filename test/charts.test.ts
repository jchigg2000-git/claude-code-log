import { test } from "node:test";
import assert from "node:assert/strict";

import { esc, peakLabelWidth, resolvePeakLabels } from "../src/charts.ts";

test("esc neutralizes markup in element-content position", () => {
  assert.equal(esc("<script>1 & 2</script>"), "&lt;script&gt;1 &amp; 2&lt;/script&gt;");
});

test("esc neutralizes both quote styles for attribute positions", () => {
  assert.equal(esc(`x" onload="alert(1)`), "x&quot; onload=&quot;alert(1)");
  assert.equal(esc("x' y"), "x&#39; y");
});

test("esc leaves plain project names untouched", () => {
  assert.equal(esc("claude-code-log"), "claude-code-log");
});

// ── resolvePeakLabels — collision policy for areaChart peak captions ──

/** A middle-anchored candidate with a typical "Aug 12 · 1.2M" width (13 chars). */
const cand = (x: number, priority: number) => ({
  x,
  y: 20,
  text: "Aug 12 · 1.2M",
  priority,
  anchor: "middle" as const,
});

test("resolvePeakLabels keeps every label when none collide", () => {
  const spread = [cand(100, 3), cand(500, 2), cand(900, 1)];
  assert.deepEqual(resolvePeakLabels(spread), spread);
});

test("resolvePeakLabels drops the lower-value label of an adjacent-day pair", () => {
  const tall = cand(500, 900);
  const short = cand(520, 400); // 20 units apart ≪ label width → boxes overlap
  assert.deepEqual(resolvePeakLabels([short, tall]), [tall]);
  // The winner is picked by priority, not by input order.
  assert.deepEqual(resolvePeakLabels([tall, short]), [tall]);
});

test("peakLabelWidth estimates ~7.2 viewBox units per glyph", () => {
  assert.equal(peakLabelWidth("abcd"), 4 * 7.2);
  assert.equal(peakLabelWidth("abcd", 10), 40); // charW override flows through
});

test("resolvePeakLabels collision boundary follows the estimated width", () => {
  // Two middle-anchored 10-char labels at charW 10 span ±50 around x; with the
  // default 6-unit gap the second label clears exactly at 50 + 6 + 50 = 106.
  const at = (x: number, priority: number) => ({
    x,
    y: 0,
    text: "0123456789",
    priority,
    anchor: "middle" as const,
  });
  assert.equal(resolvePeakLabels([at(0, 2), at(106, 1)], { charW: 10 }).length, 2);
  assert.equal(resolvePeakLabels([at(0, 2), at(105, 1)], { charW: 10 }).length, 1);
});

test("resolvePeakLabels boxes extend from the text-anchor, not around it", () => {
  // end-anchored extends left of x, start-anchored extends right — so these
  // nearly-touching anchors don't collide even though |Δx| ≪ label width.
  const endC = { x: 500, y: 0, text: "0123456789", priority: 2, anchor: "end" as const };
  const startC = { x: 510, y: 0, text: "0123456789", priority: 1, anchor: "start" as const };
  assert.deepEqual(resolvePeakLabels([endC, startC], { charW: 10 }), [endC, startC]);
});
