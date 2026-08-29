import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { countLines, parseTranscriptText, readTranscriptCapped } from "../server/jsonl.ts";

const line = (o: unknown) => JSON.stringify(o);

test("parses user and assistant messages with string content", () => {
  const raw = [
    line({ type: "user", timestamp: "2026-07-01T10:00:00.000Z", message: { role: "user", content: "hello" } }),
    line({
      type: "assistant",
      timestamp: "2026-07-01T10:00:05.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "hi back" }] },
    }),
  ].join("\n");

  const events = parseTranscriptText(raw);
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map((e) => [e.kind, e.text]),
    [
      ["user", "hello"],
      ["assistant", "hi back"],
    ],
  );
  assert.equal(events[0].ts, "2026-07-01T10:00:00.000Z");
});

test("skips malformed lines instead of throwing", () => {
  const raw = [
    line({ type: "user", message: { role: "user", content: "kept" } }),
    '{"type":"user","message":', // truncated JSON
    "null", // parses, but isn't an object
    "42", // parses, but isn't an object
    "", // blank
    "   ", // whitespace only
    line({ type: "user", message: { role: "user", content: "also kept" } }),
  ].join("\n");

  const events = parseTranscriptText(raw);
  assert.deepEqual(
    events.map((e) => e.text),
    ["kept", "also kept"],
  );
});

test("tool_use is labelled with its tool name and an arrow", () => {
  const raw = line({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls" } }] },
  });
  const [ev] = parseTranscriptText(raw);
  assert.equal(ev.kind, "tool_use");
  assert.equal(ev.tool, "Bash");
  assert.equal(ev.text, "→ Bash");
  // Regression: the tool's INPUT is not surfaced, so bash command text is not
  // full-text searchable. Search's raw pre-filter must stay consistent with this.
  assert.ok(!ev.text.includes("ls"));
});

test("a tool_use with no name falls back to a generic label", () => {
  const raw = line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "x" }] } });
  const [ev] = parseTranscriptText(raw);
  assert.equal(ev.tool, "tool");
});

test("tool_result text is extracted from both string and block content", () => {
  const raw = [
    line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "plain output" }] } }),
    line({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "b", content: [{ type: "text", text: "block output" }] }],
      },
    }),
  ].join("\n");

  const events = parseTranscriptText(raw);
  assert.deepEqual(
    events.map((e) => [e.kind, e.text]),
    [
      ["tool_result", "plain output"],
      ["tool_result", "block output"],
    ],
  );
});

test("thinking blocks are surfaced and multiple blocks join with newlines", () => {
  const raw = line({
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reasoning" },
        { type: "text", text: "answer" },
      ],
    },
  });
  const [ev] = parseTranscriptText(raw);
  assert.equal(ev.text, "reasoning\nanswer");
});

test("summary lines and empty messages", () => {
  const raw = [
    line({ type: "summary", timestamp: "2026-07-01T09:00:00.000Z", summary: "what happened" }),
    // No extractable text — dropped rather than emitted as a blank row.
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "image", source: {} }] } }),
    line({ content: "bare content field" }),
  ].join("\n");

  const events = parseTranscriptText(raw);
  assert.deepEqual(
    events.map((e) => [e.kind, e.text]),
    [
      ["summary", "what happened"],
      ["other", "bare content field"],
    ],
  );
});

test("a missing or non-string timestamp becomes null, not a crash", () => {
  const raw = [
    line({ type: "user", message: { role: "user", content: "no ts" } }),
    line({ type: "user", timestamp: 12345, message: { role: "user", content: "numeric ts" } }),
  ].join("\n");
  assert.deepEqual(
    parseTranscriptText(raw).map((e) => e.ts),
    [null, null],
  );
});

test("countLines ignores blank and whitespace-only lines", () => {
  assert.equal(countLines("a\nb\n\n   \nc"), 3);
  assert.equal(countLines(""), 0);
  assert.equal(countLines("\n\n"), 0);
});

// ── readTranscriptCapped ─────────────────────────────────────────────────────

const userLine = (i: number) => line({ type: "user", message: { role: "user", content: `prompt ${i}` } });

async function transcriptFile(lines: string[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ccl-jsonl-"));
  const file = path.join(dir, "sess.jsonl");
  await writeFile(file, lines.join("\n"));
  return file;
}

test("a small transcript reads whole: no truncation, totals agree", async () => {
  const file = await transcriptFile([userLine(1), userLine(2), userLine(3)]);
  const read = await readTranscriptCapped(file);
  assert.equal(read.truncated, false);
  assert.equal(read.totalEvents, 3);
  assert.equal(read.events.length, 3);
  assert.equal(read.readBytes, read.sizeBytes);
  assert.ok(read.sizeBytes > 0);
});

test("the event cap slices the timeline but reports the honest total", async () => {
  const file = await transcriptFile([userLine(1), userLine(2), userLine(3), userLine(4), userLine(5)]);
  const read = await readTranscriptCapped(file, undefined, 2);
  assert.equal(read.truncated, true);
  assert.equal(read.totalEvents, 5);
  assert.deepEqual(
    read.events.map((e) => e.text),
    ["prompt 1", "prompt 2"],
    "the head of the timeline, in order",
  );
  assert.equal(read.readBytes, read.sizeBytes, "the event cap alone is not a byte cap");
});

test("the byte cap reads only the file head and drops the cut trailing line", async () => {
  const lines = [userLine(1), userLine(2), userLine(3), userLine(4)];
  const file = await transcriptFile(lines);
  // Cap mid-way through line 3: lines 1–2 survive, the partial line is noise, not a parse.
  const sizeCap = Buffer.byteLength(`${lines[0]}\n${lines[1]}\n`) + 10;
  const read = await readTranscriptCapped(file, sizeCap);
  assert.equal(read.truncated, true);
  assert.equal(read.totalEvents, 2, "only complete lines within the cap are parsed");
  assert.deepEqual(
    read.events.map((e) => e.text),
    ["prompt 1", "prompt 2"],
  );
  assert.equal(read.readBytes, sizeCap);
  assert.ok(read.sizeBytes > read.readBytes);
});

test("a byte-capped read with no newline in the head yields zero events, still flagged truncated", async () => {
  const file = await transcriptFile([userLine(1), userLine(2)]);
  const read = await readTranscriptCapped(file, 5); // cuts inside the first line
  assert.equal(read.truncated, true);
  assert.equal(read.totalEvents, 0);
  assert.deepEqual(read.events, []);
});

test("an unreadable file yields an empty, un-truncated read rather than a throw", async () => {
  const read = await readTranscriptCapped(path.join(os.tmpdir(), "ccl-jsonl-none", "missing.jsonl"));
  assert.deepEqual(read, { events: [], totalEvents: 0, truncated: false, sizeBytes: 0, readBytes: 0 });
});
