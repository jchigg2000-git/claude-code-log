import { test } from "node:test";
import assert from "node:assert/strict";

// appendTranscriptBody is shared by the inline repo-page transcript and the
// standalone session view. Node has no DOM, so a minimal fake covers only what
// the helper and dom.ts's `el` touch: createElement/createTextNode, append,
// listeners, className, isConnected, and a manual rAF queue.
class FakeNode {
  children: FakeNode[] = [];
  parent: FakeNode | null = null;
  className = "";
  hidden = false;
  private text = "";
  // Faithful enough to the DOM for what the helpers do: a text node holds its
  // string; an element's text is its children's, and assigning replaces them.
  get textContent(): string {
    return this.tag === "#text" ? this.text : this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    if (this.tag === "#text") {
      this.text = v;
      return;
    }
    this.children = [];
    const t = new FakeNode("#text");
    t.text = v;
    t.parent = this;
    this.children.push(t);
  }
  attrs: Record<string, string> = {};
  listeners: Record<string, (() => void)[]> = {};
  classList = { toggle: () => {} };
  get firstChild(): FakeNode | null {
    return this.children[0] ?? null;
  }
  insertBefore(n: FakeNode, ref: FakeNode | null): void {
    n.parent = this;
    this.children.splice(ref ? this.children.indexOf(ref) : this.children.length, 0, n);
  }
  tag: string;
  constructor(tag: string) {
    this.tag = tag;
  }
  append(...kids: (FakeNode | string)[]): void {
    for (const k of kids) {
      const n = typeof k === "string" ? new FakeNode("#text") : k;
      if (typeof k === "string") n.textContent = k;
      n.parent = this;
      this.children.push(n);
    }
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  addEventListener(t: string, fn: () => void): void {
    (this.listeners[t] ??= []).push(fn);
  }
  get isConnected(): boolean {
    let n: FakeNode | null = this;
    while (n?.parent) n = n.parent;
    return n?.tag === "#root";
  }
  querySelectorAll(): FakeNode[] {
    return [];
  }
}
const rafQueue: (() => void)[] = [];
Object.assign(globalThis, {
  Node: FakeNode,
  document: {
    createElement: (tag: string) => new FakeNode(tag),
    createTextNode: (t: string) => Object.assign(new FakeNode("#text"), { textContent: t }),
  },
  requestAnimationFrame: (fn: () => void) => rafQueue.push(fn),
});

const { appendTranscriptBody, extendsTranscript } = await import("../src/views/transcript.ts");

function session(n: number) {
  const events = Array.from({ length: n }, (_, i) => ({
    kind: "user",
    text: `msg ${i}`,
    ts: null,
  }));
  return { events, truncated: false, totalEvents: n, readBytes: 1, sizeBytes: 1 } as never;
}
function drain(): void {
  while (rafQueue.length) rafQueue.shift()!();
}
function attached(): FakeNode {
  const root = new FakeNode("#root");
  const transcript = new FakeNode("div");
  root.append(transcript);
  return transcript;
}
const rowsOf = (t: FakeNode) => t.children.find((c) => c.className === "ev-rows")!;

test("appendTranscriptBody renders chips, rows and a hidden more-button for a small session", () => {
  const t = attached();
  appendTranscriptBody(t as never, session(5));
  drain();
  assert.equal(t.children[0].className, "ev-chips");
  assert.equal(rowsOf(t).children.length, 5);
  assert.equal(t.children.at(-1)!.className, "ev-more");
  assert.equal(t.children.at(-1)!.attrs.hidden, "");
});

test("appendTranscriptBody stops filling rows once the transcript is detached", () => {
  const t = attached();
  appendTranscriptBody(t as never, session(5000));
  const rows = rowsOf(t);
  t.parent!.children = [];
  t.parent = null; // a hash change replaced the page
  drain();
  assert.ok(rows.children.length < 5000);
});

// ── Live transcripts: a grown file is folded in at the tail ──────────────────

const labelOf = (b: FakeNode) => b.textContent;
const chipLabels = (t: FakeNode) => t.children[0].children.map(labelOf);

function growing(from: number, to: number) {
  const s = session(to) as { events: unknown[]; totalEvents: number };
  return { ...s, events: s.events.slice(0, from) };
}

test("extendsTranscript: the same events plus a tail extends; rewrites, shrinks and empties don't", () => {
  const ev = (text: string) => ({ kind: "user" as const, ts: null, text });
  const prev = { events: [ev("a"), ev("b")] };
  assert.equal(extendsTranscript(prev, { events: [ev("a"), ev("b"), ev("c")] }), true);
  assert.equal(extendsTranscript(prev, { events: [ev("a"), ev("b")] }), true, "unchanged is trivially an extension");
  assert.equal(extendsTranscript(prev, { events: [ev("a")] }), false, "shrunk");
  assert.equal(extendsTranscript(prev, { events: [ev("x"), ev("b"), ev("c")] }), false, "first event differs");
  assert.equal(extendsTranscript(prev, { events: [ev("a"), ev("y"), ev("c")] }), false, "last-seen event differs");
  assert.equal(extendsTranscript({ events: [] }, { events: [ev("a")] }), false, "nothing on screen to append to");
});

test("grow appends only the new rows, leaving rendered ones in place, and recounts the chips", () => {
  const t = attached();
  const handle = appendTranscriptBody(t as never, growing(3, 5) as never);
  drain();
  const rows = rowsOf(t);
  const first = rows.children[0];
  assert.equal(rows.children.length, 3);
  assert.deepEqual(chipLabels(t), ["All (3)", "Prompts only (3)", "Hide tools (3)"]);

  assert.equal(handle.grow(session(5)), true);
  drain();
  assert.equal(rows.children.length, 5);
  assert.equal(rows.children[0], first, "the reader's existing rows are the same nodes — nothing was rebuilt");
  assert.deepEqual(chipLabels(t), ["All (5)", "Prompts only (5)", "Hide tools (5)"]);
});

test("grow refuses a payload that isn't an extension and changes nothing", () => {
  const t = attached();
  const handle = appendTranscriptBody(t as never, session(3));
  drain();
  const other = session(4) as { events: { text: string }[] };
  other.events[0] = { ...other.events[0], text: "a different file entirely" };
  assert.equal(handle.grow(other as never), false);
  drain();
  assert.equal(rowsOf(t).children.length, 3);
});

test("grow past a parked batch refreshes the show-more label instead of rendering unasked", () => {
  const t = attached();
  const handle = appendTranscriptBody(t as never, session(1200));
  drain();
  const more = t.children.at(-1)!;
  assert.equal(rowsOf(t).children.length, 1000, "parked at the batch boundary");
  assert.equal(handle.grow(session(1500)), true);
  drain();
  assert.equal(rowsOf(t).children.length, 1000, "still parked");
  assert.match(more.textContent, /Show 500 more events/);
});

test("grow adds the truncation notice once, then keeps it current", () => {
  const t = attached();
  const small = session(3) as { truncated: boolean };
  const handle = appendTranscriptBody(t as never, small as never);
  drain();
  const capped = (n: number) => ({ ...(session(n) as object), truncated: true, totalEvents: n + 10, readBytes: 5, sizeBytes: 5 }) as never;
  assert.equal(handle.grow(capped(4)), true);
  assert.equal(t.children[0].className, "truncation-note", "inserted above the chips");
  assert.equal(handle.grow(capped(5)), true);
  assert.equal(t.children.filter((c) => c.className === "truncation-note").length, 1);
  assert.match(t.children[0].textContent, /showing 5 of 15/);
});
