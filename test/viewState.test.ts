import { test } from "node:test";
import assert from "node:assert/strict";

import { carryDetailsState, restoreChoice } from "../src/viewState.ts";

// Node has no DOM: a <details> here is just { open, summary text } and a page
// is a list of them in document order, which is all carryDetailsState reads.
interface FakeDetails {
  open: boolean;
  querySelector(sel: string): { textContent: string } | null;
}
const details = (summary: string | null, open: boolean): FakeDetails => ({
  open,
  querySelector: (sel) => (sel === "summary" && summary !== null ? { textContent: summary } : null),
});
const page = (...ds: FakeDetails[]) => ({ querySelectorAll: () => ds });

test("a spec the reader opened stays open, and one they closed stays closed, across the rebuild", () => {
  // Defaults: CLAUDE.md open, README closed. The reader flipped both.
  const old = page(details("CLAUDE.md", false), details("README.md", true));
  const rebuilt = [details("CLAUDE.md", true), details("README.md", false)];
  carryDetailsState(old, page(...rebuilt));
  assert.deepEqual(rebuilt.map((d) => d.open), [false, true]);
});

test("a trailing count in the summary doesn't break the match when the data grew", () => {
  const old = page(details("Other Claude Code activity (12)", true));
  const rebuilt = [details("Other Claude Code activity (13)", false)];
  carryDetailsState(old, page(...rebuilt));
  assert.equal(rebuilt[0].open, true);
});

test("same-named disclosures pair by order; one with no counterpart keeps its default", () => {
  const old = page(details("Notes", true), details("Notes", false));
  const rebuilt = [details("Notes", false), details("Notes", true), details("Notes", true), details("New spec", true)];
  carryDetailsState(old, page(...rebuilt));
  assert.deepEqual(rebuilt.map((d) => d.open), [true, false, true, true], "third Notes and the new spec have no counterpart");
});

test("a page with no disclosures, or a summary-less one, is a no-op", () => {
  assert.doesNotThrow(() => carryDetailsState(page(), page()));
  const rebuilt = [details(null, true)];
  carryDetailsState(page(details(null, false)), page(...rebuilt));
  assert.equal(rebuilt[0].open, false, "both unnamed: they still pair as one group");
});

test("restoreChoice: a refresh keeps a still-valid pick; a navigation, or a pick the data lost, falls back", () => {
  const valid = (f: string) => f === "all" || f === "pivot";
  assert.equal(restoreChoice("pivot", true, valid, "all"), "pivot");
  assert.equal(restoreChoice("pivot", false, valid, "all"), "all", "navigating away and back starts fresh");
  assert.equal(restoreChoice("literal", true, valid, "all"), "all", "its last entry vanished in the new data");
});
