import { test } from "node:test";
import assert from "node:assert/strict";

import { countLines, parseTranscriptText } from "../server/jsonl.ts";

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
