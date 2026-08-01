import { test } from "node:test";
import assert from "node:assert/strict";

import { isSafeUrl } from "../src/sanitize.ts";

// `sanitizeHtml` needs a DOM (DOMParser), which this repo deliberately doesn't
// ship a stub for. `isSafeUrl` is the security-critical decision inside it and
// is pure, so it's the part worth pinning here.

test("relative, fragment and empty URLs are allowed", () => {
  for (const url of ["", "  ", "./doc.md", "../up.md", "docs/page.html", "#anchor", "?q=1", "/absolute/path"]) {
    assert.equal(isSafeUrl(url), true, `expected allowed: ${JSON.stringify(url)}`);
  }
});

test("http, https and mailto are allowed", () => {
  for (const url of ["http://example.com", "https://example.com/a?b=c#d", "HTTPS://EXAMPLE.COM", "mailto:a@b.co"]) {
    assert.equal(isSafeUrl(url), true, `expected allowed: ${url}`);
  }
});

test("script-bearing schemes are rejected", () => {
  for (const url of ["javascript:alert(1)", "JavaScript:alert(1)", "vbscript:msgbox(1)", "  javascript:alert(1)"]) {
    assert.equal(isSafeUrl(url), false, `expected rejected: ${url}`);
  }
});

test("embedded whitespace and control characters cannot smuggle a scheme past the check", () => {
  // The URL parser strips tab/LF/CR from anywhere in a URL and trims leading
  // C0 controls, so all of these ARE javascript: URLs to a browser.
  const smuggled = [
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "java\rscript:alert(1)",
    "\u0000javascript:alert(1)",
    "\u0001javascript:alert(1)",
    "\u001fjavascript:alert(1)",
    "\u007fjavascript:alert(1)",
    "java script:alert(1)",
  ];
  for (const url of smuggled) {
    assert.equal(isSafeUrl(url), false, `expected rejected: ${JSON.stringify(url)}`);
  }
});

test("data: URLs are rejected outright, including images", () => {
  for (const url of [
    "data:text/html,<script>alert(1)</script>",
    "data:image/svg+xml,<svg onload=alert(1)>",
    "data:image/png;base64,iVBORw0KGgo=",
  ]) {
    assert.equal(isSafeUrl(url), false, `expected rejected: ${url}`);
  }
});

test("other unexpected schemes are rejected rather than passed through", () => {
  for (const url of ["file:///etc/passwd", "ftp://example.com", "blob:https://example.com/x", "about:blank"]) {
    assert.equal(isSafeUrl(url), false, `expected rejected: ${url}`);
  }
});

test("a path that merely looks scheme-ish is still treated as relative", () => {
  // No colon => no scheme => relative. Guards against over-eager rejection.
  assert.equal(isSafeUrl("javascript-notes.md"), true);
  assert.equal(isSafeUrl("./http/readme.md"), true);
});
