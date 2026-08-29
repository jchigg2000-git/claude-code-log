import { test } from "node:test";
import assert from "node:assert/strict";

import { repoHash, sessionBackLink, sameRepoPage } from "../src/routes.ts";

test("repoHash round-trips path/name and carries the session only when given", () => {
  const plain = repoHash("/Users/me/Projects/my repo", "my repo");
  assert.ok(plain.startsWith("#/repo?"));
  const p = new URLSearchParams(plain.slice("#/repo?".length));
  assert.equal(p.get("path"), "/Users/me/Projects/my repo");
  assert.equal(p.get("name"), "my repo");
  assert.equal(p.get("session"), null, "plain repo hash must not carry a session param");

  const open = new URLSearchParams(repoHash("/r", "n", "abc-123").slice("#/repo?".length));
  assert.equal(open.get("session"), "abc-123");
});

test("sessionBackLink resolves origin views and states the true destination", () => {
  assert.deepEqual(sessionBackLink("words", null), { href: "#/words", label: "← Back to Words" });
  assert.deepEqual(sessionBackLink("search", "vite build"), {
    href: "#/search?q=vite%20build",
    label: "← Back to results",
  });
  // Pre-`back` deep links: a bare q still restores the results page.
  assert.deepEqual(sessionBackLink(null, "x"), { href: "#/search?q=x", label: "← Back to results" });
  // No origin, no query: an honest link to the empty search page, not "results".
  assert.deepEqual(sessionBackLink(null, null), { href: "#/search", label: "← Back to search" });
  assert.deepEqual(sessionBackLink("nonsense", null), { href: "#/search", label: "← Back to search" });
});

test("sameRepoPage matches only repo hashes for the same repo", () => {
  const base = "http://localhost:5189/";
  const repo = (extra = "") => `${base}#/repo?path=%2FUsers%2Fme%2Fr&name=r${extra}`;
  assert.ok(sameRepoPage(repo(), repo("&session=abc")), "toggle open is the same page");
  assert.ok(sameRepoPage(repo("&session=abc"), repo("&session=def")), "switching sessions is the same page");
  assert.ok(!sameRepoPage(repo(), `${base}#/repo?path=%2Fother&name=o`), "different repo is a different page");
  assert.ok(!sameRepoPage(`${base}#/`, repo()), "arriving from another view is a different page");
  assert.ok(!sameRepoPage(`${base}#/words`, `${base}#/search`), "non-repo hashes never match");
});
