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
  textContent = "";
  attrs: Record<string, string> = {};
  listeners: Record<string, (() => void)[]> = {};
  classList = { toggle: () => {} };
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

const { appendTranscriptBody } = await import("../src/views/transcript.ts");

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
