import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, utimes, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { scanLogProjects, buildRepoDetail, clearLineCountCache } from "../server/fsScan.ts";
import { encodeProjectDir } from "../server/paths.ts";

const line = JSON.stringify({ type: "user", message: { role: "user", content: "hi" } });

async function corpus(projects: Record<string, string[]>): Promise<string> {
  const logDir = await mkdtemp(path.join(os.tmpdir(), "ccl-fsscan-"));
  for (const [dirName, sessionFiles] of Object.entries(projects)) {
    const dir = path.join(logDir, dirName);
    await mkdir(dir, { recursive: true });
    for (const f of sessionFiles) {
      await writeFile(path.join(dir, f), `${line}\n${line}`);
    }
  }
  return logDir;
}

test("scanLogProjects dirFilter skips non-matching project dirs before reading", async () => {
  const logDir = await corpus({
    "-Users-me-Projects-alpha": ["a1.jsonl"],
    "-Users-me-Projects-beta": ["b1.jsonl", "b2.jsonl"],
  });
  const all = await scanLogProjects(logDir);
  assert.equal(all.length, 2);

  const filtered = await scanLogProjects(logDir, (d) => d.endsWith("-beta"));
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].dirName, "-Users-me-Projects-beta");
  assert.equal(filtered[0].sessions.length, 2);
});

test("line counts are memoized on mtime+size and invalidated on growth", async () => {
  clearLineCountCache();
  const logDir = await corpus({ "-Users-me-Projects-alpha": [] });
  const file = path.join(logDir, "-Users-me-Projects-alpha", "s1.jsonl");
  // Pin a whole-ms mtime before each scan: the filesystem may keep sub-ms
  // precision, so "restore the original stat mtime" would not round-trip.
  const pinned = new Date(1700000000000);
  await writeFile(file, "aaa\nbbb"); // 7 bytes, 2 lines
  await utimes(file, pinned, pinned);

  const first = await scanLogProjects(logDir);
  assert.equal(first[0].sessions[0].messageCount, 2);

  // Same size, same mtime, different line count: a cache hit must serve the
  // memoized 2, proving the bytes were not re-read. (Real transcripts are
  // append-only, so this content swap can't happen outside a test.)
  await writeFile(file, "a\nb\ncc\n"); // 7 bytes, 3 lines
  await utimes(file, pinned, pinned);
  const second = await scanLogProjects(logDir);
  assert.equal(second[0].sessions[0].messageCount, 2, "unchanged mtime+size must hit the cache");

  // Growth changes size (and mtime), so the entry is stale and gets recounted.
  await appendFile(file, "ddd\n");
  const third = await scanLogProjects(logDir);
  assert.equal(third[0].sessions[0].messageCount, 4);
});

test("session preview is the first substantive prompt: carriers, noise, and malformed lines skipped, 90-char cap", async () => {
  clearLineCountCache();
  const long =
    "Refactor the session list so every row shows what the session was actually about, because raw UUIDs mean nothing to anyone scanning the page";
  const lines = [
    "{ not json at all", // malformed: counted, never previewed
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }), // carrier
    JSON.stringify({ type: "user", message: { role: "user", content: "   " } }), // whitespace-only prompt
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: "hello" } }), // not a prompt
    JSON.stringify({ type: "user", message: { role: "user", content: long } }), // first substantive → wins
    JSON.stringify({ type: "user", message: { role: "user", content: "a later prompt that must not win" } }),
  ];
  const logDir = await corpus({ "-Users-me-Projects-alpha": [] });
  await writeFile(path.join(logDir, "-Users-me-Projects-alpha", "s1.jsonl"), lines.join("\n"));

  const [proj] = await scanLogProjects(logDir);
  assert.equal(proj.sessions[0].messageCount, 6, "malformed lines still count");
  assert.equal(proj.sessions[0].preview, long.slice(0, 90));
  assert.equal(proj.sessions[0].preview.length, 90);
});

test("preview is memoized alongside the line count and recomputed on growth", async () => {
  clearLineCountCache();
  // Same byte length, different opening prompt — so mtime+size (the staleness
  // key) can be held equal while the content swaps.
  const promptA = JSON.stringify({ type: "user", message: { role: "user", content: "alpha one" } });
  const promptB = JSON.stringify({ type: "user", message: { role: "user", content: "bravo two" } });
  assert.equal(promptA.length, promptB.length);

  const logDir = await corpus({ "-Users-me-Projects-alpha": [] });
  const file = path.join(logDir, "-Users-me-Projects-alpha", "s1.jsonl");
  const pinned = new Date(1700000000000);
  await writeFile(file, promptA);
  await utimes(file, pinned, pinned);

  const first = await scanLogProjects(logDir);
  assert.equal(first[0].sessions[0].preview, "alpha one");

  // Unchanged mtime+size: the cache hit must serve the memoized preview,
  // proving the bytes were not re-read.
  await writeFile(file, promptB);
  await utimes(file, pinned, pinned);
  const second = await scanLogProjects(logDir);
  assert.equal(second[0].sessions[0].preview, "alpha one", "unchanged mtime+size must hit the cache");

  // Growth invalidates the entry; the recount re-extracts from the new bytes.
  await appendFile(file, `\n${promptA}`);
  const third = await scanLogProjects(logDir);
  assert.equal(third[0].sessions[0].preview, "bravo two");
  assert.equal(third[0].sessions[0].messageCount, 2);
});

test("spec reads refuse symlinks that escape the repo", async () => {
  const outside = await mkdtemp(path.join(os.tmpdir(), "ccl-outside-"));
  const secret = path.join(outside, "secret.txt");
  await writeFile(secret, "PRIVATE KEY MATERIAL");

  const repo = await mkdtemp(path.join(os.tmpdir(), "ccl-repo-"));
  await writeFile(path.join(repo, "CLAUDE.md"), "# real spec");
  await symlink(secret, path.join(repo, "README.md"));

  const logDir = await mkdtemp(path.join(os.tmpdir(), "ccl-emptylogs-"));
  const detail = await buildRepoDetail(repo, "repo", logDir);
  const names = detail.specs.map((s) => s.name);
  assert.ok(names.includes("CLAUDE.md"), "regular spec files are still read");
  assert.ok(!names.includes("README.md"), "symlinked README escaping the repo must be skipped");
  assert.ok(!detail.specs.some((s) => s.content.includes("PRIVATE")), "escaped bytes must never be served");
});

test("buildRepoDetail attributes exact-match and worktree-suffix dirs, nothing else", async () => {
  const repoPath = path.join(os.homedir(), "Projects", "alpha");
  const key = encodeProjectDir(repoPath);
  const logDir = await corpus({
    [key]: ["main.jsonl"],
    [`${key}-wt-feature`]: ["wt.jsonl"],
    [`${key.slice(0, -1)}X`]: ["other.jsonl"], // different repo, shared prefix without the dash
    "-Users-me-Projects-unrelated": ["u.jsonl"],
  });
  const detail = await buildRepoDetail(repoPath, "alpha", logDir);
  assert.equal(detail.sessionCount, 2);
  assert.deepEqual(detail.sessions.map((s) => s.id).sort(), ["main", "wt"]);
});
