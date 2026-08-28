import { marked } from "marked";
import { sanitizeHtml } from "./sanitize.ts";

type Attrs = Record<string, string | number | boolean | EventListener>;

/** Tiny hyperscript helper. Event handlers are passed as on* attributes. */
export function el(tag: string, attrs: Attrs = {}, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (k === "class") {
      node.className = String(v);
    } else if (v === true) {
      node.setAttribute(k, "");
    } else if (v !== false) {
      node.setAttribute(k, String(v));
    }
  }
  for (const c of children) node.append(c instanceof Node ? c : document.createTextNode(c));
  return node;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

/**
 * The standard failure state. Every view funnels errors through this one
 * builder so failures look the same everywhere and an improvement (say, a
 * retry link) lands in every tab at once. `hint` is a plain string for the
 * common "check Settings" case; pass a ready element when a view needs
 * something richer (a back-link), or nothing at all.
 */
export function errorBox(lead: string, err: unknown, hint?: string | HTMLElement): HTMLElement {
  const box = el(
    "div",
    { class: "error" },
    el("strong", {}, lead),
    err instanceof Error ? err.message : "Unknown error",
  );
  if (typeof hint === "string") box.append(el("p", { class: "hint" }, hint));
  else if (hint) box.append(hint);
  return box;
}

/** One `.stat` cell (value over label) — the unit statStrip composes. */
export function stat(value: string | number, label: string): HTMLElement {
  return el("div", { class: "stat" }, el("span", { class: "stat-v" }, String(value)), el("span", { class: "stat-l" }, label));
}

/** A row of stat cells — the `.stats.snapshot` strip the analytics tabs share. */
export function statStrip(items: [string, string][]): HTMLElement {
  const strip = el("div", { class: "stats snapshot" });
  for (const [v, l] of items) strip.append(stat(v, l));
  return strip;
}

export function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const day = 86_400_000;
  if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))}m ago`;
  if (diff < day) return `${Math.round(diff / 3_600_000)}h ago`;
  if (diff < 30 * day) return `${Math.round(diff / day)}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Render Markdown crawled from repos under a caller-supplied `repoRoot`.
 * That root isn't guaranteed to be "the operator's own" (mistyped path,
 * shared/symlinked root, vendored files), and `marked` passes raw HTML
 * embedded in markdown straight through — so the parsed output is run
 * through `sanitizeHtml` before it reaches the DOM, rather than assumed
 * trusted.
 */
export function renderMarkdown(src: string): HTMLElement {
  const div = el("div", { class: "md" });
  div.replaceChildren(sanitizeHtml(marked.parse(src, { async: false }) as string));
  return div;
}
