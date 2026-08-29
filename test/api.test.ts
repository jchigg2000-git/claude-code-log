import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

import { handleApi } from "../server/api.ts";

function req(url: string, host?: string, method = "GET"): IncomingMessage {
  return { url, method, headers: host === undefined ? {} : { host } } as unknown as IncomingMessage;
}

/** Capture status, headers and JSON body the way handleApi's send() writes them. */
function res(): {
  res: ServerResponse;
  status: () => number;
  body: () => unknown;
  header: (name: string) => string | undefined;
} {
  let status = 0;
  let raw = "";
  const headers = new Map<string, string>();
  const stub = {
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    end(chunk: string) {
      raw = chunk;
    },
    set statusCode(code: number) {
      status = code;
    },
  };
  return {
    res: stub as unknown as ServerResponse,
    status: () => status,
    body: () => JSON.parse(raw),
    header: (name) => headers.get(name.toLowerCase()),
  };
}

test("loopback hosts pass the gate", async () => {
  for (const host of ["127.0.0.1:5189", "localhost:5189", "[::1]:5189", "127.0.0.1"]) {
    const r = res();
    assert.equal(await handleApi(req("/api/health", host), r.res), true);
    assert.equal(r.status(), 200, `host ${host} should be allowed`);
    assert.deepEqual(r.body(), { ok: true });
  }
});

test("cross-host and hostless requests are rejected with 403", async () => {
  for (const host of ["evil.example.com:5189", "192.168.1.20:5189", "localhost.attacker.dev", undefined]) {
    const r = res();
    assert.equal(await handleApi(req("/api/health", host), r.res), true);
    assert.equal(r.status(), 403, `host ${String(host)} should be rejected`);
  }
});

test("non-/api paths are left for the dev server regardless of host", async () => {
  const r = res();
  assert.equal(await handleApi(req("/", "evil.example.com"), r.res), false);
  assert.equal(r.status(), 0, "no response should have been written");
});

test("write verbs get 405 with an Allow header — the API is read-only", async () => {
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const r = res();
    assert.equal(await handleApi(req("/api/health", "127.0.0.1:5189", method), r.res), true);
    assert.equal(r.status(), 405, `${method} should be rejected`);
    assert.equal(r.header("Allow"), "GET, HEAD");
  }
});

test("responses carry X-Content-Type-Options: nosniff", async () => {
  const r = res();
  await handleApi(req("/api/health", "127.0.0.1:5189"), r.res);
  assert.equal(r.header("X-Content-Type-Options"), "nosniff");
});

// ── /api/session caps ────────────────────────────────────────────────────────

interface SessionBody {
  file: string;
  events: { text: string }[];
  totalEvents: number;
  truncated: boolean;
  sizeBytes: number;
  readBytes: number;
}

/** A 7-event fixture transcript in a dir the containment layer will accept. */
async function sessionFixture(): Promise<{ logDir: string; file: string }> {
  const logDir = await mkdtemp(path.join(os.tmpdir(), "ccl-api-"));
  // os.tmpdir() sits outside $HOME on macOS; allowedRoots() re-reads this env
  // var per request, so adding the fixture root here is enough.
  process.env.CLAUDE_CODE_LOG_ROOTS = logDir;
  const file = path.join(logDir, "sess.jsonl");
  const lines: string[] = [];
  for (let i = 1; i <= 7; i++) {
    lines.push(JSON.stringify({ type: "user", message: { role: "user", content: `prompt ${i}` } }));
  }
  await writeFile(file, lines.join("\n"));
  return { logDir, file };
}

function sessionUrl(logDir: string, file: string, limit?: string): string {
  const params = new URLSearchParams({ logDir, file });
  if (limit !== undefined) params.set("limit", limit);
  return `/api/session?${params.toString()}`;
}

test("/api/session returns the capped payload shape, un-truncated for a small file", async () => {
  const { logDir, file } = await sessionFixture();
  const r = res();
  await handleApi(req(sessionUrl(logDir, file), "127.0.0.1:5189"), r.res);
  assert.equal(r.status(), 200);
  const body = r.body() as SessionBody;
  assert.equal(body.truncated, false);
  assert.equal(body.totalEvents, 7);
  assert.equal(body.events.length, 7);
  assert.equal(body.readBytes, body.sizeBytes);
  assert.ok(body.sizeBytes > 0);
});

test("/api/session limit truncates events but reports the honest total", async () => {
  const { logDir, file } = await sessionFixture();
  const r = res();
  await handleApi(req(sessionUrl(logDir, file, "3"), "127.0.0.1:5189"), r.res);
  assert.equal(r.status(), 200);
  const body = r.body() as SessionBody;
  assert.equal(body.truncated, true);
  assert.equal(body.totalEvents, 7);
  assert.deepEqual(
    body.events.map((e) => e.text),
    ["prompt 1", "prompt 2", "prompt 3"],
    "the head of the timeline, in order",
  );
});

test("/api/session clamps limit like /api/journey's days: junk falls back to the cap", async () => {
  const { logDir, file } = await sessionFixture();
  // Junk and out-of-range values fall back to the default cap (which this tiny
  // file never reaches), and an over-cap ask is clamped down, not honoured up.
  for (const limit of ["0", "-5", "junk", "999999999"]) {
    const r = res();
    await handleApi(req(sessionUrl(logDir, file, limit), "127.0.0.1:5189"), r.res);
    assert.equal(r.status(), 200, `limit=${limit}`);
    const body = r.body() as SessionBody;
    assert.equal(body.events.length, 7, `limit=${limit} should fall back to the cap`);
    assert.equal(body.truncated, false);
  }
});

test("/api/session still refuses a file outside the log location", async () => {
  const { logDir } = await sessionFixture();
  const r = res();
  await handleApi(req(sessionUrl(logDir, "/etc/passwd.jsonl"), "127.0.0.1:5189"), r.res);
  assert.equal(r.status(), 400);
});
