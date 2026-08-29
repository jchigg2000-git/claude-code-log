import { test } from "node:test";
import assert from "node:assert/strict";

import { fetchSession, sessionStaleKey } from "../src/api.ts";
import type { AppConfig } from "../src/types.ts";

const cfg: AppConfig = { logDir: "/logs", repoRoot: "/code" };

/** Swap globalThis.fetch for a canned responder; returns the call log. */
function stubFetch(respond: (call: number) => { ok: boolean; body: unknown }): {
  calls: string[];
  restore: () => void;
} {
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const r = respond(calls.push(String(url)));
    return { ok: r.ok, json: async () => r.body } as Response;
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}

test("sessionStaleKey changes exactly when the file's mtime or size does", () => {
  const meta = { mtime: "2026-08-01T00:00:00.000Z", sizeBytes: 100 };
  assert.equal(sessionStaleKey(meta), sessionStaleKey({ ...meta }));
  assert.notEqual(sessionStaleKey(meta), sessionStaleKey({ ...meta, sizeBytes: 180 }));
  assert.notEqual(sessionStaleKey(meta), sessionStaleKey({ ...meta, mtime: "2026-08-01T00:05:00.000Z" }));
});

test("fetchSession memoizes by staleKey and refetches when the file grows", async () => {
  const { calls, restore } = stubFetch(() => ({ ok: true, body: { file: "s", events: [] } }));
  try {
    const file = "/logs/p/memo.jsonl";
    const meta = { mtime: "2026-08-01T00:00:00.000Z", sizeBytes: 100 };
    const a = await fetchSession(cfg, file, sessionStaleKey(meta));
    const b = await fetchSession(cfg, file, sessionStaleKey(meta));
    assert.equal(calls.length, 1, "an unchanged file replays the memoized payload");
    assert.equal(a, b, "both callers see the same resolved payload");

    // The file grew: the scan hands out new metadata, the key changes, and
    // the memo self-invalidates — no manual invalidate call anywhere.
    const grown = { mtime: "2026-08-01T00:05:00.000Z", sizeBytes: 180 };
    await fetchSession(cfg, file, sessionStaleKey(grown));
    assert.equal(calls.length, 2, "a grown file refetches");

    // No staleKey (the standalone #/session view) bypasses the memo entirely…
    await fetchSession(cfg, file);
    await fetchSession(cfg, file);
    assert.equal(calls.length, 4, "uncached path always fetches");
    // …and never clobbers the keyed entry.
    await fetchSession(cfg, file, sessionStaleKey(grown));
    assert.equal(calls.length, 4, "memoized entry survived the uncached calls");
  } finally {
    restore();
  }
});

test("a rejected session fetch is evicted, not replayed from the memo", async () => {
  const { calls, restore } = stubFetch((call) =>
    call === 1 ? { ok: false, body: { error: "boom" } } : { ok: true, body: { file: "s", events: [] } },
  );
  try {
    const file = "/logs/p/flaky.jsonl";
    const key = sessionStaleKey({ mtime: "2026-08-01T00:00:00.000Z", sizeBytes: 100 });
    await assert.rejects(fetchSession(cfg, file, key), /boom/);
    await new Promise((r) => setTimeout(r, 0)); // let the evict-on-rejection handler run
    const ok = await fetchSession(cfg, file, key);
    assert.equal(calls.length, 2, "the transient failure was not cached");
    assert.deepEqual(ok, { file: "s", events: [] });
  } finally {
    restore();
  }
});
