import { test } from "node:test";
import assert from "node:assert/strict";

import { repoHash, sessionHash, sessionBackLink, sameRepoPage } from "../src/routes.ts";

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

test("repoHash reproduces overview's former hand-built card href byte-for-byte", () => {
  // repoCard used to interpolate encodeURIComponent directly; the retrofit
  // onto repoHash must not change a byte of those hrefs. (The two encoders
  // only ever diverge on characters like spaces — `+` vs `%20` — which
  // URLSearchParams parses identically, as the round-trip test above pins.)
  const path = "/Users/me/Projects/demo";
  const name = "demo";
  assert.equal(
    repoHash(path, name),
    `#/repo?path=${encodeURIComponent(path)}&name=${encodeURIComponent(name)}`,
  );
});

test("sessionHash carries only the options given, in the file,q,label,back order", () => {
  assert.equal(sessionHash("/logs/p/s.jsonl"), "#/session?file=%2Flogs%2Fp%2Fs.jsonl");
  // Empty options are omitted outright, never serialized as empty params.
  assert.equal(
    sessionHash("/logs/p/s.jsonl", { label: "", back: "", q: "" }),
    "#/session?file=%2Flogs%2Fp%2Fs.jsonl",
  );

  const p = new URLSearchParams(
    sessionHash("/logs/p/s.jsonl", { q: "vite build", label: "~/x", back: "search" }).slice(
      "#/session?".length,
    ),
  );
  assert.deepEqual([...p.keys()], ["file", "q", "label", "back"]);
  assert.equal(p.get("file"), "/logs/p/s.jsonl");
  assert.equal(p.get("q"), "vite build");
  assert.equal(p.get("label"), "~/x");
  assert.equal(p.get("back"), "search");
});

test("sessionHash reproduces the views' former hand-built links byte-for-byte", () => {
  const file = "/Users/me/.claude/projects/-Users-me-Projects-demo/s1.jsonl";
  const label = "/Users/me/Projects/demo";
  // words.ts's former template.
  assert.equal(
    sessionHash(file, { label, back: "words" }),
    `#/session?${new URLSearchParams({ file, label, back: "words" }).toString()}`,
  );
  // search.ts's former template.
  const q = "vite build";
  assert.equal(
    sessionHash(file, { q, label, back: "search" }),
    `#/session?${new URLSearchParams({ file, q, label, back: "search" }).toString()}`,
  );
});

test("sessionBackLink resolves origin views and states the true destination", () => {
  assert.deepEqual(sessionBackLink("words", null), { href: "#/words", label: "← Back to Words" });
  assert.deepEqual(sessionBackLink("viz", null), { href: "#/viz", label: "← Back to Data Viz" });
  // A named origin wins over a stray q, exactly like the words branch.
  assert.deepEqual(sessionBackLink("viz", "x"), { href: "#/viz", label: "← Back to Data Viz" });
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
