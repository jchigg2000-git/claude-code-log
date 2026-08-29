import { test } from "node:test";
import assert from "node:assert/strict";

import {
  esc,
  graphPad,
  peakAnchor,
  peakAnchorBand,
  peakLabelSpan,
  peakLabelWidth,
  resolvePeakLabels,
  timelineGutter,
} from "../src/charts.ts";

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

// ── Width-aware geometry — charts are rebuilt per container width ──

test("peakAnchorBand keeps the historical 160-unit band at the default widths", () => {
  assert.equal(peakAnchorBand(1000), 160);
  assert.equal(peakAnchorBand(1200), 160);
});

test("peakAnchorBand shrinks on narrow charts so the bands still partition the axis", () => {
  assert.equal(peakAnchorBand(320), 320 / 3);
  for (const w of [320, 480, 700, 1000]) {
    assert.ok(2 * peakAnchorBand(w) <= w, `start+end bands overlap at W=${w}`);
  }
});

test("peakAnchor matches the historical constants at the default width", () => {
  assert.equal(peakAnchor(100, 1000), "start");
  assert.equal(peakAnchor(500, 1000), "middle");
  assert.equal(peakAnchor(900, 1000), "end");
});

test("peak labels stay inside a 320-wide frame wherever the peak lands", () => {
  const W = 320;
  const text = "Aug 12 · $1,234"; // the widest label shape (money-formatted)
  for (const cx of [0, 40, 106, 160, 214, 280, 320]) {
    const anchor = peakAnchor(cx, W);
    // areaChart's inward nudge for edge-anchored labels.
    const x = anchor === "end" ? cx - 6 : anchor === "start" ? cx + 6 : cx;
    const [l, r] = peakLabelSpan({ x, y: 0, text, priority: 1, anchor });
    assert.ok(l >= 0 && r <= W, `${anchor} label at cx=${cx} spans [${l}, ${r}] outside [0, ${W}]`);
  }
});

test("resolvePeakLabels stays consistent as charW shrinks", () => {
  // The same pair 60 units apart: tighter glyphs clear, wider glyphs collide.
  const at = (x: number, priority: number) => ({
    x,
    y: 0,
    text: "0123456789",
    priority,
    anchor: "middle" as const,
  });
  const pair = [at(100, 2), at(160, 1)];
  assert.equal(resolvePeakLabels(pair, { charW: 4 }).length, 2);
  assert.equal(resolvePeakLabels(pair, { charW: 7.2 }).length, 1);
});

test("timelineGutter pins the 128-unit gutter at the default width", () => {
  assert.equal(timelineGutter(1000), 128);
});

test("timelineGutter floors on narrow charts but never eats the plot", () => {
  assert.equal(timelineGutter(480), 76);
  assert.equal(timelineGutter(320), 76);
  assert.ok(timelineGutter(320) < 320 / 3);
});

test("graphPad pins 56 at the default width and floors on narrow frames", () => {
  assert.equal(graphPad(1200), 56);
  assert.equal(graphPad(1000), (1000 * 56) / 1200);
  assert.equal(graphPad(320), 24);
});
