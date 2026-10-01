import { test } from "node:test";
import assert from "node:assert/strict";

import { isSettled, mountView, startRoute } from "../src/mount.ts";
import { runViewTeardown, setViewTeardown } from "../src/viewLifecycle.ts";

// Node has no DOM. mountView touches only document.createElement, children /
// childNodes, classList.contains and replaceChildren, so a tiny fake pins the
// policy: what stays on screen while a refresh fetches, what replaces it, and
// when it must be left alone.
class FakeEl {
  children: FakeEl[] = [];
  childNodes = this.children; // same array: replaceChildren mutates in place
  classes: Set<string>;
  classList = { contains: (c: string) => this.classes.has(c) };
  name: string;
  constructor(name = "", cls = "") {
    this.name = name;
    this.classes = new Set(cls.split(" ").filter(Boolean));
  }
  replaceChildren(...kids: FakeEl[]): void {
    this.children.length = 0;
    this.children.push(...kids);
  }
  append(...kids: FakeEl[]): void {
    this.children.push(...kids);
  }
}
Object.assign(globalThis, { document: { createElement: () => new FakeEl("stage") } });

const names = (h: FakeEl) => h.children.map((c) => c.name);
const asHost = (h: FakeEl) => h as unknown as HTMLElement;
const asEl = (h: HTMLElement) => h as unknown as FakeEl;

function deferred() {
  let go!: () => void;
  const promise = new Promise<void>((r) => (go = r));
  return { promise, go };
}

test("isSettled: a page is settled; a top-level loading line or error box is not", () => {
  assert.equal(isSettled(new FakeEl("h", "")), true);
  const page = new FakeEl();
  page.append(new FakeEl("head", "page-head"), new FakeEl("body", "vz-section"));
  assert.equal(isSettled(page), true);
  page.append(new FakeEl("spin", "loading"));
  assert.equal(isSettled(page), false);
  const failed = new FakeEl();
  failed.append(new FakeEl("err", "error"));
  assert.equal(isSettled(failed), false);
});

test("isSettled looks only at direct children — a nested .error (a failed transcript) is content", () => {
  const page = new FakeEl();
  const row = new FakeEl("row", "session");
  row.append(new FakeEl("t", "error"));
  page.append(row);
  assert.equal(isSettled(page), true);
});

test("a navigation renders straight into the host, and afterAttach runs immediately", async () => {
  const host = new FakeEl("host");
  const order: string[] = [];
  await mountView(asHost(host), startRoute(), false, async (t, ctx) => {
    assert.equal(asEl(t), host);
    assert.equal(ctx.refreshing, false);
    asEl(t).append(new FakeEl("page"));
    ctx.afterAttach(() => order.push(`attached:${names(host).join(",")}`));
    order.push("after-call");
  });
  // Ran at the call, not queued: the host is the live page already.
  assert.deepEqual(order, ["attached:page", "after-call"]);
});

test("a refresh keeps the old page up while the new one loads, then swaps it in one step", async () => {
  const host = new FakeEl("host");
  host.append(new FakeEl("old"));
  const gate = deferred();
  const done = mountView(asHost(host), startRoute(), true, async (t, ctx) => {
    assert.equal(ctx.refreshing, true, "views use this to wait for data a placeholder would otherwise stand in for");
    asEl(t).append(new FakeEl("loading", "loading")); // the view's own shell goes to the stage
    await gate.promise;
    asEl(t).replaceChildren(new FakeEl("new"));
  });
  await Promise.resolve();
  assert.deepEqual(names(host), ["old"], "nothing may touch the live page before the data lands");
  gate.go();
  await done;
  assert.deepEqual(names(host), ["new"]);
});

test("a refresh defers afterAttach until the stage is in the page, and tears the old view down first", async () => {
  const host = new FakeEl("host");
  host.append(new FakeEl("old"));
  const order: string[] = [];
  setViewTeardown(() => order.push(`teardown:${names(host).join(",")}`));
  await mountView(asHost(host), startRoute(), true, async (t, ctx) => {
    asEl(t).append(new FakeEl("new"));
    ctx.afterAttach(() => order.push(`attached:${names(host).join(",")}`));
  });
  // Teardown sees the old page (the swap hasn't happened); attach sees the new one.
  assert.deepEqual(order, ["teardown:old", "attached:new"]);
});

test("a refresh whose refetch failed keeps the old page and leaves its teardown armed", async () => {
  const host = new FakeEl("host");
  host.append(new FakeEl("old"));
  let tornDown = false;
  setViewTeardown(() => (tornDown = true));
  let attached = false;
  await mountView(asHost(host), startRoute(), true, async (t, ctx) => {
    asEl(t).append(new FakeEl("err", "error"));
    ctx.afterAttach(() => (attached = true));
  });
  assert.deepEqual(names(host), ["old"], "stale content beats an error box mid-read");
  assert.equal(tornDown, false, "the live page keeps its animation loop and listeners");
  assert.equal(attached, false);
  // Drain the slot so it can't leak into a later test.
  runViewTeardown();
});

test("a refresh over a host that is itself a spinner or an error takes whatever the stage ended on", async () => {
  for (const cls of ["loading", "error"]) {
    const host = new FakeEl("host");
    host.append(new FakeEl("stuck", cls));
    await mountView(asHost(host), startRoute(), true, async (t) => {
      asEl(t).append(new FakeEl("err2", "error"));
    });
    assert.deepEqual(names(host), ["err2"], `a stuck ${cls} host must not be preserved over a newer outcome`);
  }
});

test("a refresh render superseded by a newer route is discarded, afterAttach included", async () => {
  const host = new FakeEl("host");
  host.append(new FakeEl("mine"));
  const gate = deferred();
  let attached = false;
  const done = mountView(asHost(host), startRoute(), true, async (t, ctx) => {
    await gate.promise;
    asEl(t).append(new FakeEl("late"));
    ctx.afterAttach(() => (attached = true));
  });
  startRoute(); // the reader navigated away mid-fetch
  host.replaceChildren(new FakeEl("their-page"));
  gate.go();
  await done;
  assert.deepEqual(names(host), ["their-page"]);
  assert.equal(attached, false);
});

test("isCurrent flips the moment a newer route starts", async () => {
  const host = new FakeEl("host");
  const seen: boolean[] = [];
  await mountView(asHost(host), startRoute(), false, async (_t, ctx) => {
    seen.push(ctx.isCurrent());
    startRoute();
    seen.push(ctx.isCurrent());
  });
  assert.deepEqual(seen, [true, false]);
});
