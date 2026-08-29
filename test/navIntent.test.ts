import { test } from "node:test";
import assert from "node:assert/strict";

import {
  INTENT_TTL_MS,
  classifySessionRender,
  consumeSessionNav,
  recordSessionNav,
} from "../src/navIntent.ts";

// ── classifySessionRender (pure scroll policy) ──────────────────────────────

const NOW = 1_700_000_000_000;

test("a render with no session in the URL never scrolls", () => {
  const c = classifySessionRender({ sessionId: "", intent: null, shownSessionId: "a", now: NOW });
  assert.deepEqual(c, { scroll: false, cause: "closed" });
});

test("a consumed matching intent scrolls — the user asked to go there", () => {
  const c = classifySessionRender({
    sessionId: "a",
    intent: { sessionId: "a", at: NOW - 5 },
    shownSessionId: null,
    now: NOW,
  });
  assert.deepEqual(c, { scroll: true, cause: "user-nav" });
});

test("a first mount scrolls: deep link, reload, or Forward reopening a session", () => {
  // Deep link / reload: nothing was on screen.
  assert.deepEqual(classifySessionRender({ sessionId: "a", intent: null, shownSessionId: null, now: NOW }), {
    scroll: true,
    cause: "mount",
  });
  // History traversal landed on a different session than the one showing.
  assert.deepEqual(classifySessionRender({ sessionId: "b", intent: null, shownSessionId: "a", now: NOW }), {
    scroll: true,
    cause: "mount",
  });
});

test("a refresh re-render of the session already on screen never scrolls", () => {
  const c = classifySessionRender({ sessionId: "a", intent: null, shownSessionId: "a", now: NOW });
  assert.deepEqual(c, { scroll: false, cause: "refresh" });
});

test("a mismatched or expired intent cannot claim the scroll", () => {
  // Intent for another session: ignored; the shown-session rule decides.
  assert.deepEqual(
    classifySessionRender({ sessionId: "a", intent: { sessionId: "b", at: NOW }, shownSessionId: "a", now: NOW }),
    { scroll: false, cause: "refresh" },
  );
  // Matching but stale: a stray intent must not yank the reader minutes later.
  assert.deepEqual(
    classifySessionRender({
      sessionId: "a",
      intent: { sessionId: "a", at: NOW - INTENT_TTL_MS - 1 },
      shownSessionId: "a",
      now: NOW,
    }),
    { scroll: false, cause: "refresh" },
  );
  // …but a fresh mount still scrolls on its own merits, stale intent or not.
  assert.equal(
    classifySessionRender({
      sessionId: "a",
      intent: { sessionId: "a", at: NOW - INTENT_TTL_MS - 1 },
      shownSessionId: null,
      now: NOW,
    }).scroll,
    true,
  );
});

// ── one-shot intent ────────────────────────────────────────────────────────

test("recorded intent is consumed exactly once", () => {
  recordSessionNav("a", NOW);
  assert.deepEqual(consumeSessionNav(), { sessionId: "a", at: NOW });
  assert.equal(consumeSessionNav(), null, "second consume must be empty");
});

test("a later record supersedes an unconsumed one — the newest click wins", () => {
  recordSessionNav("a", NOW);
  recordSessionNav("b", NOW + 1);
  assert.deepEqual(consumeSessionNav(), { sessionId: "b", at: NOW + 1 });
  assert.equal(consumeSessionNav(), null);
});

test("a close records an empty-string intent, which never claims a scroll", () => {
  recordSessionNav("", NOW);
  const intent = consumeSessionNav();
  assert.deepEqual(intent, { sessionId: "", at: NOW });
  // The render for a close has sessionId "" too, and classify short-circuits.
  assert.deepEqual(classifySessionRender({ sessionId: "", intent, shownSessionId: "a", now: NOW }), {
    scroll: false,
    cause: "closed",
  });
});
