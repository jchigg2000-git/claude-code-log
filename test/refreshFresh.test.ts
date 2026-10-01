import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { fetchJourney, fetchMetrics, fetchWords, freshUrl, invalidateJourney, invalidateMetrics, invalidateWords } from "../src/api.ts";
import { handleApi } from "../server/api.ts";
import type { AppConfig } from "../src/types.ts";

// The periodic refresh fires on the same 5-minute interval as the server's
// whole-corpus memo, so a plain refetch lands inside the memo window and gets
// the previous scan back. `fresh=1` is the client asking past it. Two halves:
// the client must send it exactly once per invalidation, and the server must
// honour it for each memoized endpoint.

// ── client ───────────────────────────────────────────────────────────────────

function stubFetch(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    calls.push(String(url));
    return { ok: true, json: async () => ({}) } as Response;
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = real) };
}

test("freshUrl appends the bypass with the right separator, and only when asked", () => {
  assert.equal(freshUrl("/api/metrics?logDir=%2Fa", false), "/api/metrics?logDir=%2Fa");
  assert.equal(freshUrl("/api/metrics?logDir=%2Fa", true), "/api/metrics?logDir=%2Fa&fresh=1");
  assert.equal(freshUrl("/api/metrics", true), "/api/metrics?fresh=1");
});

test("invalidating an endpoint makes its next request fresh=1 — once", async () => {
  const { calls, restore } = stubFetch();
  try {
    const cfg: AppConfig = { logDir: "/logs-a", repoRoot: "/code-a" };
    const cases = [
      { name: "metrics", fetch: () => fetchMetrics(cfg), invalidate: invalidateMetrics },
      { name: "journey", fetch: () => fetchJourney(cfg), invalidate: invalidateJourney },
      { name: "words", fetch: () => fetchWords(cfg), invalidate: invalidateWords },
    ];
    for (const c of cases) {
      calls.length = 0;
      await c.fetch();
      assert.ok(!calls[0].includes("fresh=1"), `${c.name}: a first load is an ordinary request`);
      await c.fetch();
      assert.equal(calls.length, 1, `${c.name}: still memoized on the client`);

      c.invalidate();
      await c.fetch();
      assert.equal(calls.length, 2);
      assert.ok(calls[1].endsWith("&fresh=1"), `${c.name}: the refetch after invalidate must bypass the server memo (${calls[1]})`);

      c.invalidate();
      await c.fetch();
      c.invalidate();
      await c.fetch();
      assert.ok(calls.slice(2).every((u) => u.endsWith("&fresh=1")), `${c.name}: every invalidation is honoured`);

      // A plain navigation after the refresh settles must not keep asking past the memo.
      const cfg2: AppConfig = { logDir: `/other-${c.name}`, repoRoot: "/code-a" };
      calls.length = 0;
      await (c.name === "metrics" ? fetchMetrics(cfg2) : c.name === "journey" ? fetchJourney(cfg2) : fetchWords(cfg2));
      assert.ok(!calls[0].includes("fresh=1"), `${c.name}: the flag is one-shot`);
    }
  } finally {
    restore();
  }
});

// ── server ───────────────────────────────────────────────────────────────────

function req(url: string): IncomingMessage {
  return { url, method: "GET", headers: { host: "127.0.0.1:5189" } } as unknown as IncomingMessage;
}

async function get(url: string): Promise<Record<string, unknown>> {
  let raw = "";
  const stub = {
    setHeader() {},
    end(chunk: string) {
      raw = chunk;
    },
    set statusCode(_: number) {},
  };
  await handleApi(req(url), stub as unknown as ServerResponse);
  return JSON.parse(raw);
}

const line = (text: string) => JSON.stringify({ type: "user", timestamp: "2026-09-01T00:00:00.000Z", message: { role: "user", content: text } });

test("the server's TTL memos hold within the window and give way to fresh=1 (metrics, journey, words)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ccl-fresh-"));
  const logDir = path.join(root, "projects");
  await mkdir(path.join(logDir, "-tmp-fresh-app"), { recursive: true });
  process.env.CLAUDE_CODE_LOG_ROOTS = root; // history.jsonl sits beside logDir, so the root is its parent
  await writeFile(path.join(logDir, "-tmp-fresh-app", "a.jsonl"), line("hello there friend"));
  const history = path.join(root, "history.jsonl");
  const hist = (n: number) =>
    Array.from({ length: n }, (_, i) => JSON.stringify({ display: `typed something ${i}`, timestamp: Date.now() - i * 1000, project: "/tmp/fresh-app", sessionId: "s1" })).join("\n");
  await writeFile(history, hist(1));

  const q = new URLSearchParams({ logDir, repoRoot: root }).toString();
  const probes = [
    { url: `/api/metrics?${q}`, read: (b: Record<string, unknown>) => (b.totals as { sessions: number }).sessions, grow: () => writeFile(path.join(logDir, "-tmp-fresh-app", "b.jsonl"), line("a second session")) },
    { url: `/api/words?${q}`, read: (b: Record<string, unknown>) => b.sessionsScanned as number, grow: () => writeFile(path.join(logDir, "-tmp-fresh-app", "c.jsonl"), line("a third session")) },
    { url: `/api/journey?logDir=${encodeURIComponent(logDir)}`, read: (b: Record<string, unknown>) => b.totalCommands as number, grow: () => writeFile(history, hist(2)) },
  ];

  for (const p of probes) {
    const before = p.read(await get(p.url));
    await p.grow();
    assert.equal(p.read(await get(p.url)), before, `${p.url.split("?")[0]}: a plain request inside the TTL replays the memo`);
    assert.equal(p.read(await get(`${p.url}&fresh=1`)), before + 1, `${p.url.split("?")[0]}: fresh=1 re-scans`);
    assert.equal(p.read(await get(p.url)), before + 1, `${p.url.split("?")[0]}: and the re-scan becomes the new memo`);
  }
});
