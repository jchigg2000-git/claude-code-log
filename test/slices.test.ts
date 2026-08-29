import { test } from "node:test";
import assert from "node:assert/strict";

import { renderInSlices, type SliceOptions } from "../src/slices.ts";

/**
 * Drive the loop with a manual tick queue standing in for requestAnimationFrame,
 * so slice-per-tick behaviour is observable and tests never need a DOM.
 */
function harness(opts: Partial<SliceOptions> & { total: number }) {
  const queue: (() => void)[] = [];
  const slices: [number, number][] = [];
  let pause: { remaining: number; resume: () => void } | null = null;
  let done = 0;
  renderInSlices({
    sliceSize: 3,
    batchSize: 6,
    schedule: (fn) => queue.push(fn),
    renderSlice: (start, end) => slices.push([start, end]),
    onPause: (remaining, resume) => (pause = { remaining, resume }),
    onDone: () => done++,
    ...opts,
  });
  return {
    slices,
    pause: () => pause,
    doneCount: () => done,
    /** Run exactly one scheduled tick. */
    tick: () => queue.shift()?.(),
    /** Run scheduled ticks until the queue drains. */
    drain: () => {
      while (queue.length) queue.shift()!();
    },
  };
}

test("renders one slice per scheduled tick, then parks at the batch boundary", () => {
  const h = harness({ total: 10 });
  assert.deepEqual(h.slices, [], "nothing renders before the first tick");
  h.tick();
  assert.deepEqual(h.slices, [[0, 3]], "exactly one slice per tick");
  h.drain();
  assert.deepEqual(h.slices, [
    [0, 3],
    [3, 6],
  ]);
  const p = h.pause();
  assert.ok(p, "loop parks after batchSize rows");
  assert.equal(p.remaining, 4);
  assert.equal(h.doneCount(), 0);
});

test("resume renders the next batch (scheduled, not synchronous) and finishes", () => {
  const h = harness({ total: 10 });
  h.drain();
  h.pause()!.resume();
  assert.deepEqual(h.slices.length, 2, "resume only schedules — rows land on the next tick");
  h.drain();
  assert.deepEqual(h.slices, [
    [0, 3],
    [3, 6],
    [6, 9],
    [9, 10],
  ]);
  assert.equal(h.doneCount(), 1, "onDone fires once everything is rendered");
});

test("a list smaller than one batch completes without pausing", () => {
  const h = harness({ total: 5 });
  h.drain();
  assert.deepEqual(h.slices, [
    [0, 3],
    [3, 5],
  ]);
  assert.equal(h.pause(), null);
  assert.equal(h.doneCount(), 1);
});

test("an empty list goes straight to done with no slices", () => {
  const h = harness({ total: 0 });
  h.drain();
  assert.deepEqual(h.slices, []);
  assert.equal(h.pause(), null);
  assert.equal(h.doneCount(), 1);
});

test("alive() false abandons the loop without rendering or completing", () => {
  let alive = true;
  const h = harness({ total: 10, alive: () => alive });
  h.tick();
  assert.deepEqual(h.slices, [[0, 3]]);
  alive = false; // the container was detached by a route re-render
  h.drain();
  assert.deepEqual(h.slices, [[0, 3]], "no further slices after death");
  assert.equal(h.pause(), null);
  assert.equal(h.doneCount(), 0);
});
