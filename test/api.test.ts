import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";

import { handleApi } from "../server/api.ts";

function req(url: string, host?: string): IncomingMessage {
  return { url, method: "GET", headers: host === undefined ? {} : { host } } as unknown as IncomingMessage;
}

/** Capture status + JSON body the way handleApi's send() writes them. */
function res(): { res: ServerResponse; status: () => number; body: () => unknown } {
  let status = 0;
  let raw = "";
  const stub = {
    setHeader() {},
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
