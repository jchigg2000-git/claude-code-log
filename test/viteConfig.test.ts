import { test } from "node:test";
import assert from "node:assert/strict";

import config from "../vite.config.ts";

/**
 * Regression pin for the audit's most serious finding.
 *
 * Vite's dev and preview servers reflect any localhost Origin back as
 * `Access-Control-Allow-Origin` unless told otherwise. /api/* serves the full
 * text of every transcript on the machine, so with that default on, a page from
 * any other local dev server could read the whole corpus cross-origin — while
 * the README's Security section claimed the opposite. The fix is one word in
 * vite.config.ts, which makes it exactly the kind of thing a later refactor
 * silently undoes. These assertions are what stop that being silent.
 */
test("CORS is pinned off on the dev server", () => {
  assert.equal(config.server?.cors, false);
});

test("CORS is pinned off on the preview server", () => {
  assert.equal(config.preview?.cors, false);
});

test("both servers stay bound to loopback on a pinned port", () => {
  for (const s of [config.server, config.preview]) {
    assert.equal(s?.host, "127.0.0.1", "off-machine reachability would expose an unauthenticated API");
    assert.equal(s?.port, 5189);
    assert.equal(s?.strictPort, true, "a drifting port can land on an origin another app's service worker owns");
  }
});
