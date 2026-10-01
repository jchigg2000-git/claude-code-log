import { test } from "node:test";
import assert from "node:assert/strict";

import { ttlMemo } from "../server/memo.ts";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("concurrent gets for one key share a single scan", async () => {
  const memo = ttlMemo<string>(60_000);
  const gate = deferred<{ value: string; healthy: boolean }>();
  let scans = 0;
  const compute = () => {
    scans++;
    return gate.promise;
  };
  const a = memo.get("k", compute);
  const b = memo.get("k", compute);
  gate.resolve({ value: "corpus", healthy: true });
  assert.deepEqual(await Promise.all([a, b]), ["corpus", "corpus"]);
  assert.equal(scans, 1, "the second caller joined the running scan instead of starting a parallel one");
  assert.equal(await memo.get("k", compute), "corpus");
  assert.equal(scans, 1, "and the healthy result is memoized for the TTL");
});

test("different keys scan independently", async () => {
  const memo = ttlMemo<string>(60_000);
  let scans = 0;
  const compute = (v: string) => async () => {
    scans++;
    return { value: v, healthy: true };
  };
  assert.deepEqual(await Promise.all([memo.get("a", compute("A")), memo.get("b", compute("B"))]), ["A", "B"]);
  assert.equal(scans, 2);
});

test("a scan that started before clear() cannot repopulate the memo over a fresher one", async () => {
  const memo = ttlMemo<string>(60_000);
  const old = deferred<{ value: string; healthy: boolean }>();
  const first = memo.get("k", () => old.promise);
  memo.clear(); // fresh=1: reflect the disk as of now
  const fresh = await memo.get("k", async () => ({ value: "fresh", healthy: true }));
  assert.equal(fresh, "fresh", "the post-clear caller did not join the pre-clear scan");
  old.resolve({ value: "stale", healthy: true });
  assert.equal(await first, "stale", "its own caller still gets what it asked for");
  assert.equal(await memo.get("k", async () => ({ value: "rescan", healthy: true })), "fresh", "but the memo holds the fresh result");
});

test("an unhealthy scan is not memoized, and a rejected one is neither cached nor left joinable", async () => {
  const memo = ttlMemo<string>(60_000);
  let scans = 0;
  await memo.get("k", async () => (scans++, { value: "degraded", healthy: false }));
  assert.equal(await memo.get("k", async () => (scans++, { value: "recovered", healthy: true })), "recovered");
  assert.equal(scans, 2, "a degraded scan must not be replayed for the full TTL");

  const boom = ttlMemo<string>(60_000);
  await assert.rejects(boom.get("k", async () => Promise.reject(new Error("fs race"))), /fs race/);
  assert.equal(await boom.get("k", async () => ({ value: "ok", healthy: true })), "ok", "the next caller retries");
});

test("entries expire after the TTL", async () => {
  const memo = ttlMemo<string>(0);
  let scans = 0;
  const compute = async () => (scans++, { value: `v${scans}`, healthy: true });
  assert.equal(await memo.get("k", compute), "v1");
  await new Promise((r) => setTimeout(r, 2));
  assert.equal(await memo.get("k", compute), "v2");
});
