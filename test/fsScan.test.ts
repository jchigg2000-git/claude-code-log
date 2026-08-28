import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { scanLogProjects, buildRepoDetail } from "../server/fsScan.ts";
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
