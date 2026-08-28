import { test } from "node:test";
import assert from "node:assert/strict";

import { esc } from "../src/charts.ts";

test("esc neutralizes markup in element-content position", () => {
  assert.equal(esc("<script>1 & 2</script>"), "&lt;script&gt;1 &amp; 2&lt;/script&gt;");
});

test("esc neutralizes both quote styles for attribute positions", () => {
  assert.equal(esc(`x" onload="alert(1)`), "x&quot; onload=&quot;alert(1)");
  assert.equal(esc("x' y"), "x&#39; y");
});

test("esc leaves plain project names untouched", () => {
  assert.equal(esc("claude-code-log"), "claude-code-log");
});
