import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildWords } from "../server/words.ts";

const line = (o: unknown) => JSON.stringify(o);

/** Write a throwaway log dir. A fresh dir per call also sidesteps the module-level TTL cache. */
async function corpus(projects: Record<string, Record<string, string[]>>): Promise<string> {
  const logDir = await mkdtemp(path.join(os.tmpdir(), "ccl-words-"));
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

const user = (ts: string, text: string) =>
  line({ type: "user", timestamp: ts, message: { role: "user", content: text } });
const assistant = (ts: string, text: string) =>
  line({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "text", text }] } });
const toolUse = (ts: string, name: string) =>
  line({ type: "assistant", timestamp: ts, message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name, input: {} }] } });

test("a correction pairs to the last substantive prompt and summarizes what ran", async () => {
  const logDir = await corpus({
    [PROJ]: {
      "s1.jsonl": [
        user("2026-08-01T10:00:00.000Z", "add auth to the login page please"),
        assistant("2026-08-01T10:00:30.000Z", "Adding auth to every page in the app."),
        toolUse("2026-08-01T10:01:00.000Z", "Edit"),
        user("2026-08-01T10:05:00.000Z", "that's not what I meant — only the API routes"),
      ],
    },
  });

  const w = await buildWords(logDir);
  assert.equal(w.sessionsScanned, 1);
  assert.equal(w.matchedSessions, 1);
  assert.equal(w.totalMatches, 1);
  assert.equal(w.entries.length, 1);

  const e = w.entries[0];
  assert.equal(e.category, "literal");
  assert.equal(e.confidence, "explicit");
  assert.equal(e.matched, "that's not what I meant");
  assert.equal(e.original, "add auth to the login page please");
  assert.equal(e.assistantTurns, 2);
  assert.equal(e.toolCalls, 1);
  assert.ok(e.firstAction.includes("Adding auth"));
});

test("a correction before the assistant acts is a mis-said self-correction", async () => {
  const logDir = await corpus({
    [PROJ]: {
      "s1.jsonl": [
        user("2026-08-01T10:00:00.000Z", "deploy the fromtend build now"),
        user("2026-08-01T10:00:10.000Z", "typo, I meant the frontend build"),
      ],
    },
  });

  const w = await buildWords(logDir);
  assert.equal(w.entries.length, 1);
  assert.equal(w.entries[0].category, "missaid");
  assert.equal(w.entries[0].original, "deploy the fromtend build now");
  assert.equal(w.entries[0].assistantTurns, 0);
});

test("harness-injected rows are never the original; weak reversals come back inferred", async () => {
  const logDir = await corpus({
    [PROJ]: {
      "s1.jsonl": [
        user("2026-08-01T10:00:00.000Z", "run the migration on staging today"),
        assistant("2026-08-01T10:00:30.000Z", "Running the migration."),
        user("2026-08-01T10:01:00.000Z", "Caveat: injected by the harness, not typed"),
        user(
          "2026-08-01T10:01:30.000Z",
          "Base directory for this skill: /Users/me/.claude/skills/shipit — that's not what I meant is a phrase inside these instructions, not a correction",
        ),
        user("2026-08-01T10:02:00.000Z", "no, wait — that migration targets prod"),
      ],
    },
  });

  const w = await buildWords(logDir);
  assert.equal(w.entries.length, 1);
  assert.equal(w.entries[0].original, "run the migration on staging today");
  assert.equal(w.entries[0].confidence, "inferred");
  assert.equal(w.entries[0].category, "literal");
});

test("'I never asked' lands in the overweighted bucket", async () => {
  const logDir = await corpus({
    [PROJ]: {
      "s1.jsonl": [
        user("2026-08-01T10:00:00.000Z", "make the dashboard feel a bit more polished, maybe cross platform"),
        toolUse("2026-08-01T10:01:00.000Z", "Write"),
        user("2026-08-01T10:10:00.000Z", "I never asked for a mobile app scaffold, drop it"),
      ],
    },
  });

  const w = await buildWords(logDir);
  assert.equal(w.entries.length, 1);
  assert.equal(w.entries[0].category, "pivot");
  assert.equal(w.entries[0].confidence, "explicit");
});

test("a markerless corpus and an unreadable log dir both yield empty results", async () => {
  const clean = await buildWords(
    await corpus({
      [PROJ]: {
        "s1.jsonl": [
          user("2026-08-01T10:00:00.000Z", "ship the release notes"),
          assistant("2026-08-01T10:00:30.000Z", "Done."),
        ],
      },
    }),
  );
  assert.equal(clean.entries.length, 0);
  assert.equal(clean.matchedSessions, 0);
  assert.equal(clean.sessionsScanned, 1);

  const missing = await buildWords(path.join(os.tmpdir(), "ccl-words-does-not-exist"));
  assert.equal(missing.sessionsScanned, 0);
  assert.equal(missing.entries.length, 0);
});
