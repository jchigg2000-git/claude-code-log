import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildSearch, clearSearchCaches } from "../server/search.ts";
import { clearTranscriptCache } from "../server/transcriptCache.ts";

const line = (o: unknown) => JSON.stringify(o);
const userLine = (text: string, ts = "2026-07-01T10:00:00.000Z") =>
  line({ type: "user", timestamp: ts, message: { role: "user", content: text } });

async function corpus(projects: Record<string, Record<string, string[]>>): Promise<string> {
  clearSearchCaches();
  clearTranscriptCache();
  const logDir = await mkdtemp(path.join(os.tmpdir(), "ccl-search-"));
  for (const [dirName, sessions] of Object.entries(projects)) {
    const dir = path.join(logDir, dirName);
    await mkdir(dir, { recursive: true });
    for (const [file, lines] of Object.entries(sessions)) {
      await writeFile(path.join(dir, file), lines.join("\n"));
    }
  }
  return logDir;
}

const PROJ = "-Users-me-Projects-demo";

test("queries under two characters are ignored without scanning", async () => {
  const logDir = await corpus({ [PROJ]: { "s1.jsonl": [userLine("pagination")] } });
  for (const q of ["", " ", "p"]) {
    const r = await buildSearch(logDir, q);
    assert.equal(r.results.length, 0);
    assert.equal(r.sessionsSearched, 0, `"${q}" must not walk the corpus`);
  }
});

test("matching is case-insensitive and counts every matching event", async () => {
  const logDir = await corpus({
    [PROJ]: {
      "s1.jsonl": [userLine("The Pagination cursor"), userLine("pagination again"), userLine("unrelated")],
    },
  });

  const r = await buildSearch(logDir, "PAGINATION");
  assert.equal(r.matchedSessions, 1);
  assert.equal(r.results[0].matchCount, 2);
  assert.equal(r.sessionsSearched, 1);
  assert.equal(r.truncated, false);
});

test("results are newest-first by mtime and carry project identity", async () => {
  const logDir = await corpus({
    [PROJ]: { "old.jsonl": [userLine("ferry timetable")] },
    "-Users-me-Projects-other": { "new.jsonl": [userLine("ferry schedule")] },
  });
  // Make the ordering deterministic regardless of write order.
  const { utimes } = await import("node:fs/promises");
  await utimes(path.join(logDir, PROJ, "old.jsonl"), new Date(1), new Date("2026-01-01T00:00:00Z"));
  await utimes(path.join(logDir, "-Users-me-Projects-other", "new.jsonl"), new Date(1), new Date("2026-07-01T00:00:00Z"));
  clearSearchCaches();

  const r = await buildSearch(logDir, "ferry");
  assert.equal(r.matchedSessions, 2);
  assert.deepEqual(
    r.results.map((x) => x.sessionId),
    ["new", "old"],
  );
  assert.equal(r.results[0].dirName, "-Users-me-Projects-other");
  assert.equal(r.results[0].approxPath, "/Users/me/Projects/other");
});

test("rows are capped at 100 while matchedSessions reports the true total", async () => {
  const sessions: Record<string, string[]> = {};
  for (let i = 0; i < 105; i++) sessions[`s${i}.jsonl`] = [userLine("shipit")];
  const logDir = await corpus({ [PROJ]: sessions });

  const r = await buildSearch(logDir, "shipit");
  assert.equal(r.results.length, 100);
  assert.equal(r.matchedSessions, 105);
  assert.equal(r.truncated, true);
});

test("snippet windows around the first match and marks truncation with ellipses", async () => {
  const filler = "x".repeat(300);
  const logDir = await corpus({ [PROJ]: { "s1.jsonl": [userLine(`${filler} NEEDLE ${filler}`)] } });

  const { snippet } = (await buildSearch(logDir, "needle")).results[0];
  assert.ok(snippet.includes("NEEDLE"), "the original casing is preserved in the snippet");
  assert.ok(snippet.startsWith("…") && snippet.endsWith("…"), "both sides were trimmed");
  // 90 chars of context each side, plus the needle and the two ellipses.
  assert.ok(snippet.length < 200, `snippet unexpectedly long: ${snippet.length}`);
});

test("a match at the very start has no leading ellipsis", async () => {
  const logDir = await corpus({ [PROJ]: { "s1.jsonl": [userLine(`NEEDLE ${"x".repeat(300)}`)] } });
  const { snippet } = (await buildSearch(logDir, "needle")).results[0];
  assert.ok(!snippet.startsWith("…"));
  assert.ok(snippet.endsWith("…"));
});

test("snippet whitespace is collapsed to a single line", async () => {
  const logDir = await corpus({ [PROJ]: { "s1.jsonl": [userLine("before\n\n   needle \t\n after")] } });
  const { snippet } = (await buildSearch(logDir, "needle")).results[0];
  assert.equal(snippet, "before needle after");
  assert.ok(!snippet.includes("\n"));
});

test("the raw pre-filter does not change results for escaped or non-ASCII queries", async () => {
  // Queries containing " \ or a control char skip the raw pre-filter, because
  // JSON escapes them in the file. They must still find their matches.
  const logDir = await corpus({
    [PROJ]: {
      "s1.jsonl": [
        userLine('he said "hello" loudly'),
        userLine("a back\\slash here"),
        userLine("café au lait"),
        userLine("nothing to see"),
      ],
    },
  });

  for (const [q, expected] of [
    ['said "hello"', 1],
    ["back\\slash", 1],
    ["café", 1],
    ["not-present-anywhere", 0],
  ] as const) {
    const r = await buildSearch(logDir, q);
    assert.equal(r.matchedSessions, expected, `query ${JSON.stringify(q)}`);
  }
});

test("the synthesized tool arrow is searchable despite living only in parsed text", async () => {
  const logDir = await corpus({
    [PROJ]: {
      "s1.jsonl": [
        line({
          type: "assistant",
          timestamp: "2026-07-01T10:00:00.000Z",
          message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] },
        }),
      ],
    },
  });

  // "→ Bash" exists only after parsing, so this query must bypass the raw
  // pre-filter rather than silently returning nothing.
  const r = await buildSearch(logDir, "→ Bash");
  assert.equal(r.matchedSessions, 1);
  assert.equal(r.results[0].kind, "tool_use");
  assert.equal(r.results[0].tool, "Bash");
});

test("re-running a query after a transcript grows picks up the new content", async () => {
  const logDir = await corpus({ [PROJ]: { "s1.jsonl": [userLine("first entry")] } });
  const file = path.join(logDir, PROJ, "s1.jsonl");

  assert.equal((await buildSearch(logDir, "second")).matchedSessions, 0);

  const { appendFile } = await import("node:fs/promises");
  await appendFile(file, "\n" + userLine("second entry"));
  clearSearchCaches(); // the enumeration memo has a 10s TTL; the content cache is mtime+size keyed

  assert.equal(
    (await buildSearch(logDir, "second")).matchedSessions,
    1,
    "the mtime+size cache key must invalidate on append",
  );
});

test("malformed lines are skipped without failing the search", async () => {
  const logDir = await corpus({
    [PROJ]: { "s1.jsonl": ['{"type":"user","message":', "null", "", userLine("survivor pagination")] },
  });
  const r = await buildSearch(logDir, "pagination");
  assert.equal(r.matchedSessions, 1);
});

test("an unreadable log dir returns empty results rather than throwing", async () => {
  const r = await buildSearch(path.join(os.tmpdir(), "ccl-search-missing-xyz"), "anything");
  assert.equal(r.sessionsSearched, 0);
  assert.equal(r.results.length, 0);
});
