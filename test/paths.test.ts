import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  allowedRoots,
  decodeProjectDirApprox,
  encodeProjectDir,
  expandHome,
  resolveRoot,
  safeResolve,
  safeResolveReal,
} from "../server/paths.ts";

test("encodeProjectDir matches Claude Code's dash-separated naming", () => {
  assert.equal(encodeProjectDir("/Users/me/Projects/app"), "-Users-me-Projects-app");
  // Trailing slashes and `..` normalize away before encoding, or the encoded
  // name won't match the directory Claude Code actually created.
  assert.equal(encodeProjectDir("/Users/me/Projects/app/"), "-Users-me-Projects-app");
  assert.equal(encodeProjectDir("/Users/me/Projects/x/../app"), "-Users-me-Projects-app");
});

test("decoding is lossy for segments containing a dash", () => {
  // The documented reason repos are joined to logs by ENCODING, never decoding:
  // both of these encode differently but decode to the same wrong answer.
  const withDash = "/Users/me/Projects/my-app";
  assert.equal(encodeProjectDir(withDash), "-Users-me-Projects-my-app");
  assert.notEqual(decodeProjectDirApprox(encodeProjectDir(withDash)), withDash);
  assert.equal(decodeProjectDirApprox("-Users-me-Projects-my-app"), "/Users/me/Projects/my/app");
});

test("decodeProjectDirApprox round-trips paths with no dashes", () => {
  const clean = "/Users/me/Projects/app";
  assert.equal(decodeProjectDirApprox(encodeProjectDir(clean)), clean);
});

test("expandHome resolves ~ and $HOME", () => {
  const home = os.homedir();
  assert.equal(expandHome("~"), home);
  assert.equal(expandHome("~/.claude/projects"), path.join(home, ".claude/projects"));
  assert.equal(expandHome("$HOME/Projects"), path.join(home, "Projects"));
  // A bare `~user` is NOT a home reference and must not be expanded.
  assert.equal(expandHome("~other/x"), path.resolve("~other/x"));
});

test("safeResolve contains paths lexically", () => {
  const root = "/tmp/root";
  assert.equal(safeResolve(root, "/tmp/root"), "/tmp/root");
  assert.equal(safeResolve(root, "/tmp/root/a/b.jsonl"), "/tmp/root/a/b.jsonl");
  assert.equal(safeResolve(root, "/tmp/root/../etc/passwd"), null);
  assert.equal(safeResolve(root, "/etc/passwd"), null);
  // A sibling that merely shares the root's prefix must not pass.
  assert.equal(safeResolve(root, "/tmp/rootother/x"), null);
});

test("safeResolveReal rejects a symlink that escapes the root", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "ccl-paths-"));
  const root = path.join(tmp, "root");
  const outside = path.join(tmp, "outside.jsonl");
  await mkdir(root);
  await writeFile(outside, "secret");

  const inside = path.join(root, "ok.jsonl");
  await writeFile(inside, "fine");
  const escape = path.join(root, "escape.jsonl");
  await symlink(outside, escape);

  assert.equal(await safeResolveReal(root, inside), inside);
  // The lexical check passes the symlink — that's the whole reason the
  // realpath-aware variant exists.
  assert.notEqual(safeResolve(root, escape), null);
  assert.equal(await safeResolveReal(root, escape), null);
});

test("safeResolveReal falls back to the lexical answer for missing paths", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "ccl-paths-"));
  const missing = path.join(tmp, "not-there.jsonl");
  // Doesn't exist yet, so realpath fails; containment still holds and the
  // eventual read fails on its own rather than us failing closed here.
  assert.equal(await safeResolveReal(tmp, missing), missing);
});

test("resolveRoot admits paths under $HOME and rejects everything else", async () => {
  const home = os.homedir();
  assert.equal(await resolveRoot("~/.claude/projects"), path.join(home, ".claude/projects"));
  assert.equal(await resolveRoot("$HOME/Projects"), path.join(home, "Projects"));
  assert.equal(await resolveRoot(home), path.resolve(home));

  assert.equal(await resolveRoot("/etc"), null);
  assert.equal(await resolveRoot("/"), null);
  assert.equal(await resolveRoot("/var/log"), null);
  // Traversal that lands outside home is rejected after normalization.
  assert.equal(await resolveRoot("~/.claude/../../../etc"), null);
  // Empty/whitespace is not a root.
  assert.equal(await resolveRoot(""), null);
  assert.equal(await resolveRoot("   "), null);
});

test("CLAUDE_CODE_LOG_ROOTS widens the allowed roots", async () => {
  const prev = process.env.CLAUDE_CODE_LOG_ROOTS;
  try {
    assert.equal(await resolveRoot("/tmp/elsewhere"), null);
    process.env.CLAUDE_CODE_LOG_ROOTS = `/tmp/elsewhere${path.delimiter}/opt/logs`;
    assert.ok(allowedRoots().includes("/tmp/elsewhere"));
    assert.equal(await resolveRoot("/tmp/elsewhere/sub"), "/tmp/elsewhere/sub");
    assert.equal(await resolveRoot("/opt/logs"), "/opt/logs");
    assert.equal(await resolveRoot("/opt/other"), null);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_LOG_ROOTS;
    else process.env.CLAUDE_CODE_LOG_ROOTS = prev;
  }
});

test("resolveRoot rejects a root that symlinks out of the allowed boundary", async () => {
  const prev = process.env.CLAUDE_CODE_LOG_ROOTS;
  const box = await mkdtemp(path.join(os.tmpdir(), "ccl-rootlink-"));
  try {
    // An allowed root containing a symlink that escapes it. Lexically the link
    // sits inside the boundary; really it points at the box's sibling. Before
    // resolveRoot was symlink-aware this was accepted, and every file read on
    // the route then inherited the escaped root's clearance.
    const allowed = path.join(box, "allowed");
    const outside = path.join(box, "outside");
    await mkdir(allowed, { recursive: true });
    await mkdir(outside, { recursive: true });
    const escape = path.join(allowed, "escape");
    await symlink(outside, escape);

    process.env.CLAUDE_CODE_LOG_ROOTS = allowed;
    assert.equal(await resolveRoot(allowed), allowed, "the root itself still resolves");
    assert.equal(await resolveRoot(escape), null, "a symlink out of the root is rejected");
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_LOG_ROOTS;
    else process.env.CLAUDE_CODE_LOG_ROOTS = prev;
  }
});
