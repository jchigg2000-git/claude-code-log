import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildMetrics } from "../server/metrics.ts";
import { DEFAULT_PRICING, family } from "../server/pricing.ts";

const line = (o: unknown) => JSON.stringify(o);

/** Write a throwaway log dir. A fresh dir per call also sidesteps the module-level TTL cache. */
async function corpus(projects: Record<string, Record<string, string[]>>): Promise<string> {
  const logDir = await mkdtemp(path.join(os.tmpdir(), "ccl-metrics-"));
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

test("cost is per-model list pricing across all four token buckets", async () => {
  const logDir = await corpus({
    [PROJ]: {
      "s1.jsonl": [
        line({
          type: "assistant",
          timestamp: "2026-07-01T10:00:00.000Z",
          message: {
            role: "assistant",
            model: "claude-opus-5",
            usage: {
              input_tokens: 1_000_000,
              output_tokens: 100_000,
              cache_creation_input_tokens: 200_000,
              cache_read_input_tokens: 10_000_000,
            },
            content: [{ type: "text", text: "x" }],
          },
        }),
      ],
    },
  });

  const m = await buildMetrics(logDir);
  // 1M*5 + 100k*25 + 200k*6.25 + 10M*0.5, all per 1M tokens.
  assert.equal(m.totals.cost, 13.75);
  assert.equal(m.totals.tokIn, 1_000_000);
  assert.equal(m.totals.tokCacheRead, 10_000_000);
  assert.equal(m.pricing.source, "built-in");
});

test("an unrecognized model contributes tokens but no cost", async () => {
  const logDir = await corpus({
    [PROJ]: {
      "s1.jsonl": [
        line({
          type: "assistant",
          timestamp: "2026-07-01T10:00:00.000Z",
          message: {
            role: "assistant",
            model: "some-other-vendor-model",
            usage: { input_tokens: 1_000_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            content: [{ type: "text", text: "x" }],
          },
        }),
      ],
    },
  });

  const m = await buildMetrics(logDir);
  assert.equal(m.totals.cost, 0);
  assert.equal(m.totals.tokIn, 1_000_000);
});

test("family() classifies model ids and rejects unknowns", () => {
  assert.equal(family("claude-opus-5"), "opus");
  assert.equal(family("claude-opus-4-8"), "opus");
  assert.equal(family("claude-opus-4-5-20251101"), "opus");
  assert.equal(family("claude-opus-4-1"), "opus-legacy", "pre-4.5 opus keeps the $15/$75 rate");
  assert.equal(family("claude-3-opus-20240229"), "opus-legacy");
  assert.equal(family("claude-fable-5"), "fable");
  assert.equal(family("claude-mythos-5"), "fable");
  assert.equal(family("claude-sonnet-5"), "sonnet");
  assert.equal(family("claude-haiku-4-5-20251001"), "haiku");
  assert.equal(family("CLAUDE-OPUS-5"), "opus");
  assert.equal(family("gpt-4"), null);
  assert.equal(family(undefined), null);
  assert.equal(family(42), null);
  assert.deepEqual(DEFAULT_PRICING.opus, [5, 25, 6.25, 0.5]);
  assert.deepEqual(DEFAULT_PRICING.fable, [10, 50, 12.5, 1]);
});

test("subagent dispatches pair to their tool_result by tool_use_id", async () => {
  const logDir = await corpus({
    [PROJ]: {
      "s1.jsonl": [
        line({
          type: "assistant",
          timestamp: "2026-07-01T10:00:00.000Z",
          message: {
            role: "assistant",
            model: "claude-opus-5",
            usage: {},
            content: [
              { type: "tool_use", id: "toolu_a", name: "Agent", input: { subagent_type: "Explore", description: "scout the repo" } },
            ],
          },
        }),
        // Result arrives in a LATER message — pairing must survive that.
        line({
          type: "user",
          timestamp: "2026-07-01T10:05:00.000Z",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_a", content: "done" }] },
        }),
        // A `Task`-named dispatch that never returns: counted, but no duration.
        line({
          type: "assistant",
          timestamp: "2026-07-01T10:06:00.000Z",
          message: {
            role: "assistant",
            model: "claude-opus-5",
            usage: {},
            content: [{ type: "tool_use", id: "toolu_b", name: "Task", input: { subagent_type: "general-purpose", description: "no result" } }],
          },
        }),
      ],
    },
  });

  const m = await buildMetrics(logDir);
  assert.equal(m.agents.total, 2);
  assert.equal(m.agents.withDuration, 1);
  assert.equal(m.agents.totalSeconds, 300);

  const explore = m.agents.byType.find((t) => t.type === "Explore");
  assert.equal(explore?.count, 1);
  assert.equal(explore?.seconds, 300);
  assert.equal(explore?.maxSeconds, 300);

  const gp = m.agents.byType.find((t) => t.type === "general-purpose");
  assert.equal(gp?.count, 1);
  assert.equal(gp?.seconds, 0, "an unpaired dispatch must not invent a duration");

  assert.equal(m.agents.longest[0].description, "scout the repo");
});

test("a dispatch with no subagent_type is bucketed as unknown, and non-Agent tools are ignored", async () => {
  const logDir = await corpus({
    [PROJ]: {
      "s1.jsonl": [
        line({
          type: "assistant",
          timestamp: "2026-07-01T10:00:00.000Z",
          message: {
            role: "assistant",
            model: "claude-opus-5",
            usage: {},
            content: [
              { type: "tool_use", id: "toolu_a", name: "Agent", input: {} },
              { type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "ls" } },
            ],
          },
        }),
      ],
    },
  });

  const m = await buildMetrics(logDir);
  assert.equal(m.agents.total, 1, "Bash is a tool call, not a subagent dispatch");
  assert.equal(m.agents.byType[0].type, "unknown");
  assert.ok(m.tools.some((t) => t.name === "Bash"));
  assert.equal(m.totals.toolCalls, 2);
});

test("working time counts model+tool gaps, caps long ones, and excludes human think time", async () => {
  const logDir = await corpus({
    [PROJ]: {
      "s1.jsonl": [
        line({ type: "user", timestamp: "2026-07-01T10:00:00.000Z", message: { role: "user", content: "do the thing" } }),
        // +30s of generation
        line({ type: "assistant", timestamp: "2026-07-01T10:00:30.000Z", message: { role: "assistant", model: "claude-opus-5", usage: {}, content: [{ type: "text", text: "ok" }] } }),
        // +30s of tool execution (a tool_result is not a human prompt)
        line({ type: "user", timestamp: "2026-07-01T10:01:00.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "out" }] } }),
        // +19min — clamped to the 600s cap
        line({ type: "assistant", timestamp: "2026-07-01T10:20:00.000Z", message: { role: "assistant", model: "claude-opus-5", usage: {}, content: [{ type: "text", text: "done" }] } }),
        // +40min of the human thinking — excluded entirely
        line({ type: "user", timestamp: "2026-07-01T11:00:00.000Z", message: { role: "user", content: "next thing" } }),
      ],
    },
  });

  const m = await buildMetrics(logDir);
  assert.equal(m.engagement.gapCapSeconds, 600);
  assert.equal(m.engagement.workingSeconds, 30 + 30 + 600);
  assert.equal(m.totals.userPrompts, 2, "a tool_result must not count as a typed prompt");
});

test("sidechain rows are excluded from main-thread working time", async () => {
  const rows = (extra: string[]) => [
    line({ type: "user", timestamp: "2026-07-01T10:00:00.000Z", message: { role: "user", content: "go" } }),
    ...extra,
    line({ type: "assistant", timestamp: "2026-07-01T10:00:30.000Z", message: { role: "assistant", model: "claude-opus-5", usage: {}, content: [{ type: "text", text: "ok" }] } }),
  ];

  const plain = await buildMetrics(await corpus({ [PROJ]: { "s1.jsonl": rows([]) } }));
  const withSidechain = await buildMetrics(
    await corpus({
      [PROJ]: {
        "s1.jsonl": rows([
          line({ type: "assistant", timestamp: "2026-07-01T10:00:10.000Z", isSidechain: true, message: { role: "assistant", model: "claude-opus-5", usage: {}, content: [{ type: "text", text: "subagent" }] } }),
        ]),
      },
    }),
  );

  assert.equal(plain.engagement.workingSeconds, 30);
  assert.equal(
    withSidechain.engagement.workingSeconds,
    30,
    "a sub-agent's own rows already show up as the main thread's tool gap",
  );
});

test("longest missions drop harness noise and bare approvals", async () => {
  const turn = (ts: string, opening: string, endTs: string) => [
    line({ type: "user", timestamp: ts, message: { role: "user", content: opening } }),
    line({ type: "assistant", timestamp: endTs, message: { role: "assistant", model: "claude-opus-5", usage: {}, content: [{ type: "text", text: "ok" }] } }),
  ];

  const logDir = await corpus({
    [PROJ]: {
      "s1.jsonl": [
        ...turn("2026-07-01T10:00:00.000Z", "y", "2026-07-01T10:01:00.000Z"),
        ...turn("2026-07-01T11:00:00.000Z", "<task-notification>something</task-notification>", "2026-07-01T11:02:00.000Z"),
        ...turn("2026-07-01T12:00:00.000Z", "Caveat: injected by the harness", "2026-07-01T12:03:00.000Z"),
        ...turn("2026-07-01T13:00:00.000Z", "rework the pagination cursor", "2026-07-01T13:00:20.000Z"),
      ],
    },
  });

  const m = await buildMetrics(logDir);
  assert.deepEqual(
    m.topMissions.map((x) => x.opening),
    ["rework the pagination cursor"],
    "bare approvals, harness tags and Caveat: injections are not missions",
  );
});

test("scaffold directories are counted but never read", async () => {
  const logDir = await corpus({
    [PROJ]: { "s1.jsonl": [line({ type: "assistant", timestamp: "2026-07-01T10:00:00.000Z", message: { role: "assistant", model: "claude-opus-5", usage: { input_tokens: 1_000_000 }, content: [{ type: "text", text: "real" }] } })] },
    "-private-var-folders-tmp-scratch": { "s1.jsonl": [line({ type: "assistant", timestamp: "2026-07-01T10:00:00.000Z", message: { role: "assistant", model: "claude-opus-5", usage: { input_tokens: 9_000_000 }, content: [{ type: "text", text: "throwaway" }] } })] },
    "-Users-me-Projects-app-claude-worktrees-wip": { "s1.jsonl": [line({ type: "assistant", timestamp: "2026-07-01T10:00:00.000Z", message: { role: "assistant", model: "claude-opus-5", usage: { input_tokens: 9_000_000 }, content: [{ type: "text", text: "worktree" }] } })] },
  });

  const m = await buildMetrics(logDir);
  assert.equal(m.totals.humanProjects, 1);
  assert.equal(m.totals.scaffoldProjects, 2);
  assert.equal(m.totals.tokIn, 1_000_000, "scaffold tokens must not reach the totals");
});

test("an unreadable log dir yields empty metrics rather than throwing", async () => {
  const m = await buildMetrics(path.join(os.tmpdir(), "ccl-does-not-exist-abc123"));
  assert.equal(m.totals.sessions, 0);
  assert.equal(m.agents.total, 0);
  assert.equal(m.span.days, 0);
});
