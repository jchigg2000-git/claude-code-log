import { test } from "node:test";
import assert from "node:assert/strict";

import { setViewTeardown, runViewTeardown } from "../src/viewLifecycle.ts";

// The router runs the pending teardown before mounting the next view. What
// matters is the policy, not the DOM it eventually disposes: run at most once,
// clear on run, and never throw when there is nothing to run.

test("running with no registered teardown is a no-op", () => {
  runViewTeardown();
  runViewTeardown();
});

test("a registered teardown runs on the next route", () => {
  let ran = 0;
  setViewTeardown(() => ran++);
  runViewTeardown();
  assert.equal(ran, 1);
});

test("a teardown is one-shot — a second route can't run it again", () => {
  let ran = 0;
  setViewTeardown(() => ran++);
  runViewTeardown();
  runViewTeardown();
  assert.equal(ran, 1, "the slot must clear itself so a double route disposes once");
});

test("registering again replaces the pending teardown rather than stacking", () => {
  const order: string[] = [];
  setViewTeardown(() => order.push("first"));
  setViewTeardown(() => order.push("second"));
  runViewTeardown();
  assert.deepEqual(order, ["second"]);
});

test("re-registering after a run arms the slot again", () => {
  let ran = 0;
  setViewTeardown(() => ran++);
  runViewTeardown();
  setViewTeardown(() => ran++);
  runViewTeardown();
  assert.equal(ran, 2, "leaving and re-entering Journey must dispose each visit");
});
